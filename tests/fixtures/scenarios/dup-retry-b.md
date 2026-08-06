# Retry Budget Operations Guide

PayCore's retry budget caps total attempts per charge request at four (initial
plus three retries). Budget consumption is tracked per merchant and reported
to the ops dashboard every minute.

When a merchant burns more than 80% of its hourly retry budget, the gateway
throttles new requests with 429 and notifies the on-call channel.
