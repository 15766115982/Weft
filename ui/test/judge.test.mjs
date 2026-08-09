// K judge tests: the registry plug point (mock backend through the same path),
// rubric prompt shape, verdict parsing robustness (prose around JSON, missing
// slots, out-of-range scores), endpoint validation + security.
// The real claude backend is NOT spawned in tests — registerJudge is the
// documented plug point, so a mock proves the chain except the spawn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { registerJudge, judgeNames, buildJudgePrompt, parseVerdicts } from '../lib/judge.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-k-'));
  fs.mkdirSync(path.join(kb, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];

  registerJudge('mock', async (prompt) => {
    const n = (prompt.match(/"id":/g) || []).length;
    return `Here are my grades:\n${JSON.stringify(
      Array.from({ length: n }, (_, i) => ({ id: i + 1, score: (i % 4), reason: `mock reason ${i + 1}` })),
    )}\nHope that helps!`;
  });
});
after(() => { server.close(); fs.rmSync(kb, { recursive: true, force: true }); });

const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});

test('judge registry: claude built-in, mock registered through the same path', () => {
  assert.ok(judgeNames().includes('agent'));
  assert.ok(judgeNames().includes('mock'));
});

test('rubric prompt: fixed rubric, bounded fields, ids in order', () => {
  const p = buildJudgePrompt('retry policy', [
    { page: 'wiki/syntheses/a.md', title: 'A'.repeat(500), snippet: 'S'.repeat(2000) },
    { page: 'wiki/syntheses/b.md', title: 'B', snippet: 's' },
  ]);
  assert.ok(p.includes('3 = directly answers'));
  assert.ok(p.includes('"id": 1') && p.includes('"id": 2'));
  assert.ok(p.length < 2000, 'title/snippet are sliced (200/500 chars)');
});

test('parseVerdicts: prose tolerated, missing slot → null, bad score → null', () => {
  const v = parseVerdicts('Blah blah.\n[{"id":1,"score":3,"reason":"direct"},{"id":2,"score":9,"reason":"x"}]\nDone.', 3);
  assert.deepEqual(v[0], { score: 3, reason: 'direct' });
  assert.equal(v[1].score, null, 'out-of-range score rejected');
  assert.equal(v[2].score, null, 'unjudged slot is null, not an error');
  assert.throws(() => parseVerdicts('no json at all', 1), /no JSON array/);
});

test('/api/judge: mock verdicts land per result', async () => {
  const res = await post('/api/judge', {
    q: 'retry compensation',
    results: [
      { page: 'wiki/syntheses/a.md', title: 'A', snippet: 'alpha' },
      { page: 'wiki/syntheses/b.md', title: 'B', snippet: 'beta' },
    ],
    backend: 'mock',
  }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.backend, 'mock');
  assert.ok(out.ms >= 0);
  assert.equal(out.verdicts.length, 2);
  assert.equal(out.verdicts[0].score, 0);
  assert.equal(out.verdicts[1].score, 1);
  assert.equal(out.verdicts[1].reason, 'mock reason 2');
});

test('/api/judge validation + security', async () => {
  assert.equal((await post('/api/judge', { q: '', results: [{}], backend: 'mock' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/judge', { q: 'x', results: [], backend: 'mock' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/judge', { q: 'x', results: [{}], backend: 'nope' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/judge', { q: 'x', results: [{}], backend: 'mock' })).status, 403, 'no token');
  assert.equal((await post('/api/judge', { q: 'x', results: [{}], backend: 'mock' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403, 'forged Origin');
});
