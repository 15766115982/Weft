# ADR-0011: Chat 回答管线优化 — 忠实度守门 + 引用兜底

Status: accepted (2026-08-07)

## Context

T6 基线与 R2 复测暴露两个 chat 质量问题:
1. faithfulness 从 0.984 降到 0.934(个别回答夹带上下文不支持的陈述);
2. ce02 类问题:模型答了但不按 `[[wikilink]]` 指令引用(R2 重排后缓解,但无保障);
3. CRAG(HuskyInSalt/CRAG,检索评估器→触发纠偏动作)与 Self-RAG(按需检索+
   自我反思)提供了可借鉴的纠偏框架;完整实现需要训练评估器/反思模型,不适用。

## Decision

C1 轮(本实现):
1. **忠实度守门(CRAG-lite)**:deep / deep-research 回答完成后,用现有
   judge-faithfulness 评估;score < 0.8 时以更严格的指令**重生成一次**
   ("只使用上下文明确支持的陈述;不确定就说明没有")。quick 级不做(保延迟)。
2. **引用兜底**:回答非拒答且 citations 为空但检索确有命中时,在 done 帧附
   `uncited_reads`(检索到但未被引用的页),交给 UI 选择展示;不伪造引用。

不采纳:decompose-then-recompose(snippet 级裁剪,片段已短)、Self-RAG 反思
token(需训练)。

## Consequences

- deep/dr 在守门触发时多 1 次评估 + 至多 1 次重生成调用;quick 无新增成本。
- 守门阈值 0.8 写在 chat.mjs 常量,后续按 eval 趋势调整。
- 验收:chat-eval 的 faithfulness 应回升 ≥0.95,citation validity 保持 100%,
  behavior 不降。
