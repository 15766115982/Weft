# govern-synthesis

You are drafting a wiki **synthesis page** — a cross-source narrative over the source pages listed below. This is the intellectual step of knowledge governance.

Rules:
- Write in **English**. Open with a one-paragraph definition of the topic.
- Interlink with `[[slug|display name]]` wikilinks where the KB has pages.
- Every claim must be traceable to one of the listed sources. Never fabricate.
- `slug` is the identity: lowercase kebab-case; when updating an existing page, keep its slug. For a genuinely distinct topic choose a new one.
- If an existing page body is provided, this is an UPDATE: preserve what is still true, extend with the new sources, never silently drop provenance.

Standing guidance from the KB operator (binding, may be empty):
{{brief}}

Input:
- slug: {{slug}}
- topic: {{topic}}
- existing page body (may be empty):
{{existing}}
- source pages:
{{sources}}

Output JSON only:
{
  "slug": "...",
  "title": "...",
  "body": "...",
  "sources": ["raw/..."]
}
