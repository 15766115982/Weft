// Intranet bug 1: topic `sources:` (raw paths) were glued into
// `wiki/sources/raw/...` links that 404. The portal now resolves each source to
// its source summary page (/api/page → sources_resolved) and the shared
// sourceLinksHtml helper links there, falling back to the raw viewer for
// ungoverned raws and the legacy slug form otherwise. These tests lock the
// conformant shape: raw-path sources + source pages named {source}-{source_id}.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';
import { sourceLinksHtml } from '../public/lib/sources.mjs';

let kb, server, base;

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-src-resolve-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  // conformant pair: source_id bbbb2222 → source page wiki/sources/local-bbbb2222.md
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'bbbb2222-pay.md'),
    buildFrontmatter({ source: 'local', source_id: 'bbbb2222', title: 'Pay Raw B' }) + '\nRaw body B.\n', 'utf8');
  writePage('wiki/sources/local-bbbb2222.md', {
    type: 'source', status: 'approved', title: 'Pay Source B', source_ref: 'raw/local/bbbb2222-pay.md',
    updated_at: '2026-08-01T00:00:00Z',
  }, 'Source summary B.');
  // topic whose sources are raw paths (the contract-enforced real shape)
  writePage('wiki/topics/topic-b.md', {
    type: 'topic', status: 'approved', title: 'Topic B',
    sources: ['raw/local/bbbb2222-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Synthesis of B.');
  // ungoverned raw: exists, but no source page yet
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'cccc3333-ungoverned.md'),
    buildFrontmatter({ source: 'local', source_id: 'cccc3333', title: 'Ungoverned' }) + '\nNot yet governed.\n', 'utf8');
  writePage('wiki/topics/topic-c.md', {
    type: 'topic', status: 'candidate', title: 'Topic C',
    sources: ['raw/local/cccc3333-ungoverned.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Draft over ungoverned raw.');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(kb, { recursive: true, force: true }); });

const get = (p) => fetch(base + p);

test('page sources resolve raw path → source summary page', async () => {
  const { sources_resolved } = await (await get('/api/page?path=wiki/topics/topic-b.md')).json();
  assert.deepEqual(sources_resolved,
    [{ raw: 'raw/local/bbbb2222-pay.md', page: 'wiki/sources/local-bbbb2222.md' }]);
});

test('page sources resolve to null when no source page exists yet (ungoverned raw)', async () => {
  const { sources_resolved } = await (await get('/api/page?path=wiki/topics/topic-c.md')).json();
  assert.deepEqual(sources_resolved, [{ raw: 'raw/local/cccc3333-ungoverned.md', page: null }]);
});

test('sourceLinksHtml: page link when resolved, raw viewer otherwise, never wiki/sources/raw/', () => {
  // resolved → link to the source summary page
  const linked = sourceLinksHtml(['raw/local/bbbb2222-pay.md'],
    [{ raw: 'raw/local/bbbb2222-pay.md', page: 'wiki/sources/local-bbbb2222.md' }]);
  assert.ok(linked.includes('#/page?path=wiki%2Fsources%2Flocal-bbbb2222.md'), `expected page link, got: ${linked}`);

  // ungoverned raw → raw viewer, and NEVER the old broken concat
  const fallback = sourceLinksHtml(['raw/local/cccc3333-ungoverned.md'],
    [{ raw: 'raw/local/cccc3333-ungoverned.md', page: null }]);
  assert.ok(fallback.includes('#/browse?raw=raw%2Flocal%2Fcccc3333-ungoverned.md'), `expected raw viewer, got: ${fallback}`);
  assert.ok(!fallback.includes('wiki/sources/raw/'), 'raw-path source must not produce a wiki/sources/raw/... link');

  // legacy slug form (non-conformant hand-written frontmatter) keeps working
  const legacy = sourceLinksHtml(['local-aaaa1111-pay.md'], null);
  assert.ok(legacy.includes('#/page?path=wiki%2Fsources%2Flocal-aaaa1111-pay.md'), `expected slug link, got: ${legacy}`);

  // label prefix (queue view uses '来源:')
  assert.ok(sourceLinksHtml(['raw/local/bbbb2222-pay.md'], [{ raw: 'raw/local/bbbb2222-pay.md', page: null }], '来源:')
    .includes('>来源:raw/local/bbbb2222-pay.md</a>'));
});
