// Shared upstream-detection output writer (Phase 3).
// Classification: new | changed | unchanged | removed_upstream | error.
// Output: <kb>/.kb/acquire/upstream-detect.json (contract §1).
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

export function writeDetectReport(kbRoot, connector, result) {
  const out = {
    ts: new Date().toISOString(),
    connector,
    new: result.new || [],
    changed: result.changed || [],
    unchanged: result.unchanged || [],
    removed_upstream: result.removed_upstream || [],
    errors: result.errors || [],
  };
  const dir = path.join(kbRoot, '.kb', 'acquire');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, 'upstream-detect.json');
  fs.writeFileSync(abs, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

export function readDetectReport(kbRoot) {
  const abs = path.join(kbRoot, '.kb', 'acquire', 'upstream-detect.json');
  if (!fs.existsSync(abs)) return null;
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch { return null; }
}

/** Classify an upstream item against the local raw/ mirror.
 *  upstream: { id, version, title }
 *  local:    Map<id, { path, version, title }>
 */
export function classify(id, upstreamVersion, localMap) {
  const local = localMap.get(id);
  if (!local) return 'new';
  if (upstreamVersion !== local.version) return 'changed';
  return 'unchanged';
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

/** Build a map of local raw docs for a source system.
 *  @param {string} kbRoot
 *  @param {string} source — 'local' | 'jira' | 'confluence'
 *  @returns {Map<string, { path: string, version: string, title: string }>}
 */
export function loadLocalBySource(kbRoot, source) {
  const map = new Map();
  const rawDir = path.join(kbRoot, 'raw', source);
  if (!fs.existsSync(rawDir)) return map;
  for (const abs of walk(rawDir)) {
    try {
      const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      const id = String(fields.source_id || '');
      if (!id) continue;
      map.set(id, {
        path: path.relative(kbRoot, abs).replace(/\\/g, '/'),
        version: String(fields.source_version || ''),
        title: String(fields.title || ''),
      });
    } catch { /* skip malformed raw docs */ }
  }
  return map;
}
