# Governance Detects Duplicate/Version/Factual-Conflict, Forces Candidate Fail-Closed, and Archives the Adjudicated Loser Out of Retrieval

Governance detects three cross-document conflict categories — **exact duplicate** (identical `content_hash`),
**similar version** (title-based pre-filter + CJK-aware body-similarity confirmation), and **factual
conflict with existing topic content** (semantic, judged at topic-application time) — across the **whole
knowledge base** (not just the current batch). Exact duplicates auto-dedup; similar/conflict groups force
`candidate` fail-closed at `apply-topic` so a fused topic can never be silently approved; the adjudicated
loser's source page is **archived and tombstoned**, making the stale or wrong content structurally
unreachable by retrieval — and unrecoverable by the next `plan()` pending scan.

**Context**: `plan()` (`governance/scripts/lib/govern.mjs`) produces six work lists but no duplicate or
similarity detection — neither within the batch nor against existing wiki pages. `applyTopicPage` risk
tiering is `status = (candidate || keepCandidate) ? 'candidate' : 'approved'`: the `candidate` flag is
decided entirely by the caller (the governance LLM), which failed in production (bug 0001 — a topic fused
two version files of one source, approved, no conflict flagged). `CONTEXT.md` already promises "identical
content hash → automatic dedup; high similarity without identity → candidate status for human adjudication";
it was never implemented. Retrieval indexes **every approved page independently**
(`retrieval/scripts/lib/store.mjs` `indexDoc`): source pages are retrievable whether or not any topic
references them, so stale or contradictory source content genuinely reaches the answer surface. The local
connector cannot know that two inbox files are versions of one document (`source_id` = hash of the inbox
path), so this resolution necessarily lives at the governance layer.

**Considered Options**:
- *Acquisition-side detection* (the local connector collapses version files before they land in `raw/`):
  rejected — covers only the local case, cannot adjudicate which version is authoritative, and discards
  provenance. The same governance-side content signal covers same-source (local) and genuinely cross-source
  copies uniformly.
- *Batch-internal detection only*: rejected — forever misses a new document conflicting with an
  already-approved page; the confirmed repro is a same-batch pair, but the scope must cover the whole KB.
- *Advisory-only* (`plan()` reports a duplicates list; the LLM decides `--candidate`): rejected — this is
  the precise judgment step that failed in bug 0001. Correctness must be structural, not agent discipline.
- *Soft resolution* (topic-first retrieval ranking; stale source pages stay indexed): rejected as the sole
  mechanism — weighting deprioritizes but does not remove; a direct query still surfaces the wrong version.
  Kept only as a future option, not v1.
- *Chosen: hard resolution* — `plan()` computes mechanical groups (identical hash; title-based pre-filter +
  CJK-aware body similarity) over the whole KB and reports a `conflicts` list plus a
  `.kb/govern/conflicts.json` side-channel (with `generated_at` and a raw-set fingerprint, so `apply-topic`
  can detect staleness and degrade instead of silently trusting stale data); `apply-topic` forces `candidate`
  (fail-closed) when a topic's sources contain a flagged group, and emits `semantic_check_required` for
  title-overlapping existing topics so the semantic self-check stays a visible output contract rather than a
  memory burden; identical-hash duplicates auto-dedup **without writing** a redundant source page
  (tombstoned instead); the adjudicated loser's source page is archived **and tombstoned**
  (`.kb/govern/source-tombstones.json`), so the next `plan()` does not re-list it as pending and
  `apply-source` refuses to revive it without `--force`; adjudicated "parallel documents" pairs are persisted
  in `.kb/govern/conflict-dismissals.json` so they are not re-flagged every run; rejecting an overwritten
  topic restores the previous approved version from git and logs the rejection synchronously, so the sweep
  backfill cannot mis-record it as an approval. Factual conflict with existing topic content remains a
  **mandatory governance-LLM step** (reference = the existing topic content only) that writes the specific
  conflict points into `review_note`; it cannot be mechanically detected and is carried by the
  `semantic_check_required` contract, the skill, and an optional user-written `GOVERNANCE.md` standing
  instruction.

**Consequences**:
- `plan()` gains `conflicts` and `suppressed` lists; `apply-topic` becomes fail-closed on flagged groups
  (a stale side-channel degrades to an in-topic check with a warning); `apply-source` auto-dedup does not
  write a redundant exact-duplicate source page — it tombstones the raw and logs `govern | auto:dedup-source`.
- Three `.kb/govern/` state files carry adjudication memory: `conflicts.json` (with a raw-set freshness
  fingerprint), `source-tombstones.json` (archived-loser raws are not re-pended), and
  `conflict-dismissals.json` ("parallel documents" pairs are not re-flagged every run).
- The review flow gains **reject-and-restore** (revert an overwritten topic to its last approved version from
  git, logging synchronously so the sweep backfill cannot mis-record the rejection as an approval; non-git KBs
  fall back to plain reject with a warning), **edit-then-approve**, **archive-loser** (archive + tombstone),
  and **keep-both** (persisted dismissal).
- Retrieval code is unchanged in v1 (no topic-first ranking): the loser-archive makes stale/wrong content
  structurally unreachable and — via the tombstone — structurally irrevivable, consistent with this system's
  "double insurance" preference for structural guarantees over agent discipline.
- Accepted side effects (documented, not silently absorbed): archiving a loser does not rewrite backlinks, so
  pointing `[[wikilink]]`s surface as `dangling_links` on the next `plan()`; the retrieval provenance edge
  (topic→source) for that page disappears, which is consistent with "moved out of retrieval".
- `schema/contract.md` and `CONTEXT.md` are revised: `wiki/sources/` 1:1 becomes "1:1 by default, archival /
  dedup as exceptions"; source pages "always approved" gains an archival exception; `.kb/` subdirectory
  ownership is spelled out (retrieval: `index.sqlite`; governance: `govern/`, `bodies/`; portal: `ui/`).
- Accepted trade-offs: adjudicated losers leave the browse/search surface (evidence preserved in `raw/`, git
  history, and the topic's version note); a soft escape hatch stays — when the adjudicator judges two
  documents genuinely parallel (not versions), the archive is declined and the pair is persisted as a
  dismissal. The dissimilar-document factual-conflict case still relies on the governance LLM's mandatory
  self-check (mitigated by `semantic_check_required`); this residual risk is knowingly accepted.
- The three categories become canonical domain terms (exact duplicate / similar version / factual conflict);
  `CONTEXT.md`'s promised-but-unimplemented dedup/candidate behaviour is now implemented and refined.
