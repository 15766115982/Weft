# Self-Governing Knowledge Base (knowledge-extension)

A self-governing knowledge base system for Claude Code: three fully decoupled services —
**acquisition** (Jira / Confluence / local files → normalized `raw/`), **governance**
(`raw/` → curated `wiki/` with a candidate state machine), **retrieval** (hybrid FTS5
search over approved pages) — distributed as Claude Code skills + Node.js scripts.
No Python, no always-on services, no web platform.

- **安装配置教程（中文）**: [docs/installation.zh-CN.md](docs/installation.zh-CN.md)
- **Installation & configuration (English)**: [docs/installation.md](docs/installation.md)
- Architecture & decisions: [CONTEXT.md](CONTEXT.md) · three-party contract:
  [schema/contract.md](schema/contract.md) · dev log: [docs/DEVLOG.md](docs/DEVLOG.md)

## Quick start / 快速开始

**Prerequisite: Node.js ≥ 20** and Claude Code.

```bash
# 1. One-click install (Node dependency + skill links) — 一键安装
install.cmd        # Windows (cmd)
./install.sh       # Linux / macOS

# 2. Create a knowledge base (its own git repo) — 创建知识库
mkdir D:\kb\work && cd D:\kb\work && git init
echo .kb/ > .gitignore
# write kb.json — see docs/installation.md section 5-6

# 3. Set secrets as env vars (never in kb.json) — 密钥只走环境变量
setx JIRA_PAT "<pat>" & setx CONFLUENCE_PAT "<pat>"   # Windows; new shell afterwards
```

Then restart Claude Code and talk to it: *"pull the knowledge base documents"* (kb-acquire)
→ *"govern the knowledge base"* (kb-govern) → ask knowledge questions (kb-search).
Full smoke-test commands: [docs/installation.md](docs/installation.md) §7.

## Repository layout / 目录结构

| Path | Content |
|---|---|
| `acquisition/` | Acquisition service: `scripts/` (connectors: local, jira, confluence) + `skills/acquire/` |
| `governance/` | Governance service: `scripts/` (plan/apply/review/sweep) + `skills/govern/` + `viewer/` (thin review UI) |
| `retrieval/` | Retrieval service: `scripts/` (dual FTS5 + graph expansion) + `skills/search/` |
| `schema/` | The frozen contract (`contract.md`) + governance conventions (`governance.md`) |
| `docs/` | Installation guides (EN/中文), real-env acceptance checklist, DEVLOG, ADRs |
| `guide/` | Pre-M0 research notes (Chinese) + `materials/` (paper/article snapshots) |
| `install.cmd` / `install.sh` | One-click installers (steps 3-4 of the installation guide) |

The three services have **zero code dependency** on each other; they communicate only
through the knowledge base directory per `schema/contract.md`.

## Tests / 测试

125 tests, all mocked (no network, no PATs):

```bash
cd acquisition/scripts && npm test     # 36
cd governance/scripts && npm test      # 52 (includes viewer)
cd retrieval/scripts  && npm test      # 37 (npm install first)
```
