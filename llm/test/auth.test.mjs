import assert from 'node:assert';
import test from 'node:test';
import { fetchSpnToken, getCachedToken, setCachedToken } from '../lib/auth.mjs';

test('fetchSpnToken returns access token', async () => {
  const mockFetch = async (url, init) => {
    assert.ok(url.includes('/tenant/oauth2/v2.0/token'));
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ access_token: 'tok123', expires_in: 3600 }),
    };
  };
  const token = await fetchSpnToken(
    { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' },
    mockFetch
  );
  assert.strictEqual(token, 'tok123');
});

test('fetchSpnToken caches token', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ access_token: 'cached', expires_in: 3600 }),
    };
  };
  await fetchSpnToken({ tenantId: 't2', clientId: 'c2', clientSecret: 's' }, mockFetch);
  const cached = getCachedToken('t2', 'c2');
  assert.strictEqual(cached, 'cached');
  await fetchSpnToken({ tenantId: 't2', clientId: 'c2', clientSecret: 's' }, mockFetch);
  assert.strictEqual(calls, 1);
});

test('fetchSpnToken throws on missing config', async () => {
  await assert.rejects(
    fetchSpnToken({ tenantId: '', clientId: 'c', clientSecret: 's' }, async () => {}),
    /Azure SPN config requires/
  );
});
