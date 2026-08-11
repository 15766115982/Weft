# distill-chat

Distill the following knowledge-base chat conversation into a structured document
that will enter the knowledge base as source material (a "chat distillation
document"). Write in the SAME LANGUAGE as the conversation.

Transcript (entries numbered [T1]..[Tn]):

{{transcript}}

Rules:
- Organize the conversation's knowledge into a clear structure (key conclusions,
  Q&A pairs, decisions — whatever fits the content). Drop pure chit-chat.
- EVERY distilled point must carry at least one reference marker like [T3]
  pointing at the transcript entry it comes from. A point without backing does
  not belong in the document.
- Only reference numbers that exist in the transcript; never invent content.
- Do NOT restate the transcript and do NOT add an appendix — the transcript
  appendix is appended mechanically after your output.

Output JSON:
{
  "title": "a concise document title",
  "body": "the distilled markdown document, every point carrying [T-n] markers"
}
