# Saga Compensation for Failed Payments

PayCore models a cross-service payment as a saga. When a later step fails —
for example the ledger posting fails after the acquirer capture succeeded —
the orchestrator executes compensation transactions in reverse order: void the
capture, then release the risk hold.

Compensation is distinct from a refund. A refund is customer-initiated and
flows through the REFUND_API; compensation is system-initiated and idempotent
by construction, keyed by the saga identifier.

## Failure Matrix

| Failed step      | Compensation action        |
|------------------|----------------------------|
| ledger posting   | void capture               |
| risk hold        | none (terminal)            |
| notification     | retry queue, no compensation |
