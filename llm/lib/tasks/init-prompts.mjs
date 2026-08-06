// init-prompts — seed .kb/config/prompts/ from templates/prompts/.
import { initPrompts } from '../prompts.mjs';

export async function run({ kbRoot, input }) {
  const result = initPrompts(kbRoot, { force: input?.force === true });
  return {
    ok: true,
    src: result.src,
    dst: result.dst,
    prompts: result.results,
  };
}
