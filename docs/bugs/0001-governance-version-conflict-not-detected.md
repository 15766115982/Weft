# Bug 0001: Governance does not detect version/duplicate conflicts across sources

**Status**: open — deferred, design discussion required
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
