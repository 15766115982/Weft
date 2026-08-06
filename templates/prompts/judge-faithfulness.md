# judge-faithfulness

You are evaluating whether an answer is faithful to the given context (RAGAS-style
faithfulness). List the factual claims the answer makes, then judge each one:
is it directly supported by the context? Claims not present in the context are
unsupported, even if they are true in general.

Output ONLY a JSON object:
{"claims": [{"claim": "...", "supported": true|false}], "score": <supported/total, 0-1>}

Context:
{{context}}

Answer:
{{answer}}
