// Phase 1: Settings/admin route tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createPortal } from '../serve.mjs';

let kb, server, base;
const PASSWORD = 'test-password-123';
const PASSWORD_HASH = crypto.createHash('sha256').update(PASSWORD, 'utf8').digest('hex');

before(async () => {
  process.env.WEFT_ADMIN_PASSWORD_HASH = PASSWORD_HASH;
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-settings-'));
  fs.mkdirSync(path.join(kb, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({ version: 2 }));
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
  delete process.env.WEFT_ADMIN_PASSWORD_HASH;
});

const get = (p, opts = {}) => fetch(base + p, { credentials: 'same-origin', ...opts });
const post = (p, obj, opts = {}) => fetch(base + p, {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json', ...opts.headers },
  body: JSON.stringify(obj),
  ...opts,
});

async function adminCookie() {
  const res = await post('/api/admin/login', { password: PASSWORD });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie;
}

test('settings read requires admin session', async () => {
  const res = await get('/api/settings');
  assert.equal(res.status, 401);
});

test('settings read returns config when admin', async () => {
  const cookie = await adminCookie();
  const res = await get('/api/settings', { headers: { cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.admin_configured, true);
  assert.strictEqual(data.config, null);
  assert.equal(data.env.WEFT_ADMIN_PASSWORD_HASH, true);
});

test('admin login rejects wrong password', async () => {
  const res = await post('/api/admin/login', { password: 'wrong' });
  assert.equal(res.status, 401);
});

test('settings/check enqueues an llm check job', async () => {
  const cookie = await adminCookie();
  const res = await post('/api/settings/check', {}, { headers: { cookie } });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.ok(data.job.id);
  assert.equal(data.job.type, 'llm-check');
});

test('settings/init-prompts enqueues a job', async () => {
  const cookie = await adminCookie();
  const res = await post('/api/settings/init-prompts', {}, { headers: { cookie } });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.job.type, 'llm-init-prompts');
});

test('logout clears session', async () => {
  const cookie = await adminCookie();
  const logout = await post('/api/admin/logout', {}, { headers: { cookie } });
  assert.equal(logout.status, 200);
  const after = await get('/api/settings', { headers: { cookie } });
  assert.equal(after.status, 401);
});

test('settings page static asset is served', async () => {
  const res = await get('/views/settings.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Settings/);
});
