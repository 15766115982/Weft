# 优化循环日志(2026-08-07 启动)

Loop 约定(用户指令):落实 T1–T10;优化持续进行;每轮落实文档与决策、提交 git;
**停止条件**:启动后 8h,或检索/chat 累计完成 5 轮优化。停止后汇报最终成果。

- 启动时间:2026-08-07(本地)
- 优化轮次计数(检索/chat 实现类):0 / 5

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
