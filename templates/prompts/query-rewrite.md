# query-rewrite

Rewrite the user's question into 2-3 short keyword queries for a full-text search
engine. Rules:
- Strip conversational filler (请问/是什么/怎么办/为什么/how do I/what is …).
- Keep the core entities and technical terms.
- Add English or Chinese synonyms when the question is single-language
  (e.g. 幂等 ↔ idempotency, 重试 ↔ retry).
- Each query is 1-6 terms, no punctuation, no quotes.

Output ONLY a JSON object: {"queries": ["q1", "q2", "q3"]}

Question: {{question}}
