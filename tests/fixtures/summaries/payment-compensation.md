## Key Points

- PayCore models cross-service payments as sagas; failed later steps trigger reverse-order compensation.
- Compensation is system-initiated and idempotent, keyed by saga id; refunds are customer-initiated via REFUND_API.
- Failure matrix: ledger posting failure voids the capture; notification failure goes to a retry queue.

## Related Topics

- payment-safety
