# Two Data Zones + Candidate State Machine, Not Three Persistent Directory Layers

The knowledge base has only two persistent data zones: `raw/` (exclusive write by acquisition,
normalized Markdown, originals discarded) and `wiki/` (exclusive write by governance, curated
product). The human-machine risk-tiering of collaborative governance does not materialize as a
third directory, but as a state machine on wiki page frontmatter (candidate/approved).

**Context**: the user initially expected that industry LLM Wiki systems generally use three
layers — raw / intermediate / wiki. Research (Karpathy LLM Wiki gist, louiswang524 Claude Code
implementation, atomicstrata/llm-wiki-compiler, nashsu/llm_wiki) shows: Karpathy's original
"three layers" are raw/wiki/**schema** (a rules layer, not a data layer); the human
intervention mechanism in real implementations (llm-wiki-compiler's review queue) is "a
candidate is a status", not a separate document layer.

**Considered Options**: three persistent directory layers (every extra directory is one more
three-party contract surface; the intermediate product's schema would also have to be frozen
and maintained, while its only consumer is the governance service itself); single-tree in-place
governance (acquisition and governance writing the same tree — conflict handling would
re-couple the two layers).

**Consequences**: the rules layer is materialized as `schema/`; candidate pages are
structurally invisible to retrieval (retrieval indexes only approved) — "only the currently
effective version is retrievable" is guaranteed by structure; the adjudication point for
cross-source version confusion lands on the governance layer + candidate state machine.
