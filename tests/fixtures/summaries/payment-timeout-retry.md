## Key Points

- PayCore gateway calls time out after PAY_TIMEOUT_MS=3000 ms and retry with exponential backoff (500/1000/2000 ms).
- At most three retries per request, a hard retry budget of four total attempts.
- Retries require idempotent operations or an Idempotency-Key header; otherwise the outcome is PAYMENT_TIMEOUT_UNKNOWN.
- Alert RETRY_BUDGET_EXHAUSTED pages on-call when over 2% of requests exhaust the retry budget in 5 minutes.

## Related Topics

- retry-resilience
- payment-safety
