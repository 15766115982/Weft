# ADR-0009: LLM Service, Decision-Log Governance, and Four Wiki Page Types

**Status**: accepted (2026-08-05)

Weft repositions from a single-user localhost knowledge-base assistant to a **team intranet
knowledge governance + Q&A portal**. A fourth fully decoupled **LLM service** (`llm/`) owns
all model calls behind a stable CLI contract (`llm.mjs <task> --kb <path> --input-file
<json> --output-file <json|ndjson>`), leaving the existing services deterministic and
model-free. The wiki page-type system expands from `source | topic` to **
`source | entity | concept | synthesis`** (Contract v2). Governance becomes
**decision-log driven**: every action — human or LLM — appends a record to
`.kb/govern/decisions/<id>.json`; human decisions require a reason; LLM auto-decisions
retrieve same-type historical decisions as few-shot context and fail closed to `candidate`
when human precedent is contradictory. Prompts are externalized (`templates/prompts/`
defaults, copied to editable `.kb/config/prompts/`); Azure OpenAI via SPN is configured in
`.kb/config/models.json` with secrets in env vars only. Acquisition gains a read-only
`acquire detect` subcommand; chat/deep-research stream NDJSON; concurrency is per-request
process isolation with a portal-side user-visible queue.

**Context**

`CONTEXT.md` and `schema/contract.md` v1 describe three decoupled services (acquisition /
governance / retrieval), a two-zone KB (`raw/` and `wiki/`), a `source | topic` page-type
system, and a candidate state machine. Human interaction is intentionally thin: on-demand
localhost tools, no user system, no permissions, no configuration UI. This was the right
shape for a personal Claude Code assistant, but it no longer matches the user's team
problem: documents are scattered across Confluence, Jira, OneDrive, GitHub, Azure Repos,
and local storage; nobody maintains them; duplicates and contradictions go unnoticed; new
team members need page-level Q&A and deep-research over the approved knowledge base.

The user has already ruled on the major product and architectural choices in prior sessions:
- The product serves the team, not a single operator.
- One team = one KB, two roles: readers (no login) and operators (single admin login).
- Azure OpenAI GPT-5.4 via SPN is the only acceptable LLM path.
- No migration obligation: existing KBs can be abandoned and rebuilt from raw.
- Page types should model entities and concepts, not just topics.
- Deep-research answers only from approved wiki pages and never writes back to wiki.
- Governance steps must be independently executable so they can be orchestrated into daily
  automatic runs.

This ADR records those rulings and the concrete implementation shape they impose.

**Considered Options**

1. **Keep three services; embed LLM calls inside governance/retrieval.**
   Rejected. It would couple model choice, prompt discipline, and retry logic to the
   deterministic services, making it impossible to swap the LLM backend later and forcing
   every service to carry Azure auth code. A separate `llm/` service keeps the other
   services model-free and satisfies the "zero code dependency" rule via a CLI contract.

2. **Integrate pi-agent as the LLM layer.**
   Rejected. pi-agent supports API-key auth only, not Azure SPN; its dependency footprint
   and build step are too heavy; and it would reintroduce cross-service code coupling.

3. **Keep `source | topic` and add entity/concept only as labels.**
   Rejected. The user's example ("FAA is a feature, built on Agent Framework, in Python,
   owner is A") needs first-class entity pages with stable slugs and typed relations, not
   just taxonomy tags. Synthesis pages separate cross-source narrative from concept
   definitions.

4. **Hard-coded automation levels (L0–L3) for auto-governance.**
   Rejected in favor of a decision-log mechanism. Static levels cannot capture the user's
   intent that "LLM should learn how humans decided in similar cases." A log of every
   human/LLM decision, fed back as few-shot context, is more adaptive and auditable.

5. **Prompts baked into `.mjs` files.**
   Rejected. The user explicitly requires prompts to live in editable files so operators
   can tune them and the UI can expose them.

6. **`acquire detect` updates `raw/` automatically when upstream changes are found.**
   Rejected. Detection must be read-only so it can run safely every day without side
   effects. Pulling is a separate write action.

7. **Deep-research loop controlled by UI/portal.**
   Rejected. The retrieval strategy (what to query, how many rounds) should live inside the
   LLM service; the portal only consumes the NDJSON progress stream.

**Consequences**

- `schema/contract.md` is bumped from **v1 to v2** (semantic changes: page-type enum and
  write-permission matrix). `CONTEXT.md` is synchronized to reflect team-intranet
  positioning, four services, four page types, and the decision-log mechanism.
- A new top-level service directory `llm/` is created with its own scripts, tests, and
  optional skill linkage. It is the only service that talks to Azure OpenAI.
- Wiki directory tree gains `wiki/entities/`, `wiki/concepts/`, `wiki/syntheses/`
  (replacing `wiki/topics/`). `wiki/sources/` remains 1:1 with `raw/` by default.
- `.kb/` ownership is extended:
  - `.kb/acquire/upstream-detect.json` — acquisition.
  - `.kb/govern/decisions/<id>.json` — governance (adjudication memory, not rebuildable).
  - `.kb/config/prompts/` and `.kb/config/models.json` — user-edited, seeded by `llm/`.
  - `.kb/ui/queue.json` — UI portal (operational, rebuildable).
- Governance CLI changes:
  - New: `apply-entity`, `apply-concept`, `apply-synthesis`, `decisions`, `migrate-v2`.
  - `approve`, `reject`, `archive`, `merge-topic` require `--reason`.
  - `--actor human|llm` distinguishes operator and model decisions.
- Acquisition CLI changes:
  - New: `detect` subcommand; writes `.kb/acquire/upstream-detect.json` only.
- Retrieval changes:
  - Indexes new wiki directories.
  - `type:` filter accepts `entity | concept | synthesis`.
- LLM CLI contract:
  - `llm.mjs <task> --kb <path> --input-file <json> --output-file <json|ndjson>`.
  - Governance tasks emit single JSON; `chat` and `deep-research` emit NDJSON.
  - `llm.mjs init-prompts --kb <path>` seeds `.kb/config/prompts/` from `templates/prompts/`.
  - `llm.mjs check --kb <path>` validates config and SPN token acquisition.
- Decision-log mechanics:
  - Every mutating governance action writes a JSON decision record.
  - Human records require `reason`; LLM records include `referenced_decisions` and a
    `model_version` field.
  - LLM auto-decision loads all historical decisions of the same `decision_type`, asks the
    model to follow precedent; if precedent is contradictory, the decision is forced to
    `candidate` with a reason explaining the conflict.
- Prompt files default in `templates/prompts/` and are copied per KB to
  `.kb/config/prompts/`. User edits are preserved; default improvements are backported by
  re-running `init-prompts --force` or by manual merge.
- Tests are added per phase in each service's `test/` directory and in the cross-service
  `tests/e2e/pipeline.test.mjs`.
- Accepted trade-offs:
  - `.kb/govern/decisions/` is adjudication memory, not rebuildable from `raw/`/`wiki/`.
    The human-readable spine remains in `log.md`.
  - The portal becomes a team server, relaxing the original "no resident service, no user
    system" red lines; authentication is intentionally minimal (single admin operator).

**Open items for later ADRs or implementation phases**

- Exact rate-limit numbers for the LLM service (default proposal: 200 ms floor between calls,
  exponential backoff 1 s / 2 s / 4 s, three retries).
- Whether the LLM service gets its own Claude skill (`kb-llm`) or is invoked only by other
  skills and the portal.
- Per-page fan-out caps for deep-research retrieval expansion.
- Resume behavior for killed deep-research jobs (v1 proposal: no resume; queue marks
  interrupted).

**Implementation shape**

1. Phase 0 — ADR-0009 + `schema/contract.md` v2 + `CONTEXT.md` sync.
2. Phase 1 — `llm/` service skeleton: CLI, config, auth, transport, prompts, NDJSON writer.
3. Phase 2 — Governance decision-log + four page types + `migrate-v2`; retrieval indexing.
4. Phase 3 — `acquire detect` and per-connector detect hooks.
5. Phase 4 — LLM task implementations including deep-research retrieval loop.
6. Phase 5 — UI portal chat/research/decision-inbox/queue views.
7. Phase 6 — E2E tests, eval regression, docs closeout.
