# semantic-check

Check whether the proposed content contradicts any existing approved page.

Proposed: {{proposed}}
Existing approved pages:
{{existing}}

Output JSON:
{
  "conflict": true|false,
  "severity": "none|low|medium|high",
  "reasoning": "...",
  "contradicting_pages": ["..."]
}
