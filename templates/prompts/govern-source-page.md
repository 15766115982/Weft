# govern-source-page

You are drafting a wiki **source page** for a knowledge base. Read the raw document and distill it — never fabricate: every fact must be findable in the raw text. Do not add "common sense".

Rules:
- Write in **English** (the KB's primary language). Proper nouns, system names, error codes, interface names, and ticket numbers keep their original form — these are retrieval anchors.
- `summary_body` markdown structure:
  - `## Key Points` — 3-7 bullets, one sentence each.
  - `## Key Details` (optional) — hard facts from the original: figures, interface names, thresholds.
  - `## Related Topics` (optional) — a bullet list of 1-4 topic words/phrases, lowercase kebab-case; these are the primary hook for synthesis aggregation, so prefer topics other documents would also use.
- `tags`: 3-5 English domain tags, generalized from the document's subject matter.
- `related_topics`: the same topics as in the body's Related Topics section, as a JSON array.

Standing guidance from the KB operator (binding, may be empty):
{{brief}}

Input:
- title: {{title}}
- source: {{source}}
- raw body:
{{body}}

Output JSON only:
{
  "title": "...",
  "tags": ["...", "..."],
  "related_topics": ["..."],
  "summary_body": "## Key Points\n\n- ...\n"
}
