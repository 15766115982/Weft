# Chat Quality Evaluation Report

Date: 2026-08-07T02:43:28.781Z · dataset: 9 items · judge: same provider as chat

**behavior accuracy = 8/9 · citation validity = 7/7**
**faithfulness = 0.971 · relevance = 0.986 · context precision = 0.847**

| id | q | level | behavior | auto | citations | faithfulness | relevance | ctx-precision |
|---|---|---|---|---|---|---|---|---|
| ce01 | retry 策略是怎么设计的? | quick | answer | ✅ | local-5570aff6<br>local-5a64d5fb | 1.00 | 1.00 | 1.00 |
| ce02 | 幂等键有什么用? | deep | answer | ✅ | local-746b5bcf<br>local-8f920c4c<br>payment-safety<br>retry-resilience | 1.00 | 1.00 | — |
| ce03 | 什么是 saga 补偿? | quick | answer | ✅ | payment-safety<br>local-495e26f9 | 0.80 | 1.00 | 1.00 |
| ce04 | 对账超时是什么原因? | deep | answer | ✅ | local-00f3e81b | 1.00 | 0.90 | 1.00 |
| ce05 | 重试几次之后不行怎么办? | quick | answer | ❌ | — | 1.00 | 1.00 | 0.33 |
| ce06 | 什么时候会触发 RETRY_BUDGET_EXH | deep | answer | ✅ | local-5a64d5fb | 1.00 | 1.00 | 0.75 |
| ce07 | kubernetes operator 怎么升级 | quick | refuse | ✅ | — | — | — | — |
| ce08 | 区块链智能合约怎么写? | deep | refuse | ✅ | — | — | — | — |
| ce09 | 对账窗口有多长? | quick | answer | ✅ | local-00f3e81b | 1.00 | 1.00 | 1.00 |

## notes

- **ce05**: missing citations (expected local-746b5bcf.md)
