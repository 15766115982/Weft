# Incident INC-2077 复盘:settlement delay 导致对账超时

2026-07-28 晚,settlement 文件延迟 40 分钟到达,第二天的对账任务大面积超时。

## 经过

- 23:00 定时任务未等到 bank file,进入等待队列
- 23:40 文件到达,但 reconciliation window 已过,任务标记 TIMEOUT
- 次日 09:00 人工补跑,对账在 11:20 完成

## 结论

reconciliation window 从 60 分钟放宽到 120 分钟;增加 bank file 延迟告警
(超过 15 分钟未达即通知 on-call)。
