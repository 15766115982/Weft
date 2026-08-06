# Weft 测试用例目录(2026-08-07)

执行约定:每个用例有 ID、目的、数据、步骤、期望;实现后逐个执行,结果写入
`docs/test-reports/<suite>-latest.md`,可逐条 review。三层门禁:
L1 确定性 CI 门禁(stub/mock,秒级)· L2 协议门禁 · L3 真实 LLM 质量评估(报告非门禁)。

## A. 治理流程行为测试(L1,stub LLM)— `tests/e2e/govern-flow.test.mjs`

| ID | 目的 | 数据 | 期望 |
|---|---|---|---|
| GF-01 | 全链路 happy path | 3 篇 inbox 文档 | acquire→摘要(stub)→candidate→approve→rebuild-index→search 命中 |
| GF-02 | 完全重复自动去重 | 内容逐字相同的两篇 | 不产生 candidate,auto-dedup 落 decision |
| GF-03 | 相似版本强制候选 | 同 ID 新旧两版 | 新版强制 candidate + 进入冲突组 |
| GF-04 | 事实冲突标记 | 数字矛盾文档对(预算 500 vs 5000) | semantic-check(stub conflict)→ candidate + 冲突组 |
| GF-05 | dismiss 持久化 | GF-04 冲突组 | dismiss-conflict 后下轮 plan 不再报警 |
| GF-06 | 决策日志完整性 | 任意 candidate | approve/reject/archive 均落 decision record,带 reason + actor |
| GF-07 | sweep 补录 viewer 翻页 | 手改 frontmatter status: rejected | sweep 归档该页 + log.md 补录,不误记为 approve |
| GF-08 | 治理幂等 | 同一 KB 连跑两轮 | 页面数/decision 数不翻倍,plan 第二轮全空 |
| GF-09 | merge-topic 裁决 | 两篇 approved topic | sources union-merge,不丢溯源,loser 归档 |
| GF-10 | reject→sweep→archive | 一篇 candidate | rejected 页面进 archive/,raw 打 tombstone |
| GF-11 | apply-topic 触冲突组 | 含 GF-04 成员的 slug | 强制 candidate,不允许直接 approved |
| GF-12 | index 一致性 | 治理完成的 KB | rebuild-index 后 index.md 链接 == approved 页面集合 |

## B. Chat 机制测试(L2,stub LLM)— llm + portal 套件

| ID | 目的 | 期望 |
|---|---|---|
| CM-01 | 三级协议形状 | quick/deep/deep-research 的 NDJSON 帧序:meta→search→read*→chunk+→done |
| CM-02 | 引用有效性(硬门禁) | 每个 citation 在 KB 存在且 status: approved,100% |
| CM-03 | 口语化查询 fallback | "retry 策略是怎么设计的?" 命中指定 source 页(golden) |
| CM-04 | 零命中拒答路径 | negative query → done.citations 为空,无 error 帧,模型被告知 KB 无内容 |
| CM-05 | 错误帧冒泡 | failing stub → portal SSE error 帧 → 页面 bubble 显示错误(非"无回答") |
| CM-06 | quick 轻量语义 | quick 的 search limit=3,deep=5,deep-research=8(golden 断言) |

## C. 检索黄金数据集(L1 门禁 + L3 扩展)— `tests/eval/golden/`

- 现有 queries.json(18 条)迁移并扩到 **~45 条**,每条标注**分级相关度**(2=必中,1=相关,0=不相关):
  - 分类:exact / stemmed / phrase / CJK-trigram / CJK-LIKE / mixed-locale / conversational(口语化)/ filter(type·tag·date)/ negative
  - conversational 类 ≥10 条 — 这是为 query 改写准备的基线(改写前后对比 Hit@5)
- 报告增强:Hit@1 / Hit@5 / MRR 总分 + **按分类分项分**,落 `docs/test-reports/retrieval-eval-latest.md`
- 门禁:Hit@5 ≥ 0.85(总),conversational 类单独跟踪不门禁(待 query 改写落地后收紧)

## D. Chat 质量评估(L3,真实 LLM,报告非门禁)— `tests/eval/chat-eval/`

数据集 ~15 条:`{ question, behavior: answer|refuse, must_cite[], forbidden[], note }`

自动判分(硬):
- 引用有效性(同 CM-02,100%)
- 拒答正确率(refuse 类不得给确定答案;answer 类不得拒答)
- forbidden 字符串检查

LLM-as-a-judge(参考 RAGAS / DeepEval 的 prompt 改写,存 `templates/prompts/judge-*.md`):
| 指标 | 借鉴 | 判定方式 |
|---|---|---|
| faithfulness | RAGAS faithfulness | 答案拆成陈述句,逐条判"是否被上下文支持",输出支持率 |
| answer relevance | RAGAS answer relevancy | judge 据答案反推问题,与原问题比对相关性 0-1 |
| context precision | RAGAS context precision | 检索页是否相关且相关者靠前 0-1 |
| context recall | RAGAS context recall | golden 相关页集合的召回率(与 C 共享标注) |

judge 用 models.json 同一 provider;报告 `docs/test-reports/chat-eval-latest.md`(分数+逐条明细)。

## E. Playwright 真实 UI 流程(L1/L2,CI)— `ui/e2e/flows.spec.mjs`

| ID | 流程 |
|---|---|
| PW-01 | chat:输入→search/read 步骤出现→chunk 流入→citation 链接点开对应页面 |
| PW-02 | 治理控制台:plan 预览→发起(stub agent)→进度更新→health 刷新 |
| PW-03 | 评审:队列填 reason→approve→队列减一→browse 树中状态变 approved |
| PW-04 | settings:改 model→保存条出现→保存→刷新值持久→检查连通 job 完成 |
| PW-05 | upload:拖文件→inbox 出现→acquire→raw 树出现新文档 |

(现有 open-portal 15 例 + chat-input 5 例保留。)

## 数据构建

`tests/fixtures/inbox/` 扩展场景对:
- `dup-a.md` / `dup-b.md`(逐字重复)→ GF-02
- `ver-v1.md` / `ver-v2.md`(同 ID 两版,少量改动)→ GF-03
- `conflict-budget-a.md`(预算 500)/ `conflict-budget-b.md`(预算 5000)→ GF-04/05/11
- 口语化语料若干(问答式标题/中英混排)→ C 类 conversational 标注源

## 任务拆分(执行顺序)

1. T1 场景语料扩展(E 节数据)
2. T2 治理行为测试 GF-01..12 + 报告
3. T3 Chat 机制测试 CM-01..06
4. T4 检索黄金数据集扩充 + 分类别报告
5. T5 Playwright 流程 PW-01..05
6. T6 Chat LLM-as-judge 评估 + 报告(L3,需真实 LLM)
