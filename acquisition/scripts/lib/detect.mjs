// Shared upstream-detection output writer (Phase 3).
// Classification: new | changed | unchanged | removed_upstream | error.
// Output: <kb>/.kb/acquire/upstream-detect.json (contract §1).
// Schema v2 (2026-08-08): one file holds every connector's latest report —
// running detect for jira no longer overwrites confluence's report.
// Legacy flat files ({connector, ts, ...buckets}) are upgraded on read.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

const BUCKETS = ['new', 'changed', 'unchanged', 'removed_upstream', 'errors'];

function reportPath(kbRoot) {
  return path.join(kbRoot, '.kb', 'acquire', 'upstream-detect.json');
}

function toReport(connector, result) {
  const r = { ts: new Date().toISOString(), connector };
  for (const b of BUCKETS) r[b] = result[b] || [];
  return r;
}

/** Read all reports as { reports: <connector, report> }. Upgrades the legacy
 *  single-connector flat format transparently. */
export function readDetectReports(kbRoot) {
  const abs = reportPath(kbRoot);
  if (!fs.existsSync(abs)) return {};
  try {
    const stored = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (stored && stored.reports && typeof stored.reports === 'object') return stored.reports;
    if (stored && stored.connector) return { [stored.connector]: stored }; // legacy flat
    return {};
  } catch { return {}; }
}

export function writeDetectReport(kbRoot, connector, result) {
  const reports = readDetectReports(kbRoot);
  reports[connector] = toReport(connector, result);
  const abs = reportPath(kbRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ reports }, null, 2), 'utf8');
  return reports[connector];
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

// Frontmatter lives at the head of the doc; raw bodies can run to hundreds of
// KB, so reading the whole file just for the identity five-tuple is wasted IO.
const HEAD_BYTES = 16 * 1024;

function readHead(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
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
      const { fields } = parseFrontmatter(readHead(abs));
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
