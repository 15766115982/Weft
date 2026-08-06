// Prompt file resolution and seeding.
// Defaults live in templates/prompts/; editable per-KB copies live in .kb/config/prompts/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

export function defaultPromptsDir() {
  return path.join(REPO_ROOT, 'templates', 'prompts');
}

export function kbPromptsDir(kbRoot) {
  return path.join(kbRoot, '.kb', 'config', 'prompts');
}

export function resolvePrompt(kbRoot, name) {
  const kbPath = path.join(kbPromptsDir(kbRoot), `${name}.md`);
  if (fs.existsSync(kbPath)) return fs.readFileSync(kbPath, 'utf8');
  const defaultPath = path.join(defaultPromptsDir(), `${name}.md`);
  if (fs.existsSync(defaultPath)) return fs.readFileSync(defaultPath, 'utf8');
  throw new Error(`prompt not found: ${name}`);
}

export function listPrompts() {
  const dir = defaultPromptsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
}

export function initPrompts(kbRoot, { force = false } = {}) {
  const src = defaultPromptsDir();
  const dst = kbPromptsDir(kbRoot);
  fs.mkdirSync(dst, { recursive: true });

  if (!fs.existsSync(src)) {
    throw new Error('default prompts directory missing: ' + src);
  }

  const results = [];
  for (const file of fs.readdirSync(src)) {
    if (!file.endsWith('.md')) continue;
    const srcPath = path.join(src, file);
    const dstPath = path.join(dst, file);
    if (fs.existsSync(dstPath) && !force) {
      results.push({ file, status: 'skipped' });
      continue;
    }
    fs.copyFileSync(srcPath, dstPath);
    results.push({ file, status: force && fs.existsSync(dstPath) ? 'overwritten' : 'created' });
  }
  return { src, dst, results };
}
