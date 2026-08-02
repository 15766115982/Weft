// M7c governance console tests: /api/plan preview (I5), mechanical steps via
// the queue (I1), agent runs with a mock executor (I2/I3 pluggability), SSE
// 'run' chunk streaming (I4), write security on the new endpoints.
// The real claude executor is NOT spawned in tests — registerExecutor is the
// documented plug point, so a mock proves the whole chain except the spawn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createPortal } from '../serve.mjs';
import { registerExecutor, executorNames } from '../lib/executor.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-m7c-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki', 'topics'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'aaaa1111-pay.md'),
    buildFrontmatter({
      source: 'local', source_id: 'aaaa1111', title: 'Pay Raw',
      source_url: 'file:///inbox/pay.md',
      source_version: '2026-08-01T00:00:00Z', content_hash: 'h1',
    }) + '\nRaw evidence body.\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];

  // Mock executor: the I3 plug point. Emits two progressive chunks then a
  // successful done — mirrors the claude executor's event contract.
  registerExecutor('mock', ({ prompt }) => {
    const events = new EventEmitter();
    setTimeout(() => {
      events.emit('event', { kind: 'init', text: 'session mock-1 (mock)' });
      events.emit('event', { kind: 'assistant', text: `working on: ${prompt.slice(0, 40)}` });
      events.emit('event', { kind: 'assistant', text: 'created wiki/sources/aaaa1111-pay.md (candidate)' });
      events.emit('done', { ok: true, text: 'summary: 1 source page written as candidate' });
    }, 30);
    return { events, kill: () => {} };
  });
  registerExecutor('mock-fail', () => {
    const events = new EventEmitter();
    setTimeout(() => events.emit('done', { ok: false, text: 'simulated agent failure' }), 10);
    return { events, kill: () => {} };
  });
});
after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
});

const get = (p) => fetch(base + p);
const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});

async function until(fn, ms = 10000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, step));
  }
}

async function waitJob(id) {
  let job;
  await until(async () => {
    const { jobs } = await (await get('/api/jobs')).json();
    job = jobs.find((j) => j.id === id);
    return job && (job.status === 'done' || job.status === 'failed');
  });
  return job;
}

test('mock executor registered (I3: the plug point works)', () => {
  assert.ok(executorNames().includes('claude'), 'claude is the built-in');
  assert.ok(executorNames().includes('mock'), 'third-party executors register by name');
});

test('plan preview: full six lists with titles and reasons (I5)', async () => {
  const p = await (await get('/api/plan')).json();
  assert.ok(Array.isArray(p.pending) && Array.isArray(p.review_queue) && Array.isArray(p.orphaned_pages));
  const hit = p.pending.find((x) => x.raw === 'raw/local/aaaa1111-pay.md');
  assert.ok(hit, 'raw without a source page is pending');
  assert.equal(hit.reason, 'new');
  assert.equal(hit.title, 'Pay Raw');
});

test('mechanical steps: sweep runs via queue; merge-topic validates slugs (I1)', async () => {
  const res = await post('/api/govern', { action: 'sweep' }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  assert.equal((await waitJob((await res.json()).job.id)).status, 'done');
  const badAction = await post('/api/govern', { action: 'drop-database' }, { 'x-ui-token': token });
  assert.equal(badAction.status, 400);
  const badSlug = await post('/api/govern', { action: 'merge-topic', from: '../../etc', to: 'x' }, { 'x-ui-token': token });
  assert.equal(badSlug.status, 400);
  const missing = await post('/api/govern', { action: 'merge-topic', from: 'a' }, { 'x-ui-token': token });
  assert.equal(missing.status, 400);
});

test('agent run: mock executor → queued job, transcript captured (I2)', async () => {
  const res = await post('/api/govern-run', { prompt: 'govern this KB', executor: 'mock' }, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const done = await waitJob((await res.json()).job.id);
  assert.equal(done.status, 'done', done.error || '');
  assert.ok(done.log.includes('working on: govern this KB'), 'assistant chunks streamed into job.log');
  assert.ok(done.result.result.includes('summary:'), 'result text preserved');
  const fail = await post('/api/govern-run', { prompt: 'x', executor: 'mock-fail' }, { 'x-ui-token': token });
  assert.equal((await waitJob((await fail.json()).job.id)).status, 'failed', 'agent failure surfaces as a failed job');
  const unknown = await post('/api/govern-run', { prompt: 'x', executor: 'not-real' }, { 'x-ui-token': token });
  assert.equal(unknown.status, 400);
});

test('agent run streams SSE run chunks live (I4)', async () => {
  const chunks = [];
  let jobId = null;
  const req = http.get(base + '/api/events', (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        if (!part.startsWith('event: run')) continue;
        const data = JSON.parse(part.split('data: ')[1]);
        if (jobId && data.jobId === jobId) chunks.push(data.chunk);
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  const res = await post('/api/govern-run', { prompt: 'stream test', executor: 'mock' }, { 'x-ui-token': token });
  jobId = (await res.json()).job.id;
  await waitJob(jobId);
  await until(() => chunks.length >= 2, 3000);
  assert.ok(chunks.some((c) => c.includes('working on: stream test')), 'live chunks carry the transcript');
  req.destroy();
});

test('M7c write security: govern endpoints refuse no-token and forged Origin', async () => {
  assert.equal((await post('/api/govern', { action: 'sweep' })).status, 403);
  assert.equal((await post('/api/govern-run', { prompt: 'x' })).status, 403);
  assert.equal((await post('/api/govern-run', { prompt: 'x', executor: 'mock' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403);
});
