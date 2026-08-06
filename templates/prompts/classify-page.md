# classify-page

Classify the following wiki page into one of: source, entity, concept, synthesis.

Input:
- path: {{page_path}}
- title: {{title}}
- body: {{body}}

Output JSON:
{
  "classification": "source|entity|concept|synthesis",
  "confidence": 0.0-1.0,
  "reasoning": "..."
}
