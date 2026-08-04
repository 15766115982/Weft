// Review regression tests (5 defects found in the M2 review, pinned one by one)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { plan, applySourcePage, rebuildIndex } from '../lib/govern.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-'));
  fs.mkdirSync(path.join(kbRoot, 'raw', 'local'), { recursive: true });
  return kbRoot;
}
function writeRaw(kbRoot, name, over = {}) {
  const fm = buildFrontmatter({
    source: 'local', source_id: name, source_url: `file:///inbox/${name}.md`,
    source_version: '2026-07-01T00:00:00Z', pulled_at: '2026-07-01T00:00:00Z',
    content_hash: `sha256:${name}`, title: `标题${name}`, connector: 'local@1.0.0', ...over,
  });
  fs.writeFileSync(path.join(kbRoot, 'raw', 'local', `${name}.md`), fm + '\n正文\n', 'utf8');
  return `raw/local/${name}.md`;
}
const readPage = (kbRoot, rel) =>
  parseFrontmatter(fs.readFileSync(path.join(kbRoot, rel), 'utf8'));

test('#1 update without tags keeps old values; empty array emits no bare key', () => {
  const kb = makeKb();
  const r = writeRaw(kb, 'a1');
  applySourcePage(kb, r, '摘要 v1', { tags: ['payment', 'gateway'] });
  applySourcePage(kb, r, '摘要 v2'); // no tags passed
  const page = readPage(kb, 'wiki/sources/local-a1.md');
  assert.deepEqual(page.fields.tags, ['payment', 'gateway'], 'tags should be preserved');

  // explicit clear → the tags key disappears from frontmatter entirely (not a bare key)
  applySourcePage(kb, r, '摘要 v3', { tags: [] });
  const text = fs.readFileSync(path.join(kb, 'wiki', 'sources', 'local-a1.md'), 'utf8');
  assert.ok(!/^tags:/m.test(text), 'empty array must not emit a bare tags key');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#2 Windows backslash --raw normalization produces no false orphans', () => {
  const kb = makeKb();
  writeRaw(kb, 'b2');
  applySourcePage(kb, 'raw\\local\\b2.md', '摘要');
  const page = readPage(kb, 'wiki/sources/local-b2.md');
  assert.equal(page.fields.source_ref, 'raw/local/b2.md', 'source_ref must use forward slashes');
  assert.equal(plan(kb).orphaned_pages.length, 0, 'must have no false orphans');
  assert.throws(() => applySourcePage(kb, 'etc/passwd', 'x'), /must be a relative path under raw\//);
  assert.throws(() => applySourcePage(kb, 'raw/../escape.md', 'x'), /must be a relative path under raw\//);
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#3b legitimate double-dot filename (v1..2.md) is not falsely rejected', () => {
  const kb = makeKb();
  // filename contains consecutive dots, but the frontmatter source_id is still valid (as in the real scenario)
  const fm = buildFrontmatter({
    source: 'local', source_id: 'v12', source_url: 'u', source_version: 'v1',
    pulled_at: 'v1', content_hash: 'sha256:v', title: 'T', connector: 'c',
  });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'v1..2.md'), fm + '\n正文\n', 'utf8');
  const res = applySourcePage(kb, 'raw/local/v1..2.md', '摘要');
  assert.equal(res.action, 'auto:create-source');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#3 CRLF parses; missing contract fields go to errors, no phantom paths', () => {
  const kb = makeKb();
  writeRaw(kb, 'c3');
  // CRLF version (all fields present) → detected normally
  const good = buildFrontmatter({
    source: 'local', source_id: 'crlf1', source_url: 'u', source_version: 'v1',
    pulled_at: 'v1', content_hash: 'sha256:c', title: 'CRLF Doc', connector: 'c',
  }).replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'crlf1.md'), good + '\r\n正文\r\n', 'utf8');
  // doc without frontmatter → errors
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'broken.md'), '没有 frontmatter 的文档\n', 'utf8');

  const p = plan(kb);
  const raws = p.pending.map(x => x.raw);
  assert.ok(raws.includes('raw/local/crlf1.md'), 'CRLF doc should be detected normally');
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].raw, 'raw/local/broken.md');
  assert.ok(!p.pending.some(x => x.page.includes('undefined')), 'must not generate undefined phantom paths');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#4a source_id path injection rejected', () => {
  const kb = makeKb();
  writeRaw(kb, 'evil', { source_id: '../../../escape' });
  assert.throws(() => applySourcePage(kb, 'raw/local/evil.md', 'x'), /illegal characters/);
  assert.ok(!fs.existsSync(path.join(kb, 'wiki', 'escape.md')));
  const p = plan(kb);
  assert.equal(p.errors.length, 1, 'plan should also classify illegal IDs into errors');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#4b index.md title injection flattened', () => {
  const kb = makeKb();
  writeRaw(kb, 'd4', { title: 'Real title\n- [[topics/fake-page]] — injected entry' });
  applySourcePage(kb, 'raw/local/d4.md', '摘要');
  rebuildIndex(kb);
  const idx = fs.readFileSync(path.join(kb, 'wiki', 'index.md'), 'utf8');
  const entries = idx.split('\n').filter(l => l.startsWith('- [['));
  assert.equal(entries.length, 1, 'injection must not produce a second index entry');
  assert.ok(entries[0].startsWith('- [[sources/local-d4]]'), 'the single entry must be the legitimate page');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('#5 hash changed + version unchanged → anomaly detected', () => {
  const kb = makeKb();
  const r = writeRaw(kb, 'e5');
  applySourcePage(kb, r, '摘要');
  assert.equal(plan(kb).anomalies.length, 0);
  // version unchanged, content (hash) changed — source was modified out of band
  writeRaw(kb, 'e5', { content_hash: 'sha256:CHANGED' });
  const p = plan(kb);
  assert.equal(p.pending.length, 0, 'unchanged version is not stale');
  assert.equal(p.anomalies.length, 1);
  assert.equal(p.anomalies[0].reason, 'hash-changed-version-unchanged');
  // anomaly cleared after re-governance
  applySourcePage(kb, r, '新摘要');
  assert.equal(plan(kb).anomalies.length, 0);
  fs.rmSync(kb, { recursive: true, force: true });
});
