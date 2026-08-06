# Incident INC-2077 复盘:settlement delay 导致对账超时

2026-07-28 晚 settlement 文件延迟 40 分钟到达,reconciliation window 已过导致
对账任务超时,次日人工补跑完成。改进:reconciliation window 从 60 分钟放宽到
120 分钟,并新增 bank file 延迟告警(超过 15 分钟通知 on-call)。
