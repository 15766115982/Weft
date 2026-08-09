# 安装配置教程

> **新版完整指南(`guide.zh-CN.md`,2026-08-03)已发布**——覆盖三服务 +
> KB Portal Web 控制台 + Claude Code 委托安装提示词,新用户请以它为准;
> 本文保留作为纯服务层的参照。

自治理知识库系统：五个完全解耦的服务（获取 / 治理 / 检索 / agent / UI 门户）——
Node.js 脚本加一个 Python 服务（ADR-0012,2026-08 起 Claude Code skill 形态随 claude CLI
依赖一同退役）。本教程从零开始，带你装到能连内网 Jira/Confluence 跑通为止。

- English version: `installation.md`
- 架构说明：`../CONTEXT.md` · 三方契约：`../schema/contract.md` ·
  真实环境验收清单：`real-env-test.md`

## 1. 前置要求

| 要求 | 版本 | 原因 |
|---|---|---|
| Node.js | **≥ 20**(20 / 22 / 24 均已验证) | 用到 global `fetch`、`AbortSignal.timeout`、`node --test`。全仓唯一原生依赖 `better-sqlite3` 版本范围 `~12.4.x`：其预编译二进制覆盖 Node 20–25(12.5+ 砍掉了 Node 20 预编译,所以范围收在 12.4.x)。更换 Node 大版本无需改配置——`npm install` 会自动下载与当前 Node 匹配的预编译二进制 |
| npm | 随 Node 自带 | 安装唯一的原生依赖（`better-sqlite3`，预编译二进制——不需要编译器） |
| Git | 任意近期版本 | 知识库本身是 Git 仓库 |
| Python | **≥ 3.11**（建议 64 位） | agent 服务（`agent/`)——全部模型调用与治理图 agent |

Python 只存在于 agent 服务（ADR-0012 将"No Python"修订为"Python 仅限 `agent/`")，
其余服务均为纯 Node。无常驻服务，无需运维数据库（SQLite 在 `.kb/` 内，可随时重建）。

第四个服务 `agent/`(Python + LangGraph）统一管理所有模型调用（Azure OpenAI SPN 与
OpenAI 兼容网关）、chat/deep-research 管线与图约束治理运行，通过 CLI
(`python -m weft_agent <task>`）被门户与评测套件调用——服务间永不互相 import。
prompt 模板在 `<repo>/templates/prompts/`，每个 KB 可在 `.kb/config/prompts/` 覆盖。

## 2. 获取代码

把本仓库 clone 或拷贝到内网机器任意位置，例如 `D:\claude\knowledge-extension`。
路径自选，下文统一以 `<repo>` 指代。

## 3. 安装 Node 依赖

**一键方式**：在仓库根目录运行 `install.cmd`(Windows）或 `./install.sh`
(Linux/macOS)——自动完成本节和第 4 节（Node ≥20 / Python ≥3.11 检查、`npm install`、
agent venv + `pip install -e agent`)。下面的手动步骤作为参照和兜底保留。

只有检索服务有依赖：

```bash
cd <repo>/retrieval/scripts
npm install
```

`better-sqlite3` 下载的是**预编译** Windows 二进制，不需要任何编译链。
获取、治理两个服务零依赖，无需安装。

> **内网完全离线？** 目标机访问不了 npm registry 时，二选一：把 npm 指向内部镜像
> （`npm config set registry <镜像地址>`)；或在**操作系统/架构/Node 大版本相同**的
> 联网机器上执行 `npm install`，把产出的 `retrieval/scripts/node_modules/` 整个
> 目录拷过去（预编译二进制是平台相关的，机器不一致不能拷）。

## 4. 安装 agent 服务（Python 环境）

agent 服务运行在自己的虚拟环境 `agent/.venv`（门户与测试会自动解析；可用环境变量
`WEFT_AGENT_PYTHON` 覆盖）:

```bash
python -m venv <repo>/agent/.venv
<repo>/agent/.venv/Scripts/python -m pip install -e "<repo>/agent"      # Windows
<repo>/agent/.venv/bin/python -m pip install -e "<repo>/agent"          # Linux/macOS
```

依赖全是纯 wheel 包（httpx、langgraph、pydantic——无原生编译）。刻意不使用
`langgraph-checkpoint-sqlite`（其依赖 sqlite-vec 无 32 位轮且是原生包）；运行断点
用内置的纯 JSON saver(`agent/weft_agent/checkpoints.py`)。

> **离线内网？** 与 npm 同理：把 pip 指向内部镜像
> (`pip config set global.index-url <url>`)，或在联网机器 `pip download` 后离线安装。
> 注意镜像的高危包拦截规则——依赖集都是主流包（见 `agent/pyproject.toml`)。

## 5. 创建知识库实例

知识库是磁盘上任选的一个目录，**独立于代码仓库**，且自身是一个 Git 仓库。
可以同时存在多个知识库。

```bash
# 以 Windows 为例，任意路径均可
mkdir D:\kb\work
cd D:\kb\work
git init
```

加 `.gitignore`，让派生产物不进历史：

```
.kb/
```

创建 `kb.json`（先最小化，连接器在第 6 步配）:

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {},
  "retrieval": { "embedding": "off" }
}
```

到此即可——`raw/`、`wiki/`、`log.md`、`.kb/` 会在首次使用时由脚本自动创建。
所有命令都接受 `--kb <路径>`；也可以一次性设好 `KB_PATH` 环境变量（两者同时存在时
`--kb` 优先）。

> 知识库的 `raw/` 会存放真实内网内容，提交进 Git 前请先确认单位的安全政策。

> git 在这里是承重的，不只是卫生习惯：治理运行会把 `wiki/` + `log.md` 的变更
> 自动提交（一次治理一次提交——portal 在服务端自动做），查看器的冲突 diff 和 portal 的页面历史都读这段历史。
> 非 git 知识库一切照常，只是快照退化为文件副本。治理提交自带固定机器身份
> （`kb-portal` / `kb-govern`,`-c` 旗标注入）——机器上**不需要**配置 git 的
> user.name/user.email。

## 6. 配置连接器与密钥

### 6.1 密钥——只走环境变量

PAT 只存在于环境变量中；`kb.json` 最多存变量**名**。知识库是 Git 仓库——
提交进去的令牌会永远留在历史里。

**Windows**（对当前用户持久化；设完要开**新**终端）:

```cmd
setx JIRA_PAT "<你的-jira-pat>"
setx CONFLUENCE_PAT "<你的-confluence-pat>"
```

**Linux / macOS**：把 `export JIRA_PAT=...` / `export CONFLUENCE_PAT=...` 写进
shell 配置文件。

两者都是 Server/DC 的个人访问令牌（Bearer 认证），在 Jira/Confluence 网页端的
个人资料 → Personal Access Tokens 里创建。

### 6.2 内部 CA（自签名证书）

Node 的 fetch 会拒绝企业内网/自签名证书链。如果 Jira 或 Confluence 主机使用内部 CA,
先把 CA 证书导出为 PEM，然后：

```cmd
setx NODE_EXTRA_CA_CERTS "C:\path\to\internal-ca.pem"
```

**绝不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕开证书错误——那会整体关闭证书校验。

### 6.3 kb.json 连接器范围

完整示例（契约 §6):

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

- jira `jql`:JQL 范围数组；
- confluence `spaces`：空间键数组（每个键生成一条 CQL 范围）；也可用 `cql`
  （字符串或数组），设置后**覆盖** `spaces`;
- local `inbox`：手工导出文件的投放目录（相对 kb-root 或绝对路径），支持
  `.md`/`.txt`;
- `pat_env` 可省略——默认就是 `JIRA_PAT` / `CONFLUENCE_PAT`。

先用一个小项目 + 一个小空间起步，冒烟通过后再扩大范围。

## 7. 冒烟测试

在任意目录执行（替换 `<repo>` 和你的知识库路径）:

```bash
# 1. 认证往返（需要 6.1 的 PAT 环境变量）
node <repo>/acquisition/scripts/acquire.mjs jira       --kb D:\kb\work --check
node <repo>/acquisition/scripts/acquire.mjs confluence --kb D:\kb\work --check

# 2. 小量拉取（封顶 20 条；截断会被上报，绝不静默）
node <repo>/acquisition/scripts/acquire.mjs confluence --kb D:\kb\work --max 20
node <repo>/acquisition/scripts/acquire.mjs jira       --kb D:\kb\work --max 20

# 3. 本地连接器（先往 inbox 里丢一个 .md 文件）
node <repo>/acquisition/scripts/acquire.mjs local --kb D:\kb\work

# 4. 治理:sweep → plan →(对每项 apply-source)→ rebuild-index
node <repo>/governance/scripts/govern.mjs sweep --kb D:\kb\work
node <repo>/governance/scripts/govern.mjs plan  --kb D:\kb\work

# 5. 检索(wiki/ 里至少有一页之后)
node <repo>/retrieval/scripts/kb_search.mjs search "语料里的某个词" --kb D:\kb\work

# 6. 薄查看器(候选评审界面;Ctrl+C 停止)
node <repo>/governance/viewer/serve.mjs --kb D:\kb\work
# → http://127.0.0.1:8321(仅监听本机,无登录——单用户工具。写操作带每次启动
#   生成的一次性 token(注入页面 meta)+ Origin/Host 校验;正常使用无感,
#   重启查看器后刷新一下页面即可)

# 7. UI portal(此处可选;完整控制台——浏览/检索/评审/采集/治理,
#    见 guide.zh-CN.md §7-8)
node <repo>/ui/serve.mjs --kb D:\kb\work
# → http://127.0.0.1:8322(同样的本机 + token + Origin/Host 姿态)
```

第 4 步的逐篇 `apply-source` 与主题合成，正常使用中由门户的 **govern-run**(LangGraph
图约束 agent:sweep → plan → 逐文档 → 合成 → rebuild-index）驱动——它底层调用的正是
上面这些 CLI 命令，LLM 只负责写摘要与合成。手动跑一遍命令仍是最好的安装自检。

要在真实服务器上做完整验收（失败演练、增量跳过验证、XHTML 保真审计），按
`real-env-test.md` 执行。

## 8. 可选：跑测试套件

258 个测试、五个套件，全部打 mock——不需要网络、不需要 PAT:

```bash
cd <repo>/acquisition/scripts && npm test            # 59 个
cd <repo>/governance/scripts && npm test             # 54 个(含薄查看器)
cd <repo>/retrieval/scripts  && npm test             # 37 个(需先 npm install)
cd <repo>/ui                 && node --test test/    # 69 个(零依赖)
cd <repo> && node --test tests/e2e/ tests/eval/      # 39 个(e2e 全流程 + 检索评测)
```

## 9. 日常使用

全在浏览器里驱动：`node <repo>/ui/serve.mjs --kb <路径>` 启动按需
UI portal(http://127.0.0.1:8322；浏览/检索/评审/采集控制台/agent 治理
控制台/图谱/chat；多知识库切换器见 `<repo>/ui/kbs.json`):

1. **获取**——采集控制台跑连接器（或命令行 `acquire.mjs`);
2. **治理**（人工触发，绝不自动）——治理面板的 govern-run(LangGraph 图约束 agent:
   sweep → plan → 逐文档摘要 → 主题合成 → rebuild-index;LLM 只做结构化判断，
   写盘全走 govern.mjs)，候选页进评审队列人工裁决；
3. **检索**——搜索页或直接 chat(quick/deep/deep-research 三档，带引用作答）。

完整走查见 `guide.zh-CN.md` §7-8。三方契约是 `schema/contract.md`。

## 10. 升级

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # 刷新 better-sqlite3 预编译二进制
                                      # (仓库不含 package-lock.json——按当前 Node 现解析)
```

agent 依赖有变化时重装:`<repo>/agent/.venv/Scripts/python -m pip install -e "<repo>/agent"`。

## 11. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 内部 CA——设置 `NODE_EXTRA_CA_CERTS`（见 6.2)；绝不要关闭 TLS 校验 |
| `authentication failed HTTP 401` | PAT 错误/过期/被吊销；到网页端重建。Server/DC 的 PAT 有有效期策略 |
| `confluence PAT not available: environment variable ... is not set` | `setx` 只对新开的终端生效——开**新**窗口（或在当前窗口用 `set` 临时设） |
| `no knowledge base specified` | 传 `--kb <路径>` 或设 `KB_PATH` |
| `kb directory does not exist` | 先建知识库根目录（见第 5 步）；脚本只自动建内部骨架，不建根目录 |
| better-sqlite3 的 `npm install` 失败 | 无 registry 访问或平台无预编译二进制——见第 3 步离线说明 |
| 门户 LLM 任务报 python 找不到 / 模块错误 | agent venv 缺失或过期——重跑第 4 步，或用 `WEFT_AGENT_PYTHON` 指向有效解释器 |
| `node: bad option: --test` 或 `fetch is not defined` | Node 版本低于 20——升级（见第 1 步） |
| 查看器空白 / 翻转返回 409 | 有治理操作在同时进行——关掉查看器，跑 `sweep` 再试（单操作者纪律） |
| 查看器/portal 写操作返回 403 `write requests require the per-startup token` | 开着的页面是上一次启动的，持的是已失效的旧令牌——刷新页面 |

## 12. 卸载

直接删除 `<repo>`(`agent/.venv` 随之删除)。知识库是独立目录，
保留或删除自便。
