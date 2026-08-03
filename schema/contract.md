# Knowledge Base Contract (Contract v1)

> This file is the **single contract** jointly obeyed by the three services: **acquisition /
> governance / retrieval**. The three services have zero code dependency and zero
> inter-process calls; they communicate only through the directory structure and frontmatter
> spec defined here. Modifying this file = modifying the three-party contract; it requires
> review and a synchronized update of `CONTEXT.md` and the relevant ADRs.
>
> Status: **Frozen (v1, 2026-07-30)** · Companion: `./governance.md` (governance conventions)

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
│   ├── topics/<slug>.md                  # topic synthesis pages, 1:N cross-source fusion
│   ├── archive/                          # archive of merged/superseded pages (kept for traceability)
│   └── index.md                          # whole-KB navigation index, the retrieval entry contract
├── log.md                   # governance log (append-only, checked in)
└── .kb/                     # derived-artifacts directory (not checked in, .gitignore)
    ├── index.sqlite         # retrieval index (dual FTS5 tables + optional vectors), exclusive write by the retrieval service
    ├── search_state.json    # incremental hash state of the index
    ├── candidates/          # query candidate spaces persisted to disk by the retrieval script (temporary)
    ├── acquire_runs.jsonl   # per-source pull records appended by the acquisition service (one JSON line per run; the only record of all-skipped incremental pulls)
    ├── govern_runs.jsonl    # agent-governance run records appended by the UI portal (two lines per run: phase start/finish; a start with no finish reads as interrupted)
    └── ui/                  # UI portal derived artifacts (jobs.db, eval scores, snapshots/), exclusive write by the UI portal
```

### Write Permission Matrix (single-responsibility principle)

| Path | Acquisition | Governance | Retrieval | Thin viewer | UI portal |
|---|---|---|---|---|---|
| `raw/` | **write** | read | forbidden | read | read + **delete/move only** (see rules) |
| `wiki/` | forbidden | **write** | read | only frontmatter `status` (candidate → approved / rejected) | same flip primitive + **human body edits** (demote rule, see ⑤) |
| `log.md` | **append** | **append** | read | forbidden | **append** (manual-edit entries: `candidate:manual`, `file:edit`) |
| `.kb/` | only `acquire_runs.jsonl` append | forbidden | **write** | read | `.kb/ui/` **write** + `govern_runs.jsonl` append, rest read |
| `kb.json` | read | read | read | read | read |

Rules:
- No layer may write to paths exclusively owned by another layer;
- The thin viewer is a "dumb consumer"; its only write operation is flipping the `status`
  field of a wiki page's frontmatter (candidate → approved / rejected); `rejected` is a
  transient outcome — the governance service's sweep moves rejected pages into
  `wiki/archive/` and flips them to `archived` (see §4);
- The **UI portal** (ADR-0006, `ui/`) is an on-demand localhost human console under the
  same red lines as the thin viewer (launch on demand; no user system), with its KB
  writes confined to an explicit whitelist: ① inbox/ uploads (staging area of the local
  connector — never raw/ directly), ② raw/ delete & move (snapshot first, impact preview
  first, executed via its per-KB serial write queue; move = new identity — the old
  document becomes an orphan, as with any rename), ③ frontmatter `status` flips via the
  governance statusflip primitive,
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
- Everything inside `.kb/` can be fully rebuilt from `wiki/` (plus, for
  `acquire_runs.jsonl` and `.kb/ui/`, re-derived from operational use); deleting it does
  not affect correctness.

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
type: source | topic           # page type (required)
status: candidate | approved | rejected | archived  # candidate state machine (required,
                                # see §4; `rejected` is transient — the governance sweep
                                # moves rejected pages into archive/ and flips them to
                                # `archived`; `archived` is used only for pages inside
                                # archive/)
title: "Page title"            # required
created_at / updated_at: ISO8601
---
```

### 3.2 source summary pages (`wiki/sources/`)

**1:1 mechanical mapping** with `raw/` documents; filename = `<source>-<source_id>.md`.
Creation and source-following updates are both low-risk automatic operations.

```yaml
---
type: source
status: approved                # source pages always take effect directly
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

### 3.3 topic pages (`wiki/topics/`)

Cross-source synthesis pages (1:N fusion); the core product of governance. Filename = topic
slug. The slug is the topic's **identity**: lowercase kebab-case,
`/^[a-z0-9][a-z0-9-]*$/` (a path component, whitelisted like `source_id` in §2); re-applying
an existing slug = an update of the same topic, never a fork. Update semantics: `sources` is
**union-merged** (provenance is never silently dropped), `created_at` is preserved,
`updated_at` is bumped; `aliases`/`tags` omitted = keep.

```yaml
---
type: topic
status: candidate | approved
title: "Topic name"
sources:                         # provenance trace-back (required)
  - "raw/jira/PROJ-123.md"
  - "raw/confluence/123456.md"
aliases: [...]                   # aliases, for wikilink resolution
tags: [...]
review_note: "..."               # optional; the reason a page is a candidate (what
                                 # conflicts with what), visible to reviewers; meaningful
                                 # while candidate. Dropped when the page is next WRITTEN
                                 # by apply-topic as approved; approve/viewer flips touch
                                 # only the status line, so the note remains on flipped
                                 # pages as inert residue
---
```

The body interlinks using `[[wikilink]]` (the piped alias form `[[slug|display name]]`
guarantees Obsidian compatibility and rename stability).

### 3.4 `wiki/index.md` (retrieval entry contract)

Must be rebuilt after every governance run. Grouped by type, one line per page:

```markdown
## Topics
- [[topics/payment-timeout]] — Payment timeout retry mechanism and compensation strategy(status:approved, sources:3)

## Sources
- [[sources/jira-PROJ-123]] — PROJ-123 payment gateway requirements(jira, 2026-07-28)
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
  update, creation of new topic pages, appending non-contradictory information to existing
  topic pages;
- **Must be a candidate (candidate)**: contradiction with existing pages, suspected
  cross-source duplicates, merging already-approved topic pages, archiving/deleting
  already-approved pages, multi-version validity trade-offs;
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
- **Merge discipline**: merging topic pages is human-adjudicated and scoped to
  already-`approved` pages — a candidate in the pair is reviewed first (approve or
  reject); merging one would bypass the review queue. The governance merge
  command mechanically rewrites backlinks (`[[old-slug]]` → `[[new-slug]]`, display and
  anchor preserved) across `wiki/sources` + `wiki/topics`, unions provenance into the
  surviving page, archives the old page, and logs — no dangling wikilinks are left
  behind (archive/ is a frozen record and is not rewritten);
- The retrieval service **indexes only pages with `status: approved`** — "only the currently
  effective version is retrievable" is guaranteed by this contract's structure.

## 5. log.md Governance Log

append-only; every entry starts with a uniform prefix (parseable with Unix tools like grep):

```markdown
## [2026-07-30T14:00:00+08:00] govern | auto:create-source | wiki/sources/jira-PROJ-123.md | from raw/jira/PROJ-123.md
## [2026-07-30T14:00:01+08:00] govern | candidate:contradiction | wiki/topics/payment-timeout.md | conflicts with sources/jira-PROJ-099.md
## [2026-07-30T14:00:02+08:00] govern | auto:create-topic | wiki/topics/payment-timeout.md | sources:3
## [2026-07-30T15:20:00+08:00] review | approve | wiki/topics/payment-timeout.md | via session
## [2026-07-30T15:21:00+08:00] review | reject | wiki/topics/old-topic.md | via viewer (backfilled)
## [2026-07-30T15:22:00+08:00] govern | auto:archive-rejected | wiki/archive/old-topic.md | from wiki/topics/old-topic.md
## [2026-07-30T15:23:00+08:00] govern | archive | wiki/archive/superseded.md | from wiki/sources/jira-PROJ-099.md
## [2026-07-30T15:24:00+08:00] govern | merge | wiki/topics/payment-timeout.md | from wiki/topics/payment-retry.md (archived, 2 backlink files)
```

Format: `## [<ISO8601>] <actor> | <action> | <object path> | <note>`,
actor ∈ `govern | review | acquire`.

Action vocabulary (non-exhaustive): `auto:create-source`, `auto:update-source`,
`auto:rebuild-index`, `auto:create-topic`, `auto:update-topic`, `candidate:*` (any
candidate-producing governance outcome), `archive`, `auto:archive-rejected`, `merge`
(govern actor);
`approve`, `reject` (review actor, note `via session | via viewer | via viewer (backfilled)` —
the backfilled form is written by the sweep for flips the viewer made without logging).

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

1. Any modification to this file must be synced to CONTEXT.md, with ADRs added as the impact
   warrants;
2. The three services' implementations are free in everything internal outside the contract
   (chunking strategy, fusion parameters, prompts, etc. are not part of the contract);
3. Contract evolution is **increment-compatible only**: adding optional fields is allowed;
   changing semantics or deleting fields requires a version bump.
