// M4 thin viewer tests (ADR-0004): API gates (path traversal, approved-only flips,
// optimistic concurrency), byte-preserving status flips over HTTP, static serving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createViewer } from '../serve.mjs';
import { buildFrontmatter } from '../../scripts/lib/frontmatter.mjs';

let kb, server, base;
const synthAbs = (name) => path.join(kb, 'wiki', 'syntheses', name);

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-viewer-'));
  writePage('wiki/syntheses/cand-one.md', {
    type: 'synthesis', status: 'candidate', title: 'Candidate One',
    sources: ['raw/local/aaaa1111-pay.md'], updated_at: '2026-07-30T00:00:00Z',
  }, 'Candidate body.');
  writePage('wiki/syntheses/ok-page.md', {
    type: 'synthesis', status: 'approved', title: 'Approved Page',
    sources: ['raw/local/aaaa1111-pay.md'], updated_at: '2026-07-30T00:00:00Z',
  }, 'Approved body.');
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'aaaa1111-pay.md'),
    buildFrontmatter({ source: 'local', source_id: 'aaaa1111-pay', title: 'Pay Raw' }) + '\nRaw evidence body.\n', 'utf8');
  server = createViewer(kb);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
});

const get = async (p) => ({ status: (await fetch(base + p)).status, data: await (await fetch(base + p)).json().catch(() => null) });
const post = (p, obj) => fetch(base + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-viewer-token': server.viewerToken }, body: JSON.stringify(obj) });

test('S8 write protection: no token / bad Origin / bad Host are all refused', async () => {
  // missing token → 403, page untouched
  let r = await fetch(base + '/api/review', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'wiki/syntheses/cand-one.md', action: 'approve' }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /x-viewer-token/);
  // wrong token → 403
  r = await fetch(base + '/api/review', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-viewer-token': 'wrong' },
    body: JSON.stringify({ path: 'wiki/syntheses/cand-one.md', action: 'approve' }) });
  assert.equal(r.status, 403);
  // cross-origin Origin → 403 even with the token
  r = await fetch(base + '/api/review', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-viewer-token': server.viewerToken, origin: 'https://evil.example' },
    body: JSON.stringify({ path: 'wiki/syntheses/cand-one.md', action: 'approve' }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /cross-origin write/);
  // non-loopback Host (DNS rebinding) → 403 on reads too. fetch() forbids
  // overriding Host, so go one level down to node:http for this one.
  const rebinding = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/pages`, { headers: { host: 'evil.example' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebinding.status, 403);
  assert.match(JSON.parse(rebinding.body).error, /DNS-rebinding/);
  // index.html serves the token to the real page
  const home = await (await fetch(base + '/')).text();
  assert.match(home, new RegExp(`name="viewer-token" content="${server.viewerToken}"`));
});

test('queue lists candidate pages only; pages lists everything', async () => {
  const queue = await (await fetch(base + '/api/queue')).json();
  assert.deepEqual(queue.pages.map((p) => p.path), ['wiki/syntheses/cand-one.md']);
  const all = await (await fetch(base + '/api/pages')).json();
  assert.equal(all.pages.length, 2);
});

test('path gates: traversal / raw / index / archive all refused on /api/page', async () => {
  for (const bad of ['../log.md', 'wiki/../log.md', 'raw/local/aaaa1111-pay.md', 'wiki/index.md', 'wiki/archive/old.md']) {
    const r = await fetch(base + '/api/page?path=' + encodeURIComponent(bad));
    assert.equal(r.status, 400, `should refuse: ${bad}`);
    assert.match((await r.json()).error, /page path must be wiki\/sources\|entities\|concepts\|syntheses/);
  }
  const r = await fetch(base + '/api/page?path=' + encodeURIComponent('wiki\\syntheses\\ok-page.md'));
  assert.equal(r.status, 200, 'backslash variant of a legit path normalizes');
});

test('raw evidence endpoint: serves raw/ only, refuses traversal and log.md', async () => {
  const ok = await fetch(base + '/api/raw?path=' + encodeURIComponent('raw/local/aaaa1111-pay.md'));
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).body.includes('Raw evidence body'));
  for (const bad of ['../log.md', 'raw/../../log.md', 'wiki/syntheses/ok-page.md', 'log.md']) {
    const r = await fetch(base + '/api/raw?path=' + encodeURIComponent(bad));
    assert.ok(r.status === 400 || r.status === 404, `should refuse: ${bad} (got ${r.status})`);
  }
});

test('review flip over HTTP is byte-preserving (CRLF + BOM + comments)', async () => {
  const abs = synthAbs('crlf-cand.md');
  const original = '﻿---\r\n' +
    'type: topic\r\n' +
    'status: candidate\r\n' +
    'title: "CRLF Candidate"\r\n' +
    '# editor comment\r\n' +
    '---\r\n' +
    '\r\nBody.\r\n';
  fs.writeFileSync(abs, original, 'utf8');
  const r = await post('/api/review', { path: 'wiki/syntheses/crlf-cand.md', action: 'approve' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'approved');
  const expected = original.replace('status: candidate\r\n', 'status: approved\r\n');
  assert.equal(fs.readFileSync(abs, 'utf8'), expected, 'only the one status line may change');
});

test('review gates: double flip → 409; approved page → 409; index.md → 400; ghost → 404; bad action → 400', async () => {
  let r = await post('/api/review', { path: 'wiki/syntheses/cand-one.md', action: 'approve' });
  assert.equal(r.status, 200);
  r = await post('/api/review', { path: 'wiki/syntheses/cand-one.md', action: 'reject' });
  assert.equal(r.status, 409, 'second flip loses loudly');
  assert.match((await r.json()).error, /page status is "approved", expected "candidate"/);
  r = await post('/api/review', { path: 'wiki/syntheses/ok-page.md', action: 'approve' });
  assert.equal(r.status, 409, 'approved page is not flippable');
  r = await post('/api/review', { path: 'wiki/index.md', action: 'approve' });
  assert.equal(r.status, 400);
  r = await post('/api/review', { path: 'wiki/syntheses/ghost.md', action: 'approve' });
  assert.equal(r.status, 404);
  r = await post('/api/review', { path: 'wiki/syntheses/ok-page.md', action: 'delete' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /action must be approve\|reject/);
});

test('static serving: index + app.js, no escape from public/', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  // the page carries the per-startup token — it must never be cached (a stale
  // copy holds a dead token and every write would 403 after a relaunch)
  assert.match(home.headers.get('cache-control') || '', /no-cache/);
  assert.match(await home.text(), /KB Review Viewer/);
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const evil = await fetch(base + '/..%2f..%2fserve.mjs');
  assert.ok(evil.status === 400 || evil.status === 404);
});

test('CJK regression: CJK title and body round-trip through /api/page', async () => {
  writePage('wiki/syntheses/cjk-page.md', {
    type: 'synthesis', status: 'candidate', title: '支付超时治理',
    sources: ['raw/local/aaaa1111-pay.md'],
  }, '## 超时\n\n支付网关支持超时重试。');
  const r = await fetch(base + '/api/page?path=' + encodeURIComponent('wiki/syntheses/cjk-page.md'));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.fields.title, '支付超时治理');
  assert.ok(data.body.includes('超时重试'));
});

test('L3 regression: oversize POST body gets a 413 response, not a hung connection', async () => {
  const r = await post('/api/review', { path: 'wiki/syntheses/ok-page.md', action: 'approve', pad: 'x'.repeat(70 * 1024) });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /request body too large/);
});

test('diff endpoint: graceful null baseline when the KB has no git history', async () => {
  const r = await fetch(base + '/api/diff?path=' + encodeURIComponent('wiki/syntheses/ok-page.md'));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.baseline, null, 'temp KB is not a git repo — no baseline');
  assert.equal(d.changed, false);
  assert.ok(d.current.includes('Approved body'));
  const bad = await fetch(base + '/api/diff?path=' + encodeURIComponent('../log.md'));
  assert.equal(bad.status, 400);
});

test("L5' regression: diff endpoint returns the git baseline and changed=true (happy path)", async (t) => {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git not available in this environment');
    return;
  }
  const gkb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-viewer-git-'));
  const pageAbs = path.join(gkb, 'wiki', 'syntheses', 'versioned.md');
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, buildFrontmatter({
    type: 'synthesis', status: 'approved', title: 'Versioned', sources: [],
  }) + '\nOld baseline body line.\n', 'utf8');
  const git = (args) => execFileSync('git', ['-C', gkb, ...args], { stdio: 'ignore' });
  git(['init']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t', '-c', 'user.name=t', 'commit', '-m', 'baseline']);
  // a candidate overwrite: status flip + body change, uncommitted
  fs.writeFileSync(pageAbs, buildFrontmatter({
    type: 'synthesis', status: 'candidate', title: 'Versioned', sources: [],
  }) + '\nNew conflicting body line.\n', 'utf8');

  const server2 = createViewer(gkb);
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server2.address().port}/api/diff?path=` + encodeURIComponent('wiki/syntheses/versioned.md'));
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(d.baseline && d.baseline.includes('Old baseline body line'), 'baseline comes from git HEAD');
    assert.ok(!d.baseline.includes('New conflicting body line'));
    assert.ok(d.current.includes('New conflicting body line'));
    assert.equal(d.changed, true);
  } finally {
    server2.close();
    fs.rmSync(gkb, { recursive: true, force: true });
  }
});
