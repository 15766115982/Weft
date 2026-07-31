# The Thin Viewer Holds Three Red Lines: Why a UI Was Still Built After Rejecting the Platform

Human review (candidate queue, conflict diffs) uses a self-built thin viewer: a Node script
launches localhost on demand + a no-build HTML page. Three red lines: (1) launch on demand,
not resident; (2) no user system / permissions / configuration UI; (3) dumb consumer with zero
governance logic — its only write operation is flipping frontmatter `status`; governance rules
live forever only in the skills/scripts.

**Context**: architecture decision #1 rejected the Web platform (the old LLM-Wiki's
FastAPI+React shape was bloated and hard to maintain), but reading plain Markdown file by file
plus item-by-item in-session review is unfriendly to humans — the human intervention point
needs graphical assistance; the intranet forbids installing Obsidian (otherwise Dataview +
rendering would cover this need at zero cost).

**Considered Options**: Obsidian as the IDE (forbidden on the intranet, excluded);
conversational in-session review (the only channel when candidates are numerous —
unacceptable experience); full platform UI (already rejected).

**Consequences**: the viewer is delivered together with the candidate state machine (M4); what
it reads and writes is still files and frontmatter within the contract, so it can be replaced
at any time by any equivalent tool; the frontend introduces no framework build chain (the old
npm build chain was one of the maintenance burdens).
