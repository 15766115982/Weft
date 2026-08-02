# 方案 1(no-build SPA)评审问题清单与修复方案(开发自检用)

> 来源:2026-08-02 架构评审(对方案文档 + 现有代码逐条核查)。
> 适用范围:`ui/` 包开发全程。每条含:问题 → 证据 → 修复方案 → 验收标准(自检勾选项)。
> 优先级:**P0** = 开工前必须落实(写进公共决策/设计);**P1** = M7a-M7b 期间落实;**P2** = 备忘,触达条件时执行。

---

# 核对结论(2026-08-02,对现有代码逐条验证):7 属实 / 2 误判 / 1 部分属实

## ❌ 误判 1:P0-4 之 B4 路由信息 —— 不需要 --debug

`retrieval/scripts/lib/query.mjs:81-84` 构建 `routed = {latin:[], cjk:[], like:[]}`,
**该字段就在 search() 的返回值里**(query.mjs:161 `return { query: input, routed, ... }`),
CLI stdout 的 JSON 原样输出。UI 后端 spawn kb_search 解析 stdout 即得每个查询词的路由腿。
candidates_file 里没有 routed,但 UI 无需从那里取。**契约修订③取消,B4 按原口径全量实现,
不降格。**(评审只核查了落盘文件,漏了 stdout 返回值。)

## ❌ 误判 2:P1-2 candidates 无界增长 —— 已有 KEEP=20 上限

`query.mjs:150-158`:每次搜索后只保留最新 20 份 candidates 文件(当前运行除外),
注释原文即 "preventing unbounded growth"(M3 第三轮已钉测试)。**不存在无界增长,
无需 UI 侧清理。**唯一真实的小问题:UI 不应长期引用 candidates_file(会被后续搜索
churn 掉)——搜索响应时立即读完内容即可,不存路径引用。此注记并入方案 1 设计。

## 🟡 部分属实:P0-4 之 J6 数据源 —— 有 log.md 逐文档行,但无"全跳过拉取"痕迹

acquisition 有 `lib/log.mjs`,每个文档级动作都写
`## [ts] acquire | confluence:created | raw/... | id 123`(jira/local 同)。所以
"来源分布、最后变更时间"可从 log.md 解析;但**一次全部增量跳过的健康拉取不写任何行**,
"最后拉取时间"确实无数据源。修复按评审方案执行(acquire 写 per-source 拉取记录到 .kb/,
随契约修订打包);另有零改动补充:UI 发起的拉取由 jobs.mjs 把 stdout 摘要存 jobs.db。

## ✅ 属实(7 条,修复全部零依赖可执行)

P0-1(per-KB 串行写队列)、P0-2(token + Origin 校验,判断完全正确:简单 POST 不受 CORS
阻挡)、P0-3(spike 先行;"默认不流式"细节留 spike 验证,stream-json 方向正确;Windows
.cmd shim ENOENT 为真坑)、P0-5(写白名单)、P1-1(写 spawn / 只读热路径 import)、
P1-3(watch 排除 .kb/ + 防抖)、P1-4(原始字节 + X-Filename 免 multipart)、
P1-5(innerHTML 唯一出口 + DOMPurify)、P2-1(Alpine 减压阀)、P2-2(D3 复用 plan 输出,
已验证 govern.mjs:159)。

## 落实位置

- P0-1 → 公共决策 **S10**;P0-2 → 并入 **S8**;P0-3 → 重写 **S7**;P0-4 → **S2 软化** +
  契约修订包(仅 ①.kb/ui/ ②per-source 拉取记录);P0-5 → 公共决策 **S11**(见 options/README.md);
- P1-1/P1-3/P1-4/P1-5 + P1-2 注记 + P2-2 → 已并入 option-1-nobuild-spa.zh-CN.md 设计;
- 以下原始清单保留作开发自检,与本文核对结论冲突处以核对结论为准。

---
---

# 原始评审清单(2026-08-02,含已被推翻的两条,保留存档)

## P0-1 并发与串行化:per-KB 写作业队列

**问题**:现有治理体系假设单写者(statusflip 的 409 只保护单页翻转)。UI 作业中心让并发写极易发生:治理 agent 跑 sweep 的同时用户触发 acquire,同时又点了 approve——三者在 KB 上交错,409 挡不住"sweep 扫到一半 raw 目录变了"这类问题。三份方案均未覆盖。

**修复方案**(作为公共决策 S10 写入 [README.md](README.md)):

- `lib/jobs.mjs` 内置 **per-KB 串行队列**:写类作业(acquire / govern 各子命令 / approve / reject / raw 删除·移动 / wiki 编辑)按 KB 排队串行执行;
- 只读作业(search / read / plan / health / freshness)不参与队列,任意并发;
- 队列状态在作业中心可见(排队中 / 运行中),UI 对排队中的触发给出明确反馈而非静默等待。

**验收自检**:
- [ ] 同一 KB 上并发触发 acquire + approve,后者进入排队而非并发执行
- [ ] 不同 KB 的作业互不影响
- [ ] 测试覆盖:fake CLI 延时脚本模拟并发,断言执行顺序与队列可见性

---

## P0-2 localhost 服务跨源安全(token + Origin 校验)

**问题**:S8 照抄了 viewer 的路径闸门,但 viewer 的写面只有翻一个 status;新 UI 能**删 raw、移动文件、spawn 进程**。绑 127.0.0.1 不等于安全:浏览器里任何网页都能向 `127.0.0.1:8322` 发 POST(简单请求不受 CORS 阻挡,CORS 只拦读响应),DNS rebinding 可绕过 Host 检查。

**修复方案**(并入 S8):

- 启动时生成随机 token,经首屏 HTML meta 注入前端;`api.js` 所有写请求(POST/DELETE)携带;
- 服务端对所有写请求:校验 token + 校验 `Origin`/`Host` 头(拒绝跨源、拒绝非 127.0.0.1 的 Host);
- token 每次启动换新,不写盘、不进日志。

**验收自检**:
- [ ] curl 无 token POST 删除接口 → 403
- [ ] 伪造 `Origin: http://evil.example` 的写请求 → 403
- [ ] 读请求(GET)不要求 token(本机工具,浏览不设卡)

---

## P0-3 agent 执行器:开工前先做 spike,三个实现级未知先钉死

**问题**(S7 目前只写了接口形状,以下三点未写,每个都足以让 M7c 返工):

1. **`claude -p` 默认不流式**——进程结束才吐 stdout。I4 要实时看到 agent 在干什么,必须 `claude -p --output-format stream-json --verbose` 并解析 JSONL 事件流。这直接决定 executor 接口的事件模型,必须现在定,不是 M7c 再发现。
2. **Windows spawn 坑**:`claude` 在 Windows 是 .cmd shim,`spawn('claude')` 不带 `shell: true`(或用 `claude.cmd`)直接 ENOENT。
3. **权限模式**:headless 跑 govern skill 需要 `--dangerously-skip-permissions` 或精细 allowedTools 清单——这是安全姿态决定,属需求层面,需用户拍板,不留到实现期。

**修复方案**:

- M7a 开工前安排 1-2 天 spike:`spawn claude -p stream-json → executor 事件流 → SSE → 浏览器滚动` 最小链路,验证上面三点;
- spike 结论回填 S7(事件模型 = stream-json 事件类型的子集)并写进 ADR。

**验收自检**:
- [ ] spike 中能在浏览器实时看到 agent 逐条输出(非结束后一次性出现)
- [ ] executor 接口文件定义的事件类型与 stream-json 实际输出一一对应,有文档
- [ ] Windows 上真实 claude 可执行文件可 spawn(非仅假 executor)

---

## P0-4 S2 措辞软化 + 契约修订一次打包

**问题**:S2 写"零代码改动",但两处现实会撑破它:

1. **J6 来源新鲜度没有数据源**——已验证 acquisition 不落盘任何 per-source 拉取元数据。UI 从 raw/ mtime 推导会被 G1/G2 的删除/移动污染,脆弱不可用;
2. **B4 路由信息**——candidates_file 有 `via: search/link` 徽标(够"图扩展了哪些"),但每个查询词走了哪条检索腿(FTS latin / fts_cjk / LIKE,见 retrieval/scripts/lib/query.mjs:34)不落盘。

**修复方案**:

- S2 措辞从"零代码改动"软化为"**零行为变更;只读增量允许,随契约注记一起走评审**";
- 一次打包的契约修订(随 `.kb/ui/` 注记一起):① `.kb/ui/` 派生制品目录;② acquire 成功后写一行 per-source 拉取记录到 `.kb/`(派生制品,供 J6);③ (可选)kb_search 加 `--debug` 输出 per-term 路由腿;
- B4 的"路由信息"先按降格解释执行(via 徽标 = 路由信息),`--debug` 列为可选增量,不阻塞 M7a。

**验收自检**:
- [ ] 契约修订文档一次过评审,不走"做到一半发现要改"的路径
- [ ] J6 面板数据来自拉取记录而非 mtime 推导
- [ ] 需求清单 B4 的措辞与实现口径对齐(需用户确认降格解释)

---

## P0-5 UI 写 KB 的白名单(viewer 红线 3 的新形态)

**问题**:E1 明确了"inbox/ 是唯一允许的写",但 G1/G2 的**删除和移动 raw** 是 UI 直接动 raw/——比 inbox 大得多的信任面。方案只有 snapshots.mjs 兜底,没写"谁执行、什么顺序"。

**修复方案**(作为公共决策写入 README,替代 viewer 红线 3 的"哑消费者"表述):

- 明确 UI 直接写 KB 的**完整白名单**:① inbox/ 上传;② raw/ 删除·移动(快照先行);③ statusflip 评审写;④ `.kb/ui/` 派生物。白名单之外一律不许写;
- raw 删除/移动实现为 `lib/` 独立模块:**快照先行(S4)→ resolveUnder 校验 → 走 P0-1 串行队列**;删除前必须过 G5 影响预览(frontmatter 扫 source_ref)。

**验收自检**:
- [ ] 代码审查可查:全部 KB 写路径能在白名单中找到对应条目
- [ ] 删除 raw 的集成测试:快照存在 → 文件消失 → 引用它的 wiki 页列表在预览中已展示
- [ ] 无快照时(磁盘满等)删除操作失败且不进行

---

## P1-1 只读热路径改 in-process import(搜索延迟)

**问题**:S2 定"集成全部走 spawn CLI",但搜索是热路径——Windows 上每次 `spawn node kb_search.mjs` 的 Node 启动开销约 150-400ms,叠加 ensureFresh 的 lazy reconciliation,B1 查询体验很肉。

**修复方案**:原则说透——**写操作一律 spawn(进程隔离);只读热路径(search / read / plan)允许 in-process import retrieval/governance 的 lib**。statusflip 的 import 已是先例,不违反"零行为变更"。

**验收自检**:
- [ ] 搜索请求不 spawn 子进程(日志/计数可证)
- [ ] acquire/govern 等写操作仍全部 spawn
- [ ] 搜索 P95 延迟有实测数字记录

---

## P1-2 `.kb/candidates/` 无界增长

**问题**:kb_search 每次搜索写一份 `.kb/candidates/<id>.json`(retrieval/scripts/lib/query.mjs:146)。UI 搜索频率远高于 agent 场景,KB 目录会被派生垃圾撑大。

**修复方案**:jobs.mjs(或启动时)定期清理,只保留最近 N 份(建议 N=50);清理动作本身是 KB 写,纳入白名单第 ④ 条 `.kb/` 派生物范畴。

**验收自检**:
- [ ] 连续 60 次搜索后 candidates/ 目录文件数 ≤ N
- [ ] 正在展示的搜索结果页不因清理而 404(清理跳过当前引用的文件)

---

## P1-3 J3 fs watch 自我触发风暴

**问题**:原生 `fs.watch` recursive 在 Windows 可用(无需 chokidar),但服务器自己的写——`.kb/candidates/`、`.kb/ui/jobs.db`、快照——全落在 KB 目录内。不排除 `.kb/` 会形成"UI 写 → watch 触发 → 前端刷新 → 触发搜索 → 又写"的循环。

**修复方案**:watch 过滤器排除 `.kb/` 全目录 + 事件防抖(建议 300-500ms 合并)+ 前端收到变更事件后**只刷新数据视图,不自动重发会写 KB 的请求**。

**验收自检**:
- [ ] UI 触发一次搜索,watch 不产生推送(候选文件写在 .kb/ 内)
- [ ] 外部编辑器改 wiki/ 页面,前端 1s 内收到刷新事件
- [ ] 连续快速改 10 个文件,前端只收到 ≤2 次合并后的事件

---

## P1-4 上传:免 multipart

**问题**:方案宣称 0 npm 依赖,但 E1 上传需解析 multipart,手写 boundary 解析是经典翻车点。

**修复方案**(二选一,推荐前者):

- **前端 `fetch` POST 原始字节 + `X-Filename` 头**,服务端直接流式写盘——根本不用 multipart;
- 备选:Node 20+ 用 `new Request(url, {method, headers, body: Readable.toWeb(req), duplex: 'half'})` 再 `await req.formData()`,借 undici 内建解析,仍零依赖。

**验收自检**:
- [ ] 上传实现不含手写 boundary 解析代码
- [ ] 413 体积限制生效(照抄 viewer 闸门)
- [ ] 文件名含 `..` / 路径分隔符时被 resolveUnder 拒绝

---

## P1-5 客户端渲染单一出口(XSS 一致性)

**问题**:S8 的"渲染输出消毒"写在后端闸门里,但方案 1 的 markdown 渲染在客户端。3-5k 行 vanilla JS 里只要有一个视图绕过消毒直接拼 innerHTML,Jira/Confluence 来的不可信内容就有 XSS 面。

**修复方案**:立一条与 resolveUnder 同级的红线——**任何 innerHTML 必须经过 `lib/render.js` 的唯一出口,该出口默认过 DOMPurify**;wikilink tokenizer 输出只产 `<a href="#/...">` 白名单形态。代码评审 checklist 加一项"新增 innerHTML 赋值点"。

**验收自检**:
- [ ] 全仓 grep `innerHTML` 仅出现在 render.js 内
- [ ] 测试:markdown 内含 `<script>` / `onerror=` 属性,渲染输出中被剥除
- [ ] DOMPurify 配置允许 hash 路由链接(wikilink 跳转不被误杀)

---

## P2-1 Alpine.js 减压阀 + render.js 纪律(压低逃生舱成本)

**备忘**:方案 3 的逃生舱阈值(views >12 / app.js >800 行)是事后指标。两条前置纪律:

1. **views/ 只许组装,所有 DOM 构造走 lib/render.js**——将来迁方案 3 时只是"把 render 调用翻译成组件";
2. 若 M7c 做到一半 vanilla 状态管理真的痛,先考虑 **Alpine.js(16.7KB gz,vendor 进仓,无构建)** 而非直接迁 Svelte——便宜一个数量级,不触碰无构建红线。

**触发条件**:views/ 超过 10 个 module 或 app.js 超过 600 行时,在 Alpine 与方案 3 之间做一次正式评估,不要硬撑到失控。

---

## P2-2 D3 健康指标数据源:复用 `govern plan`

**备忘**(好消息,已验证):`govern plan` 已计算 `orphaned_pages` + `dangling_links` + `review_queue`(governance/scripts/lib/govern.mjs:159)——D3 直接复用 plan 输出即可,不需要 UI 自己实现扫描,也不违反哑消费者原则。dashboard 数据源说明里补这一句。

---

## 落地顺序建议

1. **本周**:P0-3 spike(最高技术风险,卡住整个 M7c 排期);P0-1/P0-2/P0-4/P0-5 写进公共决策 README + ADR;
2. **M7a 开发期**:P1-1 ~ P1-5 随对应功能块落地(搜索→P1-1/P1-2;上传→P1-4;渲染→P1-5;watch→P1-3);
3. **持续**:P2 两条作为里程碑检查项挂在 M7c 入口。
