// semantic-check — check whether new content contradicts existing approved content.
import { runJsonPrompt } from '../runner.mjs';

export async function run({ kbRoot, input }) {
  const proposed = input?.proposed || '';
  const existing = Array.isArray(input?.existing_pages)
    ? input.existing_pages.map((p) => `## ${p.path}\n${p.body || ''}`).join('\n\n---\n\n')
    : '';
  const { data } = await runJsonPrompt(kbRoot, 'semantic-check', { proposed, existing });
  return {
    task: 'semantic-check',
    conflict: Boolean(data.conflict),
    severity: ['none', 'low', 'medium', 'high'].includes(data.severity) ? data.severity : 'none',
    reasoning: data.reasoning || '',
    contradicting_pages: Array.isArray(data.contradicting_pages) ? data.contradicting_pages : [],
    existing_pages: input?.existing_pages || [],
  };
}
