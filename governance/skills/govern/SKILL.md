---
name: kb-govern
description: Governance service — governs raw/ original documents into wiki/ curated pages (source summary pages, topic synthesis pages, candidate review, index.md). Use when the user says "govern the knowledge base", "organize the pulled documents into the wiki", "review the candidate queue", or "govern". Use kb-search for retrieval and kb-acquire for acquisition.
---

# kb-govern · Governance

Governs the original documents in `raw/` into curated products in `wiki/`. Governance is a
**human-triggered batch operation** — it never runs automatically right after acquisition.

Contract: `schema/contract.md` (wiki page spec, candidate state machine, log.md format);
conventions: `schema/governance.md` (language, topic, and review conventions).

## Standard flow

Script: `govern.mjs`, located in the `scripts/` directory **two levels up from the directory
containing this SKILL.md** (`<skill-dir>/../../scripts/govern.mjs`). When invoking it in any
session, first assemble the absolute path from this file's actual install location — **do not
assume cwd is some code repository**.

```bash
# 0. SWEEP FIRST — reconcile any thin-viewer flips since the last run:
#    backfills missing review log lines, archives rejected pages. Idempotent.
node <skill-dir>/../../scripts/govern.mjs sweep --kb <kb-root>

# 1. Diff scan: pending source pages, anomalies, orphaned pages, errors, review queue
node <skill-dir>/../../scripts/govern.mjs plan --kb <kb-root>

# 2. For each item in pending:
#    a. Read the corresponding raw file
#    b. Write a summary (spec below) and pass it via stdin to apply-source
cat <summary> | node <skill-dir>/../../scripts/govern.mjs apply-source \
  --kb <kb-root> --raw <raw path of the pending item> --tags tag1,tag2

# 3. Topic synthesis (see the section below): create/update topic pages
cat <synthesis> | node <skill-dir>/../../scripts/govern.mjs apply-topic \
  --kb <kb-root> --slug <slug> --title "Topic Title" \
  --sources raw/local/a.md,raw/jira/b.md [--aliases x,y] [--tags t1,t2] \
  [--candidate --note "what conflicts with what"]

# 4. Review queue: process each candidate with the human (see the review section)
node <skill-dir>/../../scripts/govern.mjs approve --kb <kb-root> --page wiki/topics/<slug>.md
node <skill-dir>/../../scripts/govern.mjs reject  --kb <kb-root> --page wiki/topics/<slug>.md
#    Archive adjudication (approved pages only, e.g. orphans) — human decision first:
node <skill-dir>/../../scripts/govern.mjs archive --kb <kb-root> --page wiki/sources/<name>.md --note "why"
#    Topic merge — human decides which slug survives, the script rewrites backlinks,
#    unions provenance, and archives the loser; then re-apply-topic the survivor's body:
node <skill-dir>/../../scripts/govern.mjs merge-topic --kb <kb-root> --from <old-slug> --to <surviving-slug> [--note "why"]

# 5. After all mutations, rebuild the navigation index
node <skill-dir>/../../scripts/govern.mjs rebuild-index --kb <kb-root>

# 6. One commit per governance run (CONTEXT.md: the KB's git history is the
#    audit/rollback backbone — the viewer's diff view and J7 page history read
#    from it). Skip silently when the KB is not a git repository. Pathspec-
#    scoped so unrelated worktree changes are never swept in:
git -C <kb-root> status --porcelain -- wiki log.md   # empty → nothing to commit
git -C <kb-root> add -- wiki log.md
git -C <kb-root> commit -m "govern: <one-line summary of this run>" -- wiki log.md
```

Step 6 closes every run that changed anything: exactly one commit covering the
run's `wiki/` + `log.md` changes, after `rebuild-index`. The UI portal's
agent-governance runs do this commit automatically server-side.

## Summary writing spec (source page body)

- **Language: written in English** (the KB's primary language is English, see
  `schema/governance.md` §1); proper nouns, system names, error codes, interface names, and
  ticket numbers **keep their original form** — these are retrieval anchors;
- Structure: `## Key Points` (3-7 items, one sentence each) + optional `## Key Details`
  (hard facts from the original: figures, interface names, thresholds, etc.) + optional
  `## Related Topics` (a list of topic words — the primary hook for topic-page aggregation);
- Distill only, never fabricate: every piece of information must be findable in the raw
  original; do not add "common sense";
- tags parameter: 3-5 English domain tags, generalized from the document's subject matter.

## Topic synthesis (step 3)

The intellectual step of governance — Claude authors the synthesis body; the script owns
frontmatter, path, provenance validation, and logging.

- **When**: after the source pages of a run are written. Inputs: the `## Related Topics`
  hooks of the summaries just written/updated + a read of `wiki/index.md` and the existing
  `wiki/topics/` for the global view;
- **Slug = identity**: lowercase kebab-case; re-applying an existing slug is an UPDATE of the
  same topic (sources union-merge, `created_at` is preserved), never a fork. For a genuinely
  distinct topic choose a new slug;
- **Risk tier** (contract §4): creating a new topic or appending non-contradictory
  information → default (approved). Contradiction with existing pages or a merge of approved
  topics → `--candidate` with `--note` stating what conflicts with what (the note lands in
  the page's `review_note` frontmatter, visible to reviewers in the viewer). Overwriting an
  approved page with a candidate drops it from retrieval until reviewed; the previous version
  is recoverable via the KB's Git history (and the viewer's diff view shows exactly what
  changed);
- **Candidate protection is enforced by the script**: re-applying a page that is still
  candidate keeps it candidate even without `--candidate` — approval only ever comes from
  `approve` or the viewer. If apply-topic, merge-topic or archive refuses with "unlogged
  review flip pending; run sweep first", a viewer flip has not been solidified yet:
  run `sweep`, then retry;
- **Body spec**: English; open with a one-paragraph definition; interlink with
  `[[slug|display name]]` wikilinks; every claim must be traceable to a listed `--sources`
  entry;
- `--sources` on update: omitted = keep existing; any newly listed raw path must exist
  (fail-closed provenance). `--aliases`/`--tags`: omitted = keep, explicit `""` = clear.

## Review queue (step 4) — two channels, one state machine

`plan`'s `review_queue` lists all `status: candidate` pages. Process every item with the
human, either:

- **Conversational** (default): show the page and its evidence (the raw documents behind its
  `sources`), the human decides, then run `approve` / `reject` — these write the log line
  immediately. Never flip a status by hand-editing the page;
- **Thin viewer** (nicer for long queues): offer to launch
  `node <skill-dir>/../../viewer/serve.mjs --kb <kb-root>` (localhost, on demand; Ctrl+C to
  stop). The viewer shows the candidate reason (`review_note`), per-source evidence panes,
  and a diff against the Git baseline for candidate pages. It flips only the frontmatter
  `status` and writes no log — the next run's `sweep` backfills it. **Do not run governance
  mutations while the viewer is open** (single-operator discipline).

`reject` sets the transient `rejected` status; the next `sweep` moves the page into
`wiki/archive/` and flips it to `archived`. Archiving an **approved** page (e.g. an orphan
from `orphaned_pages`) requires an explicit human decision in-session; only then run
`archive`.

## Interpreting output and reporting

`plan` returns six lists; **every list must be either processed or reported — none may be
silently skipped**:

- `pending` (reason: new / stale) — normal governance targets; run each through apply-source;
- **`anomalies` (reason: hash-changed-version-unchanged) — a high-risk signal that must be
  escalated to a human**: the content hash changed but the source version number did not,
  meaning the source may have been modified out of band (a plugin writing the DB directly, a
  manual overwrite of an export, etc.). Report it to the user as-is and recommend manual
  verification; after user confirmation, re-running apply-source clears it (the new hash
  becomes authoritative);
- `orphaned_pages` — pages whose provenance points at a vanished raw (source pages via
  `source_ref`, topic pages via any `sources` entry — e.g. after `acquire --prune`).
  Report truthfully and ask the human whether to `archive` them (archiving is a
  human-adjudicated action);
- **`errors` — corrupted or illegal data (missing contract fields, IDs containing illegal
  characters); must be reported to the user item by item**. These documents will not be
  governed; fixing usually requires correcting the source data or the connector (connectors
  should escape/hash-map non-compliant IDs, contract §2);
- `review_queue` — candidate pages awaiting human review; process per the section above;
- `dangling_links` — wikilinks pointing at pages that no longer exist (after hand edits;
  `merge-topic` rewrites backlinks itself, so merges never produce these). Report and fix
  by hand-editing the linking page or restoring the target.

Also report `sweep`'s output at the start: N flips backfilled, M rejected pages archived.

After governance completes, report to the user: N pages created, M pages updated, X anomalies,
Y errors, Z orphaned, Q candidates reviewed.

`apply-source`'s `--tags` semantics: **omitted = keep existing tags; explicit `--tags ""` =
clear; `--tags a,b` = overwrite**. When re-governing a stale page, omitting is usually right.
`apply-source` / `apply-topic` errors (empty body, missing contract fields, illegal ID/slug,
illegal path, nonexistent topic source) must be fixed and retried — do not skip them.

Retrieval needs no explicit action after governance: its lazy incremental index picks up
status flips and page changes automatically on the next kb-search run.

## Behavioral red lines

1. Never modify any file inside `raw/` (read-only);
2. Page frontmatter is always generated by the script; do not hand-write frontmatter
   and then let the script overwrite it;
3. Actually read the raw original for every summary and synthesis; do not guess from
   filenames;
4. The governance log is recorded automatically by the script (log.md); do not append to it
   by hand;
5. Never flip a page's `status` by hand-editing — use `approve`/`reject` (logged immediately)
   or the viewer (backfilled by the next sweep);
6. `archive` is invoked only after an explicit human decision in-session.
