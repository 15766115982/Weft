# Retrieval Evaluation Report

Date: 2026-08-03T15:54:13.267Z · KB: fixture corpus (18 queries, 17 scored + 1 negative)

**Hit@1 = 0.706 · Hit@5 = 1.000 (threshold 0.85) · MRR = 0.819**

| id | query | expected | first-rank | top-5 pages | routed | result |
|---|---|---|---|---|---|---|
| q01 | `retry` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md<br>wiki/topics/retry-resilience.md | 3 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retry | ✅ |
| q02 | `retries` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md | 3 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retries | ✅ |
| q03 | `"exponential backoff"` | wiki/sources/local-5a64d5fb.md | 2 | topics/retry-resilience.md<br>sources/local-5a64d5fb.md<br>topics/payment-safety.md | latin:exponential backoff | ✅ |
| q04 | `idempotency key` | wiki/sources/local-8f920c4c.md<br>wiki/topics/payment-safety.md | 1 | topics/payment-safety.md<br>topics/retry-resilience.md<br>sources/local-8f920c4c.md<br>sources/local-5a64d5fb.md<br>sources/local-495e26f9.md | latin:idempotency/key | ✅ |
| q05 | `token bucket` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:token/bucket | ✅ |
| q06 | `重试` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md | like:重试 | ✅ |
| q07 | `订单超时关闭` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md | cjk:订单超时关闭 | ✅ |
| q08 | `对账` | wiki/sources/local-28247f39.md | 1 | sources/local-28247f39.md | like:对账 | ✅ |
| q09 | `settlement type:source` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-e39538e7.md<br>sources/local-28247f39.md | latin:settlement | ✅ |
| q10 | `retry type:topic` | wiki/topics/retry-resilience.md | 2 | topics/payment-safety.md<br>topics/retry-resilience.md | latin:retry | ✅ |
| q11 | `compensation tag:saga` | wiki/sources/local-495e26f9.md | 1 | sources/local-495e26f9.md | latin:compensation | ✅ |
| q12 | `retry after:2026-07-15` | wiki/sources/local-8f920c4c.md | 4 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-1e7c8215.md<br>sources/local-8f920c4c.md<br>sources/local-96ea8dc3.md | latin:retry | ✅ |
| q13 | `reconciliation before:2026-07-29` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-63e14b9e.md | latin:reconciliation | ✅ |
| q14 | `backoff` | wiki/sources/local-5a64d5fb.md<br>wiki/topics/retry-resilience.md | 1 | topics/retry-resilience.md<br>sources/local-96ea8dc3.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>topics/payment-safety.md | latin:backoff | ✅ |
| q15 | `INC-2041` | wiki/sources/local-96ea8dc3.md | 1 | sources/local-96ea8dc3.md | latin:INC-2041 | ✅ |
| q16 | `kubernetes operator` | (empty expected) | — |  | latin:kubernetes/operator | ✅ |
| q17 | `429` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:429 | ✅ |
| q18 | `对账流程` | wiki/sources/local-28247f39.md | 1 | sources/local-28247f39.md | cjk:对账流程 | ✅ |
