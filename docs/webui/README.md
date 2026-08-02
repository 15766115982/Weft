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
- 🔵 **M7b 采集控制台**(下一里程碑):jobs.mjs + S10 串行写队列 + 上传(E)+
  源拉取(F)+ raw 删除/移动(G,含 G5 影响预览——复用 rawrefs 扫描)+
  J3 fs-watch / J4 inbox / J5 认证检查(自 M7a 挪入)
- ⬜ M7c 治理可视化(权限姿态届时拍板)→ M7d wiki 编辑+版本管理
- ⬜ backlog:K 评测 / J9 闭环 / C5 批量 / B5 查询历史 / A7 图谱
- ⬜ 并行欠账:真实环境验收 docs/real-env-test.md(全系统级,与 M7 无关)

硬约束(全程有效):现有三服务(acquisition/governance/retrieval)零改动、零反向依赖;
前端可依赖现有服务;内网离线,依赖越少越好;继承 viewer 三条红线(按需启动 /
无用户系统 / 哑消费者)。

已撤下的材料:首版超前写出的设计方案(含 ui/ 包、子进程调 kb_search、复用 statusflip
等想法)已撤回,其思路作为阶段 4 的方案素材保留在本记录中,不构成决策。
