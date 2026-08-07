# Chat Quality Evaluation Report

Date: 2026-08-07T02:04:35.184Z · dataset: 11 items · judge: same provider as chat

**behavior accuracy = 11/11 · citation validity = 9/9**
**faithfulness = 0.934 · relevance = 0.989 · context precision = 0.950**

| id | q | level | behavior | auto | citations | faithfulness | relevance | ctx-precision |
|---|---|---|---|---|---|---|---|---|
| ce01 | retry 策略是怎么设计的? | quick | answer | ✅ | local-5570aff6<br>local-5a64d5fb<br>retry-resilience | 0.60 | 0.95 | 1.00 |
| ce02 | 幂等键有什么用? | deep | answer | ✅ | local-746b5bcf<br>local-8f920c4c<br>payment-safety | 1.00 | 1.00 | 0.80 |
| ce03 | 什么是 saga 补偿? | quick | answer | ✅ | payment-safety<br>local-495e26f9<br>retry-resilience | 0.88 | 0.95 | 1.00 |
| ce04 | 对账超时是什么原因? | deep | answer | ✅ | local-00f3e81b | 1.00 | 1.00 | 1.00 |
| ce05 | 重试几次之后不行怎么办? | quick | answer | ✅ | local-746b5bcf<br>local-1e7c8215 | 1.00 | 1.00 | 1.00 |
| ce06 | 什么时候会触发 RETRY_BUDGET_EXH | deep | answer | ✅ | local-746b5bcf<br>local-5a64d5fb | 1.00 | 1.00 | 0.75 |
| ce07 | kubernetes operator 怎么升级 | quick | refuse | ✅ | local-c86d8cb2<br>local-5570aff6<br>local-63e14b9e | — | — | — |
| ce08 | 区块链智能合约怎么写? | deep | refuse | ✅ | — | — | — | — |
| ce09 | 对账窗口有多长? | quick | answer | ✅ | local-00f3e81b | 1.00 | 1.00 | 1.00 |
| ce10 | settlement 延迟了会影响什么? | deep | answer | ✅ | local-00f3e81b<br>local-63e14b9e<br>local-e39538e7<br>local-28247f39 | — | 1.00 | 1.00 |
| ce11 | 429 是怎么产生的? | quick | answer | ✅ | local-5e280353 | 1.00 | 1.00 | 1.00 |

## notes

- **ce10**: judge-faithfulness error: failed to parse JSON from model output: no JSON object/array found in model output
raw:

