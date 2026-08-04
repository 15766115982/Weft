// End-to-end smoke (automated version of the DEVLOG M4 manual smoke): CLI-level flow
// plan → apply-source → apply-topic --candidate → viewer reject (unlogged) → sweep
// (backfill + archive) → rebuild-index. Exercises the real CLI and the real viewer
// server over HTTP — no library shortcuts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOVERN = path.join(HERE, '..', 'govern.mjs');
const VIEWER = path.join(HERE, '..', '..', 'viewer', 'serve.mjs');

let kb;
const govern = (args, stdin) => JSON.parse(execFileSync('node', [GOVERN, ...args, '--kb', kb], { input: stdin, encoding: 'utf8' }));
const log = () => fs.readFileSync(path.join(kb, 'log.md'), 'utf8');

before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'aaaa1111-pay.md'), [
    '---',
    'source: local',
    'source_id: aaaa1111-pay',
    'source_url: "file:///inbox/pay.md"',
    'source_version: "2026-07-28T10:00:00+08:00"',
    'pulled_at: "2026-07-30T09:00:00+08:00"',
    'content_hash: "sha256:aaa"',
    'title: "Payment Gateway Requirements"',
    'connector: "local@1.0.0"',
    '---',
    '',
    'The payment gateway must support timeout retries with exponential backoff.',
  ].join('\n'), 'utf8');
});
after(() => fs.rmSync(kb, { recursive: true, force: true }));

test('CLI end-to-end: govern → candidate → viewer reject → sweep → index', async () => {
  const p = govern(['plan']);
  assert.equal(p.pending.length, 1);
  assert.equal(p.review_queue.length, 0);

  const applied = govern(['apply-source', '--raw', 'raw/local/aaaa1111-pay.md', '--tags', 'payment'],
    '## Key Points\n\n- Gateway retries timed-out calls with exponential backoff.\n');
  assert.equal(applied.action, 'auto:create-source');

  const topic = govern(['apply-topic', '--slug', 'retry-budget', '--title', 'Retry Budget (draft)',
    '--sources', 'raw/local/aaaa1111-pay.md', '--candidate', '--note', 'conflicts on budget'],
    'A draft synthesis whose retry-budget claim conflicts with the source.\n');
  assert.equal(topic.status, 'candidate');

  // viewer rejects (writes no log — that is the design). S8: the write needs
  // the per-startup token, which the server injects into index.html.
  const viewer = spawn('node', [VIEWER, '--kb', kb, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve, reject) => {
    viewer.stdout.on('data', (d) => {
      const m = String(d).match(/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    viewer.on('exit', () => reject(new Error('viewer exited before listening')));
  });
  const viewerToken = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    .then((h) => h.match(/name="viewer-token" content="([^"]+)"/)?.[1]);
  assert.ok(viewerToken, 'index.html carries the per-startup token');
  const r = await fetch(`http://127.0.0.1:${port}/api/review`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-viewer-token': viewerToken },
    body: JSON.stringify({ path: 'wiki/topics/retry-budget.md', action: 'reject' }),
  });
  assert.equal(r.status, 200);
  viewer.kill();
  assert.equal((log().match(/retry-budget/g) || []).length, 1, 'only the candidate:topic line exists so far');

  const s = govern(['sweep']);
  assert.deepEqual(s.backfilled, [{ page: 'wiki/topics/retry-budget.md', status: 'rejected' }]);
  assert.deepEqual(s.archived, [{ from: 'wiki/topics/retry-budget.md', page: 'wiki/archive/retry-budget.md' }]);

  govern(['rebuild-index']);
  const index = fs.readFileSync(path.join(kb, 'wiki', 'index.md'), 'utf8');
  assert.match(index, /\[\[sources\/local-aaaa1111-pay\]\]/);
  assert.ok(!index.includes('retry-budget'), 'archived page must not appear in the index');

  for (const re of [
    /govern \| auto:create-source \| wiki\/sources\/local-aaaa1111-pay\.md/,
    /govern \| candidate:topic \| wiki\/topics\/retry-budget\.md \| sources:1 conflicts on budget/,
    /review \| reject \| wiki\/topics\/retry-budget\.md \| via viewer \(backfilled\)/,
    /govern \| auto:archive-rejected \| wiki\/archive\/retry-budget\.md \| from wiki\/topics\/retry-budget\.md/,
    /govern \| auto:rebuild-index \| wiki\/index\.md/,
  ]) {
    assert.match(log(), re);
  }
  const archived = fs.readFileSync(path.join(kb, 'wiki', 'archive', 'retry-budget.md'), 'utf8');
  assert.match(archived, /status: archived/);
});

test('CLI boolean flag trap: --candidate yes fails loudly instead of silently approving', () => {
  assert.throws(
    () => govern(['apply-topic', '--slug', 'x-topic', '--title', 'T', '--sources', 'raw/local/aaaa1111-pay.md', '--candidate', 'yes'], 'body'),
    /is a boolean flag and takes no value/);
  const ok = govern(['apply-topic', '--slug', 'x-topic', '--title', 'T', '--sources', 'raw/local/aaaa1111-pay.md', '--candidate', 'true'], 'body');
  assert.equal(ok.status, 'candidate');
});
