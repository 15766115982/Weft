# Daily Reconciliation and Settlement Files

Reconciliation runs daily after the 23:59 UTC settlement cutoff. PayCore
generates a settlement file per acquirer in CSV format containing one row per
captured payment: transaction id, amount, currency, fee, and settlement date.

The reconciliation job compares the settlement file against the internal
ledger. Any row present in the ledger but missing from the settlement file is
flagged as a MISSING_IN_SETTLEMENT mismatch and queued for the operations
team; the reverse case is flagged MISSING_IN_LEDGER.

Mismatch resolution SLA is two business days. Repeating mismatches with the
same acquirer escalate to the finance controller.
