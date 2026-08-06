// chat — page-level Q&A, streaming NDJSON. Every level retrieves (the product
// promise is "answers are KB-grounded"); they differ in depth:
//   quick         top-3 snippet grounding, single LLM call, fastest
//   deep          top-5 snippet grounding, single LLM call
//   deep-research multi-round search→read loop with full reasoning trace
import { createNdjsonWriter } from '../stream.mjs';
import { runPrompt } from '../runner.mjs';
import { searchWithFallback } from '../research.mjs';

const LEVEL_LIMIT = { quick: 3, deep: 5, 'deep-research': 8 };

export async function run({ kbRoot, input, outputPath }) {
  const writer = createNdjsonWriter(outputPath);
  const level = input?.level || 'quick';
  const question = input?.question || '';
  let context = '';
  const hits = []; // { page, title } — citation candidates, resolved against the answer

  writer.write({ type: 'meta', level, kb: kbRoot });

  try {
    const limit = LEVEL_LIMIT[level] || LEVEL_LIMIT.quick;
    writer.write({ type: 'search', query: question, round: 1 });
    const result = await searchWithFallback(kbRoot, question, { limit });
    const previews = Array.isArray(result?.preview) ? result.preview : [];
    const parts = [];
    for (const hit of previews.slice(0, limit)) {
      writer.write({ type: 'read', page: hit.page, round: 1 });
      parts.push(`## ${hit.title || hit.page}\n${hit.snippet || ''}`);
      hits.push({ page: hit.page, title: hit.title || '' });
    }
    context = parts.join('\n\n---\n\n');
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  let answer = '';
  try {
    const res = await runPrompt(kbRoot, 'chat', { question, context }, {
      stream: true,
      onDelta: (delta) => writer.write({ type: 'chunk', text: delta }),
    });
    answer = res.content || '';
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  // Citations = pages the ANSWER actually references (wikilink, title, or slug),
  // not every page retrieval happened to read. A grounded refusal therefore
  // yields [] even when the fallback surfaced weak pages.
  const citations = hits.filter((h) => {
    const slug = h.page.split('/').pop().replace(/\.md$/, '');
    return answer.includes(`[[${h.title}]]`) || answer.includes(`[[${slug}]]`)
      || (h.title && answer.includes(h.title)) || answer.includes(slug);
  }).map((h) => h.page);

  writer.write({ type: 'done', citations });
  writer.end();
  await writer.finish();

  return { level, tokens_in: 0, tokens_out: 0 };
}
