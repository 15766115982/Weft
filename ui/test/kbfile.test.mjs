// F3 GOVERNANCE.md tests (cloned from edit.test.mjs's 409/security template):
// 404 → create → read round-trip, optimistic lock, path-gate whitelist, write
// security, and the buildGovernPrompt injection contract (incl. 8KB cap).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildGovernPrompt } from '../lib/govern.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-kbfile-'));
  fs.mkdirSync(path.join(kb, 'wiki', 'topics'), { recursive: true });
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

const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});
const get = (p) => fetch(base + p);
const briefPath = () => path.join(kb, 'GOVERNANCE.md');

test('kbfile: 404 before creation, POST creates, GET round-trips with hash, log.md audited', async () => {
  const missing = await get('/api/kbfile?path=GOVERNANCE.md');
  assert.equal(missing.status, 404);

  const create = await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: '# 治理纲要\n\nAPI 文档优先。' }, { 'x-ui-token': token });
  assert.equal(create.status, 200);
  assert.deepEqual(await create.json(), { path: 'GOVERNANCE.md', created: true });
  assert.ok(fs.existsSync(briefPath()));

  const got = await (await get('/api/kbfile?path=GOVERNANCE.md')).json();
  assert.ok(got.hash);
  assert.ok(got.body.includes('API 文档优先'));

  const log = fs.readFileSync(path.join(kb, 'log.md'), 'utf8');
  assert.ok(log.includes('portal | file:edit | GOVERNANCE.md') && log.includes('(created)'));

  const again = await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: '# v2' }, { 'x-ui-token': token });
  assert.deepEqual(await again.json(), { path: 'GOVERNANCE.md', created: false });
});

test('kbfile optimistic lock: stale base_hash → 409; re-based force save succeeds', async () => {
  const { hash } = await (await get('/api/kbfile?path=GOVERNANCE.md')).json();

  fs.appendFileSync(briefPath(), 'External touch.\n', 'utf8'); // change behind the editor's back

  const stale = await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: 'My edit.', base_hash: hash }, { 'x-ui-token': token });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /^edit conflict:/);
  assert.ok(fs.readFileSync(briefPath(), 'utf8').includes('External touch.'), 'conflicting save did NOT overwrite');

  const fresh = await (await get('/api/kbfile?path=GOVERNANCE.md')).json();
  const force = await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: 'My edit.', base_hash: fresh.hash }, { 'x-ui-token': token });
  assert.equal(force.status, 200);
  assert.ok(fs.readFileSync(briefPath(), 'utf8').includes('My edit.'));
});

test('kbfile gates: whitelist, traversal, empty body, security', async () => {
  for (const bad of ['kb.json', 'wiki/syntheses/x.md', '../kb.json', 'governance.md', 'GOVERNANCE.MD ']) {
    const res = await post('/api/kbfile-edit', { path: bad, body: 'x' }, { 'x-ui-token': token });
    assert.equal(res.status, 400, `rejected: ${bad}`);
  }
  assert.equal((await get('/api/kbfile?path=kb.json')).status, 400);
  assert.equal((await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: '   ' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: 'x' })).status, 403, 'no token');
  assert.equal((await post('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: 'x' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403, 'forged Origin');
});

test('buildGovernPrompt: absent file passthrough, injection shape, 8KB cap', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prompt-'));
  try {
    assert.equal(buildGovernPrompt(bare, 'TASK'), 'TASK', 'no GOVERNANCE.md → prompt untouched');

    fs.writeFileSync(path.join(bare, 'GOVERNANCE.md'), '优先治理 API 文档', 'utf8');
    const out = buildGovernPrompt(bare, 'TASK');
    assert.ok(out.indexOf('优先治理 API 文档') < out.indexOf('TASK'), 'brief precedes the task');
    assert.ok(out.includes('服务端注入'));
    assert.ok(out.includes('不得创建、修改或删除'));

    const big = '纲'.repeat(4000); // 12000 bytes utf8 → over the 8KB cap
    fs.writeFileSync(path.join(bare, 'GOVERNANCE.md'), big, 'utf8');
    const capped = buildGovernPrompt(bare, 'TASK');
    assert.ok(capped.includes('已截断至 8KB'));
    assert.ok(Buffer.byteLength(capped.split('# 本次任务')[0], 'utf8') < 8192 + 400);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});
