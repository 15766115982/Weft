# Pure Filesystem Contract + Orchestration Moved Up to the LLM

The only contract among the three services (acquisition/governance/retrieval) is the
filesystem: directory structure + frontmatter spec (see `schema/contract.md`). Zero code
dependency between layers, zero inter-process calls; run order and flow orchestration are
carried out by the Claude session and exist in no layer's code.

**Context**: the old LLM-Wiki crammed acquisition, organization, retrieval, and UI into one
FastAPI process, coupled through function calls and shared in-memory state; after being moved
into the intranet and extended, it became bloated, hard to split, and hard to maintain.

**Considered Options**: CLI pipes passing JSON (awkward for the stateful scenario of
"governing an existing tree + incremental new documents"); local HTTP microservices (a replica
of the old mistake).

**Consequences**: any layer can be independently rewritten/replaced; indexes (SQLite) are
derived artifacts, outside the contract, rebuildable from Markdown at any time; the contract
document (contract.md) becomes the only frozen point in the system that all three parties must
obey.
