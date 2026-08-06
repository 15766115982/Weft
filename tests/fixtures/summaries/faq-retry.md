# 常见问题:支付重试

支付写接口以幂等键(Idempotency-Key)保证重试安全,重复请求不会重复扣款。重试上限为
三次,三次失败后订单进入人工审核(PAYMENT_TIMEOUT_UNKNOWN),不会继续自动
扣款。RETRY_BUDGET_EXHAUSTED 告警在 5 分钟内超过 2% 请求耗尽重试预算时触发,
通常指示下游银行通道抖动。
