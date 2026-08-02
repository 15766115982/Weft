## Key Points

- Incident INC-2041: an acquirer-A timeout spike caused a retry storm that exhausted the downstream connection pool for 47 minutes.
- Root cause: the retry budget was not isolated per acquirer, so one channel consumed the global budget.
- Fix: split retry budgets per acquirer and add jitter to backoff (action item AI-88).

## Related Topics

- retry-resilience
- incident-review
