# 方案 2:SSR + htmx 文档站

> 调研方向 A(BookStack 验证十几年的形态):服务端渲染 HTML + htmx 局部刷新,
> 浏览器只有极少 JS。公共决策(S1-S9)见 [README.md](README.md)。

## 形态

```
ui/
├── serve.mjs                 # node:http;HTML 路由 + 少量 JSON API
├── lib/                      # kb/search/acquire/govern/jobs/executor/llm/snapshots
│   │                         # (与方案 1 的后端分层基本相同,差别在输出形态)
│   ├── render.js             # 模板函数(模板字符串或微模板)+ 布局
│   └── md.mjs                # 服务端 markdown 渲染:markdown-it + wikilink 插件
├── public/
│   ├── vendor/htmx.min.js    # 16.6KB gz
│   ├── vendor/purify.min.js  # 仅给少量 JS 岛用
│   ├── islands/              # 手写 JS 岛:流式控制台、图谱、异步徽标、搜索建议
│   └── style.css
└── test/
```

- 页面 = 服务端渲染好的 HTML(浏览/队列/dashboard/详情全部 SSR);
- 交互 = htmx(hx-get/hx-post 拿 HTML 片段局部替换:树展开、队列操作、搜索提交);
- 动态 = SSE 推送 + JS 岛接管(治理流式控制台、评测徽标、图谱、自动刷新)。

## 功能块适配要点

- **强项**:A 浏览/D 门面(SSR 甜区,首屏快、无 JS 可读、打印友好);
  C 评审队列(SSR 表格 + htmx 按钮,前端成本近零);
  markdown 服务端渲染,markdown-it 插件生态(锚点/目录)现成;
- **弱项(对本需求集是硬伤)**:
  - I4 流式控制台:SSE 事件要转成 DOM 追加,htmx 的 SSE 扩展能力有限,
    实际上得手写 JS 岛——控制台是最重的一块却最不适配;
  - K 异步徽标:结果已 SSR 完,分数后到,要么轮询换片段(整片重渲)要么 JS 岛;
  - A7 图谱、J3 自动刷新、B4 候选空间检视:全部是客户端交互,SSR 帮不上;
  - 结果:**两套渲染哲学共存**——简单页 SSR,重的页实质是 SPA,维护心智不统一;
- npm 依赖:markdown-it(+ 服务端消毒如 sanitize-html)——内网需镜像装 2 个包。

## 对现有服务的影响

与方案 1 相同:零代码改动,契约注记相同。

## 测试策略

后端 HTML 路由断言片段(比 JSON 断言脆);htmx 交互基本无法单测,靠人工/手动测试指南;
JS 岛的纯函数可测。整体可测性低于方案 1。

## 工作量(相对)

M7a **S**(三方案中最快出像样的浏览体验)｜ M7b **M**｜
M7c **L+**(流式+作业中心与 SSR 哲学搏斗)｜ M7d **M**。

## 风险

1. **交互重心错配**:本需求的重心(M7c 控制台、K 徽标、图谱)全是客户端交互,
   SSR 的优势用不上、劣势全踩中——这是不推荐它的根本原因;
2. 两套渲染哲学的接缝处(JS 岛与 SSR 片段的状态同步)是长期 bug 温床;
3. markdown-it 插件版本与内网镜像可用性需要先行验证。

## 适用场景(为什么仍保留为候选)

如果里程碑重心反转——浏览/展示占 90%,治理控制台降级为"跑完看结果"——
方案 2 立刻变成最优。评审时若认为 M7c 的权重没那么高,应认真考虑它。
