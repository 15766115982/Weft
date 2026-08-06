# Installation & Configuration Guide

Self-governing knowledge base system: four fully decoupled services (acquisition /
governance / retrieval / llm) distributed as Claude Code skills + Node.js scripts. This guide
takes you from zero to a working knowledge base connected to intranet Jira/Confluence.

- 中文版: `installation.zh-CN.md`
- Architecture: `../CONTEXT.md` · Contract: `../schema/contract.md` ·
  Real-environment acceptance: `real-env-test.md`

## 1. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | **≥ 20** (verified on 20 / 22 / 24) | global `fetch`, `AbortSignal.timeout`, `node --test`. The repo's only native dependency, `better-sqlite3`, is ranged `~12.4.6 \|\| ^13.0.2` (2026-08-04): the 12.4.x leg keeps Node 20 prebuilds (12.5+ dropped them), the 13.x leg covers curated intranet mirrors that only serve 13.0.2 (13.x itself requires Node ≥ 22). npm resolves the highest match, so a fresh public install on **Node 20** may pick 13.x and fail (EBADENGINE / source build) — pin it once with `npm install better-sqlite3@~12.4.6`. Switching Node majors otherwise needs no config change — `npm install` downloads the prebuilt binary matching your current Node. |
| npm | bundled with Node | installs the single native dependency (`better-sqlite3`, prebuilt binary — no compiler needed) |
| Git | any recent | the KB is a Git repository |
| Claude Code | any recent | the three services are invoked as skills |

No Python anywhere. No always-on services, no databases to administer (SQLite lives inside
`.kb/` and rebuilds itself).

The fourth service, `llm/`, is **not** a skill; it is invoked internally by governance,
retrieval (judge), and the UI portal via its CLI (`llm.mjs`). It owns all model calls and
keeps prompt templates under `.kb/config/prompts/`.

## 2. Get the code

Clone or copy this repository to any location on the intranet machine, e.g.
`D:\claude\knowledge-extension`. The path is yours to choose; every command below references
it as `<repo>`.

## 3. Install Node dependencies

**One-click**: run `install.cmd` (Windows) or `./install.sh` (Linux/macOS) from the repo
root — it performs this section and section 4 automatically (Node ≥ 20 check,
`npm install`, skill links). The manual steps below remain the reference and fallback.

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

## 4. Install the three skills into Claude Code

The skills must be **linked**, not copied, into Claude Code's personal skills directory.
Each SKILL.md locates its scripts as `../../scripts/` relative to its own directory — that
relative layout only resolves when the skill directory stays inside the repository tree, and
a filesystem link preserves exactly that. Linking also means `git pull` updates take effect
immediately.

Skill names (from each SKILL.md's frontmatter): `kb-acquire`, `kb-govern`, `kb-search`.

**Windows** (cmd.exe, directory junctions — no admin rights needed):

```cmd
mklink /J "%USERPROFILE%\.claude\skills\kb-acquire" "<repo>\acquisition\skills\acquire"
mklink /J "%USERPROFILE%\.claude\skills\kb-govern"  "<repo>\governance\skills\govern"
mklink /J "%USERPROFILE%\.claude\skills\kb-search"  "<repo>\retrieval\skills\search"
```

**Linux / macOS**:

```bash
ln -s <repo>/acquisition/skills/acquire ~/.claude/skills/kb-acquire
ln -s <repo>/governance/skills/govern   ~/.claude/skills/kb-govern
ln -s <repo>/retrieval/skills/search    ~/.claude/skills/kb-search
```

Restart Claude Code, then verify: `kb-acquire`, `kb-govern`, `kb-search` appear in the skill
list. Each junction/symlink target directory must contain a `SKILL.md` directly inside it.

> Do NOT copy just the skill folder into `~/.claude/skills/` — the scripts would no longer
> be two levels up and every invocation would fail with a module-not-found error.

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
> server-side, skill-driven sessions do it as SKILL.md step 6), and the viewer's
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

### 6.4 LLM service configuration

The LLM service (`<repo>/llm/llm.mjs`) is not a skill; it is invoked internally by
governance, the retrieval judge, and the UI portal. It needs two things in the KB:

1. **Model config** at `.kb/config/models.json` (create it once per KB):

   ```json
   {
     "endpoint": "https://your-resource.openai.azure.com",
     "deployment": "gpt-5-4",
     "api_version": "2025-01-01-preview",
     "auth": {
       "type": "spn",
       "tenant_id": "your-tenant-id",
       "client_id": "your-client-id",
       "client_secret": "WEFT_AZURE_CLIENT_SECRET"
     },
     "defaults": {
       "temperature": 0.2,
       "max_tokens": 4096
     }
   }
   ```

   Set the secret env var:

   ```cmd
   setx WEFT_AZURE_CLIENT_SECRET "<your-spn-secret>"
   ```

   Alternative auth: replace `"type": "spn"` with `"type": "api_key"` and
   `"api_key": "AZURE_OPENAI_API_KEY"`; set that env var instead.

2. **Prompt templates** under `.kb/config/prompts/`:

   ```bash
   node <repo>/llm/llm.mjs init-prompts --kb D:\kb\work
   ```

   This copies the default templates from `<repo>/templates/prompts/` so you can edit
   them per KB. Re-run with `--force` to overwrite with defaults.

Verify the LLM service can reach Azure:

```bash
node <repo>/llm/llm.mjs check --kb D:\kb\work
```

For fully offline / stubbed integration tests, set `WEFT_LLM_STUB=1` in the environment;
the service returns deterministic canned output and does not call Azure.

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

# 6. LLM service: seed prompts and verify Azure connectivity
node <repo>/llm/llm.mjs init-prompts --kb D:\kb\work
node <repo>/llm/llm.mjs check       --kb D:\kb\work

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

Steps 4's `apply-source`/`apply-topic` and the whole search loop are normally driven by the
Claude Code skills (kb-govern / kb-search) — they read the raw documents, write the
summaries, and iterate queries. The commands above are what the skills invoke under the
hood; running them by hand is the best installation check.

For a full acceptance pass on real servers (failure drills, incremental-skip verification,
XHTML fidelity audit), follow `real-env-test.md`.

## 9. Optional: run the test suite

380 tests across six suites, all against mocks — no network, no PATs, no Azure needed:

```bash
cd <repo>/acquisition/scripts && npm test            # 69 tests
cd <repo>/governance/scripts && npm test             # 72 tests (includes the thin viewer)
cd <repo>/retrieval/scripts  && npm test             # 46 tests (needs npm install first)
cd <repo>/llm                && node --test test/    # 31 tests
cd <repo>/ui                 && node --test test/    # 92 tests / 1 skip (no dependencies)
cd <repo> && node --test tests/e2e/ tests/eval/      # 42 tests (e2e pipeline + retrieval eval)
```

## 10. Daily usage

In any Claude Code session (the skills are global):

1. **Acquire** — "pull the knowledge base documents" → kb-acquire runs the connectors;
2. **Govern** (human-triggered, never automatic) — "govern the knowledge base" → kb-govern:
   sweep, plan, summarize, topic synthesis, candidate review (conversational or viewer);
3. **Search** — ask knowledge questions → kb-search: structured query, CSQE iteration,
   cited answers.

Or drive all of it from the browser: `node <repo>/ui/serve.mjs --kb <path>` starts the
on-demand UI portal at http://127.0.0.1:8322 (browse/search/review/acquisition console/
agent-governance console/graph/chat; multi-KB switcher via `<repo>/ui/kbs.json`). The portal
and the skills mix freely — they only share the KB directory. Full walkthrough:
`guide.zh-CN.md` §7-8 (Chinese).

Each service's behavioral rules live in its SKILL.md; the three-party contract is
`schema/contract.md`.

## 11. Upgrading

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # refreshes the prebuilt better-sqlite3 binary
                                      # (the repo carries no package-lock.json — install resolves fresh)
```

The skill links keep pointing at the repo — nothing else to redo. Restart Claude Code if a
SKILL.md itself changed.

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | internal CA — set `NODE_EXTRA_CA_CERTS` (§6.2); never disable TLS verification |
| `authentication failed HTTP 401` | PAT wrong/expired/revoked; re-create in the source's web UI. PATs expire per Server/DC policy |
| `confluence PAT not available: environment variable ... is not set` | `setx` writes to future shells — open a NEW terminal (or `set` it in the current one) |
| `no knowledge base specified` | pass `--kb <path>` or set `KB_PATH` |
| `kb directory does not exist` | create the KB root first (§5); scripts create the inner skeleton, not the root |
| `npm install` fails for better-sqlite3 | no registry access or platform without prebuilt binary — see the offline note in §3 |
| skills don't appear in Claude Code | restart Claude Code; check the junction target contains `SKILL.md`; you linked, not copied (§4) |
| `node: bad option: --test` or `fetch is not defined` | Node < 20 — upgrade (§1) |
| viewer page empty / 409 on flip | a governance run is in flight — close the viewer, run `sweep`, retry (single-operator discipline) |
| viewer/portal write returns 403 `write requests require the per-startup token` | the open tab predates the latest launch and holds a dead token — reload the page |

## 12. Uninstalling

Delete the three junctions/symlinks in `~/.claude/skills/`, then delete `<repo>`. Knowledge
bases are independent directories — delete or keep them as you see fit.
