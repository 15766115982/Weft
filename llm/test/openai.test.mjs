import assert from 'node:assert';
import test from 'node:test';
import { chatCompletion, buildEndpoint } from '../lib/openai.mjs';

test('buildEndpoint constructs Azure URL', () => {
  const url = buildEndpoint('https://x.openai.azure.com/', 'd', '2025-01-01-preview');
  assert.match(url, /https:\/\/x\.openai\.azure\.com\/openai\/deployments\/d\/chat\/completions\?api-version=2025-01-01-preview/);
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
    /Azure OpenAI request failed/
  );
  delete process.env.WEFT_TEST_KEY;
});
