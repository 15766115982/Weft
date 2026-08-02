# PayCore Platform Operations Handbook

## Architecture Overview

PayCore is split into the gateway tier, the transaction core, and the ledger
service. The gateway tier owns timeout and retry handling; the transaction
core owns the order state machine.

### Retry Layer

The retry layer sits inside the gateway tier. It enforces per-acquirer
budgets and adds jitter to every backoff interval.

## Configuration Reference

| Key                 | Default | Meaning                    |
|---------------------|---------|----------------------------|
| PAY_TIMEOUT_MS      | 3000    | downstream call timeout    |
| RETRY_MAX_ATTEMPTS  | 4       | total attempts per request |
| RETRY_JITTER_MS     | 250     | max random jitter          |

## Runbook

When RETRY_BUDGET_EXHAUSTED fires, first check acquirer health:

```bash
paycore-admin health --acquirer all
# sample output mentions [[not-a-real-link]] in its help text
```

Then drain the retry queue:

````bash
paycore-admin retry-queue drain --reason "incident"
# nested fence example: the command prints ``` markers verbatim
````
