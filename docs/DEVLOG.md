# Development Log (as of 2026-08-01, M0-M5 complete)

> Restart entry point after context compaction. Architecture decisions: `CONTEXT.md`;
> three-party contract: `schema/contract.md` + `schema/governance.md` (§1 language
> convention: wiki all-English, raw keeps source language); five ADRs in `docs/adr/`.

## Current status: M0-M5 ✅, 103 tests all green (acquisition 15 / governance 52 / retrieval 36)

| Milestone | Deliverables | Tests |
|---|---|---|
| M0 Contract | schema/contract.md (v1 frozen), governance.md, ADR×4, CONTEXT.md | — |
| M1 Acquisition | acquisition/{scripts,skills/acquire}: framework (kb/frontmatter/rawdoc/log) + local connector (inbox→raw/local, incremental skip, reconcile orphaned + --prune) | 3 |
| M2 Governance v1 | governance/{scripts,skills/govern}: plan (four lists: pending/anomalies/orphaned_pages/errors), apply-source (summary via stdin, mechanical frontmatter), rebuild-index | 8 |
| M3 Retrieval | retrieval/{scripts,skills/search}: dual FTS5 tables (fts_latin=porter+unicode61 / fts_cjk=trigram), per-term routing (CJK<3 chars→LIKE fallback), structured query (type/source/tag/after/before, source-system-time preferred), ≤2 snippets per page, candidate space persisted to disk (capped at 20, cleanup excludes current run), wikilink graph expansion (top-10, supports #anchor), read #anchor (includes subsections, approved whitelist gate, path/archive checks share norm() case normalization), lazy incremental (skips table dual-key reconcile), fence recognition ~~~ / 4+ backticks / inline code excluded | 34+1 |
| M4 Governance v2 | topic pages (apply-topic: slug=identity whitelist, sources union-merge, fail-closed provenance, --candidate), candidate state machine (plan review_queue, approve/reject/archive, sweep = log backfill + rejected→archive, idempotent, archive name-collision -N suffix), thin viewer (governance/viewer/: node:http 127.0.0.1 on-demand, no-build HTML/vanilla JS, queue/browse/page views, raw-evidence pane, approve/reject = flipStatus only, byte-preserving CRLF+BOM, 409 optimistic concurrency) | 8→31 |
| M5 Jira connector | acquisition/scripts/connectors/jira.mjs (Node rewrite of the old Python jira.py): Server/DC PAT Bearer auth (env var named by kb.json pat_env, PAT never on disk/log/errors), JQL scopes from kb.json (CLI --jql override, --max cap, --check = myself), startAt/maxResults pagination, ADF→text fallback, issue→normalized markdown (English scaffold, content keeps source language), raw/jira/<KEY>.md via the shared upsertRawDoc framework (incremental skip by content_hash), non-compliant keys skipped with error (contract §2 whitelist) | 4→15 |

Run tests: per service `cd <service>/scripts && node --test test/` (governance also runs
`../viewer/test/`; retrieval requires npm install first — better-sqlite3 already installed).

## M5 delivered (2026-08-01, 103 tests all green: acquisition 15 / governance 52 / retrieval 36)

No contract amendment needed — §1 (raw/jira/<issue-key>.md), §2 (identity quintuple,
character whitelist) and §6 (kb.json connectors.jira: base_url / pat_env / jql) already
defined the shape; the connector just implements it.

Key design decisions:

- **Zero new dependencies**: Node 20 global fetch + AbortSignal.timeout(30s), redirect:
  follow; the mock-server tests exercise the real HTTP path (auth header, pagination,
  401 mapping) with zero network
- **Secrets discipline**: resolveConfig reads `process.env[pat_env]` only; auth errors say
  "check the PAT in env var <NAME>" and a test asserts the PAT value never appears in the
  error message
- **extra metadata is scalar-only** (frontmatter.mjs supports one level of nested scalars):
  labels/components/fix_versions are comma-joined, matching the old Python behavior
- **Jira "+0800" offsets normalized to strict ISO 8601** (unparseable values pass through
  unchanged, kept visible rather than invented)
- **JQL dedupe by issue key** across multiple scopes; per-issue failures (bad key, write
  error) land in `errors` without aborting the batch
- **No orphan reconcile for jira** (unlike local): a JQL is a query scope, not an
  inventory — an issue leaving the scope is not "gone". Recorded as by-design
- CLI e2e test spawns the real CLI against a mock server (async spawn — a sync spawn would
  starve the mock server's event loop)

## M4 third review-fix round (2026-07-31, 92 tests all green: acquisition 4 / governance 52 / retrieval 36)

Third external review: 1 low-medium + 2 low, all confirmed (no misjudgments), all fixed.

- **N1 guards sat on the strict parser (low-medium)**: applyTopicPage read old.status via
  parseFrontmatter (requires ": "), so a hand-mangled `status:candidate` (no space) made
  BOTH guards fall at once — a re-apply approved the page with no review. merge/archive
  already used the tolerant readStatus. Fix: applyTopicPage now reads status via
  readStatus too (one status-reading convention per service); the re-apply keeps the page
  candidate and the rewrite heals the mangled format. Regression pinned
- **N2 docs under-reported the guard scope (low)**: governance.md §3 and SKILL.md named
  only apply-topic; both now name apply-topic/merge-topic/archive (contract §4 was already
  correct)
- **N3 "both sides agree on what counts as a link" was aspirational (low)**: retrieval's
  extractWikilinks still scanned raw text, so [[links]] inside code samples became graph
  edges (via:link noise). Fixed at the source rather than softening the wording:
  extractWikilinks now strips fenced blocks and inline code first (same rules as the
  chunker and the governance stripCode — duplicated by hand across the service boundary);
  graph-expansion regression pinned

Lesson carried forward: when a guard or convention is introduced, audit every consumer of
the same input for reading-convention drift (strict parser vs tolerant reader; raw text vs
code-stripped text) — rounds N1 and N3 were both this class.

## M4 second review-fix round (2026-07-31, 90 tests all green: acquisition 4 / governance 51 / retrieval 35)

Second external review: 2 medium + 4 low, all confirmed (no misjudgments), all fixed.
The round-one M2 fix had guarded only apply-topic; this round closes the guard around
EVERY page-mutating command, so contract §4's "the audit narrative cannot be silently
truncated" now holds literally.

- **M1' backfill truncation via merge/archive (medium)**: three reproduced variants
  (unlogged viewer flip on the merge target / merge source / archive victim). Fix:
  `assertNoUnloggedFlip` is now a shared precondition of apply-topic, merge-topic AND
  archive — all three refuse with "unlogged review flip pending on this page; run sweep
  first". Contract §4 wording updated to name all three commands (the strong promise
  stays; no softening needed)
- **M2' merge had no status guard (low-medium)**: a candidate page could be merged
  (and thereby archived) straight past the review queue, review_note silently
  discarded. Fix: merge requires BOTH pages approved — "merge involves a non-approved
  page (status: …); review candidates first (approve or reject)". Contract §4 merge
  bullet scoped to approved pages
- **L1' review_note residue after approve (low)**: flips touch only the status line,
  so the note stays. Accepted by design; contract §3.3 wording made honest, and the
  viewer's metadata panel hides review_note unless the page is candidate
- **L2' dangling_links false positives in code fences (low)**: the scan now strips
  fenced blocks and inline code first (same fence rules as retrieval's chunker,
  including the ```code```-inline-line rule) — both sides agree on what counts as a link
- **L3' typo'd status invisible (low)**: plan validates the status enum; anything
  outside candidate|approved|rejected|archived lands in errors
- **L4' merge missed the [[from.md]] form (low)**: linkRe accepts an optional .md
  (form preserved in the rewrite), matching how retrieval and plan resolve links
- **L5' diff happy path untested (low)**: new viewer test with a real git-init'd KB —
  baseline from HEAD, changed=true (skips gracefully when git is unavailable)

## M4 review-fix round (2026-07-31, 82 tests all green: acquisition 4 / governance 43 / retrieval 35)

External review of M4: 5 medium + 7 low findings, all confirmed (no misjudgments), all fixed
or recorded. The review's central insight: **risk tiering was enforced only by caller
discipline (remembering --candidate / sweep-first), not by the tool layer** — now it is
enforced by both.

- **M1 re-apply silently approved a candidate (medium)**: applyTopicPage ignored the old
  page's status; re-applying a candidate page without --candidate flipped it to approved,
  bypassing review and truncating the audit narrative. Fix: a still-candidate page STAYS
  candidate on re-apply (logged `candidate:topic` + "kept candidate (pending review)") —
  approval is a review outcome only, never an apply side effect. Pinned by regression test
- **M2 sweep backfill hole (medium)**: viewer flip → governance write before sweep → the
  review record never entered log.md. Fix at the tool layer: apply-topic REFUSES to
  overwrite a page whose last log line is `candidate:*` but whose status has already
  changed ("unlogged review flip pending on this page; run sweep first"); contract §4
  amended to state the rule. The only write path that could truncate backfill is closed
- **M3 viewer gaps (medium, requirement shortfall)**: no conflict diffs, candidate reason
  invisible, topic sources evidence not clickable. Fixes: `--note` now also lands in a
  `review_note` frontmatter field (contract §3.3 amendment; shown prominently in the
  viewer, dropped when written approved); topic pages get one clickable evidence pane per
  `sources` entry; new `GET /api/diff` (read-only `git show HEAD:<page>`, graceful null
  baseline when the KB has no git history) + a client-side LCS line-diff view
- **M4 merge mechanism missing (medium, requirement shortfall)**: CONTEXT.md promised
  "merging rewrites backlinks and archives the old page". Delivered `merge-topic`:
  backlink rewrite across wiki/sources+topics (bare and topics/-prefixed forms, display
  and #anchor preserved), provenance union into the survivor, archive of the loser,
  merge log line. Plus `plan` gains a `dangling_links` list (nobody reported dead
  wikilinks — retrieval silently skips them)
- **M5 topic provenance not re-checked (medium)**: plan's orphan scan covered only source
  pages' source_ref; a raw deleted later (acquire --prune) left topic sources dangling
  silently. Fix: orphaned_pages now also scans every topic page's sources array
- **L1 boolean flag trap**: `--candidate yes` / `--prune yes` silently read as false
  (would have produced an approved page / skipped a destructive prune). Both CLIs now
  accept only bare / `true` / `false` and fail loudly otherwise
- **L2** moveToArchive comment overpromised the crash window → reworded (retrieval's
  double insurance covers it in practice). **L3** viewer oversize POST hung the client →
  413 response. **L4** statusflip/parser divergence on `status:candidate` (no space) →
  plan now surfaces wiki pages with an unreadable status in `errors` instead of letting
  them vanish from every queue. **L5** non-atomic writes (no tmp+rename) → recorded,
  accepted: KB Git is the mitigation layer. **L6** ADR-0002 drift → new
  `docs/adr/0005-rejected-transient-status-and-sweep.md`. **L7** coverage gaps → all
  M1/M2/M5 scenarios pinned by regression tests; the manual end-to-end smoke is now an
  automated CLI-level test (`e2e.test.mjs`: plan → apply-source → apply-topic
  --candidate → real viewer server reject over HTTP → sweep → rebuild-index, log
  narrative asserted line by line); acquisition gained a CLI bool-flag test

## M4 delivered (2026-07-31, 69 tests all green: acquisition 3 / governance 31 / retrieval 35)

Contract amendments (increment-compatible, contract.md/governance.md/CONTEXT.md synced):

- §3.1 status enum += `rejected` (transient; the sweep moves rejected pages into
  wiki/archive/ and flips them to `archived`); §1 write matrix: viewer flips
  candidate → approved / rejected
- §3.3 topic slug rule `/^[a-z0-9][a-z0-9-]*$/` (slug = identity; re-apply = update, never
  fork), update semantics: sources union-merge / created_at preserved / aliases+tags
  omitted = keep
- §4 state machine redrawn: candidate → rejected → sweep → archived; approved → archived is
  human-adjudicated (archive command); viewer flips are unlogged by design — the sweep
  backfills `review |` lines statelessly (last candidate:* line without a later review line),
  granularity per-sweep (double-flip between sweeps records only the final state)
- §5 log vocabulary: auto:create-topic / auto:update-topic / candidate:topic /
  review approve|reject via session|viewer|viewer (backfilled) / archive /
  auto:archive-rejected
- governance.md: new §2 topic conventions, §3 review conventions (two channels, sweep-first,
  single-operator discipline)

Key design decisions:

- **statusflip.mjs** is the viewer's ONLY write primitive: string surgery on the frontmatter
  block (never parse-reserialize) — CRLF/BOM/comments survive byte-for-byte (pinned by an
  exact-string test); the expected-from check makes a concurrent flip lose loudly (HTTP 409)
- **normalizeWikiRel** gates every wiki write path: wiki/(sources|topics)/<name>.md only —
  index.md and archive/ are unwritable by construction
- Candidate overwrite of an approved topic drops it from retrieval until reviewed; the
  pre-overwrite version is recoverable via KB Git (documented in SKILL.md)
- Viewer imports statusflip/frontmatter from governance/scripts/lib (intra-service sharing;
  the ×3 duplication rule is inter-service only)
- Retrieval untouched; a `status: rejected` regression test pins that the new enum value is
  neither indexed nor readable
- End-to-end smoke verified on a scratch KB: acquire-fixture → govern → topic → viewer
  reject (unlogged) → sweep (backfilled + archived) → rebuild-index → kb_search visibility

## Post-translation review fixes (2026-07-31, 45 tests all green)

First review round on the English-switched codebase; 4 findings, all confirmed
(1 medium severity was a translation slip):

- **CONTEXT.md thin viewer "Python script" (medium, translation slip)**: red line #1 said
  "a Python script starts localhost", contradicting the same file's tech-stack line and
  ADR-0004 ("a Node script"). The Chinese original never said Python — the translator
  introduced it. Fixed to Node. A contractual M4 description; implementing from the wrong
  one would have been rework
- **govern/acquire SKILL.md script paths (medium)**: round 3's "resolve from the skill
  install dir, never assume cwd" fix had covered only retrieval; the other two skills still
  used repo-root-relative paths, which break under plugin distribution. Unified all three to
  the `<skill-dir>/../../scripts/...` wording
- **Stale test name (low)**: `date filters: after:/before: compare updated_at` still named
  the pre-round-4 semantics; renamed to "compare the effective date (updated_at fallback)".
  Same class of issue as round 5's outdated query.mjs comment — comments/names are docs too
- **contract.md §3.4 index.md examples (low)**: examples had a space before the metadata
  parenthesis; implementation (govern.mjs rebuildIndex) and its pinned test emit no space.
  Fixed the contract examples (both Topics and Sources lines) to match the implementation,
  not vice versa — the test pins the no-space form

## Language switch: entire project now English-only (2026-07-31, 45 tests all green)

Pre-M4 housekeeping: all code comments, error messages, tests, contract, ADRs,
CONTEXT.md, SKILL.md files, package.json descriptions, and this log switched
from Chinese to pure English. Zero behavior change (verified: 3/8/34 all green
after the switch). Intentionally left as-is:

- CJK regression fixture data in tests (trigram/LIKE routing, slugify) — required
  by governance.md §1; the CJK range regex in query.mjs is functional, not prose
- `guide/` pre-M0 research notes (kept in Chinese by user decision)
- `tensorowl.html` reference article, `node_modules/`

Hazard discovered during the switch: emitting the 6-char `\uXXXX` escape text in
tool parameters gets decoded into the literal character before hitting disk —
the frontmatter BOM escape had to be rebuilt via `String.fromCharCode(92)` and
verified at codepoint level. Recorded in long-term memory.

## M3 sixth review-fix round (2026-07-31, 45 tests all green: acquisition 3 / governance 8 / retrieval 34)

1 high + 1 low, both confirmed (reproduced live: reading archived content out of `wiki/ARCHIVE/old.md`):

- **Archive gate Windows case-sensitivity bypass (high, residual from round three)**: readpage's
  wikiRoot prefix check had norm() lowercase normalization, but the archive check's normRel did
  not — path.relative is pure string arithmetic and preserves input casing. On Windows,
  `wiki/ARCHIVE/` and `wiki/Archive/` variants bypassed the archive block; stacked with the H1
  scenario (archiving without flipping status) this yielded a direct successful read — the three
  prior lines of defense (search skipping the directory / whitelist / BOM fail-closed) happened
  to all miss this path.
  Fix: normRel now goes through the same norm() normalization (one line); regression test made
  platform-conditional (win32 asserts archive blocked; case-sensitive FS asserts path not found)
- **wiki/INDEX.md whitelist false rejection (low, fail-closed)**: self-healed as a side effect
  of the same one-line fix

Lesson: two case-sensitive points within the same function must share the same normalized
product — never normalize one and use the other raw.

## M3 fifth review-fix round (2026-07-31, 43 tests all green: acquisition 3 / governance 8 / retrieval 32)

3 low findings, all confirmed: (1) skips orphan rows — toRemove changed to docs ∪ skips
dual-key reconcile (deleting a candidate page now also cleans up its skips row); (2) query.mjs
parseQuery comment was stale (still said "by updated_at"; now states the actual src_updated-
preferred semantics); (3) inline code ```code``` alone on a line was misjudged as an opening
fence — after an opening fence, the same character appearing again on the same line means it is
not a fence (CommonMark: a backtick fence's info string must not contain backticks).

## M3 fourth review-fix round (2026-07-31, 41 tests all green: acquisition 3 / governance 8 / retrieval 30)

Review report hit 2 medium + 7 low, all confirmed and fixed:

- **Medium-1 read fail-open**: a frontmatter parse failure (BOM / malformed `status:candidate`
  with no space) presented as "no status" and was let through by read — asymmetric with the
  search side's fail-closed behavior.
  Fix: readpage switched to a **whitelist** (only wiki/index.md is exempt from the status
  check; every other page must be explicitly approved); all three parseFrontmatter copies now
  tolerate BOM in sync (matching the BOM via an explicit escape sequence rather than a literal
  BOM character, to guard against editors silently stripping it)
- **Medium-2 date filter semantics**: after:/before: used to filter on governance time
  (updated_at = apply moment), so an old document "pulled in June, governed in July" was
  treated as new. Fix: docs table gains a `src_updated` column (taken from source_version when
  it is an ISO date; user_version=3 rebuild); effective date = source-system time preferred,
  falling back to governance time; SKILL.md/CONTEXT.md updated to state the semantics
- **Low**: candidates cleanup excludes the current run's file (same-millisecond mtime ties no
  longer falsely deleted); readSection includes subsections (truncated at same-or-higher-level
  headings, documented in SKILL.md); --within tolerates trailing slash; .MD uppercase extension
  (two places: read + walk); new skips table (candidate pages record hash — no more blind
  re-parsing on every ensureFresh; status flip = content change = hash change, so re-parse
  happens automatically); fence recognition for ~~~ and 4+ backticks (closing fence must use
  the same character and length ≥ opening fence); wikilinks strip #anchor for graph expansion;
  knownPaths sorted to guarantee deterministic resolution of same-name basenames

## M3 third review-fix round (2026-07-31, 20 tests all green)

Review report hit 2 high + 2 medium, all fixed with pinned regressions:

- **H1 archive leak**: ensureFresh skips `wiki/archive/` (already-indexed entries are purged
  automatically); contract §4 amended with "archiving must also flip `status: archived`" (new
  enum value, increment-compatible), §3.1/CONTEXT.md synced — retrieval-side directory skip +
  governance-side status flip as double insurance
- **H2 read backdoor**: read command extracted into `lib/readpage.mjs`; candidate/archived
  pages refused (status-less index.md allowed); SKILL.md notes read and search share the
  same gate
- **M3 path-prefix bypass**: `startsWith(wikiRoot + path.sep)` closure + path.resolve
  normalization + win32 lowercase comparison — `wiki-evil/` cannot bypass
- **M4 date filter landed**: docs table gains an `updated` column (user_version=2 whole-DB
  migration — the index is a derived artifact anyway); `after:`/`before:` compare updated_at
  in ISO lexicographic order
- Low: --within backslash normalization; --limit non-positive integer errors out; .kb/candidates
  capped at the 20 most recent with auto-cleanup; SKILL.md script path changed to resolve
  relative to the skill install directory (under plugin distribution cwd is not the repo root),
  with a note that score is heuristic-only and source: only matches source pages
- **Deferred on record**: ensureFresh re-hashes everything each run (large KBs will need
  search_state.json, already reserved in contract §1); snippets not centered on stem matches
  (degrades to the first 200 characters, cosmetic only); the vector leg (OpenAI endpoint /
  GGUF + RRF k=60) **deferred until an intranet embedding endpoint exists** — kb.json
  `retrieval.embedding` config is already defined in contract §6, not an omission

## Two earlier review-fix rounds (regressions pinned)

- frontmatter: empty arrays/objects skipped (prevents bare-key malformation), CRLF tolerated;
  three services each hold one copy (deliberate duplication, synced by hand)
- apply-source: --raw normalized (forward slashes + ^raw/ + per-segment rejection of ..),
  tags omitted = keep, writes content_hash
- plan: bad raw goes to errors; anomaly = hash changed + version unchanged (high-risk signal)
- sourcePageRelPath: source/source_id whitelist /^[A-Za-z0-9][A-Za-z0-9_-]*$/ (contract §2 in
  plain text)
- rebuildIndex: titles flattened to prevent injection
- contract §3.2 amended with content_hash (increment-compatible); log.md permissions: acquire
  may also append

## Key patterns (carried forward)

- Human-machine division: Claude does only the intellectual step (writing summaries); scripts
  do all bookkeeping (frontmatter/persisting/indexing/logging)
- Retrieval division: scripts own recall + bounding (candidate space); Claude owns precision
  (CSQE iteration, HyDE forbidden)
- Zero code dependency between services; communication only via the KB directory; retrieval
  indexes only approved pages and never touches raw/

## TODO

- **M6 (next step)**: Confluence connector (PAT, storage XHTML→markdown)
- Repo still has no .gitignore (must include node_modules) and no git init
