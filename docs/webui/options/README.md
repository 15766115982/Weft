# 架构方案对比与公共决策(阶段④)

> 需求:[../requirements.zh-CN.md](../requirements.zh-CN.md)(已冻结)。
> 三个候选方案,独立成文,逐个评审:
>
> 1. [option-1-nobuild-spa.zh-CN.md](option-1-nobuild-spa.zh-CN.md) — **no-build SPA 控制台**(viewer 模式直系放大)
> 2. [option-2-ssr-htmx.zh-CN.md](option-2-ssr-htmx.zh-CN.md) — **SSR + htmx 文档站**(BookStack/调研方向 A)
> 3. [option-3-lightbuild.zh-CN.md](option-3-lightbuild.zh-CN.md) — **轻构建组件化**(esbuild + 组件框架)

## 公共决策(三个方案共享,不随方案变)

这些点在任一方案下都一样,先行敲定,评审时只需确认无需重议:

| # | 决策 | 内容 | 理由 |
|---|---|---|---|
| S1 | 包位置 | 新顶层包 `ui/`,与三服务平级 | 独立前端服务;三服务零反向依赖 |
| S2 | 对现有服务的影响 | **零行为变更;只读增量允许,随契约注记一起走评审**(2026-08-02 评审后软化)。集成:写操作一律 spawn CLI(进程隔离);只读热路径(search/read/plan)允许 in-process import lib(statusflip 的 import 已是先例) | CLI 契约最稳定;spawn 的 Node 启动开销(Windows 150-400ms)不该由搜索热路径承担 |
| S3 | UI 自身数据落盘 | `<kb>/.kb/ui/`:jobs.db(作业中心)、eval 分数(块 K)、snapshots/(快照)——派生制品,KB gitignore 已覆盖 .kb/ | 契约 §1 "索引是派生制品"同款逻辑;需一次 increment-compatible 契约注记 |
| S4 | 版本管理约束的答案 | git 可用 → 充分利用(diff/历史/操作前 commit);不可用 → G6 退化为操作前复制快照到 .kb/ui/snapshots/ + UI 横幅提示"建议 git init";J7 页面历史无 git 时隐藏 | 不假设 git;viewer 已有 baseline=null 降级先例 |
| S5 | LLM 后端抽象 | 一个 `llm/` 模块,三个适配器:copilot proxy(fetch, OpenAI 兼容)/ Azure SPN(纯 fetch 拿 token,1h 缓存;msal-node 可选)/ claude -p(spawn);**agent 执行器(块 I)与评测 judge(块 K)共用** | 调研结论;用户硬性要求可插拔 |
| S6 | 流式(I4) | **SSE**(node:http 原生,零依赖);WebSocket 需 ws 依赖,排除;断线降级为轮询 | 内网零依赖约束 |
| S7 | agent 执行器接口 | `startRun(spec) → 事件流`;首实现 = headless `claude -p`;第三方框架按接口接入。**spike 已完成(2026-08-02,[spike-s7.zh-CN.md](../spike-s7.zh-CN.md))**:① 事件模型 = `--output-format stream-json --verbose` 的 JSONL 子集(init/assistant/result),实测渐进实时;② spawn 用 `claude.cmd` 直生不带 shell(`spawn('claude')` 在 Windows ENOENT);③ 权限姿态实测:默认拦工具写(**exit 0 不是错误信号**,必须解析 result 事件),`--dangerously-skip-permissions` 可行,allowedTools 未实测——**用户 2026-08-02 拍板:M7c 开工时再定**(M7a/M7b 只读+机械写,用不上) | 用户:"不只靠 Claude" |
| S8 | 安全闸门 | 照抄 viewer:resolveUnder 统一归一化(win32 小写)、逐段拒 `..`、413、409;渲染输出消毒。**+ localhost 写安全**(评审 P0-2):启动期生成随机 token(meta 注入前端,不写盘不进日志,每次启动换新),所有写请求校验 token + Origin/Host(拒跨源、拒非 127.0.0.1 Host);GET 读不设卡 | M3 教训;绑 127.0.0.1 挡不住恶意网页向本机端口发简单 POST(CORS 只拦读响应) |
| S9 | KB 切换器 | 配置文件(代码仓侧,非 KB 侧)登记多个 KB 路径;切换 = 重定向到 ?kb= 参数;任何时刻一个请求只作用于一个 KB | J1;多 KB 是系统既有能力 |
| S10 | per-KB 串行写队列(评审 P0-1) | 写类作业(acquire/govern 各子命令/approve/reject/raw 删除·移动/wiki 编辑)**按 KB 排队串行**;只读作业(search/read/plan/health)任意并发;队列状态在作业中心可见,排队触发有明确反馈 | 治理体系假设单操作者,409 只保单页翻转;UI 让并发写极易发生 |
| S11 | UI 写 KB 白名单(评审 P0-5,viewer 红线 3 的新形态) | 允许且仅允许:① inbox/ 上传;② raw/ 删除·移动(**快照先行 → resolveUnder 校验 → 走 S10 队列 → 删前过 G5 影响预览**);③ statusflip 评审写;④ `.kb/ui/` 派生物。白名单之外一律不写 | 删除/移动 raw 的信任面远大于 viewer 的 status 翻转,必须显性化 |

## 对比矩阵

| 维度 | 方案 1 no-build SPA | 方案 2 SSR+htmx | 方案 3 轻构建 |
|---|---|---|---|
| 红线符合度(无构建链) | ✅ 完全符合 | ✅ 符合 | ❌ 引入构建步骤(需特批) |
| npm 依赖 | **0**(vendor marked+DOMPurify ~33KB gz) | markdown-it + 消毒(2 个) | esbuild + 框架(devDep)+ 运行时库 |
| 离线安装 | 零安装 | 需内网 npm 镜像装 2 包 | 构建链离线钉版负担最重 |
| M7a(只读全套)出活速度 | 快 | **最快**(SSR 天然适合浏览) | 中(先搭脚手架) |
| 流式治理控制台(M7c) | ✅ 自然(SSE + JS) | ⚠️ SSE+htmx 组合别扭,需手写 JS 岛 | ✅ 自然 |
| 异步评测徽标(块 K) | ✅ 自然 | ⚠️ 需 JS 岛 | ✅ 自然 |
| 图谱(A7,backlog) | ✅ canvas/力导向直接画 | ❌ 与 SSR 哲学最远 | ✅ |
| 全功能规模的前端可维护性 | ⚠️ 靠 ES module 纪律,全量约 3-5k 行 JS | ⚠️ 两种渲染哲学共存,交互重处破功 | ✅ **最好**(组件复用) |
| 仓库文化契合(viewer 先例) | ✅ 一脉相承 | 🟡 新哲学 | ❌ 老前端构建链正是被否掉的 |
| 后端架构 | JSON API,lib 分层 | HTML 渲染 + 局部 API | JSON API,lib 分层(与 1 相同) |

## 推荐

**方案 1**。理由:
1. 唯一全程不触碰红线、不引入任何 npm 依赖的方案,与 viewer 一脉相承;
2. 本项目的 UI 重心在 M7c 的流式治理控制台和块 K 的异步徽标——这些恰恰都是
   客户端交互密集的,方案 2 的 SSR 优势(首屏/无 JS 可读)用不上,劣势全踩中;
3. 方案 1 与方案 3 **后端完全相同**(JSON API + lib 分层)——前端是唯一的变量。
   若将来 no-build 前端真的失控,可只换前端为方案 3,后端零改动。即:选 1 不烧桥。

方案 2 适合"以浏览为主"的产品,但我们的需求重心是"控制台"。
方案 3 是记录在案的逃生舱,不是本期选择。

## 契约修订包(一次打包过评审,2026-08-02 评审后定稿)

随 M7a 开工一次提交,不走"做到一半发现要改"的路径:
1. `.kb/ui/` 派生制品目录注记(S3);
2. acquire 成功后写一行 per-source 拉取记录到 `.kb/`(派生制品,供 J6 来源新鲜度;
   **全量增量跳过的健康拉取目前在 log.md 不留任何痕迹**,mtime 推导会被 G1/G2 污染);
3. ~~kb_search --debug~~ **取消**(评审误判:per-term 路由 `routed` 已在 search() stdout
   返回值里,query.mjs:161,UI 解析 stdout 即得,B4 按原口径全量实现);
4. M7d 的 wiki 人工编辑路径(H2)届时单独讨论,不在本包。

## 评审方式

逐个过:方案 1 → 方案 2 → 方案 3,每个方案请确认"形态、功能适配、风险"三点;
全部过完后拍板,然后补 ADR 并进 M7a 实施。
