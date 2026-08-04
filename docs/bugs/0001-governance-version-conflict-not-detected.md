# Bug 0001: Governance does not detect version/duplicate conflicts across sources

**Status**: open — design resolved (ADR-0008); awaiting implementation (plan: `docs/plans/0001-governance-conflict-detection.md`)
**Reported**: 2026-08-04 (intranet testing)
**Area**: governance service

## Symptom

When several documents are pulled and governed, content that conflicts with an existing topic
or source — or, concretely, several pulled files that are **versions of the same document** —
is not detected. Governance approved a topic that fused multiple version files directly, with
no conflict flagged.

Reporter's words: a topic ended up containing several version files of one source, because the
acquisition pull landed them as separate files in `raw/`; governance approved the topic
outright instead of surfacing the conflict.

## Repro (confirmed)

Two raw docs that are versions of the same document (same title, near-identical body, distinct
`source_id`), then `plan()` + `applyTopicPage`:

```
plan() lists:
  pending: [raw/local/pay-timeout-v1.md, raw/local/pay-timeout-v2.md]
  anomalies: []                    ← nothing
  review_queue: 0 items            ← nothing
  duplicate/version/conflict signals: 0

applyTopicPage: auto:create-topic status=approved   ← no --candidate needed
```

## Root cause

- `plan()` (`governance/scripts/lib/govern.mjs`) produces six lists (pending / anomalies /
  orphaned_pages / errors / review_queue / dangling_links) but has **no duplicate or
  similarity detection** — not for the new batch, and not against existing wiki pages.
- `applyTopicPage` risk tiering is `status = (candidate || keepCandidate) ? 'candidate' :
  'approved'` — the `candidate` flag is decided entirely by the caller (the governance LLM).
  The script's own comment says "risk tiering is enforced here, not left to the caller", but for
  duplicate/version conflicts nothing is enforced.
- `CONTEXT.md` promises the behaviour: "identical content hash → automatic dedup; high
  similarity without identity → high-risk signal, enters candidate status for human
  adjudication". It was never implemented.

## Design questions (for the follow-up discussion)

1. **Signal set** — deterministic and cheap: identical `content_hash` across different raw
   docs / normalized same title / same `source_url`; optionally body similarity
   (shingle/Jaccard) for "similar but retitled" versions.
2. **Scope** — within the new batch only, or also new-vs-existing wiki pages?
3. **Enforcement** — `plan()` reports a `duplicates` list (LLM decides) vs `applyTopicPage`
   forcing `candidate` fail-closed when a topic's `sources:` contain a flagged group.

## Notes

- Acquisition's dedup only collapses the same doc matched by several scopes; it does not
  compare across distinct documents.
- Existing tests for `applyTopicPage` cover the candidate-protection guards, not
  duplicate/version detection.

## Resolution (design, 2026-08-05)

Design resolved in **ADR-0008** (`docs/adr/0008-governance-conflict-detection-and-loser-archive.md`);
implementation plan in **`docs/plans/0001-governance-conflict-detection.md`**.

Summary of the agreed design:

1. **Three categories** — exact duplicate (`content_hash` identical), similar version (title-based
   pre-filter — same normalized title / title-token overlap / same de-versioned filename — + CJK-aware
   body similarity), factual conflict with existing topic content (semantic). Detection scope is the
   **whole KB** (new/ungoverned docs vs all existing, including approved), not just the current batch.
   Governance layer only (acquisition untouched).
2. **Enforcement** — exact duplicates auto-dedup at `apply-source` **without writing** a redundant source
   page (the raw is tombstoned instead); similar/conflict groups force `candidate` fail-closed at
   `apply-topic` (the LLM can no longer silently approve a fused topic). The semantic conflict check is a
   mandatory governance-LLM step that writes the specific conflict points into `review_note`, backed by a
   `semantic_check_required` output contract.
3. **Adjudication** — the reviewer's loser source page is archived **and tombstoned** (default action, out
   of retrieval, and not re-pended by the next `plan()`; `apply-source` refuses to revive it without
   `--force`). Genuinely parallel documents are persisted as dismissals (`conflict-dismissals.json`) and
   not re-flagged every run. `reject` becomes reject-and-restore: an overwritten topic reverts to its last
   approved version from git, logging synchronously (non-git KBs fall back to plain reject + warning).
4. **Retrieval** — unchanged in v1. The loser-archive + tombstone is the structural defence: retrieval
   indexes all approved source pages independently, and archiving removes stale/wrong content from the
   answer surface — irrevocably by routine governance runs.

The three design questions in the section above are answered by this resolution: signal set = hash +
pre-filter + Jaccard; scope = whole KB; enforcement = both `plan()` reporting a `conflicts` list and
`apply-topic` forcing candidate fail-closed.

**Review round (2026-08-05)**: an external review of ADR-0008 / plan / this doc raised 10 findings; all were
verified against the code and confirmed, then incorporated. Key additions — tombstone suppression so an
archived loser is not re-pended every run (P0-1); title-based pre-filter replacing the ineffective
"same source" one (P0-2); persisted conflict-dismissals (P1-3); side-channel freshness fingerprint
(P1-4); synchronous restore logging (P1-5); CJK-aware body similarity (P1-6); contract/CONTEXT revisions
(P2-8). See `docs/plans/0001-governance-conflict-detection.md` §0 (review response), §5, §6.
