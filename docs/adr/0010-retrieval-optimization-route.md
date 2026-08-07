# ADR-0010: 检索优化路线 — LLM 查询改写 + RRF 融合,延迟稠密检索

Status: accepted (2026-08-07)

## Context

检索 eval(45 条黄金数据集)显示:exact/phrase/CJK/filter 类 Hit@5 接近满分,
但 **conversational(口语化中文提问)类显著偏低**,q31("钱会被扣两次吗?")
无任何关键词锚点(knownMiss 基线)。调研(docs/research/retrieval-optimization.md,
Dify/LangChain/RAGFlow/LlamaIndex/FlashRank)表明主流解法是 LLM 查询改写、
多路召回 RRF 融合、重排、混合稠密检索。

## Decision

R1:在 LLM 服务的检索入口(`llm/lib/research.mjs`)加 `searchSmart`:

1. 先走现有 `searchWithFallback`(原查询 → 剥停用词 → 逐词/bigram 合并);
2. 命中不足时,用一次 LLM 调用做**查询改写**(生成 2-3 个关键词查询,中英同义扩展),
   变体分别检索;
3. 所有路的结果用 **RRF(1/(60+rank))** 融合排序,替代原按频次合并。

R2(后续轮):deep/deep-research 级加 listwise LLM 重排(top-20 → top-k)。

**不采纳**:HyDE 与稠密向量检索 — 需要 embedding 基础设施,当前 KB 规模下
成本/收益不划算;KB 上量后复议。

## Consequences

- 每次 chat/deep 在弱命中时多一次 LLM 改写调用(quick 级强命中路径不受影响)。
- 新增 prompt 模板 `query-rewrite`(templates/prompts/)。
- 效果以黄金数据集前后对比验收:conversational Hit@5 应显著上升,q31 knownMiss
  若翻转则该用例转为正式记分项(测试会大声失败提示改标注)。
- 检索服务(kb_search CLI)本身不变 — 改写/融合全部在 LLM 服务侧,保持服务解耦。
