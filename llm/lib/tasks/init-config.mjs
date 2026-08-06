// init-config — seed .kb/config/models.json from the repo templates.
// input.provider: 'azure' (default) | 'openai'; input.force overwrites an
// existing file. Never overwrites silently: an existing models.json is
// skipped unless force is set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureKbConfigDir, kbConfigPath } from '../config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const TEMPLATES = {
  azure: 'models.example.json',
  openai: 'models.example.openai.json',
};

export async function run({ kbRoot, input }) {
  const provider = input?.provider || 'azure';
  const templateName = TEMPLATES[provider];
  if (!templateName) {
    throw new Error(`unknown provider "${provider}" (expected azure|openai)`);
  }
  const src = path.join(REPO_ROOT, 'templates', templateName);
  if (!fs.existsSync(src)) throw new Error(`template missing: ${src}`);

  ensureKbConfigDir(kbRoot);
  const dst = kbConfigPath(kbRoot);
  if (fs.existsSync(dst) && input?.force !== true) {
    return { ok: true, status: 'skipped', path: dst, provider, hint: 'models.json already exists; pass force to overwrite' };
  }
  fs.copyFileSync(src, dst);
  return {
    ok: true,
    status: input?.force === true ? 'overwritten' : 'created',
    path: dst,
    provider,
    hint: 'edit endpoint/model/auth to your values; secrets stay in env vars (the auth.* fields are env var NAMES)',
  };
}
