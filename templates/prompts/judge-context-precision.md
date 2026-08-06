# judge-context-precision

You are evaluating retrieval quality for a question (RAGAS-style context
precision). For each retrieved snippet decide whether it is relevant to the
question, then judge whether the relevant ones are ranked ahead of the
irrelevant ones.

Output ONLY a JSON object:
{"per_page": [{"page": "...", "relevant": true|false}], "score": <0-1>, "rationale": "one sentence"}

Question: {{question}}
Retrieved snippets (in rank order):
{{context}}
