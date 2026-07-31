# The `rejected` Transient Status and the Sweep: How the Viewer Stays Dumb Without Losing the Audit Trail

ADR-0002 established the candidate state machine (candidate/approved). M4 completes it:
`rejected` is a **transient** status written only by review outcomes; the governance
**sweep** reconciles viewer flips (log backfill) and moves rejected pages into
`wiki/archive/` as `archived`. Risk tiering is enforced at the tool layer, not left to
caller discipline: re-applying a candidate topic page never approves it as a side effect,
and `apply-topic` refuses to overwrite a page carrying an unlogged viewer flip until the
sweep solidifies it.

**Context**: ADR-0004's red line 3 confines the viewer to a single write — flipping
frontmatter `status` — so the viewer cannot write log.md. Without a reconciliation
mechanism, review outcomes would either force the viewer to grow logging (platform
relapse) or leave the audit narrative incomplete. The M4 post-implementation review also
showed two failure modes of a purely convention-based approach ("remember to pass
--candidate", "remember to sweep first"): a re-applied candidate was silently approved,
and a governance write between viewer flip and sweep truncated the backfill record.

**Considered Options**: viewer writes log.md (violates red line 3); file-locking /
transactional review queue (resident-state complexity for a single-operator tool);
sweep + tool-layer guards (chosen).

**Consequences**: the viewer stays dumb; log.md remains append-only and complete (every
review outcome appears exactly once — immediately for session reviews, backfilled for
viewer reviews); backfill granularity is per-sweep (a page flipped twice between sweeps
records only its final state — accepted, finer granularity would require the viewer to
log); merging topic pages is mechanical (backlink rewrite + provenance union + archive),
with the merged body remaining Claude's intellectual work via apply-topic.
