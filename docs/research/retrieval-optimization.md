# 检索优化调研(2026-08-07)

方法:curl 直连 api.github.com / raw.githubusercontent.com(本机 WebSearch/WebFetch 对 GitHub 受限)。
目标:为 Weft 的检索/chat 召回问题(尤其中文口语化查询)选型。

## 候选项目与各自检索做法

| 项目 | Stars | 检索管线要点 |
|---|---|---|
| langgenius/dify | 151.6k | 四种模式:semantic / full_text / keyword / **hybrid**;后接 **rerank** 阶段 + score_threshold |
| langchain-ai/langchain | 143.6k | **MultiQueryRetriever**(LLM 生成 N 个查询变体,并集去重);EnsembleRetriever(BM25+向量,**RRF** 融合);ContextualCompression(重排/压缩) |
| infiniflow/ragflow | 87.0k | 混合检索 + rerank;**grounded citations**(答案引用可溯源)作为一等公民 |
| run-llama/llama_index | 51.4k | query transform 家族:**HyDE**(生成假想答案再检索)、Decompose(拆子问题)、Step-decompose(逐步) |
| deepset-ai/haystack | 26.1k | pipeline 显式 joiner/ranker 节点 |
| PrithivirajDamodaran/FlashRank | 1.0k | 轻量 cross-encoder/listwise **rerank** 层,CPU 可跑 |

## 提炼出的技术清单

1. **LLM 查询改写 / 多查询扩展**(MultiQuery / query transform):一次额外 LLM 调用,
   把口语化问题改写成 2-3 个关键词查询(可含同义词、中英对照),分别检索后并集。
2. **RRF 融合**(Reciprocal Rank Fusion,`1/(60+rank)` 累加):多路召回的标准融合法,
   比我们现在的"按命中频次"更抗噪声。
3. **重排(rerank)**:cross-encoder(FlashRank 类)或 listwise LLM 重排;top-20 → top-k。
4. **HyDE**:生成假想答案再检索 — 需要 embedding 相似度才有意义,纯 FTS5 下收益存疑。
5. **混合稠密检索**:BM25 + 向量,RRF 融合 — 业界共识上限最高,但需要 embedding 基础设施。

## 与 Weft 的适配判断

- 硬约束:无 Python、无常驻服务、FT5/SQLite、LLM 服务已存在(可用于改写/重排)。
- **R1(本轮)**:LLM 查询改写 + RRF 融合(技术 1+2)— 直击 conversational 类 0.44 的 Hit@5
  和 q31 knownMiss;每次 chat 仅多一次小调用,quick 级保持单次。
- **R2(下一轮)**:listwise LLM 重排(技术 3 的轻量版)— deep/deep-research 级召回 20 → 重排取 top-k;复用 judge-context-precision 的 prompt 形态。
- **HyDE 与稠密混合检索:暂不采纳**(技术 4/5)— 需要 embedding 管线与向量存储,
  对当前 KB 规模(~百页)收益/成本比低;若 KB 上量后再开 ADR 复议。
- 引用可溯源(RAGFlow 的 grounded citations)已在 T6 落实(citations=答案实际引用页)。

## 度量

- 检索:tests/eval/golden(45 条,分类别 Hit@5,conversational 基线见报告)。
- Chat:tests/eval/chat-eval(faithfulness 0.984 / relevance 0.985 / ctx-precision 0.902 基线)。
- 每轮优化必须给出前后对比并落 docs/test-reports/。
