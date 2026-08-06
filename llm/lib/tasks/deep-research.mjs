// deep-research — multi-round retrieval + synthesis, streaming NDJSON.
import { createNdjsonWriter } from '../stream.mjs';
import { runPrompt } from '../runner.mjs';
import { runResearchLoop } from '../research.mjs';

export async function run({ kbRoot, input, outputPath }) {
  const writer = createNdjsonWriter(outputPath);
  const question = input?.question || '';
  const opts = input?.opts || {};

  let context = '';
  let citations = [];
  try {
    const result = await runResearchLoop({
      kbRoot,
      question,
      onEvent: (e) => writer.write(e),
      opts,
    });
    context = result.context;
    citations = result.citations;
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  try {
    await runPrompt(kbRoot, 'deep-research', { question, context }, {
      stream: true,
      onDelta: (delta) => writer.write({ type: 'chunk', text: delta }),
    });
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  writer.write({ type: 'done', citations });
  writer.end();
  await writer.finish();

  return { rounds: opts.maxRounds || 3, tokens_in: 0, tokens_out: 0 };
}
