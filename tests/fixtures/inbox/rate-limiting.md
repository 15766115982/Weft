# API Rate Limiting with Token Bucket

PayCore throttles merchant traffic with a token bucket algorithm. Each
merchant receives a bucket of 200 tokens refilled at 200 QPS. Requests that
arrive when the bucket is empty are rejected with HTTP 429 and a Retry-After
header indicating the wait in seconds.

Burst capacity equals the bucket size, so a merchant may briefly exceed the
sustained rate. Internal service-to-service calls bypass the limiter through a
dedicated mTLS identity.

## Monitoring

The metric ratelimit_rejected_total is exported per merchant; a sustained
rejection rate above 1% triggers capacity review.
