# CONTEXT — Self-Governing Knowledge Base System

## System Positioning

A **self-governing knowledge base system**: acquires documents from multiple scattered data
sources (Confluence / SharePoint / Jira, etc.), governs them into a structurally stable
knowledge base (wiki tree), and serves efficient, precise queries through a retrieval service.

**The primary user is Claude Code (an LLM agent)**, with human users browsing by eye as the
secondary audience. This is not a multi-user collaboration platform — no always-on services,
no Web UI, no user permission system.

## Glossary

### Services

The system consists of three **fully decoupled** services. A "service" here is not a resident
process but an independent capability package in the form of **Skill + scripts**, invoked on
demand by Claude Code:

- **Acquisition service** — calls the APIs of each data source and pulls original documents
  to local storage
- **Governance service** — governs original documents and the existing wiki tree, producing a
  governed wiki tree
- **Retrieval service** — performs efficient, precise retrieval over the governed wiki tree

### KB structure: two data zones + rules layer + candidate state machine

The knowledge base consists of the following parts (aligned with the original meaning of the
Karpathy LLM Wiki paradigm: raw / wiki / schema):

- **`raw/` (raw zone)** — exclusive write by the acquisition service. Stores **normalized
  Markdown** (original payloads such as Confluence XHTML / docx are not retained; conversion
  happens at acquisition time and the original is discarded). Organized by source (e.g.
  `raw/confluence/`, `raw/jira/`). The governance service only reads, never modifies.
- **`wiki/` (curation zone)** — exclusive write by the governance service. The structurally
  stable governed product, and the retrieval service's only indexing target. Wiki pages trace
  back to `raw/` documents via source pointers in their frontmatter.
- **Rules layer (Schema)** — normative documents (directory structure + frontmatter spec +
  workflow conventions); the single contract all three services obey; must be frozen early.
- **Candidate state machine** — the implementation of governance risk tiers: wiki pages have a
  status (candidate / approved / rejected / archived; `rejected` is transient, swept into
  archive/). Low-risk, conflict-free governance is completed
  and takes effect automatically by the LLM; high-risk cases (conflicts, doubtful version
  adjudication, etc.) produce candidate pages that take effect only after human approval. A
  candidate is a **status**, not a separate directory (cf. llm-wiki-compiler's review queue).
  When an archived page is moved into `wiki/archive/`, its `status: archived` must be flipped
  at the same time (contract §4); the retrieval service indexes only approved pages and skips
  the archive/ directory wholesale (double insurance).

### Human interaction surface: the thin viewer

The intranet forbids installing Obsidian, so a **self-built thin viewer is the only interface
for human review**, delivered together with the candidate state machine (M4:
`governance/viewer/`). Three red lines
(to prevent a relapse of platform bloat disease):

1. **Launch on demand, no resident service** — a Node script starts localhost; shut down
   when done;
2. **No user system, no permissions, no configuration UI** — a single-user local tool;
3. **Dumb consumer, zero governance logic** — only renders for reading, lists the candidate
   queue, presents conflict diffs, and offers approve/reject buttons; the buttons' substantive
   action is nothing more than rewriting frontmatter `status` (candidate → approved /
   rejected); governance rules live forever only in the skills/scripts.

Tech stack: a Node script serving localhost static files + a no-build HTML page (no framework
build chain on the frontend — the old frontend's build chain was one of the maintenance
burdens). Logging of review outcomes: the viewer flips only `status` and never writes log.md;
the governance service's **`sweep`** (run first in every governance session) backfills the
missing `review |` log lines by diffing log.md against current page statuses, and moves
`rejected` pages into `wiki/archive/` (flipping them to `archived`).

### Repository and deployment shape

- **Single code repo**: the three services are top-level packages (acquisition/ governance/
  retrieval/, each containing SKILL.md + scripts/), not split into per-service repos —
  decoupling is guaranteed by "communicate only through the KB directory"; splitting repos
  would instead require syncing three copies of the contract.
- **The rules layer is materialized as `schema/`**: contract.md (directory structure +
  frontmatter spec, the single three-party contract, frozen before code) + governance.md
  (governance conventions).
- **KB data is independent**: the KB directory (raw/ wiki/ log.md .kb/) is completely separate
  from the code repo and is its own independent Git repository; multiple KB instances may
  coexist.
- **Distribution shape**: a Claude Code plugin; the three skills are globally available and
  any session can point at any KB to work on.
- **Script tech stack: Node.js (npm ecosystem), not Python**.
  - SQLite/FTS5 via `better-sqlite3` (prebuilt Windows binaries, no build-chain problems);
    unicode61/trigram are both SQLite built-in tokenizers.
  - The vector leg (optional) via `node-llama-cpp` (GGUF) or an OpenAI-compatible endpoint
    over fetch; the two major reference implementations, qmd and llm-wiki-compiler, are both
    in the npm ecosystem and can be borrowed from directly.
  - Consequence: the old Python code (jira.py, store.py, ingest.py) is not portable; only its
    API knowledge and patterns may be referenced — it must be rewritten in Node (M5 Jira
    changes from "port" to "rewrite").
- **Configuration resolution**: the `KB_PATH` environment variable locates the knowledge base
  root; `kb.json` (checked in) holds all non-sensitive configuration (base_url, JQL, space
  key, inbox path, embedding endpoint, etc.); **secrets go through environment variables
  only** (JIRA_PAT, CONFLUENCE_PAT, etc.); kb.json stores at most environment-variable name
  mappings (the KB is a Git repository — checked-in secrets would enter history; forbidden).

### Acquisition service

- **v1 connectors**: Jira (port of the old PAT implementation), Confluence (intranet
  Server/DC, **PAT auth**, same pattern as Jira; storage XHTML → markdown conversion is new
  work), **local-file fallback connector** (manually exported files are dropped into an inbox
  directory, normalized, and landed in raw/; usable for any source before its dedicated
  connector is ready). SharePoint deferred to v2 (Graph API + MSAL is the longest chain, and
  docx/pdf binary conversion quality is uncontrollable).
- **Pull boundary**: no whole-site sync; the scope is specified in the user session (Jira gets
  JQL, Confluence gets space key + optional CQL). Incremental: skip unchanged documents by
  comparing `content_hash` (where the version is metadata outside the content, e.g. Jira,
  connectors embed it at full precision in the hashed body, so hash-only skip is equivalent
  to version + hash; content-addressed sources like local are self-versioning).
- **Connector pluginization**: a common framework (frontmatter generation, normalization,
  persisting, hashing, incremental skip) + one connector script per source; adding a source =
  adding one script, without touching the framework.
- **Orphan reconcile**: when a connector runs it checks raw/ for documents whose source has
  disappeared (deleted/renamed/moved); **by default it only reports `orphaned` — deletion
  requires an explicit `--prune`** (deletion is irreversible and needs human confirmation);
  cleanup is recorded in log.md. Downstream backstop: if the governance service finds a wiki
  page whose `source_ref` points to a defunct raw document → archive candidate (human
  adjudication). Rename/move = new identity, new document, with the old document becoming an
  orphan; content-unchanged duplicates are converged by the governance layer's "identical hash
  auto-dedup". The local source's `source_id` = first 8 chars of the hash of the
  inbox-relative path.

### Retrieval service (v2, corrected through deep research)

**Design philosophy: retrieval is an interface design problem, not a retriever design
problem** — scripts own recall and bounding; the Claude session owns precision (iterative
exploration, reranking, full-text reading).

- **Contract inputs**: only pages in `wiki/` with **approved status** + index.md +
  frontmatter; candidate/archived pages are structurally invisible to retrieval ("only the
  currently effective version is retrievable" is guaranteed by structure). The retrieval
  service is **strictly read-only** and never touches `raw/`.
- **kb_search script (recall + bounding)**:
  - **Corpus is 99%+ English** (tests are predominantly English; CJK retained only for
    regression cases);
  - Dual FTS5 tables: fts_latin = **porter + unicode61** (English stemming,
    retry↔retries, compensate↔compensation) / fts_cjk = trigram; **per-term routing**: Latin
    terms → latin table, CJK ≥3 chars → trigram, CJK <3 chars → LIKE fallback (trigram has a
    physical blind spot for 1-2 char queries, confirmed empirically); queries uniformly
    wrapped in double quotes for sanitization (FTS5 pitfalls like treating hyphens as NOT);
  - **Structured query interface**: frontmatter field filters (type:/source:/tag: exact match
    + after:/before: filtering by "the document's own update time" — source pages take the
    source-system time source_version (when ISO) preferred, falling back to governance time
    updated_at; both are normalized to UTC at index time so lexicographic comparison is
    chronological; status is pinned to approved on the indexing side) + boolean combinations,
    constructed by Claude (division: the logical query defines the candidate set, BM25 defines
    the ranking);
  - **Vector leg off by default**, configurable to an OpenAI-compatible endpoint or local GGUF
    (Qwen3-Embedding-0.6B for CJK corpora, not embeddinggemma); RRF (k=60) fusion; silently
    skipped when unconfigured;
  - wikilink graph expansion: outbound-link neighbors of top-10 hit pages are merged into the
    candidates (annotated via:link);
  - Outputs a **candidate space** rather than one-shot snippets: top-10 preview + full top-K
    persisted to disk + `--within` scoped iterative digging + `read <path>#<anchor>` to fetch
    a whole section; ≤2 snippets per page.
- **Retrieval skill (Claude precision loop)**: for broad questions first read index.md →
  construct a structured query → initial search → **CSQE** (extract key terms from hit
  snippets, rewrite, re-query; **HyDE-style speculative expansion forbidden**) → read the full
  text of hit sections → answer with wikilink citations; multi-hop questions follow graph
  expansion.
- **No offline graph-building pipeline** (GraphRAG-style): wiki backlinks + index.md already
  constitute explicit structure; agentic iterative retrieval suffices; re-evaluate only if
  complex multi-hop demands emerge in the future.

### Governance risk tiers and triggering

**Line-drawing principle: incremental and reversible changes take effect automatically;
destructive ones, and those requiring business adjudication, go to the candidate queue.**

- **Automatic**: create/update source summary pages (1:1 mechanical mapping), update index.md,
  create new topic pages, append **non-contradictory** information to existing topic pages.
- **Candidate (human adjudication)**: new information contradicting existing pages, suspected
  cross-source duplicates, merging already-approved topic pages, archiving/deleting
  already-approved pages, multi-version validity trade-offs.
- **Governance log**: all governance operations (automatic and candidate) must be written to a
  traceable log (append-only, including operation type, target, and rationale), supporting
  after-the-fact audit and rollback; the whole KB is a Git repository with one commit per
  governance run for automatic changes.
- **Triggering: human-triggered, batch execution**. The user explicitly initiates governance
  in a Claude Code session; no automatic immediate governance after pulling (governance
  requires a cross-document global view). Every governance run starts with `sweep`
  (reconciling any viewer flips since the last run).
- **Review shape**: the candidate queue is processed either item by item conversationally in
  a Claude Code session (view diff, approve/reject/modify) or in the thin viewer (M4);
  both channels drive the same state machine (contract §4).

### wiki/ internal structure: page type system + topic emergence

What is stable is the **type system and entry contract**, not the topic tree (the topic tree's
language, granularity, etc. are defined later by the governance conventions):

- **`wiki/sources/`** — source summary pages. **1:1 mechanical mapping** with `raw/`
  documents — exactly one per raw document — with source pointers in frontmatter. Both
  creation and source-following updates are low-risk automatic operations.
- **`wiki/topics/`** — topic synthesis pages. 1:N cross-source fusion products; the core value
  of governance; frontmatter carries a `sources:` list tracing provenance. The topic tree
  emerges with content; duplicate topic pages are converged through a merge mechanism (merging
  rewrites backlinks and archives the old page).
- **`wiki/index.md`** — whole-KB navigation index (one line per page), must be updated after
  every governance run; the retrieval service's **entry contract**.

### Document identity and versioning

- **Identity quintuple**: `raw/` document frontmatter must carry `source` (source system),
  `source_id` (stable ID within the source, e.g. Confluence page ID / Jira issue key),
  `source_url`, `source_version` (source-system version number / update time), `pulled_at` +
  `content_hash`.
- **Deterministic filenames**: `raw/` filenames are generated from `source + source_id`;
  re-pulling the same document = overwriting the old file; raw/ keeps only the latest pulled
  version. **Same-source version confusion is resolved at the acquisition layer** (the source
  system is the authority on its own versions); historical versions are carried by the whole
  knowledge base as a **Git repository** — no in-directory snapshots.
- **Cross-source version confusion is resolved at the governance layer**: identical content
  hash → automatic dedup; high similarity without identity → high-risk signal, enters
  candidate status for human adjudication.
- `raw/` is organized into directories by source system, not by project (project attribution
  is a curation judgment, a governance-layer responsibility).

**Single-responsibility principle**: every directory has exactly one writer; orchestration is
the Claude session's responsibility.

### Inter-layer contract: pure filesystem

The **only contract among the three services is the filesystem**: the agreed directory
structure + frontmatter spec. Zero code dependency between layers, zero inter-process calls.
Any layer can be independently rewritten or replaced.

- **Orchestration moved up to the LLM**: the Claude session calls acquisition → governance →
  retrieval in order; orchestration logic exists in no layer's code; layers contain only
  deterministic scripts.
- **Indexes are derived artifacts**: SQLite and other indexes are outside the contract and can
  be fully rebuilt from Markdown at any time.
- The directory structure and frontmatter spec are the only conventions in the system that all
  three parties must obey; they must be frozen into documents early.

### Lessons from the old version (LLM-Wiki v1 platform edition)

Building it as a Web platform (FastAPI + React + configuration UI + multi-provider switching)
led to bloat and made it hard to split, reuse, and maintain. The new version abandons the
platform shape; only its core Python logic (document chunking, hybrid retrieval, Jira client,
etc.) is reusable.
