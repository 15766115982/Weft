# 人工测试指南（流程与效果)

> **⚠️ 已废弃(2026-08-12)**:本指南写于 Claude Code skill 形态时代,§0 检查项与
> §1 技能对话流围绕的三个技能(kb-acquire / kb-govern / kb-search)已随 ADR-0012
> 整体删除,自动化规模声明(39 项)与"topic 页"术语亦已过时。在新版本重写之前,
> 人工验收请改走:上手指南 `docs/guide.zh-CN.md` §8(第一次完整闭环)+ 门户
> Playwright 套件(`cd ui && npx playwright test`);自动化回归口径见 CLAUDE.md。
> 本文仅作历史记录保留。

> 配套自动化层:`node --test tests/`(39 项：流程回归 20 + 检索评估 19)。
> 自动化已覆盖脚本层全部功能（除真实 Jira/Confluence 连接，见 `real-env-test.md`)。
> 本指南覆盖**自动化测不到的部分**：技能对话流、摘要/合成的主观质量、viewer 交互体验、故障演练。
> 预计用时：60–90 分钟。建议在**测试专用 scratch KB** 中进行，不要用生产 KB。

## 0. 环境准备(10 分钟)

```cmd
:: 1. 一键安装(若已装可跳过,验证其幂等:再跑一遍不应报错)
install.cmd

:: 2. 创建测试 KB
mkdir D:\kb\manual-test && cd D:\kb\manual-test && git init
echo .kb/ > .gitignore

:: 3. kb.json(只配 local 连接器)
:: { "version": 1, "name": "manual-test", "connectors": { "local": { "inbox": "inbox/" } } }

:: 4. 拷入测试语料(12 个文件,虚构支付系统领域,中英混合)
xcopy /E /I D:\claude\knowledge-extension\tests\fixtures\inbox D:\kb\manual-test\inbox
```

- [ ] `node --version` ≥ 20;`node -e "require('better-sqlite3')"` 在 retrieval/scripts 下可用（或已 npm install)
- [ ] 重启 Claude Code 后三个技能可用（kb-acquire / kb-govern / kb-search)

**记录**:

| 项 | 结果 | 备注 |
|---|---|---|
| install.cmd 幂等 | ☐ | |
| KB 初始化 | ☐ | |

## 1. 技能对话流(15 分钟)

在 Claude Code 会话中（工作目录任意，测试技能定位脚本的能力）:

1. 说：「**把知识库文档拉取下来，KB 在 D:\kb\manual-test**」
   - [ ] 触发 kb-acquire；脚本路径从技能安装目录解析（不假设 cwd)
   - [ ] 报告为自然语言四计数（created/updated/unchanged/unsupported),**不是**甩 JSON
   - [ ] `manual.docx` 被明确解释为 unsupported（并说明 docx 需先转 md)
   - [ ] 结束后**建议**运行治理，但没有自动触发治理
2. 说：「**治理知识库**」
   - [ ] 触发 kb-govern；先 sweep 再 plan;pending 11 篇逐篇摘要
   - [ ] 摘要过程能看到它**真的在读原文**（可抽查一篇对照）
   - [ ] 结束后报告 N 创建 / X 异常 / Y 错误 / Z 孤儿 / Q 待评审
3. 直接提问：「**支付网关超时后怎么重试？**」
   - [ ] 触发 kb-search；宽问题先看 wiki/index.md 或直接结构化查询
   - [ ] 答案带引用（wikilink 或 source_url)；命中页面是 approved 页

**通过标准**：三个技能各自被正确触发，报告行为符合各自 SKILL.md 的「报告/红线」节。

## 2. 摘要与合成质量(15 分钟，主观评分)

抽查 3 篇 source 页（建议：一篇英文、一篇中文原文的、notes.txt 对应页）+ 2 篇 topic 页，对照 raw/ 原文打分（1=差，5=优）:

| 维度 | 页1 | 页2 | 页3 | 说明 |
|---|---|---|---|---|
| 忠实原文（无杜撰） | | | | 每条要点都能在原文找到 |
| 英文写作规范 | | | | wiki 全英文；专有名词/错误码/配置项保留原形 |
| 检索锚点保留 | | | | PAY_TIMEOUT_MS、RETRY_BUDGET_EXHAUSTED 等可被检索 |
| tags 质量 | | | | 3–5 个英文领域标签，泛化得当 |
| Related Topics 钩子 | | | | 指向的主题真实存在或值得建 |

Topic 页额外核对：

- [ ] 每个论断可回溯到 `sources` 列出的 raw
- [ ] wikilink 形式 `[[slug|显示名]]`，点击/检索可解析
- [ ] 风险分级正确：矛盾内容走 `--candidate` 并附 `--note`，而非直接 approved

## 3. 评审双通道(15 分钟)

1. **对话式**：让一个 topic 成为 candidate（矛盾内容），在会话中审阅证据后 approve/reject
   - [ ] 决策后脚本立即写 `review | approve/reject ... via session` 日志
2. **Viewer**:`node governance/viewer/serve.mjs --kb D:\kb\manual-test`，浏览器打开 127.0.0.1:8321
   - [ ] queue 视图只列 candidate;browse 可切换 sources/topics
   - [ ] candidate 页显示 review_note；每个 sources 条目有可点击的 raw 证据窗格
   - [ ] git 提交过的 KB 上 diff 视图显示相对 HEAD 的改动（先在 KB 里 commit 一次再制造 candidate)
   - [ ] flip 一个 candidate → approve;**再 flip 一次 → 409**（乐观并发）
   - [ ] flip 后立刻跑 `govern plan`/apply-topic → 被拒绝并提示先 sweep;sweep 后 log.md 恰好补一条 `via viewer (backfilled)`
   - [ ] reject 一个 candidate → 关闭 viewer → sweep → 页面进 wiki/archive/ 且 status: archived
3. 红线抽查：
   - [ ] viewer 打开期间不跑治理变更（单操作员纪律，SKILL 有提示）

## 4. 检索问答体验(20 分钟)

依次提问，观察 kb-search 的行为（不只是答案对错）:

| # | 问题 | 观察点 |
|---|---|---|
| 1 | 支付网关的超时重试策略是什么？ | 宽问题；命中 source+topic；答案综合多页 |
| 2 | exponential backoff 的具体参数 | 短语命中；read #anchor 取完整小节 |
| 3 | 订单多久不支付会被关闭？ | 中文问题→英文查询为主，必要时 CSQE 用中文词兜底（「订单超时关闭」应命中） |
| 4 | 2026-07-15 之后更新过的和 retry 有关的文档 | after: 过滤按源系统时间 |
| 5 | 对账差错怎么处理 | 中英混排检索；可能同时命中 EN/CJK 摘要 |
| 6 | INC-2041 事故根因 | 票号锚点精确命中 |
| 7 | 429 和 Retry-After 的含义 | 数字词检索 |
| 8 | 重试和幂等是什么关系？ | 多跳：从 retry-resilience 走到 payment-safety(via:link 邻居） |
| 9 | 我们有 kubernetes 运维文档吗？ | 诚实回答「没有」，并建议先跑治理；**不杜撰** |
| 10 | 一个你认为库里有但其实没有的问题（自拟） | CSQE 迭代一次后仍无则如实报告 |

每题评分（1–5)：答案相关性、引用完整性、检索过程合理性（查询构造/迭代）。

- [ ] 答案只来自 approved 页（可验证：先制造一个 candidate 页含独特词，确认搜不到）
- [ ] 引用可点击/可溯源到 raw(source_ref)

## 5. 故障演练(10 分钟)

| 演练 | 操作 | 预期 |
|---|---|---|
| 断网/错地址 | kb.json 加一个不存在的 jira base_url 跑 acquire jira | fetch 报错而非挂死（30s 超时）;errors 列出 scope |
| 错误 PAT | `set JIRA_PAT=wrong`（仅当前 shell）跑 --check | 401 报错，**报错信息不含 PAT 值** |
| 坏 kb.json | 改成非法 JSON 跑 acquire | 响亮报错，不静默 |
| 手改 frontmatter | 把某 wiki 页 status 改成 `status:candidate`（无空格） | plan 不吞掉该页：进 review_queue 或 errors |
| 手改 raw | 改 raw 正文不改 version | plan anomalies 报出（高风险信号，需人工确认） |
| viewer 双开 | 两个浏览器标签同时 flip 同一页 | 一个成功，另一个 409 |
| .kb 删除 | 删掉整个 .kb/ 后搜索 | 索引自动全量重建，结果不变（契约：.kb 是派生物） |

## 6. 汇总

| 环节 | 通过/问题 | 备注 |
|---|---|---|
| 0 环境准备 | | |
| 1 技能对话流 | | |
| 2 摘要与合成质量（均分 ≥4 为通过） | | |
| 3 评审双通道 | | |
| 4 检索问答（均分 ≥4 为通过） | | |
| 5 故障演练 | | |

**发现问题请记录**：复现步骤、期望/实际、相关日志行；真实 Jira/Confluence 连接的验收另见 `real-env-test.md`。
