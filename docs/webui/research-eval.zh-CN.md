# 检索质量评测服务(LLM-As-A-Judge)调研归档(2026-08-02)

> 纯调研归档,支撑 requirements.zh-CN.md 块 K。硬约束:内网离线;LLM 仅三个来源
> (Copilot proxy 转发的 GPT[OpenAI 兼容] / Azure GPT[SPN 认证] / headless `claude -p`)。

## 结论摘要

- **零 Python 可行且推荐**:自研轻量 judge(Node 内 HTTP 直调 LLM)+ Promptfoo 做 CI 回归,
  全程不引入 Python 运行时;
- 检索系统的评测对象是 query+chunk(无生成环节),**除 RAGAS 版 Answer Relevancy 外,
  常用指标全部纯 LLM 可算,embedding 缺失基本无损**;
- 每次搜索**同步评测不现实,异步徽标可行**(top-5 异步 3-6s,~3-4k tokens/查询,成本可忽略);
- 已知偏差(position/verbosity/分数漂移)有成熟缓解:固定 rubric + temperature=0 +
  **用现有黄金集校准 judge 准确性**(我们已有 Hit@5=1.000 的黄金集,正好做元回归)。

## 1. RAGAS(v0.4.x,最新 v0.4.3,2026-01;仓库迁至 vibrantlabsai/ragas)

- v0.4 重大重构:指标迁至 ragas.metrics.collections,@experiment() 架构,llm_factory()
  统一接入,底层 instructor + LiteLLM;约 50 个传递依赖(openai/instructor/litellm/
  pydantic/datasets 等),离线 wheel 安装 200-400MB。
- 指标与依赖:Faithfulness / Response Groundedness / Context Precision(无参考版)纯 LLM;
  **Answer Relevancy 必须 embedding**(生成反问算余弦)——copilot proxy 若不转发
  embeddings 接口则不可用;Context Recall / Factual Correctness 需 ground truth。
- 自定义端点:LiteLLM 支持 api_base(OpenAI 兼容)+ Azure 一等支持。
- **判断:离线可装,但"为 3 个指标引入 50 个依赖 + 一个 Python 运行时",性价比低;不推荐。**

## 2. DeepEval(v3.9.9,2026-04,迭代活跃)

- 定位 pytest 式 LLM 单测框架(assert_test / CI 回归友好),也有独立 evaluate() API。
- **关键差异:DeepEval 版 Answer Relevancy 是纯 LLM 实现,不需要 embedding**;检索常用指标
  (G-Eval/Faithfulness/Contextual Precision·Recall·Relevancy/Hallucination/DAG)全部纯 LLM。
- 端点:GPTModel(base_url=...) 指任意 OpenAI 兼容端点;AzureOpenAIModel 且
  **v3.8+ 新增 Azure AD token 认证(正好覆盖 SPN)**;Confident AI 是其 SaaS,非必需。
- **判断:若一定要引入 Python 框架,DeepEval > RAGAS;但对我们是备选(sidecar 方案 C)。**

## 3. 其他候选

- **Promptfoo(Node 原生)**:架构上最顺的框架选项。apiBaseUrl 直指 copilot proxy;内置
  llm-rubric / context-recall / context-precision / factuality 断言;
  PROMPTFOO_DISABLE_TELEMETRY=1 后完全离线;可自定义 JS provider 包住 FTS5 检索。
  短板:批量/CI 工具,不是请求路径内的实时打分。
- **Arize Phoenix**:自托管/离线一等公民,RAG 评测最强观测工具;但要再跑一个服务+Python,
  对单次搜索打分是杀鸡用牛刀;适合将来做全链路 tracing。
- **RAGChecker**(Amazon,2024):claim 级 entailment,与人工相关性显著优于 RAGAS/TruLens/ARES;
  但需 ground truth + 单 query 几十次 LLM 调用,只适合离线诊断/CI。
- TruLens(迭代落后)、ARES(需训练判别器+人工标注)、LangSmith(SaaS/自托管需 Enterprise
  且非气隙要外联)、CRAG(是 benchmark 不是工具)——排除。

## 4. 无框架轻量路线的文献依据

自研 judge prompt(query+chunk → 0-3 分 + 理由,低温度、结构化输出)有充分实证:
- **G-Eval(Liu et al. 2023)**:GPT-4 rubric 打分与人工 Spearman 0.514,优于 BLEU/ROUGE/BERTScore;
- **MT-Bench / Judging LLM-as-a-Judge(Zheng et al. 2023)**:强 LLM judge 与人工一致率 >80%;
- **RAGChecker meta-eval**:LLM 细粒度相关性判定优于框架整体指标;
- 工业界事实标准:pointwise 分级 + rubric(Microsoft/LangChain/Langfuse 同款形态)。
- 偏差缓解:position bias(换序复测)、verbosity bias(rubric 声明长度不加分)、
  self-preference(检索无生成环节,基本免疫)、分数漂移(固定 rubric + temp=0 + 黄金集校准)。

## 5. 关键架构问题的答案

- **共存方式**:实时/按需评测 = Node 内 HTTP 直调(零新运行时);批量回归 = promptfoo CLI
  (Node 同栈);不建议仅为 3-4 个指标引入 Python sidecar。
- **实时性**:top-5 pointwise 每条约 600in/80out tokens、1.5-3s;5 条并行 3-6s 或合并单次
  批量 ~2k in / 2-4s。结论:**搜索立即渲染,judge 后台跑,完成浮现质量徽标;深度评测按需
  按钮;另加 5-10% 抽样做趋势监控**。
- **无 embedding**:除 RAGAS 版 Answer Relevancy 与 Semantic Similarity 外全部可算;
  检索场景 Answer Relevancy 本就不是核心,基本无损。
- **Azure SPN @ Node**:成熟且可零依赖——纯 fetch  POST login.microsoftonline.com oauth2
  token(client_credentials,scope=cognitiveservices.azure.com/.default),token 1h 进程内缓存;
  正规做法 @azure/msal-node ConfidentialClientApplication.acquireTokenByClientCredential;
  SPN 需授 Cognitive Services OpenAI User 角色。

## 6. 候选方案

- **方案 A(推荐)**:自研轻量 judge,Node 原生,统一 LLMJudge 接口 + 三适配器
  (copilot proxy: fetch OpenAI 兼容 / Azure: msal-node 或纯 fetch / Claude: spawn claude -p
  备用+交叉验证)。指标:chunk 相关性 pointwise 0-3 + 理由(异步);结果集覆盖度/噪声率
  (单次批量);按需 groundedness。分数写 SQLite(query_hash, chunk_id, score, reason,
  judge_source, latency),前端浮现徽标。依赖:msal-node(可选)。校准:黄金集元回归。
- **方案 B(推荐作 A 的补充)**:Promptfoo CI 回归,apiBaseUrl 指 copilot proxy,
  context-precision/recall/llm-rubric 断言跑黄金集,与 A 共用 prompt+黄金集。
  **A+B 全程零 Python。**
- **方案 C(备选)**:Python sidecar(FastAPI + DeepEval v3.9.x),仅当将来需要 DAG/多轮等
  复杂指标时;明确不选 RAGAS(依赖重、要 embedding、v0.4 API 动荡)。

## 主要来源

- vibrantlabsai/ragas releases、ragas v0.4 迁移指南、ragas PyPI/pydeps、metrics 文档
- DeepEval changelog 2026(v3.9.9)/2025(v3.0)、G-Eval 文档、confident-ai/deepeval releases
- RAGChecker 论文 arXiv:2408.08067;RAG 评测综述 arXiv:2504.14891
- Arize LLM 评测指南、Langfuse LLM-as-a-judge 文档、Confident AI 博客
- genai.qa 对比文(DeepEval vs RAGAS / Promptfoo vs DeepEval vs RAGAS)、glancerai 观测工具对比
