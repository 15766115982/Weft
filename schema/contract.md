# Knowledge Base Contract (Contract v2)

> This file is the **single contract** jointly obeyed by the four services: **acquisition /
> governance / retrieval / llm**. The four services have zero code dependency and zero
> inter-process calls; they communicate only through the directory structure and frontmatter
> spec defined here. Modifying this file = modifying the four-party contract; it requires
> review and a synchronized update of `CONTEXT.md` and the relevant ADRs.
>
> Status: **Frozen (v2, 2026-08-05)** · Companion: `./governance.md` (governance conventions)
>
> Changes from v1 (ADR-0009): added the `llm` service; expanded wiki page-type enum from
> `source | topic` to `source | entity | concept | synthesis`; added `.kb/acquire/`,
> `.kb/config/`, and `.kb/govern/decisions/`; relaxed the blanket "everything in `.kb/` is
> rebuildable" statement to carve out adjudication memory and per-KB user config.

## 1. Knowledge Base (KB) Directory Structure

A knowledge base instance is a directory on disk, itself an independent Git repository:

```
<kb-root>/
├── kb.json                  # Non-sensitive configuration for this KB (checked in)
├── raw/                     # Raw zone — exclusive write by the acquisition service
│   ├── jira/<issue-key>.md          # e.g. raw/jira/PROJ-123.md
│   ├── confluence/<page-id>.md      # e.g. raw/confluence/123456.md
│   ├── confluence/<page-id>.assets/<file>  # binary evidence sidecars (Gliffy PNGs; amendment 2026-08-03 phase 1)
│   └── local/<hash8>-<slug>.md      # output of the local-file connector
├── wiki/                    # Curation zone — exclusive write by the governance service
│   ├── sources/<source>-<source_id>.md   # source summary pages, 1:1 with raw documents
│   ├── entities/<slug>.md                # entity pages: named things (systems, teams, products)
│   ├── concepts/<slug>.md                # concept pages: ideas, mechanisms, definitions
│   ├── syntheses/<slug>.md               # synthesis pages: cross-source narrative / Q&A products
│   ├── archive/                          # archive of merged/superseded pages (kept for traceability)
│   └── index.md                          # whole-KB navigation index, the retrieval entry contract
├── log.md                   # governance log (append-only, checked in)
└── .kb/                     # derived-artifacts directory (not checked in, .gitignore)
    ├── index.sqlite         # retrieval index (dual FTS5 tables + optional vectors), exclusive write by the retrieval service
    ├── search_state.json    # incremental hash state of the index
    ├── candidates/          # query candidate spaces persisted to disk by the retrieval script (temporary)
    ├── acquire_runs.jsonl   # per-source pull records appended by the acquisition service (one JSON line per run; the only record of all-skipped incremental pulls)
    ├── acquire/             # upstream-detect artifacts (exclusive write by the acquisition service)
    │   └── upstream-detect.json
    ├── govern_runs.jsonl    # agent-governance run records appended by the UI portal (two lines per run: phase start/finish; a start with no finish reads as interrupted)
    ├── govern/              # governance adjudication memory (source-tombstones.json, conflict-dismissals.json, conflicts.json, decisions/ — plan 0001 §1, ADR-0009), exclusive write by the governance service
    ├── config/              # per-KB user config (prompts and LLM models, ADR-0009)
    │   ├── prompts/
    │   └── models.json
    └── ui/                  # UI portal derived artifacts (jobs.db, eval scores, snapshots/), exclusive write by the UI portal
```

### Write Permission Matrix (single-responsibility principle)

| Path | Acquisition | Governance | Retrieval | LLM | Thin viewer | UI portal |
|---|---|---|---|---|---|---|
| `raw/` | **write** | read | forbidden | read | read | read + **delete/move only** (see rules) |
| `wiki/` | forbidden | **write** | read | read | only frontmatter `status` (candidate → approved / rejected) | same flip primitive + **human body edits** (demote rule, see ⑤) |
| `log.md` | **append** | **append** | read | read | forbidden | **append** (manual-edit entries: `candidate:manual`, `file:edit`, `review` reject-restore) |
| `.kb/acquire/` | **write** | read | read | read | read | read |
| `.kb/govern/` | read | **write** | read | read | read | read |
| `.kb/config/` | read | read | read | **write** (`prompts/` via `init-prompts` only) | read | read |
| `.kb/ui/` | read | read | read | read | read | **write** |
| `.kb/index.sqlite` / `.kb/search_state.json` / `.kb/candidates/` | read | read | **write** | read | read | read |
| `.kb/acquire_runs.jsonl` / `.kb/govern_runs.jsonl` | **append** | read | read | read | read | **append** |
| `kb.json` | read | read | read | read | read | read |

Rules:
- No layer may write to paths exclusively owned by another layer;
- The thin viewer is a "dumb consumer"; its only write operation is flipping the `status`
  field of a wiki page's frontmatter (candidate → approved / rejected); `rejected` is a
  transient outcome — the governance service's sweep moves rejected pages into
  `wiki/archive/` and flips them to `archived` (see §4);
- The **UI portal** (ADR-0006, `ui/`) is a team-server human console (ADR-0009 relaxes the
  original on-demand-only red line; it still runs on demand by default but may be deployed as
  a resident intranet service). Its KB writes are confined to an explicit whitelist: ① inbox/
  uploads (staging area of the local connector — never raw/ directly), ② raw/ delete & move
  (snapshot first, impact preview first, executed via its per-KB serial write queue; move =
  new identity — the old document becomes an orphan, as with any rename), ③ frontmatter
  `status` flips via the governance statusflip primitive,
  ④ `.kb/ui/` derived artifacts,
  ⑤ **human wiki edits** (M7d, user-ruled 2026-08-02): the portal may rewrite a wiki
  page's body; every save demotes the page to `candidate` with a `review_note`
  (`manual edit via portal @ <ts>`; editing a candidate changes content only — no
  status transition) and appends a `portal | candidate:manual` log.md entry, which the
  governance sweep's review backfill and the unlogged-flip guard treat exactly like
  `govern | candidate:*` (pending-review semantics). Provenance fields
  (`source_ref`/`sources`) are never touched by this path — drift between edited
  content and provenance is reconciled by later agent governance rounds, not by the
  editor. ⑥ **KB-root whitelisted files** (GOVERNANCE.md — the user-owned governance
  brief injected into every agent run's prompt; F3 2026-08-03): editable with the same
  optimistic-lock discipline as ⑤, audited as `portal | file:edit` log.md entries;
  the whitelist is a fixed set in code, never user-extensible. Everything else is read-only. Its write operations go
  through a per-KB serial queue; its destructive operations preserve a restorable
  snapshot (git commit when the KB is a repository, file-copy snapshot otherwise);
- Everything inside `.kb/` can be fully rebuilt **except** governance adjudication memory
  (`.kb/govern/`, including `decisions/`) and per-KB user configuration (`.kb/config/`).
  Deleting those loses historical precedent and tuned prompts; deleting other `.kb/`
  artifacts does not affect correctness.

## 2. raw/ Original Document Spec

The acquisition service outputs **normalized Markdown** (original payloads such as XHTML/docx
are not retained; conversion happens at acquisition time and the original is discarded).
Filenames are deterministically generated from `source + source_id`; re-pulling the same
document = overwriting the old file; raw/ keeps only the latest pulled version (history is
carried by Git).

**Binary evidence sidecars** (amendment 2026-08-03, phase 1): Confluence attachments that
carry content the normalized Markdown cannot express (today: Gliffy PNG renders) live at
`raw/confluence/<page-id>.assets/<file>` and are referenced from the owning document as
KB-root-relative image links (`![…](raw/confluence/<page-id>.assets/<file>)`). Sidecars
are byte-compared and updated **independently of the document's `content_hash`** (the
render can change while the page text does not); they are not hashed into the document.
Asset filenames are sanitized (path separators/traversal rejected, image extensions only).

### frontmatter (identity quintuple + required fields)

```yaml
---
source: jira | confluence | local     # source system (required)
source_id: "PROJ-123"                 # stable ID within the source (required)
source_url: "https://jira.example.com/browse/PROJ-123"  # required
source_version: "2026-07-28T02:30:00.000Z"  # source-system version number / update time (required).
                                # An ISO timestamp SHOULD be UTC (Z); any ISO
                                # offset is legal, and the retrieval service
                                # normalizes it to UTC at index time
pulled_at: "2026-07-29T09:00:00+08:00"       # time of this pull (required)
content_hash: "sha256:..."            # hash of the body content (required)
title: "Original title"               # required
connector: "jira@1.0.0"               # the connector that generated it, with version (required)
extra: {}                             # source-specific metadata (optional, e.g. jira's issue_type/status/assignee)
---
```

### Incremental rules

- Before pulling, read the target file first: skip when `content_hash` matches.
  Where the source version is metadata outside the content (e.g. Jira), connectors
  embed the source-system version **at full precision** in the hashed body, so a
  source-side edit always changes the hash — hash-only skip is then equivalent to
  comparing version + hash, without a day-granularity blind spot. Content-addressed
  sources (e.g. local, where the body IS the content) are self-versioning: an
  mtime-only change with identical content is correctly skipped;
- `kb.json` records each connector's pull scope (JQL / space key / inbox path), making pulls
  repeatable.
- **Character constraints**: `source` and `source_id` may only start with `[A-Za-z0-9]` and
  consist of `[A-Za-z0-9_-]` (i.e. `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`; no CJK, dots, or
  slashes — both are spliced into wiki page paths, so this prevents path injection;
  connectors must escape, hash-map, or **reject with an error** (fail-closed skip, the
  safest option) non-compliant external IDs).

## 3. wiki/ Curated Page Spec

### 3.1 Common frontmatter

```yaml
---
type: source | entity | concept | synthesis  # page type (required)
status: candidate | approved | rejected | archived  # candidate state machine (required,
                                # see §4; `rejected` is transient — the governance sweep
                                # moves rejected pages into archive/ and flips them to
                                # `archived`; `archived` is used only for pages inside
                                # archive/)
title: "Page title"            # required
created_at / updated_at: ISO8601
---
```

A page's **slug** is its filename without `.md`; it is the page's identity for entity,
concept, and synthesis pages. Slugs are lowercase kebab-case, `/^[a-z0-9][a-z0-9-]*$/`
(a path component, whitelisted like `source_id` in §2). Re-applying an existing slug = an
update of the same page, never a fork. Update semantics: `sources` is **union-merged**
(provenance is never silently dropped), `created_at` is preserved, `updated_at` is bumped;
`aliases`/`tags` omitted = keep. Source pages use the deterministic filename
`<source>-<source_id>.md` instead of a free slug. Body interlinks use `[[wikilink]]` (the
piped alias form `[[slug|display name]]` guarantees Obsidian compatibility and rename
stability).

### 3.2 source summary pages (`wiki/sources/`)

**1:1 with `raw/` documents BY DEFAULT**; filename = `<source>-<source_id>.md`.
Creation and source-following updates are both low-risk automatic operations. The 1:1 has
**two documented exceptions** (ADR-0008 / plan 0001): **auto-dedup** — an exact duplicate of
a raw that already has an approved source page is never written (the redundant raw is
tombstoned, logged `auto:dedup-source`); **loser-archive** — an adjudicated loser source page
is archived and its raw tombstoned, so the next `plan` does not re-pend it and `apply-source`
refuses to revive it without `--force`. `wiki/sources/` is therefore "1:1 unless adjudicated
away", never silently more than one page per document.

```yaml
---
type: source
status: approved                # source pages normally take effect directly (archivable on human adjudication)
title: "Original title"
source_ref: "raw/jira/PROJ-123.md"     # source pointer (required, forward-slash relative path)
source_url: "..."
source_version: "..."           # synced with raw, used for staleness detection
content_hash: "sha256:..."      # synced with raw (optional, staleness double insurance:
                                # hash changed + version unchanged = anomaly high-risk signal)
tags: [...]
---
```

Body = structured summary (key points, key conclusions, topics involved); does not contain
the full original text.

### 3.3 entity pages (`wiki/entities/`)

Named things: systems, teams, products, projects, people, components. An entity page
abstracts a single real-world object and is referenced by concept and synthesis pages.

```yaml
---
type: entity
status: candidate | approved
title: "FAA"
aliases: ["FAA module", "FAA feature"]
tags: []
sources:                       # provenance trace-back (required)
  - "raw/jira/FA-123.md"
  - "raw/confluence/123456.md"
kind: "system"                 # optional entity kind (free short string, human-readable)
relations:                     # typed relations to other entities (optional)
  - { rel: "developed_by", target: "entities/team-platform.md", evidence: ["raw/jira/FA-123.md"] }
review_note: "..."
---
```

### 3.4 concept pages (`wiki/concepts/`)

Ideas, mechanisms, patterns, definitions, protocols. A concept is not a named thing but a
shared abstraction that multiple sources describe.

```yaml
---
type: concept
status: candidate | approved
title: "Payment timeout retry"
aliases: ["payment retry"]
tags: []
sources:
  - "raw/jira/PROJ-123.md"
  - "raw/confluence/123456.md"
review_note: "..."
---
```

### 3.5 synthesis pages (`wiki/syntheses/`)

Cross-source narrative products: answers to recurring questions, onboarding guides,
comparisons, how-tos. A synthesis is allowed to state conclusions that are not present in
any single source, as long as each claim is backed by cited sources.

```yaml
---
type: synthesis
status: candidate | approved
title: "How payment retries work"
aliases: []
tags: []
sources:
  - "raw/jira/PROJ-123.md"
  - "raw/confluence/123456.md"
review_note: "..."
---
```

### 3.6 `wiki/index.md` (retrieval entry contract)

Must be rebuilt after every governance run. Grouped by type, one line per page:

```markdown
## Entities
- [[entities/faa]] — FAA feature overview (status:approved, sources:2)

## Concepts
- [[concepts/payment-timeout-retry]] — Payment timeout retry mechanism (status:approved, sources:3)

## Syntheses
- [[syntheses/payment-retries]] — How payment retries work (status:candidate, sources:2)

## Sources
- [[sources/jira-PROJ-123]] — PROJ-123 payment gateway requirements (jira, 2026-07-28)
```

Constraints: single line = wikilink + one-sentence summary + key metadata; read directly by
the retrieval service and by Claude for navigation; also Tier 0 of index-first retrieval.

## 4. Candidate State Machine

```
                 ┌─────────────┐   human approval (viewer or session)   ┌──────────┐
 governance out →│  candidate  │ ──────────────────────────────────────→│ approved │
                 └──────┬──────┘                                        └────┬─────┘
                        │ human rejection (viewer or session)                │ human-adjudicated
                        ▼                                                    ▼
                 ┌─────────────┐   governance sweep (next run)        ┌───────────┐
                 │  rejected   │ ────────────────────────────────────→│ archived  │
                 └─────────────┘   (move into wiki/archive/ + flip)   └───────────┘
                     approved pages archived on human decision go directly: approved → archived
```

- **Takes effect automatically (directly approved)**: source page creation/update, index.md
  update, creation of new entity/concept/synthesis pages, appending non-contradictory
  information to existing pages;
- **Must be a candidate (candidate)**: contradiction with existing pages, suspected
  cross-source duplicates, merging already-approved pages, archiving/deleting
  already-approved pages, multi-version validity trade-offs;
- **Conflict detection is structural** (ADR-0008 / plan 0001): `plan` detects three
  cross-document categories over the whole KB — exact duplicate (identical `content_hash`,
  only when both sides carry it), similar version (title/filename pre-filter + CJK-aware
  body-similarity confirmation), and factual conflict (semantic; judged at application
  time against existing approved content). A page whose `sources` touch a flagged group is
  **forced to `candidate`** by `apply-*` — the caller's `--candidate` cannot be silently
  omitted (bug 0001). `apply-source` auto-dedups exact duplicates without writing; a rejected
  candidate that overwrote an approved page is **reject-and-restored** to its last
  git-committed approved version, logged synchronously; an adjudicated loser's source page is
  archived and its raw tombstoned. Persisted adjudication lives in `.kb/govern/`
  (`source-tombstones.json`, `conflict-dismissals.json`, `conflicts.json`);
- **Decision log** (ADR-0009): every transition that changes `wiki/` or `archive/` writes a
  machine-readable decision record to `.kb/govern/decisions/<id>.json`. Human decisions
  carry a required `reason` and `actor: human`; LLM auto-decisions carry `actor: llm`, the
  `model_version` used, and the IDs of referenced historical decisions. When referenced
  human decisions are contradictory, the LLM decision is forced to `candidate`. The decision
  log is adjudication memory, not rebuildable; `log.md` remains the human-readable audit
  spine;
- **Archive discipline**: when a page is moved into `wiki/archive/`, its frontmatter `status`
  must be flipped to `archived` at the same time and recorded in log.md — double insurance:
  the retrieval service both skips the `wiki/archive/` directory and indexes only pages with
  `status: approved`. Two paths lead there: the sweep moves `rejected` pages automatically;
  archiving an `approved` page is a human-adjudicated action executed mechanically by the
  governance service's archive command;
- **Viewer flips are reconciled by the sweep**: the thin viewer flips `status` without
  writing log.md (its only write is the status field); the next governance run's sweep
  backfills the missing `review |` lines by diffing log.md against current page statuses
  (stateless detection), then archives rejected pages. Backfill granularity is per-sweep:
  a page flipped twice between sweeps records only its final state. Tool-layer enforcement:
  a page whose last log line is `candidate:*` but whose status is no longer `candidate`
  carries an unlogged flip — `apply-topic`, `merge-topic` and `archive` ALL refuse to
  touch it until the sweep has solidified the review record, so the audit narrative
  cannot be silently truncated;
- **Candidate protection**: re-applying a topic page that is still `candidate` never
  approves it as a side effect — approval is a review outcome (approve command / viewer
  flip) only;
- **Merge discipline**: merging pages is human-adjudicated and scoped to
  already-`approved` pages — a candidate in the pair is reviewed first (approve or
  reject); merging one would bypass the review queue. The governance merge
  command mechanically rewrites backlinks (`[[old-slug]]` → `[[new-slug]]`, display and
  anchor preserved) across `wiki/*`, unions provenance into the
  surviving page, archives the old page, and logs — no dangling wikilinks are left
  behind (archive/ is a frozen record and is not rewritten);
- The retrieval service **indexes only pages with `status: approved`** — "only the currently
  effective version is retrievable" is guaranteed by this contract's structure.

## 5. log.md Governance Log

append-only; every entry starts with a uniform prefix (parseable with Unix tools like grep):

```markdown
## [2026-07-30T14:00:00+08:00] govern | auto:create-source | wiki/sources/jira-PROJ-123.md | from raw/jira/PROJ-123.md
## [2026-07-30T14:00:01+08:00] govern | candidate:contradiction | wiki/syntheses/payment-retries.md | conflicts with sources/jira-PROJ-099.md
## [2026-07-30T14:00:02+08:00] govern | auto:create-synthesis | wiki/syntheses/payment-retries.md | sources:3
## [2026-07-30T15:20:00+08:00] review | approve | wiki/syntheses/payment-retries.md | via session
## [2026-07-30T15:21:00+08:00] review | reject | wiki/archive/old-synthesis.md | via viewer (backfilled)
## [2026-07-30T15:22:00+08:00] govern | auto:archive-rejected | wiki/archive/old-synthesis.md | from wiki/syntheses/old-synthesis.md
## [2026-07-30T15:23:00+08:00] govern | archive | wiki/archive/superseded.md | from wiki/sources/jira-PROJ-099.md
## [2026-07-30T15:24:00+08:00] govern | merge | wiki/entities/faa.md | from wiki/entities/faa-module.md (archived, 2 backlink files)
```

Format: `## [<ISO8601>] <actor> | <action> | <object path> | <note>`,
actor ∈ `govern | review | acquire | portal | llm` (`portal` = human actions through
the UI portal, per §1 whitelist ⑤⑥: `candidate:manual`, `file:edit`; `llm` = automatic
governance action where the model made the final approve/candidate call).

Action vocabulary (non-exhaustive): `auto:create-source`, `auto:update-source`,
`auto:rebuild-index`, `auto:create-entity`, `auto:update-entity`, `auto:create-concept`,
`auto:update-concept`, `auto:create-synthesis`, `auto:update-synthesis`, `candidate:*` (any
candidate-producing governance outcome), `auto:dedup-source` (exact-duplicate raw
tombstoned, target = the surviving page), `auto:dedup-topic` (legacy term for a page's
identical-hash sources converged to one reference), `archive`, `auto:archive-rejected`, `merge`
(govern actor);
`approve`, `reject` (review actor, note `via session | via viewer | via viewer (backfilled)` —
the backfilled form is written by the sweep for flips the viewer made without logging;
`via portal | restored previous approved version` marks a reject-and-restore, whose log line
keeps the page's last-log-action non-`candidate:*` so the sweep cannot mis-record it as an
approval).

## 6. kb.json (KB instance configuration, checked in)

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {
    "jira": {
      "base_url": "https://jira.example.com",
      "pat_env": "JIRA_PAT",
      "jql": ["project = PROJ ORDER BY updated DESC"],
      "zephyr": "auto",
      "test_issue_types": ["Test"]
    },
    "confluence": {
      "base_url": "https://wiki.example.com",
      "pat_env": "CONFLUENCE_PAT",
      "spaces": ["DEV", "REQ"],
      "cql": "type = page AND label = kb"
    },
    "local": { "inbox": "inbox/" }
  },
  "retrieval": {
    "embedding": "off",
    "embedding_endpoint_env": "EMBEDDING_BASE_URL"
  }
}
```

Rules: **secrets go through environment variables only**; kb.json stores at most
environment-variable names (`*_env`). The `KB_PATH` environment variable locates kb-root.
Connector scope keys: jira `jql` (array); confluence `spaces` (array, one CQL scope per
space key) or `cql` (string or array, optional — when set it overrides `spaces`).
Optional jira keys (amendment 2026-08-03, phase 1): `zephyr` (`"auto"` | `true` | `false`,
default `"auto"` — probe ZAPI once per run for Test-type issues and attach Zephyr Squad
test steps; degrade silently when the plugin is absent) and `test_issue_types` (array,
default `["Test"]`).

## 7. Change Discipline

1. Any modification to this file must be synced to `CONTEXT.md`, with ADRs added as the impact
   warrants;
2. The four services' implementations are free in everything internal outside the contract
   (chunking strategy, fusion parameters, prompts, model endpoints, etc. are not part of the
   contract);
3. Contract evolution is **increment-compatible only**: adding optional fields is allowed;
   changing semantics or deleting fields requires a version bump. v1 → v2 (2026-08-05, ADR-0009)
   changed the wiki page-type enum and the write-permission matrix and therefore required a
   version bump; the optional `kind` and `relations` fields on entity pages are increment-compatible
   additions within v2.
