# Judge Calibration Report (K4)

Date: 2026-08-03T03:15:35.875Z · backend: claude · 17 golden queries (fixture corpus)

**judge↔golden top-1 agreement = 94.1% (16/17) · mean judge score of golden pages = 2.65/3**

Reading: agreement asks whether the judge's highest-scored page is a golden
page (only queries where retrieval already placed a golden page in top-5);
mean score asks whether the judge recognizes golden pages as relevant (≥2 good).

| id | query | golden in top-5 | judge top pick | agree | golden mean score | note |
|---|---|---|---|---|---|---|
| q01 | `retry` | 1 | local-5a64d5fb.md | ✅ | 2.0 |  |
| q02 | `retries` | 1 | local-5a64d5fb.md | ✅ | 2.5 |  |
| q03 | `"exponential backoff"` | 1 | local-5a64d5fb.md | ✅ | 3.0 |  |
| q04 | `idempotency key` | 2 | local-8f920c4c.md | ✅ | 2.5 |  |
| q05 | `token bucket` | 1 | local-5e280353.md | ✅ | 3.0 |  |
| q06 | `重试` | 1 | local-1e7c8215.md | ✅ | 1.0 |  |
| q07 | `订单超时关闭` | 1 | local-1e7c8215.md | ✅ | 3.0 |  |
| q08 | `对账` | 1 | local-28247f39.md | ✅ | 3.0 |  |
| q09 | `settlement type:source` | 1 | local-63e14b9e.md | ✅ | 3.0 |  |
| q10 | `retry type:topic` | 1 | retry-resilience.md | ✅ | 3.0 |  |
| q11 | `compensation tag:saga` | 1 | local-495e26f9.md | ✅ | 3.0 |  |
| q12 | `retry after:2026-07-15` | 1 | local-5570aff6.md | ❌ | 2.0 |  |
| q13 | `reconciliation before:2026-07-29` | 1 | local-63e14b9e.md | ✅ | 2.0 |  |
| q14 | `backoff` | 2 | retry-resilience.md | ✅ | 3.0 |  |
| q15 | `INC-2041` | 1 | local-96ea8dc3.md | ✅ | 3.0 |  |
| q17 | `429` | 1 | local-5e280353.md | ✅ | 3.0 |  |
| q18 | `对账流程` | 1 | local-28247f39.md | ✅ | 3.0 |  |
