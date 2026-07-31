// M4 thin viewer tests (ADR-0004): API gates (path traversal, approved-only flips,
// optimistic concurrency), byte-preserving status flips over HTTP, static serving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createViewer } from '../serve.mjs';
import { buildFrontmatter } from '../../scripts/lib/frontmatter.mjs';

let kb, server, base;
const topicAbs = (name) => path.join(kb, 'wiki', 'topics', name);

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-viewer-'));
  writePage('wiki/topics/cand-one.md', {
    type: 'topic', status: 'candidate', title: 'Candidate One',
    sources: ['raw/local/aaaa1111-pay.md'], updated_at: '2026-07-30T00:00:00Z',
  }, 'Candidate body.');
  writePage('wiki/topics/ok-page.md', {
    type: 'topic', status: 'approved', title: 'Approved Page',
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
const post = (p, obj) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

test('queue lists candidate pages only; pages lists everything', async () => {
  const queue = await (await fetch(base + '/api/queue')).json();
  assert.deepEqual(queue.pages.map((p) => p.path), ['wiki/topics/cand-one.md']);
  const all = await (await fetch(base + '/api/pages')).json();
  assert.equal(all.pages.length, 2);
});

test('path gates: traversal / raw / index / archive all refused on /api/page', async () => {
  for (const bad of ['../log.md', 'wiki/../log.md', 'raw/local/aaaa1111-pay.md', 'wiki/index.md', 'wiki/archive/old.md']) {
    const r = await fetch(base + '/api/page?path=' + encodeURIComponent(bad));
    assert.equal(r.status, 400, `should refuse: ${bad}`);
    assert.match((await r.json()).error, /page path must be wiki\/sources\|topics/);
  }
  const r = await fetch(base + '/api/page?path=' + encodeURIComponent('wiki\\topics\\ok-page.md'));
  assert.equal(r.status, 200, 'backslash variant of a legit path normalizes');
});

test('raw evidence endpoint: serves raw/ only, refuses traversal and log.md', async () => {
  const ok = await fetch(base + '/api/raw?path=' + encodeURIComponent('raw/local/aaaa1111-pay.md'));
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).body.includes('Raw evidence body'));
  for (const bad of ['../log.md', 'raw/../../log.md', 'wiki/topics/ok-page.md', 'log.md']) {
    const r = await fetch(base + '/api/raw?path=' + encodeURIComponent(bad));
    assert.ok(r.status === 400 || r.status === 404, `should refuse: ${bad} (got ${r.status})`);
  }
});

test('review flip over HTTP is byte-preserving (CRLF + BOM + comments)', async () => {
  const abs = topicAbs('crlf-cand.md');
  const original = '﻿---\r\n' +
    'type: topic\r\n' +
    'status: candidate\r\n' +
    'title: "CRLF Candidate"\r\n' +
    '# editor comment\r\n' +
    '---\r\n' +
    '\r\nBody.\r\n';
  fs.writeFileSync(abs, original, 'utf8');
  const r = await post('/api/review', { path: 'wiki/topics/crlf-cand.md', action: 'approve' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'approved');
  const expected = original.replace('status: candidate\r\n', 'status: approved\r\n');
  assert.equal(fs.readFileSync(abs, 'utf8'), expected, 'only the one status line may change');
});

test('review gates: double flip → 409; approved page → 409; index.md → 400; ghost → 404; bad action → 400', async () => {
  let r = await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'approve' });
  assert.equal(r.status, 200);
  r = await post('/api/review', { path: 'wiki/topics/cand-one.md', action: 'reject' });
  assert.equal(r.status, 409, 'second flip loses loudly');
  assert.match((await r.json()).error, /page status is "approved", expected "candidate"/);
  r = await post('/api/review', { path: 'wiki/topics/ok-page.md', action: 'approve' });
  assert.equal(r.status, 409, 'approved page is not flippable');
  r = await post('/api/review', { path: 'wiki/index.md', action: 'approve' });
  assert.equal(r.status, 400);
  r = await post('/api/review', { path: 'wiki/topics/ghost.md', action: 'approve' });
  assert.equal(r.status, 404);
  r = await post('/api/review', { path: 'wiki/topics/ok-page.md', action: 'delete' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /action must be approve\|reject/);
});

test('static serving: index + app.js, no escape from public/', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /KB Review Viewer/);
  const js = await fetch(base + '/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const evil = await fetch(base + '/..%2f..%2fserve.mjs');
  assert.ok(evil.status === 400 || evil.status === 404);
});

test('CJK regression: CJK title and body round-trip through /api/page', async () => {
  writePage('wiki/topics/cjk-page.md', {
    type: 'topic', status: 'candidate', title: '支付超时治理',
    sources: ['raw/local/aaaa1111-pay.md'],
  }, '## 超时\n\n支付网关支持超时重试。');
  const r = await fetch(base + '/api/page?path=' + encodeURIComponent('wiki/topics/cjk-page.md'));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.fields.title, '支付超时治理');
  assert.ok(data.body.includes('超时重试'));
});

test('L3 regression: oversize POST body gets a 413 response, not a hung connection', async () => {
  const r = await post('/api/review', { path: 'wiki/topics/ok-page.md', action: 'approve', pad: 'x'.repeat(70 * 1024) });
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /request body too large/);
});

test('diff endpoint: graceful null baseline when the KB has no git history', async () => {
  const r = await fetch(base + '/api/diff?path=' + encodeURIComponent('wiki/topics/ok-page.md'));
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
  const pageAbs = path.join(gkb, 'wiki', 'topics', 'versioned.md');
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, buildFrontmatter({
    type: 'topic', status: 'approved', title: 'Versioned', sources: [],
  }) + '\nOld baseline body line.\n', 'utf8');
  const git = (args) => execFileSync('git', ['-C', gkb, ...args], { stdio: 'ignore' });
  git(['init']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t', '-c', 'user.name=t', 'commit', '-m', 'baseline']);
  // a candidate overwrite: status flip + body change, uncommitted
  fs.writeFileSync(pageAbs, buildFrontmatter({
    type: 'topic', status: 'candidate', title: 'Versioned', sources: [],
  }) + '\nNew conflicting body line.\n', 'utf8');

  const server2 = createViewer(gkb);
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server2.address().port}/api/diff?path=` + encodeURIComponent('wiki/topics/versioned.md'));
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
