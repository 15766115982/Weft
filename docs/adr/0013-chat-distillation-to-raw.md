# ADR-0013: Chat 一键整理 — 对话蒸馏为 raw 文档(chat source)

Status: accepted (2026-08-11)

## Context

门户聊天页(ADR-0011 管线)的问答知识随 localStorage 丢失,用户要求"一键整理":把当前
对话沉淀为结构化文档,进入 KB 的采集-治理-检索管线。三个硬约束塑造了设计:① raw/ 是
acquisition 独占写区,门户白名单只允许写 inbox/ 暂存;② 用户要求蒸馏稿"真实可靠"——
每个整理点必须可核验;③ raw/ 按契约保留源语言,KB 主语言英文化是治理层职责。

## Decision

1. **产物形态 = 单篇自包含"对话蒸馏文档"**:LLM 蒸馏正文(每个整理点带 `[T-n]` 引用
   标记)+ 同文件末尾**编号转录附录**(逐条消息,含角色/时间戳)。引用在同文件内解析,
   转录计入 `content_hash`——证据与蒸馏稿原子共存,不存分离文件、不进 `.kb/`。蒸馏稿
   用**对话语言**书写(契约:raw/ keeps source language)。
2. **新 source `chat` + `raw/chat/` 目录**(UI 显示"用户对话整理"),契约
   increment-compatible 修订。写入链路:门户把转录发给 agent 服务的蒸馏任务(所有模型
   调用归 agent)→ 门户预检 → 写 `inbox-chat/` 暂存(KB 根下、与 local 的 `inbox/`
   平级——若放进 `inbox/chat/` 会被 local 连接器的递归扫描重复采集)→ `acquire.mjs
   chat` 连接器再校验、铸 frontmatter、落盘。**门户全程不写 raw/**,写权限矩阵零改动。
3. **身份规则**:`source_id = conv-<转录hash8>`(同 local 连接器思路)——同一对话重复
   整理 = 覆盖同一篇(契约"重拉即覆盖"语义),幂等防重复文档;`source_url` 用伪 URL
   `weft://chat/<source_id>`;`source_version` = 末条消息时间;`connector = chat@1.0.0`;
   `title` 由蒸馏 LLM 产出;`extra` 记 `{message_count, levels_used, cited_pages}`。
4. **双层 fail-closed 引用校验**:门户预检(agent 返回后、写 inbox 前)与连接器入口检
   (落盘前)各自独立验证:正文每个 `[T-n]` 可解析到附录条目、附录条数 = 转录条数、
   body 无 frontmatter。任一失败 → 不写任何文件,显式报错。LLM 失败/超时不留半成品;
   对话超模型上下文**显式报错**,不静默截断(截断会无声断开证据链)。
5. **作用域与事后状态**:一键 = 整理**整段当前对话**,不支持框选(框选会使同一对话的
   不同子集产出多篇重叠文档,破坏幂等语义);整理成功后聊天记录原样保留,反馈文案明确
   "下次治理运行后进入 wiki 可检索"。**不挂立即治理链**——落 raw/ 即功能完成,治理按
   既有节奏(手动/定时 govern run)统一处理(用户裁决,2026-08-11)。

## Considered Options

- **转录单独成篇 / 存 `.kb/`**:前者让 wiki/sources/ 每段对话冒出两个 source page;后者
  引用指向 gitignored 易删工件,"可核验"承诺破产。均否。
- **门户直接写 raw/chat/**:改动最小但撕开单目录单写者原则。否。
- **整理后立即跑单文档定向治理链**(summarize-source → apply-source → reindex):反馈
  更即时但引入新编排;用户选择保持链路最小,治理留给下次 run。否(可日后复议)。
- **蒸馏直接成英文**:正文(英)与附录(对话语言)语言分裂,用户核验体验受损。否。

## Consequences

- 契约 §1/§2 修订:source 枚举 + `chat`,目录树 + `raw/chat/`;写权限矩阵不变。
- agent 服务新增蒸馏任务,prompt 入 `.kb/config/prompts/`(每 KB 可调,现有约定)。
- 治理管线对 chat 文档零改动自动生效(plan → summarize-source → dedup/冲突检测)。
- 同一对话"继续聊再整理"产出新文档而非更新旧文档——对话快照语义,历史由 KB git 承载。
