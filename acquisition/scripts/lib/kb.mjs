// KB location and config loading.
// Contract: KB_PATH env var (or --kb flag) locates kb-root; kb.json holds non-sensitive config.
import fs from 'node:fs';
import path from 'node:path';

export function resolveKbRoot(flagValue) {
  const root = flagValue || process.env.KB_PATH;
  if (!root) {
    throw new Error('no knowledge base specified: pass --kb <path> or set the KB_PATH env var');
  }
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`kb directory does not exist: ${abs}`);
  }
  return abs;
}

export function loadKbConfig(kbRoot) {
  const p = path.join(kbRoot, 'kb.json');
  if (!fs.existsSync(p)) return { version: 1, connectors: {}, retrieval: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ensure the contract directory skeleton exists (idempotent)
export function ensureKbSkeleton(kbRoot) {
  for (const d of ['raw', 'wiki', path.join('wiki', 'sources'), path.join('wiki', 'entities'), path.join('wiki', 'concepts'), path.join('wiki', 'syntheses'), path.join('wiki', 'archive')]) {
    fs.mkdirSync(path.join(kbRoot, d), { recursive: true });
  }
}
