// Settings route tests (open portal — no role gating).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-settings-'));
  fs.mkdirSync(path.join(kb, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({ version: 2 }));
  fs.mkdirSync(path.join(kb, '.kb', 'config'), { recursive: true });
  fs.writeFileSync(path.join(kb, '.kb', 'config', 'models.json'), JSON.stringify({
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt-5-4',
    auth: { type: 'api_key', api_key: 'WEFT_TEST_LLM_KEY' },
  }));
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
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(obj),
});

test('settings read is public and masks secrets', async () => {
  const res = await get('/api/settings');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.config.auth.api_key, 'env:WEFT_TEST_LLM_KEY');
  // env flags report the referenced secret var names, never values
  assert.equal(data.env.WEFT_TEST_LLM_KEY, false);
  assert.deepEqual(data.prompts, []);
});

test('settings/check enqueues an llm check job (write token required)', async () => {
  const noToken = await post('/api/settings/check', {});
  assert.equal(noToken.status, 403);
  const res = await post('/api/settings/check', {}, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.ok(data.job.id);
  assert.equal(data.job.type, 'llm-check');
});

test('settings/init-prompts enqueues a job', async () => {
  const res = await post('/api/settings/init-prompts', {}, { 'x-ui-token': token });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.job.type, 'llm-init-prompts');
});

test('legacy admin routes are gone (open portal)', async () => {
  assert.equal((await post('/api/admin/login', { password: 'x' }, { 'x-ui-token': token })).status, 404);
  assert.equal((await get('/api/session')).status, 404);
});

test('settings page static asset is served with injected token', async () => {
  const res = await get('/views/settings.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Settings/);
  assert.match(html, /name="ui-token" content="[^%]/);
});
