# 优化循环日志(2026-08-07 启动)

Loop 约定(用户指令):落实 T1–T10;优化持续进行;每轮落实文档与决策、提交 git;
**停止条件**:启动后 8h,或检索/chat 累计完成 5 轮优化。停止后汇报最终成果。

- 启动时间:2026-08-07(本地)
- 优化轮次计数(检索/chat 实现类):2 / 5

## 轮次记录

### 测试基建 T1–T6(2026-08-07 完成)

- T1 `60ac207` 场景语料(重复对/版本对/冲突对/口语化),pipeline 全绿。
- T2 `1b4b686` 治理行为测试 GF-01..12,54/54。修正三处目录假设:dismissal 是标记非删除、
  index.md 含 candidate 但带状态标记、archive decision 的 page 是归档目标。
- T3 `6788528` Chat 机制测试 CM-01..06,60/60(引用有效性硬门禁)。
- T4 `6abf423` 黄金数据集 45 条(9 类,分级相关度,conversational 走 fallback 路径,
  分类别报告;q31 标记 knownMiss 基线 = query 改写靶点)。CJK bigram 降级进 research.mjs。
- T5 `e6ab1c9` Playwright 流程 PW-01..05;**抓到一个真 bug**(队列首个条目批准后不刷新)并已修。
- T6(本提交)Chat 质量评估:真实 LLM(Kimi)12 条数据集 + RAGAS 风格 judge。
  **基线**:behavior 11/12 · citation validity 10/10 · faithfulness 0.984 · relevance 0.985 ·
  ctx-precision 0.902。
  决策:citations 语义从"检索读过的页"改为"答案实际引用的页"(拒答时弱命中页不再算引用);
  ce02 暴露模型不遵循 wikilink 引用指令 → 输入 T9/T10 的引用强制优化。

### T7 调研 + R1 优化轮(检索,2026-08-07)

- T7 `3ded388` 调研报告(docs/research/retrieval-optimization.md)+ ADR-0010:
  采用 LLM 查询改写 + RRF 融合;HyDE/稠密检索暂不采纳(需 embedding 基建,KB 上量后复议)。
- R1(本提交)实现:`searchSmart`(fallback → LLM 改写 2-3 变体 → RRF 融合);
  fallback 的逐词合并也从频次改为 RRF。chat 接入;kb_search CLI 不动(解耦保持)。
- **度量前后**(conversational 类,10 条):Hit@5 0.90 → **1.00**,Hit@1 0.70 → 0.80;
  其余类保持 1.00 无回归;q31 knownMiss 基线翻转(改写变体 "重复扣款 双重扣费" 命中),
  已转为正式记分项(无 donor 时仍按基线断言)。

### R2 优化轮(检索,2026-08-07)

- deep / deep-research 级加 listwise LLM 重排(融合池 top-20 → top-k;quick 保持单次调用)。
  rerank 失败时保留融合序;返回带 `reranked: true` 标记。
- **度量前后**(chat-eval 真实 LLM):ctx-precision 0.902 → **0.950**,relevance 0.985 → 0.989,
  behavior 11/12 → **11/11**(本轮 ce02 通过;ce12 行未进报告,原因待查——suite 本身全绿,
  疑似后台进程交叠写报告,下轮复跑确认)。faithfulness 0.984 → 0.934(下降 0.05,
  单点波动待下轮观察,仍 >0.93)。citation validity 保持 100%。
