## Key Points

- Merchant traffic is throttled by a token bucket: 200 tokens refilled at 200 QPS per merchant.
- Excess requests get HTTP 429 with a Retry-After header; bursts up to bucket size are allowed.
- Internal mTLS service calls bypass the limiter.
- Metric ratelimit_rejected_total above 1% sustained triggers capacity review.

## Related Topics

- traffic-management
