# Retrieval Evaluation Report

Date: 2026-08-09T15:34:39.042Z · golden set: 44 queries (41 scored + 3 negative)

**Hit@1 = 0.683 · Hit@5 = 0.976 (gate ≥0.85, non-conversational 1.000) · MRR = 0.823**
**conversational (fallback path, tracked, not gated): Hit@5 = 0.900 (10 queries)**

## per-category

| category | n | hit@1 | hit@5 |
|---|---|---|---|
| exact | 9 | 6 | 1.00 |
| stemmed | 2 | 1 | 1.00 |
| phrase | 3 | 1 | 1.00 |
| cjk-like | 4 | 2 | 1.00 |
| cjk-trigram | 4 | 4 | 1.00 |
| filter | 7 | 5 | 1.00 |
| mixed-locale | 2 | 2 | 1.00 |
| conversational | 10 | 7 | 0.90 |

candidate dilution: expansion per query: avg 1.5 candidates · max 3

| id | cat | query | expected | first-rank | top-5 | routed | result |
|---|---|---|---|---|---|---|---|
| q01 | exact | `retry` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md<br>wiki/syntheses/retry-resilience.md | 2 | sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-5570aff6.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retry | ✅ |
| q02 | stemmed | `retries` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md | 2 | sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-5570aff6.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retries | ✅ |
| q03 | phrase | `"exponential backoff"` | wiki/sources/local-5a64d5fb.md | 2 | syntheses/retry-resilience.md<br>sources/local-5a64d5fb.md<br>syntheses/payment-safety.md<br>sources/local-1e7c8215.md<br>sources/local-8f920c4c.md | latin:exponential backoff | ✅ |
| q04 | exact | `idempotency key` | wiki/sources/local-8f920c4c.md<br>wiki/syntheses/payment-safety.md | 1 | syntheses/payment-safety.md<br>syntheses/retry-resilience.md<br>sources/local-746b5bcf.md<br>sources/local-8f920c4c.md<br>sources/local-5a64d5fb.md | latin:idempotency/key | ✅ |
| q05 | exact | `token bucket` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:token/bucket | ✅ |
| q06 | cjk-like | `重试` | wiki/sources/local-1e7c8215.md | 2 | sources/local-746b5bcf.md<br>sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | like:重试 | ✅ |
| q07 | cjk-trigram | `订单超时关闭` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | cjk:订单超时关闭 | ✅ |
| q08 | cjk-like | `对账` | wiki/sources/local-28247f39.md | 2 | sources/local-00f3e81b.md<br>sources/local-28247f39.md<br>syntheses/recon-ops.md | like:对账 | ✅ |
| q09 | filter | `settlement type:source` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-00f3e81b.md<br>sources/local-e39538e7.md<br>sources/local-28247f39.md | latin:settlement | ✅ |
| q10 | filter | `retry type:synthesis` | wiki/syntheses/retry-resilience.md | 2 | syntheses/payment-safety.md<br>syntheses/retry-resilience.md | latin:retry | ✅ |
| q11 | filter | `compensation tag:saga` | wiki/sources/local-495e26f9.md | 1 | sources/local-495e26f9.md | latin:compensation | ✅ |
| q12 | filter | `retry after:2026-07-15` | wiki/sources/local-8f920c4c.md | 4 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-1e7c8215.md<br>sources/local-8f920c4c.md<br>sources/local-96ea8dc3.md | latin:retry | ✅ |
| q13 | filter | `reconciliation before:2026-07-29` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-63e14b9e.md | latin:reconciliation | ✅ |
| q14 | exact | `backoff` | wiki/sources/local-5a64d5fb.md<br>wiki/syntheses/retry-resilience.md | 1 | syntheses/retry-resilience.md<br>sources/local-96ea8dc3.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>syntheses/payment-safety.md | latin:backoff | ✅ |
| q15 | exact | `INC-2041` | wiki/sources/local-96ea8dc3.md | 1 | sources/local-96ea8dc3.md | latin:INC-2041 | ✅ |
| q16 | negative | `kubernetes operator` | (empty expected) | — |  | latin:kubernetes/operator | ✅ |
| q17 | exact | `429` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:429 | ✅ |
| q18 | cjk-trigram | `对账流程` | wiki/sources/local-28247f39.md | 1 | sources/local-28247f39.md<br>syntheses/recon-ops.md | cjk:对账流程 | ✅ |
| q19 | exact | `PAY_TIMEOUT_MS` | wiki/sources/local-5a64d5fb.md | 2 | sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>syntheses/retry-resilience.md | latin:PAY_TIMEOUT_MS | ✅ |
| q20 | phrase | `"Idempotency-Key header"` | wiki/sources/local-5a64d5fb.md | 2 | sources/local-8f920c4c.md<br>sources/local-5a64d5fb.md<br>syntheses/payment-safety.md<br>syntheses/retry-resilience.md | latin:Idempotency-Key header | ✅ |
| q21 | stemmed | `throttles bucket` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:throttles/bucket | ✅ |
| q22 | cjk-trigram | `超时关闭` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | cjk:超时关闭 | ✅ |
| q23 | cjk-trigram | `对账超时` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md | cjk:对账超时 | ✅ |
| q24 | cjk-like | `复盘` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md | like:复盘 | ✅ |
| q25 | mixed-locale | `INC-2077 对账` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md | latin:INC-2077 like:对账 | ✅ |
| q26 | mixed-locale | `settlement window` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md | latin:settlement/window | ✅ |
| q27 | exact | `jitter` | wiki/sources/local-96ea8dc3.md | 2 | sources/local-5570aff6.md<br>sources/local-96ea8dc3.md | latin:jitter | ✅ |
| q28 | exact | `saga compensation` | wiki/sources/local-495e26f9.md<br>wiki/syntheses/payment-safety.md | 1 | syntheses/payment-safety.md<br>sources/local-495e26f9.md<br>syntheses/retry-resilience.md<br>sources/local-8f920c4c.md | latin:saga/compensation | ✅ |
| q30 | conversational | `重试几次之后不行怎么办?` | wiki/sources/local-746b5bcf.md | 1 | sources/local-746b5bcf.md<br>sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | fallback(����|�Լ�|����|��֮|֮��|��|����) | ✅ |
| q31 | conversational | `钱会被扣两次吗?` | wiki/sources/local-746b5bcf.md<br>wiki/sources/local-8f920c4c.md | MISS |  | direct (knownMiss baseline) | ✅ |
| q32 | conversational | `对账超时是什么原因?` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md<br>sources/local-28247f39.md<br>sources/local-1e7c8215.md<br>syntheses/recon-ops.md<br>syntheses/retry-resilience.md | fallback(����|�˳�|��ʱ|ԭ��) | ✅ |
| q33 | conversational | `retry 策略是怎么设计的?` | wiki/sources/local-5a64d5fb.md | 2 | sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-96ea8dc3.md<br>sources/local-e39538e7.md<br>sources/local-1e7c8215.md | fallback(retry|����) | ✅ |
| q34 | conversational | `幂等键有什么用?` | wiki/sources/local-746b5bcf.md | 1 | sources/local-746b5bcf.md | fallback(�ݵ�|�ȼ�|����|��ʲ) | ✅ |
| q35 | conversational | `重试预算是什么意思?` | wiki/sources/local-746b5bcf.md | 1 | sources/local-746b5bcf.md | fallback(����Ԥ��) | ✅ |
| q36 | conversational | `settlement 延迟了会影响什么?` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md<br>sources/local-63e14b9e.md<br>syntheses/recon-ops.md<br>sources/local-e39538e7.md<br>sources/local-28247f39.md | fallback(settlement|�ӳ�|��Ӱ|Ӱ��|��ʲ) | ✅ |
| q37 | conversational | `什么时候会触发 RETRY_BUDGET_EXHAUSTED?` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-746b5bcf.md | 1 | sources/local-746b5bcf.md<br>sources/local-e39538e7.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>syntheses/retry-resilience.md | fallback(ʱ��|���|�ᴥ|����|RETRY_BUDGET_EXHAUSTED) | ✅ |
| q38 | conversational | `对账窗口有多长?` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md<br>sources/local-28247f39.md<br>syntheses/recon-ops.md | fallback(����|�˴�|����|����|�ж�|�೤) | ✅ |
| q39 | conversational | `什么是 saga 补偿?` | wiki/sources/local-495e26f9.md | 2 | syntheses/payment-safety.md<br>sources/local-495e26f9.md<br>syntheses/retry-resilience.md<br>sources/local-8f920c4c.md | fallback(saga|����) | ✅ |
| q40 | negative | `区块链 智能合约` | (empty expected) | — |  | cjk:区块链/智能合约 | ✅ |
| q41 | negative | `graphql federation` | (empty expected) | — |  | latin:graphql/federation | ✅ |
| q42 | filter | `INC type:source` | wiki/sources/local-96ea8dc3.md<br>wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md<br>sources/local-96ea8dc3.md | latin:INC | ✅ |
| q43 | filter | `settlement after:2026-07-29` | wiki/sources/local-00f3e81b.md | 1 | sources/local-00f3e81b.md<br>syntheses/recon-ops.md<br>sources/local-e39538e7.md<br>sources/local-28247f39.md | latin:settlement | ✅ |
| q44 | phrase | `"retry budget"` | wiki/sources/local-5a64d5fb.md | 1 | sources/local-5a64d5fb.md<br>sources/local-96ea8dc3.md<br>sources/local-746b5bcf.md<br>sources/local-e39538e7.md<br>sources/local-5570aff6.md | latin:retry budget | ✅ |
| q45 | cjk-like | `幂等` | wiki/sources/local-746b5bcf.md | 1 | sources/local-746b5bcf.md | like:幂等 | ✅ |
