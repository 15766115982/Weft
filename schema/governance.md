# Governance Conventions

> Companion to `contract.md`: the contract defines "structure"; this file defines "conventions
> of governance behavior". The risk-tier table is in CONTEXT.md under "Governance risk tiers
> and triggering". v2 (M4): added §2 topic conventions and §3 review conventions.

## 1. Language Convention (KB primary language = English)

**The knowledge base corpus is over 99% English; everything produced inside wiki/ uses English
as its first language.**

| Artifact | Language rule |
|---|---|
| `raw/` original documents | **Keep the source language**; the acquisition service does not translate (raw is the evidence layer — as-is is impartial) |
| source summary page bodies | **Written in English**; proper nouns, system names, error codes, and interface names **keep their original form** (retrieval anchors) |
| topic pages (slug, title, body) | English (slugs use English kebab-case) |
| tags | English |
| `index.md` one-sentence summaries | English |
| Retrieval queries | Prefer English terms first; if hits are poor, retry with source-language terms (CSQE extracts them from hit snippets) |
| Test fixtures | Predominantly English; source languages (e.g. Chinese) are retained only for regression cases |

**Why**: a unified language lets BM25/stemming retrieval, backlinks, and topic aggregation all
work in the same language space; mixing languages shreds recall (pages about the same concept
in two languages cannot retrieve each other). The original evidence can always be traced back
along `source_ref`, so translation loss does not accumulate.

## 2. Topic Conventions

- **The slug is the topic's identity.** Slugs are English lowercase kebab-case
  (`/^[a-z0-9][a-z0-9-]*$/`, contract §3.3). Re-applying an existing slug is an **update of
  the same topic**, never a fork: `sources` union-merges, `created_at` is preserved. If a
  genuinely distinct topic is intended, choose a new slug — the tooling must never silently
  fuse two topics, and must never silently drop provenance.
- **Topic emergence**: the primary hook is the `## Related Topics` section of source summary
  pages, supplemented by the governance session's global view (`wiki/index.md` + existing
  `wiki/topics/`). One topic page synthesizes 1:N sources; every claim in the body must be
  traceable to a listed `sources` entry.
- **Body conventions**: English; open with a one-paragraph definition; interlink with
  `[[slug|display name]]` wikilinks (contract §3.3); link member source pages where claims
  come from.
- **Risk tiering**: creating a new topic and appending non-contradictory information take
  effect automatically (`status: approved`); contradictions with existing pages and merges of
  approved topics are written as `status: candidate` with a note stating what conflicts with
  what (contract §4). Overwriting an approved page with a candidate drops it from retrieval
  until reviewed — the pre-overwrite version is recoverable via the KB's Git history.

## 3. Review Conventions

- **Two channels, one state machine**: the candidate queue is processed either
  conversationally in a Claude Code session (the `approve`/`reject` commands write the log
  line immediately) or in the thin viewer (which flips only the frontmatter `status`; the
  next governance run's `sweep` backfills the missing `review |` log lines). Never flip a
  status by hand-editing a page — an unlogged flip outside the viewer defeats the audit
  trail the sweep reconstructs.
- **Sweep first**: every governance run starts with `sweep` — it reconciles any viewer flips
  since the last run (backfill) and moves `rejected` pages into `wiki/archive/` (flipping
  them to `archived`). The sweep is idempotent.
- **Archive adjudication**: archiving an `approved` page (e.g. an orphaned page from `plan`'s
  `orphaned_pages`) requires an explicit human decision in-session; the tooling only executes
  it mechanically. Rejecting a `candidate` needs no such escalation — it is the routine
  review outcome.
- **Single operator**: do not run governance mutations while the viewer is open against the
  same KB; flips are optimistic-concurrency checked (a stale flip fails loudly), but the
  discipline keeps the log narrative linear.
- **The tool layer backs the conventions**: re-applying a still-candidate topic page keeps
  it candidate (approval is a review outcome only, never an apply side effect); a page
  whose latest log line is `candidate:*` but whose status has already changed carries an
  unlogged viewer flip, and `apply-topic`, `merge-topic` and `archive` ALL refuse to touch
  it until `sweep` has run — run sweep first and the refusal resolves itself.
- **Merging topics**: the human decides which slug survives; `merge-topic` then
  mechanically rewrites backlinks, unions provenance, and archives the losing page
  (contract §4). Both pages must be `approved` — a candidate in the pair is reviewed
  first. The merged body is written by Claude via `apply-topic` afterwards
  (`--candidate` when the merge involved contradictions). `plan`'s `dangling_links`
  list catches any link breakage from hand edits.
