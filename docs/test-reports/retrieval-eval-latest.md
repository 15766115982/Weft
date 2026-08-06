# Retrieval Evaluation Report

Date: 2026-08-06T03:39:25.639Z · KB: fixture corpus (18 queries, 17 scored + 1 negative)

**Hit@1 = 0.706 · Hit@5 = 1.000 (threshold 0.85) · MRR = 0.819**

candidate dilution: expansion per query: avg 1.6 candidates · max 3

| id | query | expected | first-rank | top-5 pages | routed | total | result |
|---|---|---|---|---|---|---|---|
| q01 | `retry` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md<br>wiki/syntheses/retry-resilience.md | 3 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retry | 16 | ✅ |
| q02 | `retries` | wiki/sources/local-5a64d5fb.md<br>wiki/sources/local-8f920c4c.md | 3 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>sources/local-1e7c8215.md<br>sources/local-5a64d5fb.md | latin:retries | 16 | ✅ |
| q03 | `"exponential backoff"` | wiki/sources/local-5a64d5fb.md | 2 | syntheses/retry-resilience.md<br>sources/local-5a64d5fb.md<br>syntheses/payment-safety.md<br>sources/local-1e7c8215.md<br>sources/local-8f920c4c.md | latin:exponential backoff | 5 | ✅ |
| q04 | `idempotency key` | wiki/sources/local-8f920c4c.md<br>wiki/syntheses/payment-safety.md | 1 | syntheses/payment-safety.md<br>syntheses/retry-resilience.md<br>sources/local-8f920c4c.md<br>sources/local-5a64d5fb.md<br>sources/local-495e26f9.md | latin:idempotency/key | 6 | ✅ |
| q05 | `token bucket` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:token/bucket | 1 | ✅ |
| q06 | `重试` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | like:重试 | 2 | ✅ |
| q07 | `订单超时关闭` | wiki/sources/local-1e7c8215.md | 1 | sources/local-1e7c8215.md<br>syntheses/retry-resilience.md | cjk:订单超时关闭 | 2 | ✅ |
| q08 | `对账` | wiki/sources/local-28247f39.md | 1 | sources/local-28247f39.md<br>syntheses/recon-ops.md | like:对账 | 2 | ✅ |
| q09 | `settlement type:source` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-e39538e7.md<br>sources/local-28247f39.md | latin:settlement | 3 | ✅ |
| q10 | `retry type:synthesis` | wiki/syntheses/retry-resilience.md | 2 | syntheses/payment-safety.md<br>syntheses/retry-resilience.md | latin:retry | 2 | ✅ |
| q11 | `compensation tag:saga` | wiki/sources/local-495e26f9.md | 1 | sources/local-495e26f9.md | latin:compensation | 1 | ✅ |
| q12 | `retry after:2026-07-15` | wiki/sources/local-8f920c4c.md | 4 | sources/local-5570aff6.md<br>sources/local-5570aff6.md<br>sources/local-1e7c8215.md<br>sources/local-8f920c4c.md<br>sources/local-96ea8dc3.md | latin:retry | 14 | ✅ |
| q13 | `reconciliation before:2026-07-29` | wiki/sources/local-63e14b9e.md | 1 | sources/local-63e14b9e.md<br>sources/local-63e14b9e.md | latin:reconciliation | 2 | ✅ |
| q14 | `backoff` | wiki/sources/local-5a64d5fb.md<br>wiki/syntheses/retry-resilience.md | 1 | syntheses/retry-resilience.md<br>sources/local-96ea8dc3.md<br>sources/local-5570aff6.md<br>sources/local-5a64d5fb.md<br>syntheses/payment-safety.md | latin:backoff | 7 | ✅ |
| q15 | `INC-2041` | wiki/sources/local-96ea8dc3.md | 1 | sources/local-96ea8dc3.md | latin:INC-2041 | 1 | ✅ |
| q16 | `kubernetes operator` | (empty expected) | — |  | latin:kubernetes/operator | 0 | ✅ |
| q17 | `429` | wiki/sources/local-5e280353.md | 1 | sources/local-5e280353.md | latin:429 | 1 | ✅ |
| q18 | `对账流程` | wiki/sources/local-28247f39.md | 1 | sources/local-28247f39.md<br>syntheses/recon-ops.md | cjk:对账流程 | 2 | ✅ |
