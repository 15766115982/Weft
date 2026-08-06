# CONTEXT — Self-Governing Knowledge Base System

## System Positioning

A **self-governing knowledge base system** for teams: acquires documents from multiple
scattered data sources (Confluence / SharePoint / Jira / GitHub / Azure Repos / local files),
governs them into a structurally stable knowledge base (wiki tree), and serves efficient,
precise queries and page-level Q&A through retrieval and LLM services.

**Primary users**: the team as a whole. Two roles:
- **Readers** — browse, search, and ask questions; no login required.
- **Operators** — a single admin login that can run acquisition/governance jobs, review
  candidates, edit wiki pages, and tune prompts.

This is not a general multi-user collaboration platform: it is a **knowledge governance and
Q&A portal** focused on ingestion, curation, and trustworthy answers. The original localhost
red lines are relaxed for team deployment (ADR-0009): the UI portal may run as a resident
intranet service, but it is still designed to be launched on demand and carries no complex
permission model.

## Glossary

### Services

The system consists of four **fully decoupled** services. A "service" here is not a resident
process but an independent capability package in the form of **Skill + scripts**, invoked on
demand by Claude Code or by each other through a stable CLI contract:

- **Acquisition service** — calls the APIs of each data source and pulls original documents
  to local storage. Also performs read-only upstream change detection (`acquire detect`).
- **Governance service** — governs original documents and the existing wiki tree, producing a
  governed wiki tree. Every mutating action is recorded in a decision log.
- **Retrieval service** — performs efficient, precise retrieval over the governed wiki tree.
- **LLM service** — owns all model calls (Azure OpenAI via SPN) behind a single CLI contract.
  Governance tasks use non-streaming JSON; chat and deep-research stream NDJSON. The LLM
  service is the only service that talks to the model.

### KB structure: two data zones + rules layer + candidate state machine

The knowledge base consists of the following parts (aligned with the original meaning of the
Karpathy LLM Wiki paradigm: raw / wiki / schema):

- **`raw/` (raw zone)** — exclusive write by the acquisition service. Stores **normalized
  Markdown** (original payloads such as Confluence XHTML / docx are not retained; conversion
  happens at acquisition time and the original is discarded). Organized by source (e.g.
  `raw/confluence/`, `raw/jira/`). Binary evidence sidecars (Gliffy PNGs) live at
  `raw/confluence/<page-id>.assets/` (contract amendment 2026-08-03). The governance
  service only reads, never modifies.
- **`wiki/` (curation zone)** — exclusive write by the governance service. The structurally
  stable governed product, and the retrieval service's only indexing target. Wiki pages trace
  back to `raw/` documents via source pointers in their frontmatter. Four page types:
  **source** (1:1 summaries), **entity** (named things), **concept** (ideas/mechanisms),
  **synthesis** (cross-source narrative / Q&A products).
- **Rules layer (Schema)** — normative documents (directory structure + frontmatter spec +
  workflow conventions); the single contract all four services obey; must be frozen early.
- **Candidate state machine** — the implementation of governance risk tiers: wiki pages have a
  status (candidate / approved / rejected / archived; `rejected` is transient, swept into
  archive/). Low-risk, conflict-free governance is completed and takes effect automatically;
  high-risk cases (conflicts, contradictions, archiving approved pages, etc.) produce
  candidate pages that take effect only after operator review. A candidate is a **status**,
  not a separate directory. Every transition writes a machine-readable **decision record**
  to `.kb/govern/decisions/`, so LLM auto-decisions can learn from human precedent.
- **Decision log** — every mutating governance action appends `.kb/govern/decisions/<id>.json`.
  Human decisions require a reason; LLM decisions cite precedent IDs and the model version.
  It is adjudication memory, not rebuildable; `log.md` remains the human-readable audit spine.

### Human interaction surface: thin localhost tools + team portal

Two local tools remain: the M4 **thin viewer** (`governance/viewer/`, review-only) and the
M7 **UI portal** (`ui/`, ADR-0006/0009 — a console for browsing, search, review, acquisition
operations, raw management, agent-driven governance with live streaming, and page-level chat
+ deep-research Q&A).

The original red lines are revised by ADR-0009:

1. **Launch on demand by default** — a Node script can start localhost; the portal may also
   be deployed as a resident intranet service for team use. No always-on background process
   is required.
2. **Minimal auth** — readers need no login; operators use a single admin login. No
   per-user permission system.
3. **Whitelisted writes only** — the viewer's only write is flipping frontmatter `status`
   (candidate → approved / rejected); the portal's KB writes are confined to the contract
   §1 whitelist plus the new decision-reason flows, executed through a **per-KB serial write
   queue** that enforces the single-operator assumption at the tool layer. Governance rules
   live forever only in the skills/scripts; prompts are editable per KB under `.kb/config/`.

Tech stack: a Node script serving static files + a no-build HTML page (no framework build
chain). Logging of review outcomes: the viewer/portal flips only `status` and never writes
log.md; the governance service's **`sweep`** (run first in every governance session) backfills
the missing `review |` log lines by diffing log.md against current page statuses, and moves
`rejected` pages into `wiki/archive/` (flipping them to `archived`). Sweep also backfills
human decision records for unlogged flips.

### Repository and deployment shape

- **Single code repo**: the four services are top-level packages (acquisition/ governance/
  retrieval/ llm/ each containing SKILL.md + scripts/) plus the M7 `ui/` portal package
  (ADR-0006/0009, a pure consumer — zero reverse dependency), not split into per-service repos —
  decoupling is guaranteed by "communicate only through the KB directory"; splitting repos
  would instead require syncing three copies of the contract.
- **The rules layer is materialized as `schema/`**: contract.md (directory structure +
  frontmatter spec, the single four-party contract, frozen before code) + governance.md
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
- **Upstream change detection**: `acquire detect` lists remote documents within the configured
  scope, compares their version/hash with the corresponding `raw/` files, and writes
  `.kb/acquire/upstream-detect.json` without modifying `raw/`. This allows a daily job to
  detect stale sources and either alert operators or trigger an `acquire pull` automatically.
- **Orphan reconcile**: when a connector runs it checks raw/ for documents whose source has
  disappeared (deleted/renamed/moved); **by default it only reports `orphaned` — deletion
  requires an explicit `--prune`** (deletion is irreversible and needs operator confirmation);
  cleanup is recorded in log.md. Downstream backstop: if the governance service finds a wiki
  page whose `source_ref` points to a defunct raw document → archive candidate (operator
  adjudication). Rename/move = new identity, new document, with the old document becoming an
  orphan; content-unchanged duplicates are converged by the governance layer's "identical hash
  auto-dedup". The local source's `source_id` = first 8 chars of the hash of the
  inbox-relative path.

### Retrieval service (v2, corrected through deep research)

**Design philosophy: retrieval is an interface design problem, not a retriever design
problem** — scripts own recall and bounding; the Claude session or LLM service owns precision
(iterative exploration, reranking, full-text reading). Chat and deep-research are first-class
consumers of retrieval, not replacements for it.

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
    constructed by Claude or the LLM service (division: the logical query defines the candidate
    set, BM25 defines the ranking);
  - **Vector leg off by default**, configurable to an OpenAI-compatible endpoint or local GGUF
    (Qwen3-Embedding-0.6B for CJK corpora, not embeddinggemma); RRF (k=60) fusion; silently
    skipped when unconfigured;
  - wikilink graph expansion: outbound-link neighbors of top-10 hit pages are merged into the
    candidates (annotated via:link), plus ADR-0007 provenance neighbors — an entity/concept/
    synthesis hit pulls in its `sources:` (via:provenance) and a source hit pulls in its
    covering pages (read-time reverse, never stored); per-page fan-out capped;
  - Outputs a **candidate space** rather than one-shot snippets: top-10 preview + full top-K
    persisted to disk + `--within` scoped iterative digging + `read <path>#<anchor>` to fetch
    a whole section; ≤2 snippets per page.
- **Retrieval skill (precision loop)**: for broad questions first read index.md →
  construct a structured query → initial search → **CSQE** (extract key terms from hit
  snippets, rewrite, re-query; **HyDE-style speculative expansion forbidden**) → read the full
  text of hit sections → answer with wikilink citations; multi-hop questions follow graph
  expansion. This loop is run by Claude Code sessions or by the LLM service's deep-research
  task.
- **No offline graph-building pipeline** (GraphRAG-style): wiki backlinks + index.md already
  constitute explicit structure; agentic iterative retrieval suffices; re-evaluate only if
  complex multi-hop demands emerge in the future. (ADR-0007's in-process provenance derivation
  is consistent with this: it is an index-time reconcile over the derived SQLite artifact —
  the copied `sources` column and `provlinks` — not an offline graph build stage.)

### Governance risk tiers and triggering

**Line-drawing principle: incremental and reversible changes take effect automatically;
destructive ones, and those requiring business adjudication, go to the candidate queue.**

- **Automatic**: create/update source summary pages (1:1 mechanical mapping), update index.md,
  create new entity/concept/synthesis pages, append **non-contradictory** information to
  existing pages;
- **Candidate (operator adjudication)**: new information contradicting existing pages,
  suspected cross-source duplicates, merging already-approved pages, archiving/deleting
  already-approved pages, multi-version validity trade-offs;
- **Decision log**: every governance operation that mutates `wiki/` or `archive/` appends a
  machine-readable record to `.kb/govern/decisions/<id>.json` (human decisions require a
  reason; LLM decisions cite precedent IDs and model version). The log is the few-shot memory
  that allows automatic governance to mimic operator precedent. When precedent is
  contradictory, the LLM fails closed to `candidate`.
- **Governance log**: all governance operations (automatic and candidate) must also be written
  to a traceable log (append-only `log.md`, including operation type, target, and rationale),
  supporting after-the-fact audit and rollback; the whole KB is a Git repository with one
  commit per governance run for automatic changes.
- **Triggering: human-triggered or scheduled batch execution**. Operators explicitly initiate
  governance in a Claude Code session or through the portal; scheduled daily jobs run the
  independent steps in order. Every governance run starts with `sweep`
  (reconciling any viewer/portal flips since the last run).
- **Review shape**: the candidate queue is processed either item by item conversationally in
  a Claude Code session (view diff, approve/reject/modify), in the thin viewer (M4), or in the
  portal's decision inbox; all channels drive the same state machine (contract §4) and write
  decision records.

### wiki/ internal structure: page type system

What is stable is the **type system and entry contract**, not the exact tree (the tree's
language, granularity, etc. are defined later by the governance conventions):

- **`wiki/sources/`** — source summary pages. **1:1 with `raw/` documents by default** —
  exactly one per raw document, with source pointers in frontmatter. Both creation and
  source-following updates are low-risk automatic operations. The 1:1 has two documented
  exceptions: **auto-dedup** (an exact duplicate of a raw that already has an approved source
  page is never written — the redundant raw is tombstoned) and **loser-archive** (an
  adjudicated loser source page is archived and its raw tombstoned).
- **`wiki/entities/`** — entity pages: named things (systems, teams, products, projects,
  components, people). Frontmatter may carry `kind` (human-readable entity kind) and typed
  `relations` to other entities; body links use `[[wikilink]]`.
- **`wiki/concepts/`** — concept pages: ideas, mechanisms, patterns, definitions, protocols.
  A concept is not a named object but a shared abstraction described by multiple sources.
- **`wiki/syntheses/`** — synthesis pages: cross-source narrative products such as onboarding
  guides, comparisons, how-tos, and answers to recurring questions. A synthesis may state
  conclusions not present in any single source, as long as each claim cites sources.
- **`wiki/index.md`** — whole-KB navigation index (one line per page, grouped by type), must
  be updated after every governance run; the retrieval service's **entry contract**.

All non-source page types share slug identity, `sources:` provenance, union-merge update
semantics, and the candidate state machine. Merge/converge semantics apply across the same
type (an entity does not merge with a concept).

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
- **Cross-source version confusion is resolved at the governance layer** (ADR-0008) via three
  canonical categories, detected over the whole KB: **exact duplicate** (identical
  `content_hash`, only when both sides carry it) → auto-dedup without writing a redundant
  source page; **similar version** (same title/filename family + CJK-aware body-similarity
  confirmation) → forced `candidate` (fail-closed) at apply-* so a fused page can never
  be silently approved; **factual conflict** with existing approved content → semantic
  self-check (mandatory governance-LLM step, prompted by `semantic_check_required`).
- **Adjudication memory** (`.kb/govern/`): an archived loser's raw is **tombstoned**
  (`source-tombstones.json`) — plan does not re-pend it, apply-source refuses to revive it
  without `--force`; a "parallel documents" pair is **dismissed**
  (`conflict-dismissals.json`) and never re-flagged; `plan` writes the **conflicts**
  side-channel (`conflicts.json`) with a raw-set freshness fingerprint that `apply-*`
  verifies, degrading to an in-topic check on a stale/missing one. `reject` is
  **reject-and-restore**: a candidate that overwrote an approved page reverts to its last
  git-committed approved version, logged synchronously. The **decision log**
  (`.kb/govern/decisions/`) is added by ADR-0009: every mutating action records the actor,
  reason, precedent IDs, and model version, so LLM auto-decisions can learn from operator
  precedent.
- `raw/` is organized into directories by source system, not by project (project attribution
  is a curation judgment, a governance-layer responsibility).

**Single-responsibility principle**: every directory has exactly one writer; orchestration is
the Claude session's or the portal scheduler's responsibility.

### Inter-layer contract: pure filesystem

The **only contract among the four services is the filesystem**: the agreed directory
structure + frontmatter spec. Zero code dependency between layers, zero inter-process calls.
Any layer can be independently rewritten or replaced.

- **Orchestration moved up to the LLM or the portal scheduler**: the Claude session or a daily
  job calls acquisition → governance → retrieval → llm in order; orchestration logic exists in
  no layer's code; layers contain only deterministic scripts.
- **Indexes are derived artifacts**: SQLite and other indexes are outside the contract and can
  be fully rebuilt from Markdown at any time (except adjudication memory in `.kb/govern/` and
  per-KB user config in `.kb/config/`).
- The directory structure and frontmatter spec are the only conventions in the system that all
  four parties must obey; they must be frozen into documents early.

### Lessons from the old version (LLM-Wiki v1 platform edition)

Building it as a Web platform (FastAPI + React + configuration UI + multi-provider switching)
led to bloat and made it hard to split, reuse, and maintain. The new version abandons the
platform shape; only its core Python logic (document chunking, hybrid retrieval, Jira client,
etc.) is reusable.
