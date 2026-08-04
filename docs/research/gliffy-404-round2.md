# Gliffy 拉取 HTTP 404 —— 二轮调研与方案 (2026-08-04)

> 一轮修复（257b2e5）后内网 404 依旧。本调研推翻一轮方案的核心假设并给出新方案。
> 结论先行：**一轮方案是"装饰性成功"——REST 解析换的是 URL 的*来源*，不是下载*通道*；
> 而真正的根因大概率是附件文件名与我们猜的不一样（我们请求 `<name>.gliffy`，真附件无扩展名）。**
>
> **状态：已实施（2026-08-04，D1–D6 全部落地）**。改动：`confluence.mjs` 新增
> `listAttachments`/`resolveDiagramPageId`/`matchDiagramAttachment`/`downloadAttachment`/
> `fetchDiagramBody`，`resolveGliffy` 走列表+匹配+D3 重试，`probeGliffy` 输出附件清单与
> 每次下载状态；测试 +4（无扩展名核心回归/无名匹配降级/前缀歧义嗅探/modificationDate
> 重试/跨页 page 参数）。下轮内网复测看 probe 的 `attachments`/`matched`/`legacy_guess`。

## 一、事实梳理（每条带出处）

### F1. Server/DC 上没有二进制下载的 REST 端点
- Confluence Data Center REST v1021 附件 API：`/rest/api/content/{id}/child/attachment/{attachmentId}/data` **只有 POST**（上传二进制，
  "Update binary data of an attachment"），无 GET。
- Confluence Server 官方文档示例下载附件的方式就是
  `curl .../rest/api/content/{id}/child/attachment`，然后从返回的 `_links.download` 取下载 URL——
  而该字段形如 `/download/attachments/1998856/test.txt?version=1&modificationDate=1519985997040&api=v2`，
  **指向的就是 `/download/attachments/` servlet**。
- 开发者社区确认：Server "there never was an attachment download endpoint"——Cloud 的
  `GET .../child/attachment/{attachmentId}/download` 在 Server 上直接 404 是预期行为。
- ⟹ **一轮的"REST 优先解析"只改变了 URL 的出处（列表 vs 猜），最终请求还是打到同一个
  servlet；若 servlet 因文件名/代理原因 404，一轮等于没修。** 这是二轮的主教训。

### F2. Gliffy 图附件在 Confluence 上是【无扩展名】的
- Gliffy 官方故障排查页（help.gliffy.com）原文：*"The downloaded file should be the diagram
  name **without a file extension**. If the downloaded file has an extension, it is not a true
  Gliffy diagram attachment."*
- MIT 的 Confluence Gliffy 插件文档：宏参数 `name` 是 *"The name of the diagram (and of the
  attachment)"*——即宏的 `name` 参数就是附件文件名本身，**不带 `.gliffy`**。
- 真实宏存储格式实例（Stack Overflow，宏参数含 `name`/`displayName`/`pagePin`）：
  ```html
  <ac:structured-macro ac:name="gliffy" ac:macro-id="a9ab423b-..." ac:schema-version="1">
    <ac:parameter ac:name="displayName">Sed do eiusmod</ac:parameter>
    <ac:parameter ac:name="name">Tempor incididunt ut</ac:parameter>
    <ac:parameter ac:name="pagePin">2</ac:parameter>
  </ac:structured-macro>
  ```
- ⟹ **我们的代码一直在请求 `<base>.gliffy`，而真附件叫 `Tempor incididunt ut`（原样、带空格、
  无扩展名）→ servlet 自然 404。** 一轮的"同扩展名列表兜底"在页面根本没有 `.gliffy` 后缀附件时
  同样落空。这是 404 的最可能根因。

### F3. `name` 参数与附件名可能不一致的多种形态
- `name` = 图名（= 附件名，无扩展名）；`displayName` = 显示标题（常为 `<name>.png`）。
- 宏可能带 `page`/`space` 参数，图附在**别的页面**上（wiki 语法 `{gliffy:name=X|space=~u|page=p}`）。
- ⟹ 不能拿 `name` 字符串拼 URL；要以"列出页面附件 → 按名归一匹配"为准。

### F4. 即使文件名对，servlet 也可能被反代/编码弄挂（二轮的第二嫌疑）
- Atlassian KB：`/download/attachments/` 在反代后 404 的常见原因——文件名特殊字符
  （`+`、前导 `.`）、代理未转发原始 URI（Apache 需 `nocanon`、nginx 需 `$request_uri`）、
  IIS Request Filtering 拦扩展名、代理开 gzip。
- CONFSERVER-60328：文件名含 `+` 且 URL 带 `&modificationDate=...` 时 nginx 下 404，
  去掉该参数即恢复。
- ⟹ 若 F2 修复后仍 404，下一个嫌疑人就是 F4；必须让 probe 抓到**确切失败的 URL+状态**来对号入座。

### F5. Gliffy 官方对 404 的定义
- *"A 404 error or 'Cannot find a diagram with these parameters' typically indicates that the
  GLIFFY DIAGRAM attachment is **missing from the Confluence page's attachment list**."*
- ⟹ 若页面附件列表里确实没有对应图，任何代码都救不了——probe 必须能证明"有/没有候选附件"，
  把结论从"连接器猜错名"和"附件真的没了"区分开。

## 二、决策（每条标注理由与风险）

### D1. 放弃"拿名字拼 URL"，改为"列附件 + 名归一匹配"【主修复】
解析流程改为：列 `/rest/api/content/{pageId}/child/attachment?limit=200` → 把宏 `name`
归一化后与附件标题匹配 → 用**匹配到的附件自身的 `_links.download`**（原样保留
`version`/`modificationDate`/`api=v2` 查询参数，它们参与正确版本的服务）下载。

匹配优先级（按序取首个命中）：
1. 附件标题 == 宏 `name`（原样，如 `Tempor incididunt ut`）；
2. 附件标题去扩展名 == 宏 `name`（如附件 `arch-diagram.gliffy` ↔ 宏 name `arch-diagram`）；
3. 附件标题 == 宏 `name` + `.gliffy`；
4. 附件标题去扩展名 == 宏 `name` 去扩展名（兜住 displayName 是 `<name>.png` 的形态）；
5. 以上都无 → 取标题去扩展名与宏 name 前缀匹配的**唯一**候选；
6. 仍歧义 → 对候选逐个下载并**内容嗅探**（body 能解析出 `stage.objects` 数组的即图），取首个成功。

- **理由**：F2/F3——真附件名与宏 name 只差一个扩展名/大小写/空格，列表匹配才能拿到真实标题。
- **风险**：页面附件很多时匹配要按序，避免误抓同名图；上限 200，超限在 SKILL/文档留痕（页面
  附件 >200 罕见）。
- **保留回退**：匹配全失败仍走一轮的 legacy 猜名路径，防回归。

### D2. PNG 边车只从附件列表里找，不再盲猜 `<base>.png`【修正一轮的行为】
- 仅当列表中存在标题去扩展名 == base 的图片附件（`.png/.svg/.jpg`）时，用它的 `_links.download`
  下载写边车；否则省略图片行（现行为不变，labels 仍落盘）。
- **理由**：真实 Confluence 上图通常只有一个"无扩展名"附件，PNG 由 Gliffy 宏即时渲染，本就没有
  独立的 `.png` 附件——盲猜 `<base>.png` 只会多一次必然 404 的请求。
- **风险**：少数确实存了 `.png` 边车的实例若文件名不匹配会少一张图——可接受（本来就 best-effort）。

### D3. 404 时带 `modificationDate` 的重试【防代理坑】
- 若 `_links.download` 404 且 URL 含 `&modificationDate=`，剥离该参数（保留 `version`）重试一次；
  再 404 则降级。
- **理由**：F4/CONFSERVER-60328——反代对 `&modificationDate=` 的已知吞 URL 行为。
- **风险**：多一次请求，仅在 404 时发生，代价可忽略。

### D4. 支持宏的 `page`/`space` 参数（图挂在别的页面）【次级，参数存在才触发】
- 宏含 `page`（+可选 `space`）参数时：`GET /rest/api/content?title=<page>&spaceKey=<space>`
  解析该页 id，再到该页列附件匹配。
- **理由**：F3——wiki 语法明示图可挂在别的页面；当前代码只搜当前页，必 404。
- **风险**：`title` 检索按关键字非精确匹配，需取首个且校验 id 存在；触发面窄，作为可选项实现。

### D5. probe 大改：把"哪个 URL 404"和"页面上有哪些附件"摊开【诊断闭环】
`confluence --probe <pageId>` 输出扩展为：
- 宏 `name`/`displayName` 原文；
- 页面附件清单（**标题/附件 id/mediaType，纯元数据、不含文档正文**）;
- 匹配结果：命中哪个候选、走哪条 URL（`rest-exact`/`rest-list`/`legacy`）、每次尝试的
  {url, http 状态}。

- **理由**：我够不到内网，唯一能收敛的方式是把下一次 404 变成两行可读的诊断。F5 要求能区分
  "附件真的不存在"（无解，需用户补附件）与"名字没对上"（本方案修复）。
- **风险**：probe 输出多出附件标题——是元数据非正文，符合"内网数据不出网、形状/元数据可转述"
  的既有红线（shape.mjs 精神）。

### D6. 保留既有红线不动
- 附件正文不进日志/错误消息/degrade 文案（沿用 `confFetchRaw` 只透 `err.status`）；匹配信息
  只在 probe 输出。**决策**：不做任何放宽。

## 三、落地范围（待你拍板后实施）

| 文件 | 改动 |
|---|---|
| `acquisition/scripts/connectors/confluence.mjs` | 重写 `attachmentUrl`→`resolveDiagramAttachment`（列表+匹配+下载+重试）；`resolveGliffy` 用其返回的 {url,via}；PNG 走 D2；probe 走 D5 |
| `acquisition/scripts/test/macros.test.mjs` | 新增用例：无扩展名附件命中（核心回归）、displayName 形态、多候选歧义嗅探、modificationDate 剥离重试、page 参数跨页 |
| `acquisition/scripts/test/cli.test.mjs` | probe 断言更新（附件清单字段 + via） |
| `docs/real-env-test.md` §3a | probe 验收说明补"看 via + 附件清单对名字" |
| `docs/DEVLOG.md` | 顶部留痕本轮 |

## 四、参考资料

1. Confluence Data Center REST API — Content Attachments（`_links.download` 形态、`data` 端点仅 POST）
   https://developer.atlassian.com/server/confluence/rest/v1021/api-group-attachments/
2. Confluence Server 官方 REST 文档"Download an attachment"示例（`_links.download` = `/download/attachments/...`)
   https://docs.atlassian.com/atlassian-confluence/REST/5.5.2/ （与上同 API，旧版页面）
3. Atlassian 开发者社区 — Server 无附件下载端点 / Cloud `/download` 端点 404 属预期
   https://community.developer.atlassian.com/t/how-to-download-attachment-via-rest-api/83378
   https://community.developer.atlassian.com/t/cant-download-confluence-page-attachments-using-api-http-401/100789
4. Gliffy 官方故障排查 — 图附件无扩展名；404 = 附件不在页面附件列表
   https://help.gliffy.com/confluence/Content/GliffyConfluence/Troubleshooting-Confluence.htm
5. MIT Confluence wiki — Gliffy 插件文档（`name` = 图名与附件名）
   https://wikis.mit.edu/confluence/plugins/viewsource/viewpagesrc.action?pageId=95847824
6. Stack Overflow — Gliffy 宏真实存储格式（`name`/`displayName`/`pagePin` 参数）
   （在 "Gliffy macro storage format" 检索结果中的 SO 条目）
7. Atlassian KB — 反代下 `/download/attachments/` 404 的若干原因
   https://support.atlassian.com/confluence/kb/confluence-issues-with-special-characters-used-in-content-name-when-behind-a-proxy/
   https://jira.atlassian.com/browse/CONFSERVER-60328
   https://support.atlassian.com/confluence/kb/unable-to-download-attachment-with-specific-extension/
