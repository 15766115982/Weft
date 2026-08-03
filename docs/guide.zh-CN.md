# Weft 完整安装与上手指南(2026-08-03)

> 项目名 **Weft**(纬线——wikilink 把页面织成网);仓库目录沿用旧名
> knowledge-extension。Web 控制台即 Weft(原称 KB Portal)。

> 面向**第一次接触本项目**的用户。照着做,每一步都有"预期结果"可对照;
> 遇到岔子先查文末「故障排查」。如果打算让 Claude Code 替你装,直接读
> 第 13 节——那里有一段可以原样粘贴的委托提示词。
>
> 本文覆盖**整个项目**:三个后端服务(获取/治理/检索)+ 三个 Claude Code
> skill + KB Portal Web 控制台。旧版服务安装说明见 `installation.zh-CN.md`
> (本文已包含其全部内容并更新了测试数与 UI 部分)。

---

## 0. 这个项目是什么

一座**自治理知识库**,住在你自己的机器上:

- **获取服务**从 Jira / Confluence / 本地文件把文档拉进 `raw/`(证据层,不可改);
- **治理服务**(由 LLM agent 驱动)把证据读成 `wiki/` 里的英文摘要页与主题页,
  全部先挂"候选",**人批准后才生效**;
- **检索服务**对批准过的页面做全文索引,供你提问;
- **KB Portal**(本指南重点)是把以上全部串起来的本地 Web 控制台:采集、
  治理、评审、检索、图谱、编辑,一个浏览器页面全搞定。

三条硬约束,先知道不踩雷:

1. **Node ≥ 20**(20 / 22 / 24 均可)——唯一原生依赖 better-sqlite3 的预编译二进制覆盖 Node 20–25;
2. **一切都是本机单人的**——portal 只听 127.0.0.1,没有账号系统;
3. **内网离线可跑**——全系统无 Python,唯一的 npm 依赖可以离线拷贝。

## 1. 前置要求(先逐项核对)

| 要求 | 验证命令 | 预期 |
|---|---|---|
| Node.js **≥ 20** | `node --version` | `v20` / `v22` / `v24` 均可(预编译二进制覆盖 Node 20–25)。低于 20 才需要升级 |
| npm | `npm --version` | 随 Node 自带 |
| Git | `git --version` | 任意近期版本 |
| Claude Code | `claude --version` | 任意近期版本;且 **`claude.cmd` 在 PATH 里**(portal 的 agent 治理要靠它,Windows 装完 Claude Code 默认就在) |

可选(连 Jira/Confluence 才需要):两个系统的 **Personal Access Token**
(网页端:个人头像 → Profile → Personal Access Tokens → 创建)。

## 2. 获取代码

把仓库 clone 或拷贝到内网机器任意位置。下文统一用 `<repo>` 指代,
示例路径 `D:\claude\knowledge-extension`。

```bash
git clone <内部仓库地址> D:\claude\knowledge-extension
# 或者直接拷贝整个目录过来
```

## 3. 安装依赖 + 链接 skill(一键或手动)

### 3.1 一键方式(推荐)

Windows 在仓库根目录:

```cmd
cd /d <repo>
install.cmd
```

Linux/macOS:`./install.sh`。

脚本会做三件事:检查 Node ≥ 20 → 安装检索服务的 npm 依赖 → 把三个
skill 以链接方式装进 `~/.claude/skills/`。**幂等**,重复跑无害。

### 3.2 手动方式(或一键失败时兜底)

```bash
cd <repo>/retrieval/scripts
npm install
```

然后链接三个 skill(**必须是链接,不能是复制**——SKILL.md 按
`../../scripts/` 相对定位脚本,复制即断;链接还让 `git pull` 立即生效):

```cmd
:: Windows(cmd.exe,junction,不需要管理员)
mklink /J "%USERPROFILE%\.claude\skills\kb-acquire" "<repo>\acquisition\skills\acquire"
mklink /J "%USERPROFILE%\.claude\skills\kb-govern"  "<repo>\governance\skills\govern"
mklink /J "%USERPROFILE%\.claude\skills\kb-search"  "<repo>\retrieval\skills\search"
```

```bash
# Linux / macOS
ln -s <repo>/acquisition/skills/acquire ~/.claude/skills/kb-acquire
ln -s <repo>/governance/skills/govern   ~/.claude/skills/kb-govern
ln -s <repo>/retrieval/skills/search    ~/.claude/skills/kb-search
```

**内网完全离线?** 联网机器上(操作系统/架构/Node 大版本必须一致)跑
`npm install`,把 `retrieval/scripts/node_modules/` 整个目录拷到目标机
同一位置。预编译二进制是平台相关的,机器不一致不能拷。

**验证**:重启 Claude Code,skill 列表出现 `kb-acquire`、`kb-govern`、
`kb-search`;每个链接目标目录里直接有一个 `SKILL.md`。

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
> 快照清单,界面上会提示"建议 git init"。建议一开始就 init。

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
3. **发起 agent 治理**:点「发起 agent 治理」→ 提示词已预填好
   (通常不用改)→「启动运行」。转写区实时滚动:agent 读 skill、跑脚本、
   读 raw、写候选页。一两分钟后作业变绿,下方出现**治理后校验卡**
   (悬空链接/异常/孤儿页计数,悬空链接可直接跳到所在页面);
   - **这一步在干什么**:portal 用你机器上的 `claude.cmd` 跑了一个
     headless agent,权限被限定在知识库目录内(acceptEdits + 自动生成的
     allow-list,细节见 `docs/webui/spike-p2-2.zh-CN.md`)——它**写不了
     KB 以外的地方**,跑完还有一道 git 越界检查;
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
  (类型/键名/数量,不含任何数据值)——内网诊断时把这段文本原样发给开发者即可;
- 输入可选的范围覆盖(JQL / CQL / max)→「拉取」→ 作业中心看进度;
- **新鲜度面板**显示每个源上次拉取时间、文档数、滞后天数(超 7 天变
  琥珀色);Jira 源还会显示 `zephyr available` 状态,Confluence 源显示宏解析计数;
- **Zephyr(测试插件)**:Jira 里 Test 类型的 issue 会自动带上 Test Steps 表格
  (Test Steps/Test Data/Expected Result 三列,走 Zephyr API,不用配置);
- **Confluence 宏**:Gliffy 图会提取全部文字标签并把 PNG 存到
  `raw/confluence/<页面id>.assets/` 嵌进文档(浏览 raw 时能看到图)、Jira
  Issue Filter 宏会变成实时查询的 issue 表格、Gallery 宏变成图片清单;
- 拉进来的东西不满意?「浏览」切到 raw 页签,可删可移(删除前有影响
  预览和自动快照,不盲删)。raw 内容本身**永远不可改**(契约)——
  local 文档想改就同名文件重传 inbox;Jira/Confluence 的去源系统改。

## 10. 和 Claude Code 对话式使用(可选但推荐)

三个 skill 是全局的,任意 Claude Code 会话里:

- 说"拉取知识库文档" → `kb-acquire` 跑连接器;
- 说"治理知识库" → `kb-govern` 走完整治理流(sweep → plan → 写摘要 →
  候选评审);
- 直接问知识问题 → `kb-search` 构造结构化查询、带引用作答。

portal 与对话**可以混用**:它们只通过知识库目录通信,互不依赖。portal
的 agent 治理和 kb-govern skill 走的是同一套 SKILL.md 工作流。

## 11. 可选:跑测试套件

全部打 mock,不需要网络/PAT:

```bash
cd <repo>/acquisition/scripts && npm test     # 59
cd <repo>/governance/scripts && npm test      # 53(含薄查看器)
cd <repo>/retrieval/scripts  && npm test      # 37(需先 npm install)
cd <repo>/ui                 && node --test test/   # 67
cd <repo>                    && node --test tests/  # 39(e2e + 检索评测)
```

全绿即环境无误。检索评测还会把命中率报告写到
`docs/test-reports/retrieval-eval-latest.md`。

## 12. 升级与卸载

```bash
cd <repo> && git pull
cd retrieval/scripts && npm install   # 仅当 package-lock.json 变了
```

skill 链接始终指向仓库,不用重做;SKILL.md 有改动就重启 Claude Code。

卸载:删掉 `~/.claude/skills/` 下三个链接 → 删 `<repo>`。知识库是独立
目录,保留或删除自便。

## 13. 想把安装交给 Claude Code?

新开一个 Claude Code 会话,把下面这段**原样粘贴**(改两处路径):

```
请按 D:\claude\knowledge-extension\docs\guide.zh-CN.md 给我完整安装这个项目:
1) 先核对第 1 节前置要求(Node ≥ 20,claude.cmd 在 PATH);
2) 执行第 3 节(install.cmd 或手动 npm install + junction 链接三个 skill);
3) 按第 4 节在 D:\kb\work 创建知识库(git init + .gitignore + 最小 kb.json);
4) 跑第 6 节冒烟测试(只用 local 连接器,inbox 里放一个示例 .md);
5) 用第 7 节命令后台启动 portal,确认 http://127.0.0.1:8322 能打开。
每步完成后用该节的"预期"自检,失败就查指南第 14 节故障排查再继续。
```

Claude Code 会自己读这份指南逐步执行——本指南的写作精度就是按"可执行"
标准来的(每步有命令、有预期、有排错索引)。

## 14. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| UI 搜索报 HTTP 400 / `ERR_DLOPEN_FAILED` | better-sqlite3 的预编译二进制与当前 Node 大版本不匹配——在 `retrieval/scripts` 下重跑 `npm install`(会按当前 Node 重新下载对应二进制) |
| `SELF_SIGNED_CERT_IN_CHAIN` | 内部 CA——设 `NODE_EXTRA_CA_CERTS`(5.2);绝不关 TLS 校验 |
| `authentication failed HTTP 401` | PAT 错/过期——网页端重建;`setx` 后要开**新**终端 |
| 启动 portal 报 `EADDRINUSE` | 旧 portal 还占着 8322:`netstat -ano | findstr :8322` 找到 PID,`taskkill /PID <pid> /F` |
| agent 治理立刻失败,日志说 spawn 失败/找不到命令 | `claude.cmd` 不在 PATH——装好 Claude Code 或把它的 bin 加进 PATH,重启 portal |
| agent 运行里某些命令"被权限拒绝" | 正常的——加固姿态只允许 `node <repo>/**` 脚本、只读 git、KB 内写。agent 会换允许的方式继续;这是设计,不是故障 |
| judge 徽标一直转圈不出现 | 首次调用 LLM 约 10-30 秒,正常;一直不出看 portal 控制台报错(通常是 claude.cmd 不在 PATH) |
| Claude Code 里看不到 skill | 重启 Claude Code;确认 `~/.claude/skills/kb-*/SKILL.md` 存在;确认是链接不是复制(3.2) |
| `no knowledge base specified` | 命令忘了 `--kb <路径>`,或设 `KB_PATH` 环境变量 |
| 页面编辑保存返回 409 | 编辑期间页面被别处改过(agent 治理或另一次保存)——按冲突卡选"查看最新"或"强制覆盖" |
| 治理后图谱里某条边不出现 | 边取自检索索引,页面重建索引前是冻结的——治理台跑「重建索引」 |
| `node: bad option: --test` / `fetch is not defined` | Node 低于 20 |

## 15. 安装完成自检单

- [ ] `node --version` ≥ 20(20 / 22 / 24 均可)
- [ ] `~/.claude/skills/` 下有三个链接,各含 SKILL.md
- [ ] 冒烟 ①-④ 全部符合预期
- [ ] `http://127.0.0.1:8322` 打开,空库引导卡可见
- [ ] 走完第 8 节闭环:上传 → agent 治理 → 评审批准 → 检索命中 → judge 徽标出现
- [ ] (可选)五个测试套件全绿

---

相关文档:架构 `../CONTEXT.md` · 三方契约 `../schema/contract.md` ·
开发日志 `DEVLOG.md` · 真实环境验收清单 `real-env-test.md` ·
旧版服务安装说明 `installation.zh-CN.md`
