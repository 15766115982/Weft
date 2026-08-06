// chat — page-level Q&A, streaming NDJSON.
import { createNdjsonWriter } from '../stream.mjs';
import { runPrompt } from '../runner.mjs';
import { searchPages } from '../research.mjs';

export async function run({ kbRoot, input, outputPath }) {
  const writer = createNdjsonWriter(outputPath);
  const level = input?.level || 'quick';
  const question = input?.question || '';
  let context = '';
  let citations = [];

  writer.write({ type: 'meta', level, kb: kbRoot });

  if (level === 'deep' || level === 'deep-research') {
    try {
      const limit = level === 'deep-research' ? 8 : 5;
      writer.write({ type: 'search', query: question, round: 1 });
      const result = await searchPages(kbRoot, question, { limit });
      const hits = Array.isArray(result?.preview) ? result.preview : [];
      const parts = [];
      for (const hit of hits.slice(0, limit)) {
        writer.write({ type: 'read', page: hit.page, round: 1 });
        parts.push(`## ${hit.title || hit.page}\n${hit.snippet || ''}`);
        citations.push(hit.page);
      }
      context = parts.join('\n\n---\n\n');
    } catch (err) {
      writer.write({ type: 'error', message: err.message });
    }
  }

  try {
    await runPrompt(kbRoot, 'chat', { question, context }, {
      stream: true,
      onDelta: (delta) => writer.write({ type: 'chunk', text: delta }),
    });
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  writer.write({ type: 'done', citations });
  writer.end();
  await writer.finish();

  return { level, tokens_in: 0, tokens_out: 0 };
}
