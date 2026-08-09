# ADR-0012: 去 Claude CLI 化 — LLM 层迁移 LangGraph,新增 agent/ 服务

Status: accepted (2026-08-08, 决策已确认,实现分阶段进行)

## Context

内网部署环境不再提供 Claude Code / claude CLI,且没有任何其他 CLI agent 工具。
盘点发现 claude CLI 硬依赖仅两处:门户的 agent 治理运行(`ui/lib/executor.mjs`
唯一注册的 executor)和 K 块 LLM judge(`ui/lib/judge.mjs` 唯一注册的 backend,
含搜索评分徽章与 judge-calibrate);chat / deep-research / settings-check 已走在
`llm/`(Node,OpenAI 兼容)之上,不受影响。内网可用的模型通道:**Copilot API
gateway(OpenAI 兼容端点)+ Azure OpenAI SPN 认证**,两者都必须支持。

## Decision

1. **模型通道**:Copilot API gateway(OpenAI 兼容)为主通道;**同时支持 Azure
   OpenAI SPN 认证**(现状 models.json 的 `provider: "azure" | "openai"` 双 provider
   契约在 Python 侧原样继承)。官方 Copilot SDK 路(MAF `github_copilot` 包)经合规
   审查否决:流量旁路公司网关(无审计/限流),且将特殊账号用于自动化服务。
2. **框架**:**LangGraph**(Python)。候选评估:MAF(年轻、API churn;其 Copilot
   SDK 优势因合规否决而失去意义)、Pydantic AI(最轻但生态/检验不如 LangGraph)、
   TS 系(Vercel AI SDK / Mastra,不破单运行时但用户选择接受 Python)。
3. **LLM 层整体搬迁**:`llm/`(Node)全部 12 个任务 + 治理 agent 迁入新顶层服务
   **`agent/`**(与 acquisition/governance/retrieval/ui 平级),`llm/` 退役。
   **CLI 契约逐字保留**(`<task> --kb --input-file --output-file`、stdout JSON、
   流式任务 NDJSON、models.json 配置格式、`WEFT_LLM_STUB` 测试桩),门户 /
   jobrunner / 测试仅需把 spawn 目标从 node 换成 python。
4. **治理 agent 形态:图约束(graph-constrained)**。固定骨架
   sweep → plan → 逐文档 → rebuild-index,由图节点代码(Python subprocess)调用
   `govern.mjs` 子命令——**写盘咽喉不变,agent 无任何直接写盘工具**;LLM 只在
   节点内做结构化输出判断(分类/冲突/合成/govern-decide)。每节点 checkpoint,
   断点续跑。由此**不依赖网关的 tool-calling 能力**,普通 chat completions +
   JSON 输出即可,最大未验证风险消除。
5. **删除**:executor 'claude'、`ui/lib/claudecli.mjs`、judge 'claude' 后端
   (judge 改走 agent/ 服务);三个 SKILL.md(kb-acquire/kb-govern/kb-search)
   删除,prompt 规范迁入 `agent/` 的 prompts 文件——内网无 Claude Code 宿主,
   skill 形态失去意义;三个服务 CLI 保持纯 node 独立可用。
6. **支柱修订**:"No Python" 修订为"**Python 仅限 `agent/` 服务**"(Node 仍是
   其余全部服务的唯一运行时);"no always-on services" 不变(agent 按 run
   spawn,NDJSON 事件流接门户 SSE);串行写队列、candidate 状态机、layer C
   git 边界检查等安全 posture 全部原样保留。

## Consequences

- 分阶段:Phase 0 网关 spike(chat + JSON 结构化输出可靠性,半天)→ Phase 1
  `agent/` 任务对等移植(judge 同时改道)→ Phase 2 治理图 agent → Phase 3 删除
  claude 代码 / `llm/` / skill,文档收官。
- 本 ADR 落地时同步:CONTEXT.md(服务清单 4 → 5、skill 相关段落)、CLAUDE.md
  (支柱与命令)、install 脚本(去掉 ~/.claude/skills 链接)。在 Phase 3 完成前,
  这些文档描述的现状与新决策并存,以本 ADR 为准。
- 开发机失去 claude executor 的本地 agent 治理能力(决策 5 的代价,用户已确认);
  开发期 Claude Code 仍可直接驱动三个服务 CLI。
- 高危包拦截风险:LangGraph 依赖 langchain-core + checkpoint 包,需在 Phase 0
  一并过内网拦截验证;若被拦,降级方案为 Pydantic AI(同契约平移)。
