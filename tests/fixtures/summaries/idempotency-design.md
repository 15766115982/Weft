## Key Points

- Every mutating PayCore endpoint accepts an Idempotency-Key header with a 24-hour dedup window.
- Repeated requests with the same key replay the original response, making retries safe against double charges.
- Keys are scoped per merchant; the dedup store is Redis with a Postgres write-through fallback.
- Gateway retries reuse the original attempt's Idempotency-Key.

## Related Topics

- payment-safety
- retry-resilience
