# Zephyr Test 用例 + Confluence 宏适配调研(2026-08-03)

> 触发:内网 Jira 用 Zephyr 插件,测试用例是 Test 类型 issue,含复数
> Test Steps / Test Data / Test Result,当前连接器只拉标准字段,全部丢失;
> 内网 Confluence 常用 Gliffy Diagram / Jira Issue Filter / Gallery / TOC 宏,
> 当前转换器对未知宏只留 `[macro: name]` 占位符,内容整个丢失。
> 方法:GitHub API(curl,本机 WebFetch 拦 github)+ 厂商文档 + 真实 fixture 验证。

## 结论(一句话)

**两块都可适配,且核心路径不需要 LLM、不需要新 npm 依赖**;没有现成开源
方案可直接抄(所有 confluence→markdown 工具对这些宏同样只能降级),但拿到了
全部三种宏的真实 storage-format fixture 和 .gliffy 文件格式参照,自研工作量可控。
LLM 只用于 Gliffy 的**可选增强**(语义描述),降级链:确定性解析 → 多模态 LLM → OCR。

---

## 一、Jira Zephyr:Test 类型 issue 的 Test Steps

### 1.1 产品判定:Zephyr Squad(不是 Scale)

Atlassian 生态有两个 Zephyr 产品,机制完全不同:

| | Zephyr Squad(原 Zephyr for Jira) | Zephyr Scale(原 TM4J) |
|---|---|---|
| 测试用例存储 | **就是 Jira issue,类型名 "Test"** | 独立实体(Jira issue 之外) |
| Steps API | `/rest/zapi/latest/teststep/{issueId}` | `/rest/atm/1.0/testcase/{key}/teststeps` |
| Server/DC 认证 | 与 Jira 同(PAT / Basic / Cookie) | 与 Jira 同 |

用户描述"测试用例会创建成 Test 类型,内含复数 Test Steps/Test Data/Test
Result"——这正是 **Squad** 的特征(issue 视图内嵌 Test Details 区,Steps /
Data / Expected Result 三列)。下文按 Squad 设计,Scale 作为意外分支留探测口。

### 1.2 关键事实:Steps 不在 Jira 字段里

Squad 的 Test Steps 存在 Zephyr 自己的表里,**任何 fields 展开都拿不到**
——这就是当前连接器"拉不到"的根因,不是 JQL 范围问题。必须走 ZAPI:

```
GET {base}/rest/zapi/latest/teststep/{issueId}
Authorization: Bearer <JIRA_PAT>        # Server/DC 与 Jira 同源认证,零新增凭证
```

响应(steps 数组,字段经 GitHub 上 Server 端实现交叉验证):

```json
[
  { "id": 10001, "orderId": 1,
    "step": "打开登录页", "data": "用户A/密码X", "result": "登录成功",
    "htmlStep": "...", "htmlData": "...", "htmlResult": "...",
    "createdBy": "...", "modifiedBy": "..." }
]
```

(step/data/result 是纯文本;html\* 是对应富文本版——渲染时用纯文本,
html 版不需要。)

### 1.3 GitHub 开源现状(为什么不直接抄)

搜到的 ZAPI 代码 ~15 个仓库,**几乎全是 Cloud 版**(JWT access/secret key
签名,与 Server/DC 不通用),且方向全是"上报自动化结果"(写),没有
"读测试用例内容进知识库"(读)的实现。唯二 Server 端实现
(`Parahet/ZephyrHelper` C#、`chaitanya8/ZAPI` Java)也只做了 cycle/
execution。结论:端点格式可参照,代码无可抄——但我们自己的 jiraGet
封装已经现成,加这个端点只是几十行。

### 1.4 适配设计

1. **配置**:`connectors.jira.zephyr`:缺省 `"auto"`,可显式 `false` 关闭。
   Test 类型名可配(`test_issue_types: ["Test"]`,防内网改名)。
2. **探测**(auto 模式):拉到首个 Test 类型 issue 时试调 teststep 端点;
   404/403 → 本次运行标记 `zephyr: unavailable`(写进 run summary),
   后续 Test issue 不再逐个试;再失败降级为普通 issue(行为=现状)。
   另试 `/rest/atm/1.0/testcase/{key}` 是否 200——是则说明内网实为 Scale,
   在 summary 里提示用户改配 `"zephyr": "scale"`(Scale 适配列为二期)。
3. **渲染**:`issueToMarkdown` 对 Test 类型追加一节(证据层,忠实原文):

   ```markdown
   ## Test Steps

   | # | Step | Test Data | Expected Result |
   |---|------|-----------|-----------------|
   | 1 | 打开登录页 | 用户A/密码X | 登录成功 |
   ```

4. **增量语义**:steps 变了 → body 变 → content_hash 变 → 正常触发
   updated,天然兼容现有增量逻辑。
5. **成本**:每个 Test issue +1 次请求;200 个用例多约 1-2 分钟,可接受。
6. **不拉 executions**(执行结果/周期):属于"运行历史"不是"知识",
   且量大易变;列为可选三期。

## 二、Confluence 宏:四种全有解,两种能完整还原

四种宏的 storage-format 结构均经真实 fixture 验证(来源:
`hallowelt/migrate-confluence` 测试集——BlueSpice 的 Confluence 迁移工具,
三个宏各有 processor + 输入输出 fixture,是本次最有价值的参照仓库)。

### 2.1 Gliffy Diagram —— 能完整还原文本,且有三种精度

宏结构(fixture 实测):

```xml
<ac:structured-macro ac:name="gliffy" ac:macro-id="12345">
  <ac:parameter ac:name="name">gliffy-file-1</ac:parameter>
  <ac:parameter ac:name="displayName">gliffy-file-1.png</ac:parameter>
</ac:structured-macro>
```

图的本体在**页面附件**里:`<name>.gliffy`(JSON)+ `<name>.png`(渲染图)。
`.gliffy` 文件格式已用 `sindrel/excalidraw-converter` 的真实样本验证
(top: `contentType/embeddedResources/metadata/stage/version`;
`stage.objects[]` 每个形状带 `graphic.Text.html` 即标签文本,带 x/y 坐标;
连线对象带 constraints 指向形状 id)。三级方案:

- **L1 确定性提取(默认,零 LLM)**:下载 `<name>.gliffy` 附件
  (`GET /download/attachments/{pageId}/{filename}`,同 PAT),解析 JSON,
  按 y→x 排序提取全部 `graphic.Text.html` 去标签 → 渲染为
  `**Gliffy diagram: name**` + 标签列表。文字全部可检索,永不出错。
- **L2 多模态语义描述(可选增强)**:下载 `<name>.png` → Azure OpenAI
  vision(SPN,支持多模态)→ 生成"这张图表达了什么流程/关系"的一段话,
  追加在标签列表后。配置驱动,缺省关。Copilot gateway 无多模态,不能干这个。
- **L3 OCR(最后手段)**:`.gliffy` JSON 缺失(老图/导入图)且 vision 未配
  时,Azure OCR 提 PNG 文字。排在最后符合用户排序。
- 附件缺失/全部失败 → 保留占位符但带名字:`[gliffy diagram: name]`。

**不做的**:Gliffy→Mermaid 结构重建(理论上连线 constraints 可生成
flowchart,但样本显示导出图的连线常无约束,投入产出差,列为远期候选)。

### 2.2 Jira Issue Filter —— 能完整还原(执行 JQL 落地为表格)

宏结构(fixture 实测,两种形态):

```xml
<!-- 单 issue -->
<ac:parameter ac:name="server">My JIRA</ac:parameter>
<ac:parameter ac:name="key">ABC-3423</ac:parameter>
<!-- 过滤器 -->
<ac:parameter ac:name="server">My JIRA</ac:parameter>
<ac:parameter ac:name="jql">project = ABC AND status != Done</ac:parameter>
```

适配:渲染阶段发现 `key` → 拉该 issue 渲染一行链接卡;发现
`jql`/`jqlQuery` → **复用 Jira 连接器执行该 JQL**(cap 20 行),渲染为
markdown 表格(key/summary/status/assignee,可点击)。这就是"差距"变
"数据"——KB 里直接有了过滤器的当前结果快照。Jira 未配置/查询失败 →
降级为 `[jira filter: <jql原文>]`,JQL 本身保留可见(也有信息量)。
注意 `serverId` 可能指向另一台 Jira:与配置的 base_url 不同源时直接降级
并在 summary 里记录(内网通常同机,罕见分支)。

### 2.3 Gallery —— 附件清单 + 可选多模态说明

宏结构(fixture 实测):宏体内直接列 `<ac:image><ri:attachment
ri:filename="dashboard.png"/></ac:image>`(可跨页引用),参数
title/columns。适配:

- 默认:渲染为图片附件名列表(名字本身常有信息量);
- 可选(同 L2 开关):图片走 Azure vision 各生成一句说明,逐个附在名下;
  张数 cap(如 8 张),防一页面几十个图把拉取拖垮。
- 跨页引用/外部 URL:只记名字与来源,不抓(内网安全边界)。

### 2.4 Table of Contents(toc)—— 现状即正确

`renderMacro` 里 toc 已返回空串——目录是导航零件不是内容,wiki 页有
自己的大纲 tab。**用户列的"Table Content"若是 toc,无需动作**;若指
"Table Filter/Table Excerpt"类三方插件宏,走通用占位符 + 二期适配清单。

### 2.5 工程要点:宏渲染从纯函数变成可联网

当前 `storageToMarkdown` 是纯同步函数,而 gliffy/jira/gallery 都要联网
(下附件/执行 JQL)。设计:

- `renderMacro` 遇到这三个宏时**不落内容,落结构化占位符**并收集进
  `pendingMacros[]`(类型+参数);
- `run()` 里页面正文转完后,**异步 resolver 统一兑现**:批量下附件、
  批量执行 JQL(同 JQL 去重),把结果字符串替换回正文;
- resolver 通过依赖注入传入,`storageToMarkdown` 单测保持纯同步
  (注入 stub resolver),网络测试只测 resolver——测试分层干净。

## 三、LLM 资源分工(对照用户三件资源)

| 任务 | 用谁 | 为什么 |
|---|---|---|
| Zephyr steps 拉取 | 不用 LLM | 纯 REST |
| Jira filter 宏 | 不用 LLM | 纯 REST(执行 JQL) |
| Gliffy 文字提取 | 不用 LLM | .gliffy JSON 确定性解析 |
| Gallery 清单 | 不用 LLM | 附件名列举 |
| Gliffy 语义描述(可选) | **Azure OpenAI vision(SPN)** | 唯一多模态;PNG → 流程/关系描述 |
| Gallery 图片说明(可选) | Azure OpenAI vision | 同上 |
| 上图都缺时 | Azure OCR | 用户指定的最后手段,只提字不给语义 |
| Copilot gateway | 本次用不上 | 无多模态;可留给 judge 后端扩展(另有欠账) |

新增 LLM 适配点:参照 `ui/lib/judge.mjs` 的 registry 模式(`registerJudge`),
在 acquisition 侧做一个 `registerVision(name, fn)` 同款注册表,Azure SPN
是第一个实现;**采集核心不依赖它**,配了才启用(内网首次可全关,先跑通
确定性路径)。

## 四、无外网 Jira/Confluence 的测试策略(**2026-08-03 用户裁定后修订**)

> **裁定:内网数据绝不传出外网**;形状不匹配时只能口头转述 + 关键报错。
> 原"录制-回放层(录制真实响应带出外网当 fixture)"因此**砍出一期**——
> 内网调试靠 probe + 小范围活拉复现,真疼了再单独立项(仅限内网自用)。

现状:连接器全部 `fetchImpl` 依赖注入,测试走 node:http mock server——体系
现成,扩展即可。修订后两层:

1. **单元层(外网可跑,CI 级)**
   - ZAPI steps 响应 → markdown 表:手写 fixture(字段已验证);
   - 三种宏 storage XHTML:**手写 fixture**(照 hallowelt/migrate-confluence
     的真实结构,绕开第三方许可问题);
   - .gliffy JSON 解析:手写 ~5KB 最小样本(结构照 sindrel/excalidraw-converter
     的样本验证过)。
2. **形状宽容 + 无值诊断(裁定后的核心机制)**
   - 所有新解析器形状不符时抛出**只含类型/键名/数量、绝不含值**的报错
     (`lib/shape.mjs`)——用户口头转述这行报错即足够外网修代码;
   - **`--probe` 形状探针**:`acquire.mjs jira --probe` 输出首个 Test issue
     的 ZAPI 响应结构(isArray/count/firstItemKeys,零值);
     `confluence --probe <pageId>` 输出首个 .gliffy 附件结构
     (jsonValid/hasStageObjects/objectCount/labelCount,零值)。
     这是唯一可以原样抄出内网的诊断产物;portal 采集页有对应按钮。
3. **内网验收层(用户最终执行)**:清单式,见 `docs/real-env-test.md` §3a
   (probe → 小范围 Test 拉取 → 宏页面拉取 → PNG 边车与浏览页可见性)。

## 五、分期(**2026-08-03 一期已实现**)

- **一期(已交付)**:Zephyr steps(1.4)+ Gliffy L1 + PNG 边车嵌入
  (`raw/confluence/<id>.assets/`,契约修订)+ Jira filter 宏 + Gallery 清单
  + `--probe` 形状探针(CLI + portal 按钮)+ `lib/shape.mjs` 无值诊断。
  全部离线可测(59 acquisition 测试 + 67 UI 测试全绿),无 LLM 依赖。
- **二期(可选增强)**:Azure vision 适配器(Gliffy L2 语义描述 + Gallery 图片
  说明,copilot gateway 无多模态用不上)、Zephyr Scale 适配(一期已留探测与
  zephyr_hint)。
- **三期(看需要)**:Zephyr executions、Gliffy→Mermaid、录制回放(仅限内网
  自用,真疼了再立项)、更多三方宏按占位符出现频率逐个补。

风险登记:① ZAPI 响应字段以 intranet 实测为准(html\* 有无因版本而异,
渲染只用 step/data/result 纯文本字段兜底);② `.gliffy` 旧版图可能只有
XML 格式(2015 前),解析器按 JSON-parse 失败 → 降 OCR/占位;③ Jira
filter 宏执行用户 JQL 有成本,cap 20 行 + 同 JQL 去重兜底;④ 附件下载
需要 PAT 有页面附件权限,403 时降级路径已设计。
