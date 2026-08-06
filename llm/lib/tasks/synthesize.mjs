// synthesize — draft a synthesis page from multiple sources.
import { runJsonPrompt } from '../runner.mjs';

export async function run({ kbRoot, input }) {
  const slug = input?.slug || 'stub-synthesis';
  const topic = input?.topic || '';
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  const { data } = await runJsonPrompt(kbRoot, 'synthesize', {
    slug,
    topic,
    sources: sources.join('\n\n---\n\n'),
  });
  return {
    task: 'synthesize',
    slug: data.slug || slug,
    title: data.title || slug,
    body: data.body || '',
    sources: Array.isArray(data.sources) ? data.sources : sources,
  };
}
