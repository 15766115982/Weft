# rerank

Rerank the candidate snippets for the question (listwise). Most relevant first.
Judge only relevance to the question, not snippet quality or length.
Return every candidate index exactly once.

Output ONLY a JSON object: {"ranking": [<index>, <index>, ...]}

Question: {{question}}

Candidates:
{{candidates}}
