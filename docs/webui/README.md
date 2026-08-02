# WebUI 工作流(process tracker)

> 与用户对齐的流程(2026-08-02),严格按序进行,不跳步:

1. ✅ **调研归档** — [research.zh-CN.md](research.zh-CN.md)(WebUI 形态)+
   [research-eval.zh-CN.md](research-eval.zh-CN.md)(块 K 评测服务,LLM-As-A-Judge)
2. ✅ **头脑风暴,捋清用户想要的工作/场景** — 完成(两轮对齐 + 愿景拆解)
3. ✅ **记录确认的功能清单** — [requirements.zh-CN.md](requirements.zh-CN.md) **已冻结**(2026-08-02);
   里程碑:M7a 只读全套 → M7b 采集控制台 → M7c 治理可视化+执行器 → M7d wiki 编辑+版本管理 → backlog
4. ✅ **按功能 + 现有服务设计多个架构方案** — [options/](options/README.md),3 个候选 + 公共决策 S1-S11
5. ✅ **逐个评审方案,敲定** — 方案一(no-build SPA)当选;架构评审 10 条已核对并入设计;
   ADR-0006 + 契约 §1 修订 + CONTEXT 同步完成(2026-08-02);S7 spike 完成(见 spike-s7.zh-CN.md)

## 实施(进行中)

- ✅ **M7a 只读全套 — 完成**(2026-08-02):slice 1-4,14 测试全绿;质量审核
  (M7a-review.zh-CN.md,零误判)全部修复,三项裁决已记录(J3-5→M7b /
  A5 分屏对照+raw 反查现补 / Node 钉 20.x)
- ✅ **M7b 采集控制台 — 完成**(2026-08-02):jobs.mjs(S10 per-KB 串行写队列,
  jobs.jsonl 持久化 + 死进程墓碑)+ 上传 E(raw bytes + X-Filename,32MB,入队后
  写 inbox → acquire 单作业)+ 源拉取 F(jql/cql/max 覆盖)+ raw 删除/移动 G
  (G5 rawrefs 影响预览弹窗;G6 快照:git pathspec 提交 / .kb/ui/snapshots 副本)+
  J3 fs-watch(.kb 排除 + 400ms 防抖,SSE /api/events)+ J4 inbox + J5 认证检查 +
  J6 新鲜度(acquisition 补上契约预定的 acquire_runs.jsonl 追加);23 UI 测试全绿,
  Playwright 行为验证零 JS 错误。**外部审核(M7b-review.zh-CN.md,零误判)4 P2 全修**:
  删/移后落地导航、全请求 Host 校验(DNS rebinding 读)、jobs.jsonl 压缩、settled 清理;
  P3 批次(J6 相对时间+逾期着色、I6 耗时、顶栏作业指示器、文案类)同步完成,25 测试全绿
- ✅ **M7c 治理可视化 — 完成**(2026-08-02):executor.mjs(startRun→事件流 +
  registerExecutor 公开插桩点;claude headless 实现,**提示词走 stdin**——spike 漏网:
  多行 argv 经 .cmd 垫片零输出)+ I4 SSE run 通道流式转写 + I5 /api/plan 全清单预览
  + I1 sweep/rebuild-index/merge-topic;**真实 agent e2e 通过**(UI 发起 → 流式 →
  产出契约合规 candidate 源页+主题草稿+日志,队列 1→3);默认提示词改指 skill 文件
  (注册无关)。31 测试全绿
- 🔵 **下一里程碑:A7 关系图谱**(小里程碑,用户拍板 B:wikilink 力导向图,
  ≤2k 节点客户端布局,与 [[引用签]] 视觉统一)→ 然后 M7d wiki 编辑(H2/H3 契约规则未议)
- ⬜ backlog:K 评测 / J9 闭环 / C5 批量 / B5 查询历史
- ⬜ 并行欠账:真实环境验收 docs/real-env-test.md(全系统级,与 M7 无关)

硬约束(全程有效):现有三服务(acquisition/governance/retrieval)零改动、零反向依赖;
前端可依赖现有服务;内网离线,依赖越少越好;继承 viewer 三条红线(按需启动 /
无用户系统 / 哑消费者)。

已撤下的材料:首版超前写出的设计方案(含 ui/ 包、子进程调 kb_search、复用 statusflip
等想法)已撤回,其思路作为阶段 4 的方案素材保留在本记录中,不构成决策。
