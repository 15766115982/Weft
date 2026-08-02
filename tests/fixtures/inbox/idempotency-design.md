# Idempotency Key Design for Payment APIs

Every mutating PayCore API endpoint accepts an Idempotency-Key header. The key
is a client-generated UUID stored for a 24-hour dedup window. A repeated
request with the same key returns the original response without re-executing
the operation, which makes client-side retries safe against double charges.

Keys are scoped per merchant. Two different merchants may reuse the same UUID
without collision. The dedup store is Redis-backed with a write-through
fallback to Postgres when Redis is unavailable.

## Interaction with Retries

A gateway retry always reuses the Idempotency-Key of the original attempt, so
a retried charge can never create a second payment record.
