// detect.mjs lib tests: schema v2 multi-connector reports (+ legacy upgrade),
// head-only frontmatter read in loadLocalBySource.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeDetectReport, readDetectReports, loadLocalBySource, classify } from '../lib/detect.mjs';
import { buildFrontmatter } from '../lib/frontmatter.mjs';

function makeKb(t) {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-detect-lib-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  return kb;
}

const empty = { new: [], changed: [], unchanged: [], removed_upstream: [], errors: [] };

test('writeDetectReport: per-connector reports coexist in one file; readDetectReports round-trips', (t) => {
  const kb = makeKb(t);
  writeDetectReport(kb, 'jira', { ...empty, new: [{ id: 'PROJ-1' }] });
  writeDetectReport(kb, 'confluence', { ...empty, changed: [{ id: '100' }] });

  const reports = readDetectReports(kb);
  assert.deepEqual(Object.keys(reports).sort(), ['confluence', 'jira']);
  assert.equal(reports.jira.new[0].id, 'PROJ-1', 'first connector report survives the second write');
  assert.equal(reports.confluence.changed[0].id, '100');
  assert.ok(reports.jira.ts, 'report carries a timestamp');

  // re-detect replaces only its own connector
  writeDetectReport(kb, 'jira', { ...empty });
  const after = readDetectReports(kb);
  assert.equal(after.jira.new.length, 0);
  assert.equal(after.confluence.changed.length, 1);
});

test('readDetectReports: legacy flat single-connector file upgrades transparently', (t) => {
  const kb = makeKb(t);
  const dir = path.join(kb, '.kb', 'acquire');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'upstream-detect.json'), JSON.stringify({
    ts: '2026-08-01T00:00:00.000Z', connector: 'local',
    new: [{ id: 'x' }], changed: [], unchanged: [], removed_upstream: [], errors: [],
  }), 'utf8');
  const reports = readDetectReports(kb);
  assert.equal(reports.local.new[0].id, 'x');

  // next write migrates the file to schema v2, keeping the legacy entry
  writeDetectReport(kb, 'jira', { ...empty });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'upstream-detect.json'), 'utf8'));
  assert.ok(stored.reports.local && stored.reports.jira, 'legacy entry carried into schema v2');
});

test('loadLocalBySource: frontmatter parses from a head read even with a huge body', (t) => {
  const kb = makeKb(t);
  const rawDir = path.join(kb, 'raw', 'jira');
  fs.mkdirSync(rawDir, { recursive: true });
  const fm = buildFrontmatter({
    source: 'jira', source_id: 'PROJ-9', source_url: 'https://x/PROJ-9',
    source_version: '2026-07-28T02:30:00.000Z', pulled_at: '2026-08-01T00:00:00.000Z',
    content_hash: 'sha256:abc', title: 'Big Doc', connector: 'jira@1.0.0',
  });
  fs.writeFileSync(path.join(rawDir, 'PROJ-9.md'), fm + '\n' + 'body line\n'.repeat(50_000), 'utf8');

  const map = loadLocalBySource(kb, 'jira');
  assert.equal(map.size, 1);
  assert.equal(map.get('PROJ-9').version, '2026-07-28T02:30:00.000Z');
  assert.equal(map.get('PROJ-9').title, 'Big Doc');

  assert.equal(classify('PROJ-9', '2026-07-28T02:30:00.000Z', map), 'unchanged');
  assert.equal(classify('PROJ-9', '2026-07-30T00:00:00.000Z', map), 'changed');
  assert.equal(classify('PROJ-99', 'x', map), 'new');
});
