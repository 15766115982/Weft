// summarize-source — produce a structured summary of a raw source document.
import { runJsonPrompt } from '../runner.mjs';

export async function run({ kbRoot, input }) {
  const title = input?.title || 'untitled';
  const source = input?.source || 'unknown';
  const body = input?.body || '';
  const { data } = await runJsonPrompt(kbRoot, 'summarize-source', { title, source, body });
  return {
    task: 'summarize-source',
    title: data.title || title,
    summary: data.summary || '',
    key_points: Array.isArray(data.key_points) ? data.key_points : [],
  };
}
