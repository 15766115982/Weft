# Installation & Configuration Guide

Self-governing knowledge base system: five fully decoupled services (acquisition /
governance / retrieval / agent / UI portal) — Node.js scripts plus one Python service
(ADR-0012). This guide takes you from zero to a working knowledge base connected to
intranet Jira/Confluence.

- 中文版: `installation.zh-CN.md`
- Architecture: `../CONTEXT.md` · Contract: `../schema/contract.md` ·
  Real-environment acceptance: `real-env-test.md`

## 1. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | **≥ 20** (verified on 20 / 22 / 24) | global `fetch`, `AbortSignal.timeout`, `node --test`. The repo's only native dependency, `better-sqlite3`, is ranged `~12.4.6 \|\| ^13.0.2` (2026-08-04): the 12.4.x leg keeps Node 20 prebuilds (12.5+ dropped them), the 13.x leg covers curated intranet mirrors that only serve 13.0.2 (13.x itself requires Node ≥ 22). npm resolves the highest match, so a fresh public install on **Node 20** may pick 13.x and fail (EBADENGINE / source build) — pin it once with `npm install better-sqlite3@~12.4.6`. Switching Node majors otherwise needs no config change — `npm install` downloads the prebuilt binary matching your current Node. |
| npm | bundled with Node | installs the single native dependency (`better-sqlite3`, prebuilt binary — no compiler needed) |
| Git | any recent | the KB is a Git repository |
| Python | **≥ 3.11** (64-bit recommended) | the agent service (`agent/`) — all model calls and the governance graph agent |

No always-on services, no databases to administer (SQLite lives inside `.kb/` and rebuilds
itself). Python is confined to the agent service (ADR-0012: "No Python" was amended to
"Python only in `agent/`"); every other service is plain Node.

The fourth service, `agent/` (Python + LangGraph), owns all model calls (Azure OpenAI SPN
and OpenAI-compatible gateways), the chat/deep-research pipelines, and the graph-constrained
governance run. It is invoked via its CLI (`python -m weft_agent <task>`) by the UI portal
and the eval suites — never imported across services. Prompt templates live under
`<repo>/templates/prompts/` with per-KB overrides at `.kb/config/prompts/`.

## 2. Get the code

Clone or copy this repository to any location on the intranet machine, e.g.
`D:\claude\knowledge-extension`. The path is yours to choose; every command below references
it as `<repo>`.

## 3. Install Node dependencies

**One-click**: run `install.cmd` (Windows) or `./install.sh` (Linux/macOS) from the repo
root — it performs this section and section 4 automatically (Node ≥ 20 / Python ≥ 3.11
checks, `npm install`, the agent venv + `pip install -e agent`). The manual steps below
remain the reference and fallback.

Only the retrieval service has a dependency:

```bash
cd <repo>/retrieval/scripts
npm install
```

`better-sqlite3` downloads a **prebuilt** Windows binary — no build chain required.
Acquisition and governance have zero dependencies; nothing to install there.

> **Offline intranet?** If the target machine cannot reach the npm registry, either point
> npm at your internal mirror (`npm config set registry <url>`) or run `npm install` on a
> connected machine with the **same OS/arch/Node major version** and copy the resulting
> `retrieval/scripts/node_modules/` directory over (the prebuilt binary is
> platform-specific).

## 4. Set up the agent service (Python)

The agent service runs from its own virtual environment at `agent/.venv` (the portal and
tests resolve it automatically; override with the `WEFT_AGENT_PYTHON` env var):

```bash
python -m venv <repo>/agent/.venv
<repo>/agent/.venv/Scripts/python -m pip install -e "<repo>/agent"      # Windows
<repo>/agent/.venv/bin/python -m pip install -e "<repo>/agent"          # Linux/macOS
```

Dependencies are pure-wheel (httpx, langgraph, pydantic — no native builds). The
`langgraph-checkpoint-sqlite` package is deliberately NOT used (its `sqlite-vec` dependency
ships no 32-bit wheels and is a native package); run checkpoints use the bundled pure-JSON
saver (`agent/weft_agent/checkpoints.py`).

> **Offline intranet?** Same story as npm: point pip at your internal mirror
> (`pip config set global.index-url <url>`) or `pip download` the wheels on a connected
> machine and install from the directory. Watch your mirror's high-risk package rules —
> the dependency set is mainstream (see `agent/pyproject.toml`).

## 5. Create a knowledge base instance

The KB is a directory of your choice, **separate from the code repo**, and its own Git
repository. Multiple KBs may coexist.

```bash
# Windows example; any path works
mkdir D:\kb\work
cd D:\kb\work
git init
```

Add a `.gitignore` so derived artifacts stay out of history:

```
.kb/
```

Create `kb.json` (start minimal; connectors come in step 6):

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {},
  "retrieval": { "embedding": "off" }
}
```

That's it — `raw/`, `wiki/`, `log.md`, `.kb/` are created automatically by the scripts on
first use. Every command takes `--kb <path>`; alternatively set the `KB_PATH` environment
variable once (`--kb` wins when both are present).

> The KB will contain real intranet content under `raw/`. Check your org's policy on
> committing it to Git before you do.

> Git is load-bearing, not just hygiene: governance runs commit their `wiki/` +
> `log.md` changes automatically (one commit per run — the portal does it
> server-side), and the viewer's
> conflict diff and the portal's page history read from that history. On a
> non-git KB everything degrades gracefully (file-copy snapshots instead).
> Governance commits carry a fixed machine identity (`kb-portal` / `kb-govern`,
> via `-c` flags) — no git `user.name`/`user.email` setup is needed on the machine.

## 6. Configure connectors and secrets

### 6.1 Secrets — environment variables ONLY

Personal access tokens live **only** in environment variables; `kb.json` stores at most the
variable *names*. The KB is a Git repository — a checked-in token enters history forever.

**Windows** (persist for your user; open a NEW shell afterwards):

```cmd
setx JIRA_PAT "<your-jira-pat>"
setx CONFLUENCE_PAT "<your-confluence-pat>"
```

**Linux / macOS**: add `export JIRA_PAT=...` / `export CONFLUENCE_PAT=...` to your shell
profile.

Both are Server/DC personal access tokens (Bearer auth), created in the Jira/Confluence web
UI under your profile → Personal Access Tokens.

### 6.2 Internal CA (self-signed certificates)

Node's fetch rejects corporate/self-signed certificate chains. If the Jira or Confluence
host uses an internal CA, export the CA certificate as PEM and:

```cmd
setx NODE_EXTRA_CA_CERTS "C:\path\to\internal-ca.pem"
```

**Never** work around certificate errors with `NODE_TLS_REJECT_UNAUTHORIZED=0` — that
disables verification entirely.

### 6.3 kb.json connector scopes

Full example (contract §6):

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {
    "jira": {
      "base_url": "https://jira.example.com",
      "pat_env": "JIRA_PAT",
      "jql": ["project = PROJ ORDER BY updated DESC"]
    },
    "confluence": {
      "base_url": "https://wiki.example.com",
      "pat_env": "CONFLUENCE_PAT",
      "spaces": ["DEV", "REQ"]
    },
    "local": { "inbox": "inbox/" }
  },
  "retrieval": { "embedding": "off" }
}
```

- jira `jql`: array of JQL scopes;
- confluence `spaces`: array of space keys (one CQL scope per key), or `cql`
  (string or array) which overrides `spaces` when set;
- local `inbox`: directory (relative to kb-root or absolute) where you drop manually
  exported `.md`/`.txt` files;
- `pat_env` may be omitted — defaults are `JIRA_PAT` / `CONFLUENCE_PAT`.

Start with ONE small project and ONE small space; widen after the smoke test passes.

### 6.4 Agent service (LLM) configuration

The agent service (`<repo>/agent/`, CLI: `python -m weft_agent`) is invoked by the UI
portal, the retrieval judge, and the eval suites. It needs two things in the KB:

1. **Model config** at `.kb/config/models.json` — one file per KB, used by **both**
   provider types. Seed it from a template instead of writing it by hand:

   ```bash
   PY=<repo>/agent/.venv/Scripts/python   # .venv/bin/python on Linux/macOS
   # Azure OpenAI (SPN or api_key)
   $PY -m weft_agent init-config --kb D:\kb\work

   # Any OpenAI-compatible endpoint (Kimi, DeepSeek, vLLM, Copilot gateways, …)
   $PY -m weft_agent init-config --kb D:\kb\work --input-file "{\"provider\":\"openai\"}"
   ```

   The Settings page of the UI portal has the same two actions as buttons
   ("Init models.json (Azure)" / "(OpenAI-compatible)"). Seeding never overwrites an
   existing `models.json` unless forced. The templates live at
   `<repo>/templates/models.example.json` and `models.example.openai.json`.

   **Azure OpenAI** (`"provider": "azure"`, the default when `provider` is omitted):

   ```json
   {
     "provider": "azure",
     "endpoint": "https://your-resource.openai.azure.com",
     "deployment": "gpt-5-4",
     "api_version": "2025-01-01-preview",
     "auth": {
       "type": "spn",
       "tenant_id": "your-tenant-id",
       "client_id": "your-client-id",
       "client_secret": "WEFT_AZURE_CLIENT_SECRET"
     },
     "defaults": { "temperature": 0.2, "max_tokens": 4096 }
   }
   ```

   Azure auth alternatives: `"type": "spn"` (client credentials, shown above) or
   `"type": "api_key"` with `"api_key": "AZURE_OPENAI_API_KEY"`. Set the referenced
   env var (`setx WEFT_AZURE_CLIENT_SECRET "…"` / `setx AZURE_OPENAI_API_KEY "…"`).

   **OpenAI-compatible** (`"provider": "openai"` — Kimi, DeepSeek, vLLM, any
   `/chat/completions` endpoint):

   ```json
   {
     "provider": "openai",
     "endpoint": "https://api.moonshot.cn/v1",
     "model": "kimi-k2-0711-preview",
     "auth": { "type": "api_key", "api_key": "WEFT_LLM_API_KEY" },
     "defaults": { "temperature": 0.2, "max_tokens": 4096 }
   }
   ```

   `endpoint` is the base URL (`/chat/completions` is appended); requests use
   `Authorization: Bearer <key>` and carry the `model` field. Set the key:
   `setx WEFT_LLM_API_KEY "<your-key>"`.

   Note: the `auth.api_key` / `auth.client_secret` values are **env var names**,
   never the secrets themselves.

2. **Prompt templates** under `.kb/config/prompts/`:

   ```bash
   <repo>/agent/.venv/Scripts/python -m weft_agent init-prompts --kb D:\kb\work
   ```

   This copies the default templates from `<repo>/templates/prompts/` so you can edit
   them per KB. Re-run with `--force` to overwrite with defaults.

Verify the LLM service config and credentials:

```bash
<repo>/agent/.venv/Scripts/python -m weft_agent check --kb D:\kb\work
```

For fully offline / stubbed integration tests, set `WEFT_LLM_STUB=1` in the environment;
the service returns deterministic canned output and does not call the provider.

## 7. Smoke test

Run these from any directory (substitute `<repo>` and your KB path):

```bash
# 1. Auth round-trip (needs the PAT env vars from 6.1)
node <repo>/acquisition/scripts/acquire.mjs jira       --kb D:\kb\work --check
node <repo>/acquisition/scripts/acquire.mjs confluence --kb D:\kb\work --check

# 2. Small pull (cap at 20; truncation is reported, never silent)
node <repo>/acquisition/scripts/acquire.mjs confluence --kb D:\kb\work --max 20
node <repo>/acquisition/scripts/acquire.mjs jira       --kb D:\kb\work --max 20

# 3. Local connector (drop a .md file into the inbox first)
node <repo>/acquisition/scripts/acquire.mjs local --kb D:\kb\work

# 4. Governance: sweep → plan → (apply-source per item) → rebuild-index
node <repo>/governance/scripts/govern.mjs sweep --kb D:\kb\work
node <repo>/governance/scripts/govern.mjs plan  --kb D:\kb\work

# 5. Retrieval (after at least one page exists in wiki/)
node <repo>/retrieval/scripts/kb_search.mjs search "a term from your corpus" --kb D:\kb\work

# 6. Agent service: seed prompts and verify model connectivity
<repo>/agent/.venv/Scripts/python -m weft_agent init-prompts --kb D:\kb\work
<repo>/agent/.venv/Scripts/python -m weft_agent check        --kb D:\kb\work

# 7. Thin viewer (candidate review UI; Ctrl+C to stop)
node <repo>/governance/viewer/serve.mjs --kb D:\kb\work
# → http://127.0.0.1:8321  (localhost only, no login — single-user tool.
#   Writes carry a per-startup token injected into the page + Origin/Host
#   checks; transparent in normal use — just reload the tab after a relaunch)

# 8. UI portal (optional here; the full console — browse/search/review/acquire/
#    govern/chat — see guide.zh-CN.md §7-8)
node <repo>/ui/serve.mjs --kb D:\kb\work
# → http://127.0.0.1:8322  (same localhost + token + Origin/Host posture)
```

Step 4's per-item `apply-source` and synthesis are normally driven by the portal's
**govern-run** (the LangGraph graph agent: sweep → plan → per-document → synthesis →
rebuild-index — it calls these same CLI commands; the LLM only drafts summaries and
syntheses). Running the commands by hand remains the best installation check.

For a full acceptance pass on real servers (failure drills, incremental-skip verification,
XHTML fidelity audit), follow `real-env-test.md`.

## 9. Optional: run the test suite

400+ tests across seven suites, all against mocks/stubs — no network, no PATs, no model
endpoint needed:

```bash
cd <repo>/acquisition/scripts && npm test            # 75 tests
cd <repo>/governance/scripts && npm test             # 83 tests (includes the thin viewer)
cd <repo>/retrieval/scripts  && npm test             # 46 tests (needs npm install first)
cd <repo>/agent              && .venv/Scripts/python -m pytest tests/   # 70 tests
cd <repo>/ui                 && node --test test/    # 96 tests (no dependencies)
cd <repo> && node --test tests/e2e/ tests/eval/      # 91 tests (e2e pipeline + retrieval eval)
```

## 10. Daily usage

Drive everything from the browser: `node <repo>/ui/serve.mjs --kb <path>` starts the
on-demand UI portal at http://127.0.0.1:8322 (browse/search/review/acquisition console/
agent-governance console/graph/chat; multi-KB switcher via `<repo>/ui/kbs.json`).
Full walkthrough: `guide.zh-CN.md` §7-8 (Chinese).

The three-party contract is `schema/contract.md`; the agent service's task/prompt surface
lives under `<repo>/agent/` and `<repo>/templates/prompts/`.

## 11. Upgrading

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # refreshes the prebuilt better-sqlite3 binary
                                      # (the repo carries no package-lock.json — install resolves fresh)
<repo>/agent/.venv/Scripts/python -m pip install -e "<repo>/agent"   # agent dep changes
```

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | internal CA — set `NODE_EXTRA_CA_CERTS` (§6.2); never disable TLS verification |
| `authentication failed HTTP 401` | PAT wrong/expired/revoked; re-create in the source's web UI. PATs expire per Server/DC policy |
| `confluence PAT not available: environment variable ... is not set` | `setx` writes to future shells — open a NEW terminal (or `set` it in the current one) |
| `no knowledge base specified` | pass `--kb <path>` or set `KB_PATH` |
| `kb directory does not exist` | create the KB root first (§5); scripts create the inner skeleton, not the root |
| `npm install` fails for better-sqlite3 | no registry access or platform without prebuilt binary — see the offline note in §3 |
| portal LLM jobs fail with `python ... not found` / module errors | the agent venv is missing or stale — rerun §4, or point `WEFT_AGENT_PYTHON` at a valid interpreter |
| `node: bad option: --test` or `fetch is not defined` | Node < 20 — upgrade (§1) |
| viewer page empty / 409 on flip | a governance run is in flight — close the viewer, run `sweep`, retry (single-operator discipline) |
| viewer/portal write returns 403 `write requests require the per-startup token` | the open tab predates the latest launch and holds a dead token — reload the page |

## 12. Uninstalling

Delete `<repo>` (the agent venv at `agent/.venv` goes with it). Knowledge bases are
independent directories — delete or keep them as you see fit.
