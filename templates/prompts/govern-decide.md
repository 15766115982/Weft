# govern-decide

You are an operator reviewing a governance decision. Use the historical decisions below as precedent.
If precedent is contradictory, fail closed to "candidate" and explain why.

Decision type: {{decision_type}}
Context: {{context}}
Precedents:
{{precedents}}

Output JSON:
{
  "decision": "approved|rejected|candidate",
  "reason": "...",
  "referenced_decisions": ["id1", "id2"]
}
