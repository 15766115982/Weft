# extract-entity

Extract named entities and their typed relations from the source text.

Input:
- source_path: {{source_path}}
- body: {{body}}

Output JSON:
{
  "entities": [
    { "slug": "...", "title": "...", "kind": "system|team|product|project|person|component" }
  ],
  "relations": [
    { "from": "...", "to": "...", "type": "owns|depends-on|contains|part-of|developed-by" }
  ]
}
