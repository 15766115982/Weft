# Weft — Self-Governing Knowledge Base

> Weft(纬线):wikilink 把页面织成网。项目原名 knowledge-extension(仓库目录名沿用)。

A self-governing knowledge base system: five fully decoupled services —
**acquisition** (Jira / Confluence / local files → normalized `raw/`), **governance**
(`raw/` → curated `wiki/` with a candidate state machine), **retrieval** (hybrid FTS5
search over approved pages), **agent** (Python + LangGraph: all model calls, chat /
deep-research, and the graph-constrained governance run — ADR-0012), and the **UI portal**
(on-demand localhost console). Node.js everywhere except `agent/`; no always-on services,
no web platform.

- **完整安装上手指南(中文,含 KB Portal)**: [docs/guide.zh-CN.md](docs/guide.zh-CN.md)
- **安装配置教程(中文,服务层)**: [docs/installation.zh-CN.md](docs/installation.zh-CN.md)
- **Installation & configuration (English)**: [docs/installation.md](docs/installation.md)
- Architecture & decisions: [CONTEXT.md](CONTEXT.md) · three-party contract:
  [schema/contract.md](schema/contract.md) · dev log: [docs/DEVLOG.md](docs/DEVLOG.md)

## Quick start / 快速开始

**Prerequisite: Node.js ≥ 20 and Python ≥ 3.11** (the agent service).

```bash
# 1. One-click install (retrieval dep + agent Python env) — 一键安装
install.cmd        # Windows (cmd)
./install.sh       # Linux / macOS

# 2. Create a knowledge base (its own git repo) — 创建知识库
mkdir D:\kb\work && cd D:\kb\work && git init
echo .kb/ > .gitignore
# write kb.json — see docs/installation.md section 5-6

# 3. Set secrets as env vars (never in kb.json) — 密钥只走环境变量
setx JIRA_PAT "<pat>" & setx CONFLUENCE_PAT "<pat>"   # Windows; new shell afterwards
```

Then start the portal and drive everything from the browser:
`node ui/serve.mjs --kb D:\kb\work` → http://127.0.0.1:8322 (acquisition console /
govern-run / search / chat). Full smoke-test commands:
[docs/installation.md](docs/installation.md) §7.

## Repository layout / 目录结构

| Path | Content |
|---|---|
| `acquisition/` | Acquisition service: `scripts/` (connectors: local, chat, jira, confluence) |
| `governance/` | Governance service: `scripts/` (plan/apply/review/sweep) + `viewer/` (thin review UI) |
| `retrieval/` | Retrieval service: `scripts/` (dual FTS5 + graph expansion) |
| `agent/` | Agent service (Python + LangGraph): all model calls (governance tasks, chat, deep-research, judge) + the graph-constrained govern run |
| `ui/` | UI portal (M7, ADR-0006): on-demand localhost human console — pure consumer, zero reverse dependency (design: [docs/webui/](docs/webui/README.md)) |
| `schema/` | The frozen contract (`contract.md`) + governance conventions (`governance.md`) |
| `docs/` | Installation guides (EN/中文), real-env acceptance checklist, DEVLOG, ADRs |
| `guide/` | Pre-M0 research notes (Chinese) + `materials/` (paper/article snapshots) |
| `install.cmd` / `install.sh` | One-click installers (steps 3-4 of the installation guide) |

The three services have **zero code dependency** on each other; they communicate only
through the knowledge base directory per `schema/contract.md`.

## Tests / 测试

400+ tests (all mocked/stubbed, no network, no PATs, no model endpoint) across seven
suites — five service suites, the UI portal suite, and a cross-service layer (scratch-KB
pipeline regression + retrieval effectiveness eval):

```bash
cd acquisition/scripts && npm test            # 75
cd governance/scripts && npm test             # 83 (includes the thin viewer)
cd retrieval/scripts  && npm test             # 46 (npm install first)
cd agent              && .venv/Scripts/python -m pytest tests/   # 70
cd ui                 && node --test test/    # 96 (no dependencies)

node --test tests/e2e/ tests/eval/            # 91: e2e pipeline + govern-run + evals
```

`tests/` builds a scratch KB from a fixture corpus (`tests/fixtures/inbox/`) and
drives the real CLIs through every function except the live Jira/Confluence
connections; the eval scores Hit@1/Hit@5/MRR against a golden query set and
writes `docs/test-reports/retrieval-eval-latest.md`. Browser-level acceptance:
`cd ui && npx playwright test`; live Jira/Confluence acceptance:
[docs/real-env-test.md](docs/real-env-test.md).
