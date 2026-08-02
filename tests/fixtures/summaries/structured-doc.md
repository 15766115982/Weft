## Key Points

- PayCore has three tiers: gateway (timeout/retry), transaction core (order state machine), and ledger.
- The retry layer enforces per-acquirer budgets and adds jitter to backoff intervals.
- Config keys: PAY_TIMEOUT_MS=3000, RETRY_MAX_ATTEMPTS=4, RETRY_JITTER_MS=250.
- Runbook for RETRY_BUDGET_EXHAUSTED: check acquirer health, then drain the retry queue.

## Related Topics

- retry-resilience
- operations
