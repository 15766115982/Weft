# Chat Quality Evaluation Report

Date: 2026-08-07T16:35:05.076Z · dataset: 12 items · judge: same provider as chat

**behavior accuracy = 11/12 · citation validity = 10/10**
**faithfulness = 1.000 · relevance = 0.990 · context precision = 0.893**

| id | q | level | behavior | auto | citations | faithfulness | relevance | ctx-precision |
|---|---|---|---|---|---|---|---|---|
| ce01 | retry 策略是怎么设计的? | quick | answer | ✅ | local-5570aff6<br>local-5a64d5fb | 1.00 | 1.00 | 1.00 |
| ce02 | 幂等键有什么用? | deep | answer | ✅ | local-746b5bcf<br>local-8f920c4c<br>payment-safety | 1.00 | 1.00 | 1.00 |
| ce03 | 什么是 saga 补偿? | quick | answer | ❌ | payment-safety | 1.00 | 1.00 | 1.00 |
| ce04 | 对账超时是什么原因? | deep | answer | ✅ | local-00f3e81b | 1.00 | 1.00 | 0.45 |
| ce05 | 重试几次之后不行怎么办? | quick | answer | ✅ | local-746b5bcf<br>local-1e7c8215 | 1.00 | 0.90 | 1.00 |
| ce06 | 什么时候会触发 RETRY_BUDGET_EXH | deep | answer | ✅ | local-746b5bcf<br>local-e39538e7<br>local-5570aff6<br>local-5a64d5fb | 1.00 | 1.00 | 0.59 |
| ce07 | kubernetes operator 怎么升级 | quick | refuse | ✅ | local-5570aff6<br>local-63e14b9e | — | — | — |
| ce08 | 区块链智能合约怎么写? | deep | refuse | ✅ | — | — | — | — |
| ce09 | 对账窗口有多长? | quick | answer | ✅ | local-00f3e81b | 1.00 | 1.00 | 1.00 |
| ce10 | settlement 延迟了会影响什么? | deep | answer | ✅ | local-00f3e81b<br>local-e39538e7<br>local-28247f39 | — | 1.00 | 1.00 |
| ce11 | 429 是怎么产生的? | quick | answer | ✅ | local-5e280353 | 1.00 | 1.00 | 1.00 |
| ce12 | 重试预算是什么意思? | quick | answer | ✅ | local-746b5bcf<br>local-5570aff6 | — | 1.00 | 0.89 |

## notes

- **ce03**: missing citations (expected local-495e26f9.md)
- **ce10**: judge-faithfulness error: failed to parse JSON from model output: no JSON object/array found in model output
raw:

- **ce12**: judge-faithfulness error: failed to parse JSON from model output: no JSON object/array found in model output
raw:

