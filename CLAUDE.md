# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Weft** (repo dir `knowledge-extension`) is a self-governing knowledge base system.
Fully decoupled **services** — **acquisition** (Jira/Confluence/local files → normalized
`raw/`), **governance** (`raw/` → curated `wiki/`), **retrieval** (hybrid FTS5 over approved
wiki pages), **agent** (`agent/`, Python + LangGraph: all model calls + the graph-constrained
govern run — ADR-0012) — plus an on-demand localhost **UI portal** (`ui/`, pure consumer).
Python is confined to `agent/`; no always-on services, no web platform.

The single most important architectural fact: **the services have zero code dependency on
each other**; their only contract is the filesystem — directory structure + frontmatter spec in
`schema/contract.md`. A KB is its own git repo, completely separate from this code repo.

Authoritative context (read before changing behavior): `CONTEXT.md` (system design) ·
`schema/contract.md` (frozen three-party contract) · `schema/governance.md` (conventions) ·
`docs/DEVLOG.md` (running dev log) · ADRs in `docs/adr/`.

## Design principles / 设计原则

User-mandated design contract (2026-08-05). Every feature/change should satisfy these; when a
trade-off arises, state which principle governs and why.

1. **架构解耦,各板块独立,围绕同一 KB 工作** — Keep the architecture decoupled: each module
   (acquisition / governance / retrieval / agent / UI portal) stays independent and is developed
   as its own capability package behind a CLI contract. They coordinate **only through the KB directory** per
   `schema/contract.md`. When extending, extend one service — never introduce service-to-service
   code dependency, inter-process calls, or a shared lib. One writer per directory, single
   responsibility everywhere.

2. **可维护性优先,代码架构友好** — Design for maintainability: deterministic scripts with clear
   JSON contracts on stdout; the frozen contract as the single source of truth; documented
   deliberate duplication (e.g. the `frontmatter.mjs` copies) instead of hidden coupling; docs kept
   in sync (contract change → CONTEXT.md + ADR). New code should be easy to read, reason about, and
   change in isolation.

3. **实现需考虑性能** — Consider performance in every implementation. Existing anchors: dual-FTS5
   retrieval (latin porter/unicode61 + CJK trigram) with per-term routing and lazy index
   reconciliation; launch-on-demand (no resident services); hot server paths avoid blocking the
   event loop (async git, no sync I/O in request handlers); tests are fast and mocked. Don't
   degrade these on hot paths (index/reconcile/search, file walking, wiki body scans).

4. **用户交互友好** — The human surface (thin viewer + UI portal) must be friendly and safe:
   launch on demand; no user system; whitelisted writes only; per-startup token + Origin/Host
   checks; **impact preview before destructive operations, snapshot-first**, optimistic-lock
   conflict feedback, streaming progress for long jobs, and clear error/empty states. Feedback
   text must be precise and actionable, not alarming or noisy.

## Commands

No build step and no linter. Plain Node ≥ 20 ESM scripts (`"type": "module"`), test runner is
`node:test`. No root package.json — suites are per-service.

**Install** (installs retrieval's `better-sqlite3` dep + creates `agent/.venv` and
`pip install -e agent`): `install.cmd` (Windows) or `./install.sh` (Linux/macOS). Manual steps
and troubleshooting: `docs/installation.md` §3–4.

**Tests** — all mocked, no network, no PATs:

```bash
cd acquisition/scripts && npm test            # acquisition suite
cd governance/scripts && npm test             # governance + thin viewer suites
cd retrieval/scripts  && npm test             # retrieval suite (npm install first)
cd agent              && .venv/Scripts/python -m pytest tests/   # agent service suite
cd ui                 && node --test test/    # UI portal suite (no deps)
node --test tests/e2e/ tests/eval/            # cross-service e2e + retrieval eval (from repo root)
```

Run a single file from inside a service dir (or the repo root for the cross-service suites):

```bash
cd governance/scripts && node --test test/conflict.test.mjs
node --test tests/e2e/pipeline.test.mjs
```

Filter by name: `node --test --test-name-pattern="<regex>" test/`.

The cross-service tests (`tests/e2e/pipeline.test.mjs`, `tests/eval/retrieval-eval.test.mjs`)
build a scratch KB from `tests/fixtures/inbox/` and drive the **real CLIs** through every
function except live Jira/Confluence; `tests/helpers/kb.mjs` supplies the harness. E2E tests are
order-dependent and share one scratch KB — don't reorder them casually.

## Architecture

### The services + UI portal

Each service = deterministic scripts behind a stable CLI contract; orchestration lives in the
UI portal (and in the agent service's governance graph), never in cross-service code imports.

| Service | CLI entry | Writes |
|---|---|---|
| acquisition | `acquisition/scripts/acquire.mjs <local\|jira\|confluence>` | `raw/` (exclusive) |
| governance | `governance/scripts/govern.mjs <plan\|apply-source\|apply-entity\|apply-concept\|apply-synthesis\|approve\|reject\|archive\|dismiss-conflict\|sweep\|merge-page\|rebuild-index\|decisions>` (`apply-topic`/`merge-topic` = legacy synthesis aliases) | `wiki/` (exclusive) |
| retrieval | `retrieval/scripts/kb_search.mjs <search\|read\|reindex>` | `.kb/index.sqlite` only |
| agent (Python) | `python -m weft_agent <task> --kb <path>` (cwd `agent/`; tasks: check/init-config/init-prompts/summarize-source/classify-page/extract-entity/draft-concept/synthesize/govern-decide/semantic-check/chat/deep-research/complete/govern-run/search-smart/prompt) | `.kb/` scratch only (wiki writes go through govern.mjs) |
| UI portal | `ui/serve.mjs` (port 8322) | per contract §1 whitelist |
| thin viewer | `governance/viewer/serve.mjs` (port 8321) | frontmatter `status` only |

Every CLI prints **JSON to stdout** for Claude to parse; usage errors exit 64. Boolean flags take
no value (`--flag` / `--flag true` / `--flag false` only) and fail loudly otherwise — never pass
`--candidate yes` expecting a silent false.

### Data flow and the two zones

```
acquisition → raw/  (normalized markdown, 1:1 per source doc, identity quintuple in frontmatter)
governance  → wiki/ (sources/ 1:1 summaries, entities|concepts|syntheses/ per ADR-0009 four page types, index.md, archive/)
retrieval   → reads ONLY wiki/ pages with status: approved — candidate/archived are structurally invisible
```

- **`raw/`**: exclusive write by acquisition; keeps only the latest pull (history is the KB's git).
- **`wiki/`**: exclusive write by governance. `wiki/sources/` is 1:1 with `raw/` unless
  adjudicated away (auto-dedup / loser-archive); `wiki/syntheses/` (plus `entities/`, `concepts/`)
  holds the cross-source fusion pages (the pre-ADR-0009 `wiki/topics/` layout is migrated away);
  `wiki/index.md` is the retrieval entry contract and must be rebuilt after every governance run.
- **`.kb/`**: derived artifacts (index, adjudication memory `.kb/govern/`, run logs). Fully
  rebuildable; gitignored.
- **Secrets** go through env vars only (`JIRA_PAT`, `CONFLUENCE_PAT`, `KB_PATH`); `kb.json`
  stores non-sensitive config and env-var names. `--kb <path>` overrides `KB_PATH`.

### Candidate state machine (contract §4)

`candidate → approved` on human review; `candidate → rejected → archived` via the sweep;
`approved → archived` on human adjudication. Low-risk ops auto-approve; contradictions,
duplicates, merges, and archiving approved pages must be `candidate`. **Every governance run
starts with `sweep`** — it reconciles viewer/portal flips into log.md and archives rejected
pages. Never flip a status by hand-editing a page; use the viewer/portal or the govern CLI.

### Governance conventions worth internalizing

- KB primary language is **English** (retrieval works in one language space); `raw/` keeps
  source language. See `schema/governance.md` §1.
- Conflict detection (ADR-0008) is structural over the whole KB: exact duplicate (hash) →
  auto-dedup; similar version → forced candidate; factual conflict → semantic check. Adjudication
  is remembered in `.kb/govern/` (tombstones, dismissals). `apply-synthesis` force-candidates any
  synthesis touching a flagged group.
- Page slug is the identity; re-applying a slug = update (union-merge `sources`, never silently
  drop provenance). Merging pages is human-adjudicated and requires both pages approved.

## Working conventions / gotchas

- **`frontmatter.mjs` is deliberately duplicated** across the services (and the viewer/portal hold
  more copies); there is no shared lib. Changes must be synced by hand across all copies — this is
  documented discipline, not an accident to "fix."
- **`docs/` discipline**: `DEVLOG.md` gets new chronological entries at the **top**; contract
  changes require syncing `CONTEXT.md` + an ADR (contract §7 change discipline — increment-compatible
  only). ADRs in `docs/adr/`, one-off plans in `docs/plans/`, bug reports in `docs/bugs/`.
- **Windows / Python**: the portal spawns the agent service as `<python> -m weft_agent`
  resolved by `ui/lib/agentcli.mjs` (`WEFT_AGENT_PYTHON` > `agent/.venv` > PATH). Python
  subprocesses that read service-CLI output must pass `encoding='utf-8'` — the Windows
  locale codec (GBK) corrupts CJK JSON (P1-C5 bug).
- **Page bodies go via `--body-file`** (scratch files in the KB's `.kb/bodies/`), never
  pipes/heredocs — the govern graph does this internally, and it stays the headless-safe
  CLI form everywhere.
- Don't commit to a KB during tests — tests build scratch KBs under a temp dir and tear them down.
- Commits in this repo are conventional one-liners prefixed by milestone/ADR (see `git log`).
