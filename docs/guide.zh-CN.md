# Weft 完整安装与上手指南(2026-08-03;2026-08-04 校订;2026-08-09 ADR-0012 校订:Claude Code skill 形态退役,LLM 层迁入 Python agent/ 服务,治理由图约束 agent 驱动)

> 项目名 **Weft**(纬线——wikilink 把页面织成网);仓库目录沿用旧名
> knowledge-extension。Web 控制台即 Weft(原称 KB Portal)。

> 面向**第一次接触本项目**的用户。照着做,每一步都有"预期结果"可对照;
> 遇到岔子先查文末「故障排查」。本文覆盖**整个项目**:四个后端服务(获取/治理/检索/agent)+ Weft Portal
> Web 控制台。旧版服务安装说明见 `installation.zh-CN.md`
> (本文已包含其全部内容并更新了测试数与 UI 部分)。
>
> **2026-08-09(ADR-0012)**:Claude Code skill 形态与 claude CLI 依赖一同退役;
> 所有模型调用与治理 agent 迁入 Python `agent/` 服务(LangGraph 图约束),
> 一切操作以 Weft Portal 为入口。

---

## 0. 这个项目是什么

一座**自治理知识库**,住在你自己的机器上:

- **获取服务**从 Jira / Confluence / 本地文件把文档拉进 `raw/`(证据层,不可改);
- **治理服务**把证据读成 `wiki/` 里的英文摘要页与主题页——由 **agent 服务**
  (Python + LangGraph)的图约束治理运行驱动,冲突页挂"候选",**人批准后才生效**;
- **检索服务**对批准过的页面做全文索引,供你提问;
- **agent 服务**统一管理所有模型调用(Azure OpenAI SPN / OpenAI 兼容网关)、
  chat / deep-research 问答与治理图 agent;
- **Weft Portal**(本指南重点)是把以上全部串起来的本地 Web 控制台:采集、
  治理、评审、检索、图谱、编辑、chat,一个浏览器页面全搞定。

三条硬约束,先知道不踩雷:

1. **Node ≥ 20**(20 / 22 / 24 均可)且 **Python ≥ 3.11**(agent 服务,建议 64 位)——唯一原生依赖 better-sqlite3 的版本范围是 `~12.4.6 || ^13.0.2`:12.4.x 保住 Node 20 预编译,13.x 适配只发 13.0.2 的内网镜像(13.x 自身要求 Node ≥ 22)。npm 总是解析最高匹配,**Node 20 全新安装若被解析到 13.x 而失败**,钉一次即可:`npm install better-sqlite3@~12.4.6`;
2. **一切都是本机单人的**——portal 只听 127.0.0.1,没有账号系统;
3. **内网离线可跑**——Python 仅限 `agent/`(纯 wheel 依赖,可离线安装),唯一的 npm 原生依赖可以离线拷贝。

## 1. 前置要求(先逐项核对)

| 要求 | 验证命令 | 预期 |
|---|---|---|
| Node.js **≥ 20** | `node --version` | `v20` / `v22` / `v24` 均可(预编译二进制覆盖 Node 20–25)。低于 20 才需要升级 |
| npm | `npm --version` | 随 Node 自带 |
| Git | `git --version` | 任意近期版本 |
| Python **≥ 3.11** | `python --version` | 建议 64 位;agent 服务(全部模型调用 + 治理图 agent)靠它 |

可选(连 Jira/Confluence 才需要):两个系统的 **Personal Access Token**
(网页端:个人头像 → Profile → Personal Access Tokens → 创建)。

## 2. 获取代码

把仓库 clone 或拷贝到内网机器任意位置。下文统一用 `<repo>` 指代,
示例路径 `D:\claude\knowledge-extension`。

```bash
git clone <内部仓库地址> D:\claude\knowledge-extension
# 或者直接拷贝整个目录过来
```

## 3. 安装依赖(一键或手动)

### 3.1 一键方式(推荐)

Windows 在仓库根目录:

```cmd
cd /d <repo>
install.cmd
```

Linux/macOS:`./install.sh`。

脚本会做三件事:检查 Node ≥ 20 / Python ≥ 3.11 → 安装检索服务的 npm 依赖 →
创建 `agent/.venv` 并 `pip install -e agent`。**幂等**,重复跑无害。

### 3.2 手动方式(或一键失败时兜底)

```bash
cd <repo>/retrieval/scripts
npm install

python -m venv <repo>/agent/.venv
<repo>/agent/.venv/Scripts/python -m pip install -e "<repo>/agent"      # Windows
<repo>/agent/.venv/bin/python -m pip install -e "<repo>/agent"          # Linux/macOS
```

**内网完全离线?** npm 侧:联网机器上(操作系统/架构/Node 大版本必须一致)跑
`npm install`,把 `retrieval/scripts/node_modules/` 整个目录拷到目标机同一位置。
pip 侧:指向内部镜像(`pip config set global.index-url <url>`),或联网机器
`pip download` 后离线安装——agent 依赖全是纯 wheel 主流包(httpx / langgraph /
pydantic 等,见 `agent/pyproject.toml`)。

**验证**:`<repo>/agent/.venv/Scripts/python -m weft_agent check --kb <知识库路径>`
返回 `ok: true`(需先完成第 5 节的 models.json 配置)。

## 4. 创建你的知识库

知识库是磁盘上任意一个**独立目录**(不在仓库里),自己是一个 git 仓库。
可以同时有多个。

```cmd
mkdir D:\kb\work
cd /d D:\kb\work
git init
```

新建 `.gitignore`(派生产物不进历史):

```
.kb/
```

新建 `kb.json`(先用最小配置):

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {
    "local": { "inbox": "inbox/" }
  },
  "retrieval": { "embedding": "off" }
}
```

`raw/`、`wiki/`、`log.md`、`.kb/` 不用建,脚本首次运行时自动创建。

> 不 `git init` 也能用——portal 的快照会退化为文件副本,页面历史只剩
> 快照清单,治理运行的自动 git 提交静默跳过,界面上会提示"建议 git init"。
> 建议一开始就 init(治理提交自带固定机器身份 kb-portal/kb-govern,
> 不需要配置 git 的 user.name/user.email)。

## 5. 配置连接器与密钥(只用 local 可跳过)

### 5.1 PAT 只走环境变量

```cmd
setx JIRA_PAT "<你的-jira-pat>"
setx CONFLUENCE_PAT "<你的-confluence-pat>"
```

`setx` 只对**新开**的终端生效。令牌绝不写进 `kb.json`(那是 git 仓库,
写进去就永远留在历史里);kb.json 里最多存变量**名**。

### 5.2 内部 CA(自签名证书才需要)

把内部 CA 导出为 PEM 文件,然后:

```cmd
setx NODE_EXTRA_CA_CERTS "C:\path\to\internal-ca.pem"
```

**绝不要**用 `NODE_TLS_REJECT_UNAUTHORIZED=0`——那会整体关闭证书校验。

### 5.3 kb.json 完整示例

```json
{
  "version": 1,
  "name": "work-kb",
  "connectors": {
    "jira": {
      "base_url": "https://jira.example.com",
      "jql": ["project = PROJ ORDER BY updated DESC"]
    },
    "confluence": {
      "base_url": "https://wiki.example.com",
      "spaces": ["DEV", "REQ"]
    },
    "local": { "inbox": "inbox/" }
  },
  "retrieval": { "embedding": "off" }
}
```

- `spaces` 是空间键数组;也可用 `cql`(字符串或数组),设了会覆盖 `spaces`;
- `pat_env` 省略时默认就是 `JIRA_PAT` / `CONFLUENCE_PAT`;
- **先小后大**:一个小项目 + 一个小空间冒烟通过后再扩范围。

### 5.4 agent 服务模型配置(models.json)

chat / judge / 治理 agent 都要模型。每个 KB 一份 `.kb/config/models.json`,
用模板播种而不是手写(portal「设置」页有对应的两个按钮):

```bash
PY=<repo>/agent/.venv/Scripts/python    # Linux/macOS:.venv/bin/python
# Azure OpenAI(SPN 或 api_key)
$PY -m weft_agent init-config --kb D:\kb\work
# 任意 OpenAI 兼容端点(Kimi / DeepSeek / Copilot 网关 / vLLM …)
$PY -m weft_agent init-config --kb D:\kb\work --input-file "{\"provider\":\"openai\"}"
```

然后编辑 `models.json` 填 endpoint / model / auth。**密钥永远只写环境变量名**
(`auth.api_key` / `auth.client_secret` 的值是环境变量名,不是密钥本身),
真正的密钥 `setx` 进环境。两种 provider 的完整字段说明见
`installation.md` §6.4。配完验证:

```bash
$PY -m weft_agent check --kb D:\kb\work     # ok:true 才算通(会打一次真实调用)
```

## 6. 冒烟测试(命令行层)

逐步跑,每步对照预期(把 `<repo>`、`D:\kb\work` 换成你的路径):

```bash
# ① 认证往返(只用 local 可跳过)
node <repo>/acquisition/scripts/acquire.mjs jira       --kb D:\kb\work --check
node <repo>/acquisition/scripts/acquire.mjs confluence --kb D:\kb\work --check
# 预期:JSON,auth ok;401 说明 PAT 错,证书错见故障排查

# ② 往 D:\kb\work\inbox\ 丢一个 .md 文件(随便什么笔记),然后:
node <repo>/acquisition/scripts/acquire.mjs local --kb D:\kb\work
# 预期:JSON 摘要,raw/local/ 下出现一个 <hash>-文件名.md

# ③ 治理机械步骤
node <repo>/governance/scripts/govern.mjs sweep --kb D:\kb\work
node <repo>/governance/scripts/govern.mjs plan  --kb D:\kb\work
# 预期:plan 输出六类清单的 JSON,pending 里有你刚丢的文档

# ④ 检索(等 wiki/ 有批准页之后才查得到,先确认命令本身能跑)
node <repo>/retrieval/scripts/kb_search.mjs search "test" --kb D:\kb\work
# 预期:JSON;哪怕 0 命中也是正常输出,不是报错
```

④如果报 `ERR_DLOPEN_FAILED` → better-sqlite3 二进制与当前 Node 不匹配,在 `retrieval/scripts` 下重跑 `npm install`。

## 7. 启动 KB Portal(核心)

```bash
node <repo>/ui/serve.mjs --kb D:\kb\work --port 8322
```

预期输出:

```
KB portal listening at http://127.0.0.1:8322  (Ctrl+C to stop; ...)
note: run at most ONE portal per knowledge base (the serial write queue is per-process)
```

浏览器打开 **http://127.0.0.1:8322**。空知识库会看到一张三步引导卡
(采集→治理→评审)——这就是起点。

关于这个进程,三件事:

- **没有账号密码**。安全边界是:只听 127.0.0.1 + 每次启动生成一次性
  token(藏在页面 meta 里)+ 写操作校验 Origin/Host。它为本机单人设计,
  不要拿反向代理把它暴露出去;
- **一个知识库同时只开一个 portal**(写队列是进程内的)。换知识库不用
  重启——界面左上角有 KB 切换器(配置文件见 7.1);
- Ctrl+C 即停,随用随起,不是常驻服务。

### 7.1 多知识库(可选)

建 `<repo>/ui/kbs.json`(仓库侧配置文件,不在知识库里):

```json
{
  "kbs": [
    { "name": "work", "path": "D:/kb/work" },
    { "name": "playground", "path": "D:/kb/play" }
  ]
}
```

启动时 `--kb` 指定的知识库会自动注册为 `default`。顶栏下拉即可切换,
各自的队列、作业、事件流互不相干。

## 8. 第一次完整闭环(15 分钟,强烈建议照做)

在 portal 里把主流程走一遍,每步都看得见东西:

1. **采集**:顶栏点「采集」→ 拖两三个 .md 文件到上传区 → 作业中心出现
   作业,几秒变绿(done)。下方 inbox/raw 列表能看到它们;
2. **治理预览**:点「治理」→ 上半屏就是 plan 六清单——"将要发生什么"
   一目了然(pending 里是你刚传的文档);
3. **发起 agent 治理**:点「发起 agent 治理」→ 提示词框已预填(它是
   **常驻指令 brief**,会注入每个 LLM 判断节点;通常不用改)→「启动运行」。
   转写区实时滚动:sweep → plan → 逐文档写摘要页 → 主题合成 → 重建索引。
   作业变绿后下方出现**治理后校验卡**
   (悬空链接/异常/孤儿页计数,悬空链接可直接跳到所在页面);
   - **这一步在干什么**(ADR-0012):portal 启动 Python `agent/` 服务里的
     **LangGraph 图约束 agent**——流程骨架固定,LLM 只在节点里做结构化判断
     (写摘要/起主题/查冲突),**所有写盘都由 govern.mjs 完成**(agent 没有任何
     直接写文件的工具),每个节点落 checkpoint,进程被杀可从断点续跑;
     跑完 portal 还有一道 git 越界检查;
   - **一次治理一次提交**:运行成功后,portal 自动把本次的 `wiki/` +
     `log.md` 变更提交进知识库的 git(作者署名 kb-portal,只提交本次运行
     弄脏的路径,不会卷入你自己未提交的手改)——治理历史因此可回溯、
     可 diff。非 git 知识库静默跳过;
   - **治理纲要(GOVERNANCE.md)**:治理页「治理纲要」区可以给 agent 写
     **常驻指令**(范围/优先级/页面粒度/语言约定,首次使用点「插入模板」)。
     它由服务端注入每次运行的提示词前部,agent 无权修改它——与单次
     提示词的关系 = 宪法与本期任务。首页会显示「上次 agent 治理」的
     状态(完成/失败/中断/无变更);
4. **评审**:点「评审」→ 队列里是 agent 起草的候选页。逐条看(左边列表
   勾选可**批量批准**;拒绝会二次确认,因为拒绝的页面会被归档);
5. **检索**:点「检索」→ 输入文档里的词 → 命中卡片即时出现;几秒后
   卡片上浮现 **judge 评分徽标**(0-3 分,悬停看理由)——这是 LLM 在
   给这次检索的结果质量打分。卡片右侧 👍/👎 可以投票,差评查询会沉淀成
   评测黄金集候选;
6. **浏览与图谱**:点「浏览」读页面(右侧栏:信息/反链/历史/大纲四个
   tab);点「图谱」看整库的关系网——悬停高亮邻居,点击跳页面;
7. **改错**:发现哪页写得不对,页面右栏「编辑」直接改 → 保存后页面
   **自动降级为候选**回评审队列(改一个错别字也会——这是规则,不是
   bug;重新批准前它会暂时从检索消失)。

走完这一圈,安装就是真的完整了。

## 9. 连接 Jira / Confluence 后的拉取

「采集」页每张源卡片(Jira / Confluence)上:

- **认证检查**按钮 = 第 6 步 `--check` 的 UI 化,先点它;
- **形状探针**按钮 = `--probe` 的 UI 化:输出 Zephyr/Gliffy 响应的**结构摘要**
  (类型/键名/数量,不含任何数据值);Gliffy 探针还会列出页面**真实附件标题**、
  宏名匹配命中的附件和下载通道、每次下载的 HTTP 状态——内网诊断时把这段文本
  原样发给开发者即可;
- 输入可选的范围覆盖(JQL / CQL / max)→「拉取」→ 作业中心看进度;
  卡片标题栏的 **? 按钮**是常用 CQL/JQL 速查(含「拉整棵子树」的
  `ancestor` 写法),每条带「填入」一键落进输入框;
- **新鲜度面板**显示每个源上次拉取时间、文档数、滞后天数(超 7 天变
  琥珀色);Jira 源还会显示 `zephyr available` 状态,Confluence 源显示宏解析计数;
- **Zephyr(测试插件)**:Jira 里 Test 类型的 issue 会自动带上 Test Steps 表格
  (Test Steps/Test Data/Expected Result 三列,走 Zephyr API,不用配置);
- **Confluence 宏**:Gliffy 图按宏名在页面**真实附件列表**里匹配后提取全部文字标签
  (图附件通常无扩展名,2026-08-04 起不再猜 `<name>.gliffy`);若页面真有一张图片附件
  还会把它存到 `raw/confluence/<页面id>.assets/` 嵌进文档(浏览 raw 时能看到图)、
  Jira Issue Filter 宏会变成实时查询的 issue 表格、Gallery 宏变成图片清单;
- 拉进来的东西不满意?「浏览」切到 raw 页签,可删可移(删除前有影响
  预览和自动快照,不盲删)。raw 内容本身**永远不可改**(契约)——
  local 文档想改就同名文件重传 inbox;Jira/Confluence 的去源系统改。

## 10. 命令行使用(可选)

所有服务都是独立 CLI,不开 portal 也能直接用:

- 采集:`node <repo>/acquisition/scripts/acquire.mjs local --kb <路径>`;
- 治理:`agent/.venv/Scripts/python -m weft_agent govern-run --kb <路径>
  --output-file <ndjson 路径>`(cwd 在 `agent/` 或设 `PYTHONPATH`);
- 检索:`node <repo>/retrieval/scripts/kb_search.mjs search "<词>" --kb <路径>`;
- 问答:`python -m weft_agent chat --kb <路径> --input-file <json> --output-file <ndjson>`。

它们与 portal 只通过知识库目录通信,互不依赖。

## 11. 可选:跑测试套件

全部打 mock,不需要网络/PAT:

```bash
cd <repo>/acquisition/scripts && npm test     # 75
cd <repo>/governance/scripts && npm test      # 83(含薄查看器)
cd <repo>/retrieval/scripts  && npm test      # 46(需先 npm install)
cd <repo>/agent              && .venv/Scripts/python -m pytest tests/  # 70
cd <repo>/ui                 && node --test test/   # 96
cd <repo>                    && node --test tests/e2e/ tests/eval/  # 91(e2e + govern-run + 检索评测)
```

全绿即环境无误。检索评测还会把命中率报告写到
`docs/test-reports/retrieval-eval-latest.md`。

## 12. 升级与卸载

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # 刷新 better-sqlite3 预编译二进制(仓库不含 lockfile,按当前 Node 现解析)
agent/.venv/Scripts/python -m pip install -e "<repo>/agent"   # agent 依赖有变化时
```

卸载:直接删 `<repo>`(`agent/.venv` 随之删除)。知识库是独立目录,保留或删除自便。

## 13. 想把安装交给 AI 助手?

把下面这段**原样粘贴**给任意能跑命令行的 AI 助手(改两处路径):

```
请按 D:\claude\knowledge-extension\docs\guide.zh-CN.md 给我完整安装这个项目:
1) 先核对第 1 节前置要求(Node ≥ 20,Python ≥ 3.11);
2) 执行第 3 节(install.cmd 或手动 npm install + agent venv);
3) 按第 4 节在 D:\kb\work 创建知识库(git init + .gitignore + 最小 kb.json);
4) 跑第 6 节冒烟测试(只用 local 连接器,inbox 里放一个示例 .md);
5) 用第 7 节命令后台启动 portal,确认 http://127.0.0.1:8322 能打开。
每步完成后用该节的"预期"自检,失败就查指南第 14 节故障排查再继续。
```

本指南的写作精度就是按"可执行"标准来的(每步有命令、有预期、有排错索引)。

## 14. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| UI 搜索报 HTTP 400 / `ERR_DLOPEN_FAILED` | better-sqlite3 的预编译二进制与当前 Node 大版本不匹配——在 `retrieval/scripts` 下重跑 `npm install`(会按当前 Node 重新下载对应二进制) |
| `SELF_SIGNED_CERT_IN_CHAIN` | 内部 CA——设 `NODE_EXTRA_CA_CERTS`(5.2);绝不关 TLS 校验 |
| `authentication failed HTTP 401` | PAT 错/过期——网页端重建;`setx` 后要开**新**终端 |
| 拉取时 Gliffy 报 `[gliffy diagram: … — HTTP 404]` | 2026-08-04 起连接器会列出页面**真实附件**再按宏名匹配(不再猜 `<name>.gliffy`——真图附件通常无扩展名)。仍 404 时用「采集」页**形状探针**(`--probe <页面id>`)定位:`attachments` 看附件到底叫什么;`matched: null` 且 `legacy_guess.http` 也是 404 → `/download/attachments/` 被反代拦了,把 probe 输出整段发给开发者 |
| 启动 portal 报 `EADDRINUSE` | 旧 portal 还占着 8322:`netstat -ano | findstr :8322` 找到 PID,`taskkill /PID <pid> /F` |
| agent 治理立刻失败,日志说 spawn 失败/找不到命令 | Python 环境没装好——重跑第 3 节(agent venv),或设 `WEFT_AGENT_PYTHON` 指向有效解释器后重启 portal |
| agent 运行里某篇文档失败但流程继续 | 设计如此——单文档失败进 `doc_errors` 并继续;报告里逐篇列出,修好原文后重跑即可(断点续跑不会重做已成功的篇目) |
| judge 徽标一直转圈不出现 | 首次调用 LLM 约 10-30 秒,正常;一直不出看 portal 控制台报错(通常是 models.json 未配或 Python 环境缺失) |
| `no knowledge base specified` | 命令忘了 `--kb <路径>`,或设 `KB_PATH` 环境变量 |
| 页面编辑保存返回 409 | 编辑期间页面被别处改过(agent 治理或另一次保存)——按冲突卡选"查看最新"或"强制覆盖" |
| 批准/保存/上传等写操作突然 403(提示 per-startup token) | portal/viewer 重启过,开着的页面持的是旧令牌——刷新页面即可 |
| 治理后图谱里某条边不出现 | 边取自检索索引,页面重建索引前是冻结的——治理台跑「重建索引」 |
| `node: bad option: --test` / `fetch is not defined` | Node 低于 20 |

## 15. 安装完成自检单

- [ ] `node --version` ≥ 20(20 / 22 / 24 均可),`python --version` ≥ 3.11
- [ ] `agent/.venv` 已创建,`python -m weft_agent check` 返回 ok(配好 models.json 后)
- [ ] 冒烟 ①-④ 全部符合预期
- [ ] `http://127.0.0.1:8322` 打开,空库引导卡可见
- [ ] 走完第 8 节闭环:上传 → agent 治理 → 评审批准 → 检索命中 → judge 徽标出现
- [ ] (可选)六个测试套件全绿

---

相关文档:架构 `../CONTEXT.md` · 三方契约 `../schema/contract.md` ·
开发日志 `DEVLOG.md` · 真实环境验收清单 `real-env-test.md` ·
旧版服务安装说明 `installation.zh-CN.md`
