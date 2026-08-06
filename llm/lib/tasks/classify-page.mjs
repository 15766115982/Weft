// classify-page — classify a page into entity/concept/synthesis or none.
import { runJsonPrompt } from '../runner.mjs';

const VALID = new Set(['source', 'entity', 'concept', 'synthesis']);

export async function run({ kbRoot, input }) {
  const pagePath = input?.page_path || '';
  const title = input?.title || '';
  const body = input?.body || '';
  const { data } = await runJsonPrompt(kbRoot, 'classify-page', { page_path: pagePath, title, body });
  const raw = String(data.classification || '').toLowerCase();
  const classification = VALID.has(raw) ? raw : 'source';
  return {
    task: 'classify-page',
    page_path: pagePath,
    classification,
    confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : 0,
    reasoning: data.reasoning || '',
  };
}
