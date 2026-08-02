# Incident INC-2041 Retry Storm 复盘

2026-07-18 凌晨,acquirer-A 网关超时率飙升,PayCore 客户端按策略重试,
retry storm 导致下游连接池耗尽,故障持续 47 分钟。

根因:retry budget 没有按 acquirer 维度隔离,单一渠道的抖动耗尽了全局
重试预算。改进措施:按渠道拆分 retry budget,并在重试前增加 jitter。

后续行动项见 action item AI-88(为每个 acquirer 配置独立的超时与重试参数)。
