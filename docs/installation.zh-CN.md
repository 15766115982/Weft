# 安装配置教程

自治理知识库系统：三个完全解耦的服务（获取 / 治理 / 检索），以 Claude Code skill +
Node.js 脚本形态分发。本教程从零开始，带你装到能连内网 Jira/Confluence 跑通为止。

- English version: `installation.md`
- 架构说明：`../CONTEXT.md` · 三方契约：`../schema/contract.md` ·
  真实环境验收清单：`real-env-test.md`

## 1. 前置要求

| 要求 | 版本 | 原因 |
|---|---|---|
| Node.js | **20.x(钉版)** | 用到 global `fetch`、`AbortSignal.timeout`、`node --test`。**不要换主版本**:`better-sqlite3` 是全仓唯一原生依赖,预编译二进制按 ABI 锁定——Node 21+ 会 `ERR_DLOPEN_FAILED`,检索静默坏掉(UI 搜索变 HTTP 400)。必须用其他主版本时,需在该 Node 下重装 better-sqlite3 |
| npm | 随 Node 自带 | 安装唯一的原生依赖（`better-sqlite3`，预编译二进制——不需要编译器） |
| Git | 任意近期版本 | 知识库本身是 Git 仓库 |
| Claude Code | 任意近期版本 | 三个服务以 skill 形态被调用 |

全系统无 Python。无常驻服务，无需运维数据库（SQLite 在 `.kb/` 内，可随时重建）。

## 2. 获取代码

把本仓库 clone 或拷贝到内网机器任意位置，例如 `D:\claude\knowledge-extension`。
路径自选，下文统一以 `<repo>` 指代。

## 3. 安装 Node 依赖

**一键方式**：在仓库根目录运行 `install.cmd`(Windows）或 `./install.sh`
(Linux/macOS)——自动完成本节和第 4 节（Node ≥20 检查、`npm install`、skill 链接）。
下面的手动步骤作为参照和兜底保留。

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

## 4. 把三个 skill 装进 Claude Code

skill 必须以**链接**方式（不是复制）放进 Claude Code 的个人 skill 目录。
每个 SKILL.md 以自身所在目录为基准、向上一层两级定位脚本（`../../scripts/`),
这个相对布局只有在 skill 目录仍位于仓库树内时才成立——文件系统链接恰好能保持这一点。
链接的另一个好处：以后 `git pull` 更新立即生效。

skill 名称（取自各 SKILL.md 的 frontmatter):`kb-acquire`、`kb-govern`、`kb-search`。

**Windows**(cmd.exe，目录联接 junction——不需要管理员权限）:

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

重启 Claude Code 后验证：skill 列表里出现 `kb-acquire`、`kb-govern`、`kb-search`。
每个链接目标目录内必须直接包含一个 `SKILL.md`。

> 不要只把 skill 文件夹**复制**进 `~/.claude/skills/`——复制后脚本不再位于"上两级",
> 每次调用都会报模块找不到。

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
# → http://127.0.0.1:8321(仅监听本机,无登录——单用户工具)
```

第 4 步的 `apply-source`/`apply-topic` 和整个检索循环，正常使用中由 Claude Code 的
skill(kb-govern / kb-search）驱动——它们负责读原文、写摘要、迭代查询。上面这些命令
正是 skill 底层调用的东西；手动跑一遍是最好的安装自检。

要在真实服务器上做完整验收（失败演练、增量跳过验证、XHTML 保真审计），按
`real-env-test.md` 执行。

## 8. 可选：跑测试套件

125 个测试，全部打 mock——不需要网络、不需要 PAT:

```bash
cd <repo>/acquisition/scripts && npm test     # 36 个
cd <repo>/governance/scripts && npm test      # 52 个(含查看器)
cd <repo>/retrieval/scripts  && npm test      # 37 个(需先 npm install)
```

## 9. 日常使用

在任意 Claude Code 会话中（skill 是全局的）:

1. **获取**——说"拉取知识库文档" → kb-acquire 跑连接器；
2. **治理**（人工触发，绝不自动）——说"治理知识库" → kb-govern:
   sweep、plan、写摘要、主题综合、候选评审（对话式或查看器）;
3. **检索**——直接问知识问题 → kb-search：构造结构化查询、CSQE 迭代、带引用作答。

各服务的行为规则写在各自的 SKILL.md 里；三方契约是 `schema/contract.md`。

## 10. 升级

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # 仅当 package-lock.json 有变化
```

skill 链接始终指向仓库，无需重做。若 SKILL.md 本身有改动，重启 Claude Code。

## 11. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 内部 CA——设置 `NODE_EXTRA_CA_CERTS`（见 6.2)；绝不要关闭 TLS 校验 |
| `authentication failed HTTP 401` | PAT 错误/过期/被吊销；到网页端重建。Server/DC 的 PAT 有有效期策略 |
| `confluence PAT not available: environment variable ... is not set` | `setx` 只对新开的终端生效——开**新**窗口（或在当前窗口用 `set` 临时设） |
| `no knowledge base specified` | 传 `--kb <路径>` 或设 `KB_PATH` |
| `kb directory does not exist` | 先建知识库根目录（见第 5 步）；脚本只自动建内部骨架，不建根目录 |
| better-sqlite3 的 `npm install` 失败 | 无 registry 访问或平台无预编译二进制——见第 3 步离线说明 |
| Claude Code 里看不到 skill | 重启 Claude Code；检查链接目标目录里有 `SKILL.md`；确认是链接不是复制（见第 4 步） |
| `node: bad option: --test` 或 `fetch is not defined` | Node 版本低于 20——升级（见第 1 步） |
| 查看器空白 / 翻转返回 409 | 有治理操作在同时进行——关掉查看器，跑 `sweep` 再试（单操作者纪律） |

## 12. 卸载

删除 `~/.claude/skills/` 下的三个链接，再删除 `<repo>`。知识库是独立目录，
保留或删除自便。
