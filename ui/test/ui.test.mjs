// M7a UI portal tests (ADR-0006): API gates (path traversal, win32 normalization),
// localhost write security (token + Origin, review P0-2), statusflip over HTTP
// (incl. 409), real FTS search with routed legs, plan-derived health, backlinks
// fence-awareness, static token injection, frontend innerHTML single-exit grep.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';
import http from 'node:http';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let kb, server, base, token;

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-'));
  writePage('wiki/topics/cand-one.md', {
    type: 'topic', status: 'candidate', title: 'Candidate One', review_note: 'check this',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Candidate body linking [[ok-page]].');
  writePage('wiki/topics/ok-page.md', {
    type: 'topic', status: 'approved', title: 'Approved Page',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Retry compensation idempotency umbrella.\n\n```\n[[not-a-link]]\n```');
  writePage('wiki/sources/local-aaaa1111-pay.md', {
    type: 'source', status: 'approved', title: 'Pay Source', source_ref: 'raw/local/aaaa1111-pay.md',
    updated_at: '2026-08-01T00:00:00Z',
  }, 'Payment source summary about retry compensation.');
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n\n- [[ok-page]]\n', 'utf8');
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'aaaa1111-pay.md'),
    buildFrontmatter({ source: 'local', source_id: 'aaaa1111', title: 'Pay Raw' }) + '\nRaw evidence body.\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // the token reaches clients only via the injected index.html meta (S8)
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});
after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);
const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});

// ---- reads ----

test('kbs registry lists the cli-provided KB as default', async () => {
  const { kbs } = await (await get('/api/kbs')).json();
  assert.equal(kbs[0].name, 'default');
  assert.equal(kbs[0].exists, true);
});

test('tree lists index.md (A4 navigable) + sources+topics; queue filters candidates', async () => {
  const { pages } = await (await get('/api/tree')).json();
  assert.equal(pages.length, 4);
  assert.deepEqual(pages.find((p) => p.isIndex)?.path, 'wiki/index.md');
  assert.ok(pages.filter((p) => !p.isIndex).every((p) => p.path.startsWith('wiki/')));
  const { pages: queue } = await (await get('/api/queue')).json();
  assert.deepEqual(queue.map((p) => p.path), ['wiki/topics/cand-one.md']);
});

test('page reads any status (human browse), index.md allowed, traversal refused', async () => {
  assert.equal((await get('/api/page?path=wiki/topics/cand-one.md')).status, 200);
  assert.equal((await get('/api/page?path=wiki/index.md')).status, 200);
  for (const bad of ['../log.md', 'wiki/../../log.md', 'raw/local/aaaa1111-pay.md', 'wiki/topics/nope.txt']) {
    assert.equal((await get('/api/page?path=' + encodeURIComponent(bad))).status, 400, `refuse ${bad}`);
  }
  assert.equal((await get('/api/page?path=' + encodeURIComponent('wiki\\topics\\ok-page.md'))).status, 200);
});

test('raw evidence gated under raw/', async () => {
  assert.equal((await get('/api/raw?path=raw/local/aaaa1111-pay.md')).status, 200);
  assert.equal((await get('/api/raw?path=' + encodeURIComponent('wiki/topics/ok-page.md'))).status, 400);
  assert.equal((await get('/api/raw?path=raw/local/nope.md')).status, 404);
});

test('rawlist: every raw doc with identity fields (C9 raw-layer browse)', async () => {
  const { docs } = await (await get('/api/rawlist')).json();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].path, 'raw/local/aaaa1111-pay.md');
  assert.equal(docs[0].source, 'local');
  assert.ok(docs[0].title);
});

test('backlinks: found, and fence-shielded [[links]] do not count', async () => {
  const { pages } = await (await get('/api/backlinks?path=wiki/topics/ok-page.md')).json();
  const rels = pages.map((p) => p.path);
  assert.ok(rels.includes('wiki/topics/cand-one.md'), 'cand-one links [[ok-page]] in body');
  const none = await (await get('/api/backlinks?path=wiki/topics/not-a-link.md')).json();
  assert.deepEqual(none.pages, [], '[[not-a-link]] appears only inside a code fence');
});

test('search: real FTS hit with per-term routed legs (B4, no CLI change)', async () => {
  const http = await get('/api/search?q=' + encodeURIComponent('retry compensation'));
  assert.equal(http.status, 200, `search must not error (native module healthy?): ${await http.clone().text().catch(() => '')}`);
  const res = await http.json();
  assert.ok(res.total > 0);
  assert.deepEqual(res.routed.latin, ['retry', 'compensation']);
  assert.ok(res.preview[0].page.startsWith('wiki/'));
  assert.equal(res.preview.every((c) => c.page !== 'wiki/topics/cand-one.md'), true,
    'candidate pages stay invisible to retrieval (contract §3)');
  const bad = await get('/api/search?q=');
  assert.equal(bad.status, 400);
});

test('rawrefs: wiki pages tracing to a raw doc (A5 reverse; G5 reuses this scan)', async () => {
  const { pages } = await (await get('/api/rawrefs?path=raw/local/aaaa1111-pay.md')).json();
  const rels = pages.map((p) => p.path);
  assert.ok(rels.includes('wiki/sources/local-aaaa1111-pay.md'), 'source page via source_ref');
  assert.ok(rels.includes('wiki/topics/ok-page.md'), 'topic page via sources[]');
});

test('health: plan-derived lists drive the dashboard and stale flag (D3/D5)', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.pages.total, 3);
  assert.equal(h.pages.byStatus.candidate, 1);
  assert.equal(h.plan.review_queue, 1);
  assert.equal(typeof h.plan.orphaned_pages, 'number');
  assert.equal(h.stale, true, 'candidate in queue ⇒ stale call-to-action');
});

test('log endpoint parses log.md prefix lines, newest first (D2)', async () => {
  fs.appendFileSync(path.join(kb, 'log.md'),
    '## [2026-08-01T01:00:00Z] govern | auto:create-topic | wiki/topics/ok-page.md | first\n' +
    '## [2026-08-01T02:00:00Z] acquire | local:created | raw/local/aaaa1111-pay.md\n' +
    'not a log line\n', 'utf8');
  const { entries } = await (await get('/api/log?limit=10')).json();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].actor, 'acquire', 'newest first');
  assert.equal(entries[1].note, 'first');
  assert.equal(entries[1].target, 'wiki/topics/ok-page.md');
});

// ---- write security (P0-2) ----

test('write without token → 403; forged Origin → 403; bad Host → 403', async () => {
  assert.equal((await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'approve' })).status, 403);
  assert.equal((await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'approve' },
    { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403);
  // fetch forbids overriding Host (undici ignores it) — go one level down to
  // node:http so the DNS-rebinding case is genuinely exercised.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ui-token': token, host: 'evil.example' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ path: 'wiki/topics/cand-one.md', action: 'approve' }));
  });
  assert.equal(status, 403);
});

test('review flip works with token; second flip 409 (optimistic concurrency)', async () => {
  // state reset: an earlier test may have touched this page
  writePage('wiki/topics/cand-one.md', {
    type: 'topic', status: 'candidate', title: 'Candidate One', review_note: 'check this',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Candidate body linking [[ok-page]].');
  const ok = await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'approve' }, { 'x-ui-token': token });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, 'approved');
  const again = await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'reject' }, { 'x-ui-token': token });
  assert.equal(again.status, 409);
  const bad = await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'maybe' }, { 'x-ui-token': token });
  assert.equal(bad.status, 400);
});

// ---- static + frontend discipline ----

test('static: index served with injected token; traversal never serves files', async () => {
  const html = await (await get('/')).text();
  assert.ok(!html.includes('%%UI_TOKEN%%'), 'placeholder must be replaced');
  assert.ok(token.length > 20);
  assert.equal((await get('/style.css')).status, 200);
  // fetch/URL normalize '/../x' and '/%2e%2e/x' before/within parsing — either
  // way the outcome must be "not the file": 404 (normalized to a missing public
  // file) or 400 (prefix gate), never 200 with server-side content.
  for (const p of ['/../serve.mjs', '/%2e%2e/serve.mjs', '/..\\serve.mjs']) {
    const r = await get(p);
    assert.ok([400, 404].includes(r.status), `${p} → ${r.status}`);
  }
  assert.equal((await get('/vendor/marked.min.js')).status, 200);
});

test('frontend red line: innerHTML appears only in lib/render.js (P1-5)', () => {
  const pubDir = path.join(UI_DIR, 'public');
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'vendor') walk(p);
      else if (e.isFile() && e.name.endsWith('.js') && !dir.includes('vendor')) {
        if (fs.readFileSync(p, 'utf8').includes('innerHTML')) offenders.push(path.relative(pubDir, p).replace(/\\/g, '/'));
      }
    }
  })(pubDir);
  assert.deepEqual(offenders, ['lib/render.js']);
});
