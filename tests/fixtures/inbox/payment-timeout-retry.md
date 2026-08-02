# Payment Gateway Timeout and Retry Policy

The PayCore payment gateway applies a bounded retry policy to all downstream
acquirer calls. Every outbound charge request carries a timeout of
PAY_TIMEOUT_MS=3000 milliseconds. When a call times out, the client retries
with exponential backoff: the first retry waits 500 ms, the second 1000 ms,
and the third 2000 ms. At most three retries are attempted per request, giving
a hard retry budget of four total attempts.

Retries are only permitted for idempotent operations or requests that carry an
Idempotency-Key header; otherwise a timeout is surfaced as
PAYMENT_TIMEOUT_UNKNOWN and the order moves to manual review.

## Retry Budget Alerts

If more than 2% of requests exhaust their full retry budget within a 5-minute
window, the on-call engineer is paged with alert RETRY_BUDGET_EXHAUSTED.
