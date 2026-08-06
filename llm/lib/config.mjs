// KB location and model configuration resolution for the LLM service.
// Secrets are referenced by env-var name in config; actual values are read from env vars only.
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

export function kbConfigPath(kbRoot) {
  return path.join(kbRoot, '.kb', 'config', 'models.json');
}

export function loadModelsConfig(kbRoot) {
  const p = kbConfigPath(kbRoot);
  if (!fs.existsSync(p)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Resolve a secret referenced by env-var name. Returns { name, value } or null if missing.
export function resolveSecret(configKey) {
  if (!configKey) return null;
  const value = process.env[configKey];
  if (!value) return null;
  return { name: configKey, value };
}

export function ensureKbConfigDir(kbRoot) {
  fs.mkdirSync(path.join(kbRoot, '.kb', 'config'), { recursive: true });
}
