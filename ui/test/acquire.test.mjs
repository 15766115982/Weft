// M7b acquisition console tests (ADR-0006 whitelist ①②④): jobs queue
// serialization (S10), upload → inbox → acquire roundtrip (E), pull +
// freshness (F/J6), inbox management (J4), raw delete/move with snapshots
// (G), SSE change events with .kb exclusion (J3), write security on the new
// endpoints. Self-contained KB fixture; the M7a suite (ui.test.mjs) is untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createPortal } from '../serve.mjs';
import { createJobCenter } from '../lib/jobs.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-m7b-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'aaaa1111-pay.md'),
    buildFrontmatter({ source: 'local', source_id: 'aaaa1111', title: 'Pay Raw' }) + '\nRaw evidence body.\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
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

async function until(fn, ms = 20000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, step));
  }
}

async function waitJob(id, baseOverride) {
  const b = baseOverride || base;
  let job;
  await until(async () => {
    const { jobs } = await (await fetch(b + '/api/jobs')).json();
    job = jobs.find((j) => j.id === id);
    return job && (job.status === 'done' || job.status === 'failed');
  });
  return job;
}

test('jobs queue: serialized in order, a failure does not poison the chain', async () => {
  const jc = createJobCenter();
  const order = [];
  const slow = (tag, fail) => ({
    type: 'probe', label: tag,
    run: async () => { await new Promise((r) => setTimeout(r, 50)); order.push(tag); if (fail) throw new Error('boom'); },
  });
  const j1 = jc.enqueue(kb, slow('first'));
  const j2 = jc.enqueue(kb, slow('second', true));
  const j3 = jc.enqueue(kb, slow('third'));
  assert.equal((await jc.waitFor(j1)).status, 'done');
  assert.equal((await jc.waitFor(j2)).status, 'failed');
  assert.equal((await jc.waitFor(j3)).status, 'done', 'chain survives a failed job');
  assert.deepEqual(order, ['first', 'second', 'third'], 'strict per-KB serial order');
  assert.ok(fs.existsSync(path.join(kb, '.kb', 'ui', 'jobs.jsonl')), 'history persisted');
});

test('upload: bytes → inbox → acquire local → raw doc (E1/E2, one queued job)', async () => {
  const name = 'retry 笔记.md';
  const res = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-ui-token': token, 'x-filename': encodeURIComponent(name) },
    body: Buffer.from('# Retry Notes\n\nCompensation and umbrella patterns.\n', 'utf8'),
  });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', done.error || 'upload job failed');
  assert.ok(fs.existsSync(path.join(kb, 'inbox', name)), 'staged in inbox (whitelist ①)');
  const rawLocal = fs.readdirSync(path.join(kb, 'raw', 'local')).filter((f) => f.endsWith('.md'));
  assert.ok(rawLocal.length >= 2, `acquire produced a raw doc: ${rawLocal}`);
  assert.ok(done.result.acquire.includes('"created"'), 'acquire summary captured in the job result');
});

test('pull local + sources freshness (F1/F2, J6 via acquire_runs.jsonl)', async () => {
  const res = await post('/api/pull', { connector: 'local' }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.equal((await waitJob(job.id)).status, 'done');
  const { sources } = await (await get('/api/sources')).json();
  const local = sources.find((s) => s.connector === 'local');
  assert.ok(local.lastRun, 'last pull recorded');
  assert.equal(local.lastRun.connector, 'local');
  assert.ok(fs.existsSync(path.join(kb, '.kb', 'acquire_runs.jsonl')), 'acquisition CLI appended the run record');
  const bad = await post('/api/pull', { connector: 'sharepoint' }, { 'x-ui-token': token });
  assert.equal(bad.status, 400);
});

test('inbox list + delete (J4), delete through the queue', async () => {
  const { files } = await (await get('/api/inbox')).json();
  assert.ok(files.some((f) => f.name.includes('retry')), 'uploaded file staged');
  const res = await post('/api/inbox-delete', { name: 'retry 笔记.md' }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.equal((await waitJob(job.id)).status, 'done');
  assert.ok(!fs.existsSync(path.join(kb, 'inbox', 'retry 笔记.md')));
  const again = await post('/api/inbox-delete', { name: 'retry 笔记.md' }, { 'x-ui-token': token });
  assert.equal((await waitJob((await again.json()).job.id)).status, 'failed', 'ENOENT surfaces as a failed job');
});

test('raw delete: snapshot-first copy fallback, then unlink (G1/G6, non-git KB)', async () => {
  const { docs } = await (await get('/api/rawlist')).json();
  const target = docs.find((d) => d.path !== 'raw/local/aaaa1111-pay.md');
  assert.ok(target, 'uploaded raw doc exists');
  const res = await post('/api/raw-delete', { path: target.path }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const done = await waitJob((await res.json()).job.id);
  assert.equal(done.status, 'done', done.error || '');
  assert.ok(!fs.existsSync(path.join(kb, target.path)), 'raw doc deleted');
  assert.equal(done.result.snapshot.kind, 'copy', 'no git → copy snapshot');
  assert.ok(fs.existsSync(path.join(kb, done.result.snapshot.path, target.path)), 'restorable copy preserved');
  const missing = await post('/api/raw-delete', { path: target.path }, { 'x-ui-token': token });
  assert.equal((await waitJob((await missing.json()).job.id)).status, 'failed', 'double delete fails loudly');
});

test('raw move: new identity, target-exists guard, traversal refused (G2)', async () => {
  const up = await fetch(base + '/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-ui-token': token, 'x-filename': encodeURIComponent('move-me.md') },
    body: Buffer.from('# Move Me\n', 'utf8'),
  });
  assert.equal((await waitJob((await up.json()).job.id)).status, 'done');
  const { docs } = await (await get('/api/rawlist')).json();
  const src = docs.find((d) => d.path.includes('move-me'));
  const res = await post('/api/raw-move', { from: src.path, to: 'raw/local/moved/move-me.md' }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const done = await waitJob((await res.json()).job.id);
  assert.equal(done.status, 'done', done.error || '');
  assert.ok(!fs.existsSync(path.join(kb, src.path)) && fs.existsSync(path.join(kb, 'raw', 'local', 'moved', 'move-me.md')));
  const clash = await post('/api/raw-move', { from: 'raw/local/moved/move-me.md', to: 'raw/local/aaaa1111-pay.md' }, { 'x-ui-token': token });
  assert.equal((await waitJob((await clash.json()).job.id)).status, 'failed', 'existing target refused');
  const escape = await post('/api/raw-move', { from: 'raw/local/moved/move-me.md', to: 'wiki/x.md' }, { 'x-ui-token': token });
  assert.equal(escape.status, 400, 'move target must stay under raw/');
});

test('M7b write security: new write endpoints refuse no-token and forged Origin', async () => {
  assert.equal((await fetch(base + '/api/upload', { method: 'POST', headers: { 'x-filename': 'x.md' }, body: 'x' })).status, 403);
  assert.equal((await post('/api/raw-delete', { path: 'raw/local/aaaa1111-pay.md' })).status, 403);
  assert.equal((await post('/api/pull', { connector: 'local' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/raw-move', { from: 'a', to: 'b' }, { 'x-ui-token': token, origin: 'https://10.0.0.9:8322' })).status, 403);
});

test('SSE /api/events: wiki change fires (debounced), .kb writes are excluded (J3)', async () => {
  const events = [];
  const req = http.get(base + '/api/events', (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) if (p.startsWith('event: change')) events.push(p);
    });
  });
  await new Promise((r) => setTimeout(r, 300)); // subscription attaches
  fs.mkdirSync(path.join(kb, '.kb', 'ui'), { recursive: true });
  fs.appendFileSync(path.join(kb, '.kb', 'ui', 'probe.txt'), 'x');
  await new Promise((r) => setTimeout(r, 1200)); // > debounce
  assert.equal(events.length, 0, '.kb/ derived writes must not retrigger the portal');
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n', 'utf8');
  await until(() => events.length > 0, 5000, 100);
  req.destroy();
});

test('raw delete in a git KB snapshots via pathspec-scoped commit (G6 git path)', async () => {
  const kb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-git-'));
  fs.mkdirSync(path.join(kb2, 'raw', 'local'), { recursive: true });
  fs.writeFileSync(path.join(kb2, 'raw', 'local', 'x.md'),
    buildFrontmatter({ source: 'local', source_id: 'x', title: 'X' }) + '\nbody\n', 'utf8');
  const git = (args, opts = {}) => execFileSync('git', ['-C', kb2, ...args], { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const portal2 = createPortal({ kb: kb2, port: 0 });
  await new Promise((r) => portal2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${portal2.address().port}`;
  const token2 = (await (await fetch(base2 + '/')).text()).match(/name="ui-token" content="([^"]+)"/)[1];
  const res = await fetch(base2 + '/api/raw-delete', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ui-token': token2 },
    body: JSON.stringify({ path: 'raw/local/x.md' }),
  });
  assert.equal(res.status, 202);
  const done = await waitJob((await res.json()).job.id, base2);
  assert.equal(done.status, 'done', done.error || '');
  assert.equal(done.result.snapshot.kind, 'git');
  assert.ok(!fs.existsSync(path.join(kb2, 'raw', 'local', 'x.md')));
  const restored = git(['show', 'HEAD:raw/local/x.md'], { encoding: 'utf8' });
  assert.ok(restored.includes('title: X'), 'pre-delete state restorable from HEAD');
  portal2.close();
  fs.rmSync(kb2, { recursive: true, force: true });
});
