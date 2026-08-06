// extract-entity — extract entities and typed relations from source text.
import { runJsonPrompt } from '../runner.mjs';

export async function run({ kbRoot, input }) {
  const sourcePath = input?.source_path || '';
  const body = input?.body || '';
  const { data } = await runJsonPrompt(kbRoot, 'extract-entity', { source_path: sourcePath, body });
  return {
    task: 'extract-entity',
    source_path: sourcePath,
    entities: Array.isArray(data.entities) ? data.entities : [],
    relations: Array.isArray(data.relations) ? data.relations : [],
  };
}
