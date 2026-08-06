import assert from 'node:assert';
import test from 'node:test';
import { chatCompletion, buildEndpoint } from '../lib/openai.mjs';

test('buildEndpoint constructs Azure URL', () => {
  const url = buildEndpoint({ endpoint: 'https://x.openai.azure.com/', deployment: 'd', api_version: '2025-01-01-preview' });
  assert.match(url, /https:\/\/x\.openai\.azure\.com\/openai\/deployments\/d\/chat\/completions\?api-version=2025-01-01-preview/);
});

test('buildEndpoint constructs OpenAI-compatible URL', () => {
  const url = buildEndpoint({ provider: 'openai', endpoint: 'https://api.moonshot.cn/v1/', model: 'kimi-k2' });
  assert.strictEqual(url, 'https://api.moonshot.cn/v1/chat/completions');
});

test('chatCompletion with openai provider: Bearer header + model in body', async () => {
  process.env.WEFT_TEST_KEY = 'sk-kimi';
  let seenBody;
  const mockFetch = async (url, init) => {
    assert.strictEqual(url, 'https://api.moonshot.cn/v1/chat/completions');
    assert.strictEqual(init.headers.Authorization, 'Bearer sk-kimi');
    assert.ok(!('api-key' in init.headers));
    seenBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    };
  };
  const res = await chatCompletion(
    { provider: 'openai', endpoint: 'https://api.moonshot.cn/v1', model: 'kimi-k2', auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' } },
    [{ role: 'user', content: 'hello' }],
    { fetchImpl: mockFetch }
  );
  assert.strictEqual(res.choices[0].message.content, 'hi');
  assert.strictEqual(seenBody.model, 'kimi-k2');
  delete process.env.WEFT_TEST_KEY;
});

test('openai provider requires model', async () => {
  process.env.WEFT_TEST_KEY = 'sk-x';
  await assert.rejects(
    chatCompletion(
      { provider: 'openai', endpoint: 'https://x.example.com/v1', auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' } },
      [{ role: 'user', content: 'hello' }],
      { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }
    ),
    /requires "model"/
  );
  delete process.env.WEFT_TEST_KEY;
});

test('openai provider rejects spn auth with a clear error', async () => {
  await assert.rejects(
    chatCompletion(
      { provider: 'openai', endpoint: 'https://x.example.com/v1', model: 'm', auth: { type: 'spn', tenant_id: 't', client_id: 'c', client_secret: 'NOPE' } },
      [{ role: 'user', content: 'hello' }],
      { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }
    ),
    /misconfigured for provider "openai"/
  );
});

test('chatCompletion with api_key auth', async () => {
  process.env.WEFT_TEST_KEY = 'key123';
  const mockFetch = async (url, init) => {
    assert.strictEqual(init.headers['api-key'], 'key123');
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    };
  };
  const res = await chatCompletion(
    { endpoint: 'https://x.openai.azure.com', deployment: 'd', auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' } },
    [{ role: 'user', content: 'hello' }],
    { fetchImpl: mockFetch }
  );
  assert.strictEqual(res.choices[0].message.content, 'hi');
  delete process.env.WEFT_TEST_KEY;
});

test('chatCompletion retries on failure', async () => {
  process.env.WEFT_TEST_KEY = 'key123';
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [] }) };
  };
  const res = await chatCompletion(
    { endpoint: 'https://x.openai.azure.com', deployment: 'd', auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' } },
    [{ role: 'user', content: 'hello' }],
    { fetchImpl: mockFetch }
  );
  assert.ok(res);
  assert.strictEqual(calls, 2);
  delete process.env.WEFT_TEST_KEY;
});

test('chatCompletion throws after retries exhausted', async () => {
  process.env.WEFT_TEST_KEY = 'key123';
  const mockFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(
    chatCompletion(
      { endpoint: 'https://x.openai.azure.com', deployment: 'd', auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' } },
      [{ role: 'user', content: 'hello' }],
      { fetchImpl: mockFetch }
    ),
    /LLM request failed/
  );
  delete process.env.WEFT_TEST_KEY;
});
