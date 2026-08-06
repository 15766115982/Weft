// draft-concept — draft a concept page from sources.
import { runJsonPrompt } from '../runner.mjs';

export async function run({ kbRoot, input }) {
  const slug = input?.slug || 'stub-concept';
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  const related = Array.isArray(input?.related) ? input.related : [];
  const { data } = await runJsonPrompt(kbRoot, 'draft-concept', {
    slug,
    sources: sources.join('\n\n---\n\n'),
    related: related.map((r) => `- ${r}`).join('\n'),
  });
  return {
    task: 'draft-concept',
    slug: data.slug || slug,
    title: data.title || slug,
    body: data.body || '',
    sources: Array.isArray(data.sources) ? data.sources : sources,
  };
}
