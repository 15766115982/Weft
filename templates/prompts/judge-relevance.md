# judge-relevance

You are evaluating whether an answer actually addresses the question
(RAGAS-style answer relevance). Consider: does it answer what was asked, is it
on-topic, is it complete enough to be useful? Do NOT judge factual accuracy
(that is faithfulness' job).

Output ONLY a JSON object: {"score": <0-1>, "rationale": "one sentence"}

Question: {{question}}
Answer:
{{answer}}
