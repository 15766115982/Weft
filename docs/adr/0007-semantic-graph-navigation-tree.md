# ADR-0007: Portal Knowledge Views — Semantic Graph Plus Navigation Tree, With Frontmatter-Derived Edges

**Status**: accepted (2026-08-04 — final review approved rev 3; prior rounds: rev 1 and rev 2
both ruled *revise-then-approve*, rev 2 left 3 mandatory + 5 clarification text-level items all
adopted in rev 3 with no mechanism change; implementation per §Implementation shape)

ADR-0006 gave the portal a relationship graph (A7). With the first real intranet KB (20+
imported articles), that graph degenerates into a hub-and-spoke star: `wiki/index.md` is the
navigation contract (rebuilt every governance run, one line per page), so it links to every
topic and every source; meanwhile the relationships the KB actually contains — which topics
cover which sources — never appear as edges at all. The graph shows navigation structure, not
knowledge structure, and index.md's degree grows unboundedly as the KB grows.

**Context**: graph edges come from body wikilinks only (`ui/lib/graph.mjs`, reading the
retrieval index's `docs.outlinks`). Topic pages reference their sources solely in `sources:`
frontmatter, as `raw/` paths; source pages' `## Related Topics` is plain-text topic words — the
governance aggregation hook (`governance/skills/govern/SKILL.md`), which can dangle (real KB
shows `order-lifecycle`). So the topic↔source relationship exists in authoritative frontmatter
but no consumer reads it. The fix must not touch governed wiki content.

A review of rev 1 (2026-08-04, three independent dimensions, evidence cross-checked; archived
verbatim at `docs/adr/0007-review.md`) confirmed the direction and the fact base, but rejected
the rev-1 mechanism — *bidirectional materialized into `outlinks` at `indexDoc`* — on
structural grounds: it collides with the per-file incremental index model, and it contradicts
how every comparable tool handles derived relations. That revision (rev 2) keeps the four user
rulings and replaces the mechanism per §Review. A second-round adversarial re-review of rev 2
(2026-08-04, archived verbatim at `docs/adr/0007-review-2.md`) verified every technical claim
against code, found no P0, and left 3 mandatory + 5 clarification items — all text-level, no
mechanism change. Rev 3 is that revision (see §Review rev 3).

**Decision** (user-ruled 2026-08-04; mechanism rulings rev 2):

1. **Dual view.** The portal's graph page becomes two tabs: a **navigation tree** ("find
   things") and a **semantic graph** ("understand relationships"). index.md stays the
   governance navigation contract; the navigation tree is a derived UI over the same node set.
   The semantic graph excludes index.md entirely.
2. **Navigation tree.** Data-driven grouped tree: Topics + Sources groups; per-node status
   badge; topic coverage count; search-to-locate; click-to-open. Node-scan driven — it does
   NOT parse index.md (index.md's one-line summaries are a possible later tooltip enhancement,
   not the tree's data spine; the directory tree is the type system).
3. **Semantic edges = frontmatter provenance ∪ body wikilinks**, derived in the graph data
   layer, zero wiki-content change. `topic → source` is derived from `sources:` frontmatter
   joined to source pages via `source_ref`; `source → topic` is the inverse. `## Related
   Topics` plain text does NOT participate.
4. **Derivation scope: graph + backlinks + retrieval expansion.** This changes retrieval
   behavior, so `tests/eval/retrieval-eval.test.mjs` must pass before acceptance.
5. **Forward-only materialization into a separate `provlinks` column.** `docs.outlinks` stays
   pure authored (its two `JSON.parse` string-array consumers, `query.mjs` and `graph.mjs`,
   are byte-compatible, untouched). `provlinks` (JSON string array) holds only `topic →
   source` edges; reverse edges are NEVER stored. SCHEMA_VERSION 5→6 (full rebuild — the docs
   table is a rebuildable derived artifact, so the change is safe; a bump is mandatory or
   incremental reconcile would leave old pages on the old edge model indefinitely).
6. **Reverse edges computed at read time.** `backlinks()` already scans `e.to === page` over
   the edge list; the graph view draws undirected edges from `provlinks` ∪ `outlinks` (each
   topic—source relation drawn once, never twice); query expansion builds the reverse map in
   memory — all docs are already loaded at search time (`query.mjs:54`). "Bidirectional
   default-on" is kept as a *behavior* (a source hit may pull in its covering topics), not as
   stored edges.
7. **Injection: a post-reconcile derived pass, not `indexDoc`.** `provlinks` is recomputed
   after the reconcile transaction, whenever the reconcile changed anything
   (`toIndex.length || toRemove.length` — a pure deletion leaves `toIndex` empty but must still
   refresh ambiguity resolution, e.g. two same-basename sources where one is removed), never on
   the read path, so the fixed per-request O(N) disk-scan regression (review 2026-08-04) is not
   revived. The pass reads topic `sources:` from a **copied `sources` column** (pure SQL,
   following the existing "index copies frontmatter fields" pattern) — the "read topic
   frontmatter directly" alternative is cancelled: on deletion-heavy reconciles it would buy
   back O(topics) disk reads on the `ensureFresh` read hot path (review rev 2 R3.1). Join
   caliber: exact `source_ref === sources[]` entry primary; fallback pinned as
   `entry.endsWith('/' + basename(source_ref))` — direction: the topic's `sources[]` entry
   endsWith the source page's `source_ref` basename, and the `'/'` anchor follows
   `resolveLinks`'s `endsWith('/' + norm)` (`store.mjs:71`), deliberately stricter than
   `browse.mjs` `rawRefs`' loose caliber so `…/aaaa1111-pay.md` cannot mis-match a `pay.md`
   `source_ref` and flip a legitimate unique match into dropped-ambiguous (review rev 2 R3.2).
   Unmatched or ambiguous entries → edge dropped and **reported on the retrieval side**
   (reindex pass output / `health()`), never silently — and never via governance's `plan()`:
   governance has zero import of retrieval (CONTEXT.md invariant) and `plan()` already reports
   un-matchable `sources[]` as `orphaned_pages`, so the genuinely new signal is basename
   ambiguity alone; if the count lands in `health()`, its hardcoded six-list enumeration and
   the three-list `stale` derivation must be extended together (review rev 2 R3.3).
   `provlinks` targets are **approved source pages only** (the join map is built from `docs`,
   which indexes approved only); a source page demoted approved→candidate by portal manual
   edit keeps its authored in-edges but loses provenance in-edges — accepted asymmetry (review
   rev 2 §4.2). When a topic's body wikilinks its own `sources:` entry, authored and derived
   edges coincide and **authored wins** the dedup (solid, matches the visual convention;
   review rev 2 §4.1). Candidate topic pages (unindexed) get the same forward derivation in
   the graph layer's UI-side scan, sharing one function — so candidate-T→S forward edges exist
   and read-time reverse makes S→T symmetric.
8. **View-layer boundary.** `buildGraph`'s contract is unchanged: index.md remains a node, its
   hub edges remain (backlinks depends on them), `outlinks` is pure authored. index.md
   exclusion and the authored/derived kind-marking are view-layer concerns
   (`views/graph.js`, backlinks panel).

**Considered Options**:

1. **Content-level wikilinks** — governance writes `## Sources` wikilink sections in topic
   pages and converts source-page `Related Topics` to wikilinks. Rejected: a schema contract
   amendment, requires re-governing existing pages, and changes the aggregation-hook semantics
   of the plain-text Related Topics list.
2. **Collapsible index hub** — keep index in the graph with faded/collapsible navigation
   edges. Rejected: dual view separates navigation cleanly instead of leaving a permanent hub
   in the relationship view.
3. **Graph-only scope** — derived edges not extended to backlinks or retrieval. Rejected by
   user ruling: the topic↔source relationship should surface in the page backlinks panel and
   in retrieval's multi-hop expansion.
4. **Bidirectional materialization into `outlinks` at `indexDoc`** (rev 1; rejected rev 2).
   Cross-row writes collide with the per-file incremental index model (`ensureFresh`
   reconciles by each file's own hash): reverse edges on source rows go stale when a topic
   changes (its `sources:` edited, approved, rejected, archived, or merged — the reverse edge
   only clears when the source file itself is next reindexed), and a stale edge to a candidate
   topic would render a provenance claim that no longer exists in the graph and backlinks. The
   join map is incomplete inside `indexDoc` during bulk first index (path-sorted walk, sources
   before topics). It forces a format change on two string-array consumers. And no comparable
   tool materializes derived/implicit relations into the author-link store: Obsidian computes
   unlinked mentions on demand in a separate collapsible block; Dendron merges derived edges at
   read time with per-kind toggles; Foam builds the graph in memory at view time; Breadcrumbs
   derives reverse relations rather than storing them.

**Consequences**:

- **Schema**: `docs` += `provlinks` + a copied `sources` column; SCHEMA_VERSION 5→6 forces one
  full rebuild; the index is single-caliber afterwards. The copied `sources` column is the
  official mechanism (Decision 7) — not an open mechanics choice.
- **Edges**: authored and derived are byte-separated by column, so kind comes from storage
  location with zero format migration.
- **Retrieval expansion**: derived neighbors tagged `via:'provenance'` (distinct from authored
  `via:'link'`), so the LLM agent and portal chips can weigh them; per-page fan-out cap added
  as a tuning knob alongside bidirectional default-on (a 50-source topic hit appending 50
  candidates, ×10 hubs, is real unbounded growth today's guardrails do not stop);
  candidate-space dilution becomes an explicit retrieval-eval observation metric — the 0.85
  Hit@5 gate is structurally unaffected (preview-based) but would otherwise pass
  "unintelligibly".
- **Portal search UX** (`ui/lib/search.mjs` in-process search): derived neighbors now surface
  in portal results with `via:'provenance'`.
- **Backlinks panel**: "who references me" = authored references ∪ derived coverage; the panel
  shows two groups (references / coverage sources). A source page's coverage group answers
  "which topics are built on this" — the relationship this ADR exists to surface. `/api/backlinks`
  gains an additive `kind` field (references | coverage) — the `{path, title}` shape and its
  stability comment (`graph.mjs:72-73`) are preserved (review rev 2 §4.3).
- **Visual convention**: authored edges solid, derived edges dashed (explicit > implicit;
  rev 1 proposed the inverse).
- index.md and all governed wiki content are unchanged.
- **Tests**: new fixtures with `sources:` frontmatter; derived-edge, read-time-reverse,
  `via:'provenance'`, fan-out-cap, and view-layer index-filter coverage. The existing
  `graph.test.mjs` `edges.length === 3` assertion only holds because its fixtures lack
  `sources:` — explicitly addressed, not relied on.
- **CONTEXT.md**: the rev-1 pointer lines are reverted until this ADR is accepted, then
  **revised, not restored verbatim** — the rev-1 original sentences describe the rejected
  bidirectional-into-outlinks mechanism and must not be resurrected; the "outbound-link
  neighbors … via:link" line (`CONTEXT.md:165-166`) becomes stale in the reverse direction once
  `provlinks` lands and is revised with it; a one-line note states the in-process derived pass
  does not conflict with "no offline graph-building pipeline" (`CONTEXT.md:175-177`) — it is an
  index-time reconcile, not an offline build stage (review rev 2 R4.4, first-round 3.8).

**Review items (open)**:

- Per-page fan-out cap: value (tuning knob; default ≈ ≤20), **scope** — per direction
  (authored out-links / derived / reverse topic-pull) vs union per expanded page; reverse
  fan-out (one source covered by 30 topics) is the new growth vector (review rev 2 R4.5) — and
  whether bidirectional behavior stays default-on.

**Implementation shape (for the review gate — not yet built)**:

1. Schema 5→6; `docs` += `provlinks` + `sources` copy column.
2. Shared derivation helper (build `source_ref` → wiki-path map; forward topic→source; exact +
   `entry.endsWith('/' + basename)` anchored join; unmatched/ambiguity counting) in
   `retrieval/scripts/lib/store.mjs` (or sibling), UI imports it — the `resolveLinks`
   precedent. Not in `frontmatter.mjs` (an intentional three-party handwritten sync copy).
3. Post-reconcile `provlinks` pass (runs when `toIndex.length || toRemove.length`; reads the
   copied `sources` column; reports dropped-edge counts retrieval-side).
4. `ui/lib/graph.mjs`: candidates scan reuses the same derivation; expose per-topic coverage
   counts; edge kind (authored/derived) available to views.
5. `views/graph.js`: navigation-tree + semantic-graph tabs; semantic view excludes index;
   authored solid / derived dashed.
6. `query.mjs` expansion: `via:'provenance'`, in-memory reverse map, per-page fan-out cap.
7. Backlinks panel: two groups (references / coverage); `/api/backlinks` adds the additive
   `kind` field.
8. Tests + retrieval-eval regression with the candidate-dilution metric.
