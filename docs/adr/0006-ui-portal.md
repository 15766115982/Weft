# The UI Portal: A Fourth Top-Level Package That Drives the Whole Pipeline Without Becoming a Platform

ADR-0004 carved the thin viewer out of the "no Web UI" rule under three red lines. M7
generalizes that carve-out: a full **human console** (`ui/`) covering read-only browsing,
search, review, acquisition operations, raw management, and agent-driven governance with
live streaming — while the system remains platform-free. The key move is replacing red
line 3 ("dumb consumer, one write") with an explicit **write whitelist + per-KB serial
write queue**, because the console's write surface (raw delete/move, spawning pipelines)
is far larger than the viewer's status flip.

**Context**: requirements (frozen 2026-08-02, `docs/webui/requirements.zh-CN.md`) demand
UI-driven acquisition, governance visualization via a pluggable agent executor (first
implementation: headless `claude -p`, others may follow), streaming progress, and an
LLM-judge evaluation service — none of which fit the viewer's single-write shape. The
original boundary "existing services never depend on the frontend; the frontend may
depend on existing services" was tested by an architecture review (10 findings, 7
confirmed / 2 misjudged / 1 partially correct, see
`docs/webui/options/option-1-review-findings.zh-CN.md`) and survives in softened form:
**zero behavior change to the three services; two read-only increments are allowed**
(`.kb/ui/` derived-artifacts note + an acquisition-appended per-source pull record in
`.kb/`, the only source for "last pull time" — an all-skipped incremental pull leaves no
trace in log.md).

**Considered Options**:

1. **No-build SPA console** (chosen) — node:http JSON API + ES-module frontend, zero npm
   dependencies (vendored marked + DOMPurify), same pattern as the viewer scaled up.
   Matches the console-heavy requirement center (SSE streaming, async eval badges, graph).
2. SSR + htmx (BookStack shape) — best for read-dominant products; mismatched here: the
   requirement center is interactive (streaming console, async badges), forcing JS islands
   that break the single rendering philosophy. Rejected.
3. Light build (esbuild + Svelte) — best frontend maintainability at full scope but
   reintroduces the build chain the project deliberately abandoned. Recorded as the
   documented escape hatch: option 1 and 3 share the identical backend, so the frontend
   alone can be swapped if no-build discipline fails (trigger: views >10 modules or app
   kernel >600 lines, evaluate vendored Alpine.js first).
4. Adopting an existing product (Outline/Wiki.js/SiYuan/…) — all require importing content
   into their own data models plus PG/Redis/ES infrastructure. Rejected (research:
   `docs/webui/research.zh-CN.md`).

**Consequences**:

- Contract §1 gains a **UI portal** column and two `.kb/` entries (increment-compatible);
  the UI's KB writes are whitelisted to exactly: inbox/ uploads, raw/ delete+move
  (snapshot-first, impact preview first, serial queue), statusflip review writes (same
  primitive as the viewer), and `.kb/ui/` derived artifacts.
- **Per-KB serial write queue** (jobs.mjs): the system's single-operator assumption is
  enforced by the tool layer, not by user discipline; read-only work stays concurrent.
- **Localhost write security**: startup-generated token + Origin/Host checks on all write
  requests — binding 127.0.0.1 does not stop a malicious web page from POSTing to it.
- Integration split: write operations spawn the service CLIs (process isolation);
  read-hot paths (search/read/plan) import libs in-process (statusflip import precedent).
- The agent executor interface (`startRun(spec) → event stream`, modeled on
  `claude -p --output-format stream-json --verbose`) keeps the LLM backend pluggable;
  the same three-source LLM adapter layer (copilot-proxy GPT / Azure SPN GPT / claude)
  serves both the executor and the evaluation judge. Headless permission posture:
  **`--dangerously-skip-permissions` (user-ruled 2026-08-02)**, buffered by candidate
  review + full job logging. Two M7c implementation facts now part of this decision:
  the prompt is delivered via **stdin** (the claude.cmd `%*` shim mangles multi-line
  argv), and the default prompt points at the **SKILL.md file path** rather than
  relying on skill registration — runs follow the canonical workflow in any
  environment, and non-Claude backends can "read this file and comply" (I3
  strengthened).
- **Recorded exposure (M7c review P2-2, hardening planned before M7d)**: under
  skip-permissions the agent's file tools are NOT confined to the KB — prompt
  injection via untrusted raw content could write outside it, bypassing both
  buffers (no candidate review, no wiki trace). Planned mitigation, in cost order:
  ① `--allowedTools` / `permissions.deny` rules scoping Write/Edit to the KB path
  (composable with skip-permissions); ② prompt-level confinement (weak, additive
  only); ③ post-run `git status` diff on git KBs to surface unexpected in-KB changes.
- Version management must not assume the KB is a git repo: git when available, file-copy
  snapshots under `.kb/ui/snapshots/` plus a "git init recommended" banner otherwise.
- The M7d wiki human-edit path (edit → demote to candidate → re-review, plus
  provenance-relinking governance rules) is a separate future contract discussion (H2/H3),
  not covered by this ADR.
