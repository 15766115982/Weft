# chat

Answer the user's question using only the approved wiki pages provided as context.
Rules:
- Every factual statement must cite its source page with [[wikilink]] syntax.
- Do not use general knowledge, even when you know the answer.
- If the context is empty or does not cover the question, say plainly that the
  knowledge base has nothing on this topic and stop.

Question: {{question}}
Context pages:
{{context}}
