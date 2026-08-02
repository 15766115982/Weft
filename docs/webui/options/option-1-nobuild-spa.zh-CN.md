# 方案 1:no-build SPA 控制台(**推荐,已通过用户初选**)

> viewer 模式的直系放大:node:http 纯 JSON API 后端 + 无构建 ES module 前端。
> 公共决策(S1-S11)见 [README.md](README.md),本文只写方案特有部分。
> 2026-08-02 架构评审问题已核对(7 属实/2 误判/1 部分属实)并全部并入本文,
> 见 [option-1-review-findings.zh-CN.md](option-1-review-findings.zh-CN.md)。

## 形态

```
ui/
├── serve.mjs                 # node:http,127.0.0.1:8322,--kb / KB_PATH,按需启动
│                             # 启动期生成写操作 token(S8);静态服务 + JSON API + SSE
├── lib/                      # 后端分层(全部纯 Node,零依赖)
│   ├── paths.mjs             # 路径闸门(S8 前半)
│   ├── auth.mjs              # 写请求 token + Origin/Host 校验(S8 后半)
│   ├── kb.mjs                # KB 注册表 + 切换(S9)+ 新鲜度探测(D5,复用 plan 输出)
│   ├── search.mjs            # in-process import retrieval lib(S2:只读热路径不 spawn);
│   │                         # routed 取自 search() 返回值;candidates_file 响应时即读,
│   │                         # 不存路径引用(会被 KEEP=20 churn 掉)
│   ├── acquire.mjs           # spawn acquire CLI(local/jira/confluence)+ --check(J5);
│   │                         # stdout 摘要存 jobs.db(J6 数据补充)
│   ├── govern.mjs            # spawn govern 机械步骤;plan 输出复用为 D3 健康指标
│   │                         # 与 D5 新鲜度(govern.mjs:159 六清单,已验证)
│   ├── jobs.mjs              # 作业中心:per-KB 串行写队列(S10)+ 只读并发;
│   │                         # 状态机 + .kb/ui/jobs.db + SSE 事件源(I4/I6)
│   ├── rawmgr.mjs            # raw 删除·移动:快照先行 → resolveUnder → S10 队列
│   │                         # → G5 影响预览前置(S11 白名单②)
│   ├── executor.mjs          # agent 执行器接口(S7)+ claude -p stream-json 首实现
│   ├── llm.mjs               # LLM 三适配器(S5),executor 与 judge 共用
│   ├── snapshots.mjs         # 版本管理降级:git 检测 + 复制快照(S4)
│   ├── watch.mjs             # J3 自动刷新:fs.watch 递归,**排除 .kb/ 全目录** +
│   │                         # 300-500ms 防抖;只推"数据变更"事件,前端不自动重发写请求
│   └── review.mjs            # import governance statusflip/frontmatter(白名单③)
├── public/
│   ├── index.html            # 单页骨架(meta 注入写 token)
│   ├── app.js                # hash 路由 + 视图注册表(内核 <600 行,超标触发 P2-1 评估)
│   ├── views/                # 原生 ES module,每视图一个文件,**只许组装**——
│   │   ├── browse.js  search.js  queue.js  dashboard.js   # 所有 DOM 构造走 lib/render.js
│   │   ├── acquire.js rawmgr.js  govern.js  jobs.js  settings.js
│   ├── lib/
│   │   ├── api.js            # 唯一请求出口(自动带写 token)
│   │   ├── render.js         # **唯一 innerHTML 出口,默认过 DOMPurify**(红线:
│   │   │                     # 全仓 grep innerHTML 只许出现在这里;wikilink 只产
│   │   │                     # <a href="#/..."> 白名单形态,DOMPurify 配置放行 hash 路由)
│   │   ├── md.js             # marked + wikilink tokenizer 扩展(剥围栏/锚点/死链样式)
│   │   ├── graph.js sse.js store.js
│   ├── vendor/marked.min.js  # 12.4KB gz
│   ├── vendor/purify.min.js  # DOMPurify ~20KB gz
│   └── style.css             # 含暗色主题变量
└── test/                     # node:test:HTTP 层(照抄 viewer 模式)+ 纯函数单测
```

## 数据流(以三个最重场景为例)

**搜索 + 异步评测徽标(B + K)**:
浏览器 → GET /api/search → search.mjs **in-process** 调 retrieval lib(无 spawn 开销;
ensureFresh 照跑)→ 立即返回结果(含 routed 路由信息)→ 前端渲染卡片;块 K 启用时
POST /api/eval → judge 经 llm.mjs 打分写 .kb/ui/jobs.db → SSE/轮询取分,徽标浮现。

**治理全流程(I,实时流式)**:
浏览器 → POST /api/runs {kind:"govern"} → govern.mjs 先跑 plan 回填"预览确认页"
(I5)→ 用户确认 → 作业进 **S10 per-KB 写队列** → executor.mjs spawn
`claude -p --output-format stream-json --verbose`(逐行解析 JSONL)→ jobs.mjs
记状态 + SSE 推送 /api/runs/:id/events → 浏览器实时滚动;结束 → 自动
rebuild-index,watch 事件触发前端刷新树与新鲜度指示。

**上传采集(E,免 multipart)**:
前端 fetch POST **原始字节 + X-Filename 头**(不手写 boundary 解析)→ 流式写 inbox/
(白名单①,resolveUnder 拒 `..`/路径分隔符,413 照抄)→ 作业入 S10 队列 spawn acquire
→ 结果 JSON(created/skipped/orphaned)回显 + 摘要存 jobs.db;inbox 管理页(J4)直接列 inbox/。

## 功能块适配要点

- **强项**:B/K(异步徽标)、I(SSE 流式控制台)、A7 图谱(canvas 直接画)、
  J3 自动刷新(SSE 同一条通道顺带推 watch 事件)、dashboard(D,plan 输出复用);
- **弱项**:首屏需 JS(无 JS 不可读——本机工具可接受);前端代码量全仓最大,
  靠"每视图一个 module + 只经 render.js/api.js 两个出口"的纪律控制;
- markdown 渲染只在客户端一处(marked + wikilink 扩展 + DOMPurify),
  不存在两处渲染逻辑漂移。

## 对现有服务的影响

零行为变更(S2 软化后):只读增量仅契约修订包两条(.kb/ui/ 注记 + per-source 拉取记录)。
M7d 的 wiki 人工编辑路径(H2 规则)届时单独讨论。

## 测试策略

- 后端:viewer 测试模式放大——scratch KB + 真实 HTTP;spawn 点全部依赖注入
  (fake CLI/假 claude 可执行文件),SSE 用真实连接断言事件序列;
- 评审专项:并发队列顺序(P0-1)、无 token/假 Origin → 403(P0-2)、白名单外写路径
  不存在(P0-5)、无快照则删除失败、watch 对 .kb/ 内写入不推送(P1-3)、
  `<script>`/`onerror=` 被剥除(P1-5)、grep innerHTML 唯一出口;
- 前端纯函数:md.js wikilink 扩展、graph 构建、查询语法解析,node:test 直测;
- e2e:复用 tests/ fixture KB,走"上传→拉取(mock 源)→治理(mock executor)→
  评审→检索→评测(mock judge)"全链路;
- 预计 40-60 条测试,与现有 125+39 的密度一致。

## 工作量(相对)

M7a **M**(视图最多但每个都浅)｜ M7b **M**(上传/删除/移动 + 影响预览 + 快照)｜
M7c **L**(执行器抽象 + 流式 + 作业中心,技术上最重;**spike 前置在 M7a 开工前**)｜
M7d **M**(契约讨论为主)。

## 风险

1. **vanilla JS 规模失控** → 缓解:视图只许组装 + 两个唯一出口;P2-1 触发线
   (views >10 或 app.js >600 行)到时先做 Alpine.js(16.7KB gz,vendor,无构建)
   评估,再考虑方案 3;
2. **claude -p 的输出格式/稳定性** → S7 spike 前置钉死三个未知;executor 接口把
   不确定性关在一个文件里,假 executor 支撑全部测试;
3. **KB 切换的状态泄漏** → 每个请求显式解析 kb 参数,server 无全局 KB 状态
   (注册表只存路径清单);
4. **并发写交错** → S10 串行队列,治理体系的单操作者假设在 UI 层由队列强制实现。
