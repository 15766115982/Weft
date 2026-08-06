import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  tmpDir, makeKb, slurpLines, writeModelsConfig,
  mockFetchJson, mockFetchStream, sseChunks,
} from './helpers.mjs';

const MODELS = {
  endpoint: 'https://x.openai.azure.com',
  deployment: 'd',
  auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' },
};

async function runTask(name, ctx) {
  const { run } = await import(`../lib/tasks/${name}.mjs`);
  return run(ctx);
}

async function withMock(fetchImpl, fn) {
  globalThis.__WEFT_LLM_FETCH_IMPL__ = fetchImpl;
  try { return await fn(); }
  finally { delete globalThis.__WEFT_LLM_FETCH_IMPL__; }
}

test('check task reports missing config', async () => {
  const kb = makeKb(tmpDir());
  const res = await runTask('check', { kbRoot: kb });
  assert.strictEqual(res.ok, false);
});

test('check task validates SPN', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, {
    endpoint: 'https://x.openai.azure.com',
    deployment: 'd',
    auth: { type: 'spn', tenant_id: 't', client_id: 'c', client_secret: 'WEFT_TEST_CS' },
  });
  process.env.WEFT_TEST_CS = 'secret';
  const res = await runTask('check', { kbRoot: kb });
  assert.strictEqual(res.ok, false); // token fetch fails without network
  delete process.env.WEFT_TEST_CS;
});

test('check task live-probes the endpoint (api_key provider)', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, {
    provider: 'openai', endpoint: 'https://api.example.com/v1', model: 'm',
    auth: { type: 'api_key', api_key: 'WEFT_TEST_KEY' },
  });
  process.env.WEFT_TEST_KEY = 'k';
  const good = await withMock(async () => ({
    ok: true, status: 200, text: async () => '',
    json: async () => ({ choices: [{ message: { content: '' } }] }),
  }), () => runTask('check', { kbRoot: kb }));
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.config.live, true);
  // a wrong endpoint path must fail check — the regression that made chat silently 404
  const bad = await withMock(async () => ({
    ok: false, status: 404, text: async () => 'resource_not_found',
    json: async () => ({}),
  }), () => runTask('check', { kbRoot: kb }));
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /404/);
  delete process.env.WEFT_TEST_KEY;
});

test('init-prompts task seeds prompts', async () => {
  const kb = makeKb(tmpDir());
  const res = await runTask('init-prompts', { kbRoot: kb, input: {} });
  assert.strictEqual(res.ok, true);
  assert.ok(res.prompts.length > 0);
});

test('summarize-source parses JSON from model output', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    title: 'Payment Summary',
    summary: 'A concise summary.',
    key_points: ['point one', 'point two'],
  })), () => runTask('summarize-source', { kbRoot: kb, input: { title: 'Pay', source: 'jira', body: 'body' } }));
  assert.strictEqual(res.task, 'summarize-source');
  assert.strictEqual(res.title, 'Payment Summary');
  assert.ok(res.key_points.length >= 1);
  delete process.env.WEFT_TEST_KEY;
});

test('classify-page parses and normalizes classification', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    classification: 'concept', confidence: 0.9, reasoning: 'defines a pattern',
  })), () => runTask('classify-page', { kbRoot: kb, input: { page_path: 'wiki/concepts/x.md', title: 'X', body: 'b' } }));
  assert.strictEqual(res.classification, 'concept');
  assert.strictEqual(res.confidence, 0.9);
  delete process.env.WEFT_TEST_KEY;
});

test('extract-entity returns structured entities/relations', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    entities: [{ slug: 'faa', title: 'FAA', kind: 'component' }],
    relations: [{ from: 'faa', to: 'agent-framework', type: 'depends-on' }],
  })), () => runTask('extract-entity', { kbRoot: kb, input: { source_path: 'raw/jira/1.md', body: 'FAA uses Agent Framework.' } }));
  assert.strictEqual(res.entities.length, 1);
  assert.strictEqual(res.relations.length, 1);
  delete process.env.WEFT_TEST_KEY;
});

test('draft-concept returns slug/title/body', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    slug: 'idempotency', title: 'Idempotency', body: '# Idempotency\n...',
  })), () => runTask('draft-concept', { kbRoot: kb, input: { slug: 'idempotency', sources: ['s1'], related: ['r1'] } }));
  assert.strictEqual(res.slug, 'idempotency');
  assert.ok(res.body.length > 0);
  delete process.env.WEFT_TEST_KEY;
});

test('synthesize returns structured synthesis', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    slug: 'retry-strategy', title: 'Retry Strategy', body: '# Retry\n...', sources: ['s1'],
  })), () => runTask('synthesize', { kbRoot: kb, input: { slug: 'retry-strategy', topic: 'retry', sources: ['s1'] } }));
  assert.strictEqual(res.title, 'Retry Strategy');
  delete process.env.WEFT_TEST_KEY;
});

test('semantic-check parses conflict verdict', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const res = await withMock(mockFetchJson(JSON.stringify({
    conflict: true, severity: 'high', reasoning: 'contradicts', contradicting_pages: ['wiki/concepts/x.md'],
  })), () => runTask('semantic-check', { kbRoot: kb, input: { proposed: 'p', existing_pages: [{ path: 'wiki/concepts/x.md', body: 'b' }] } }));
  assert.strictEqual(res.conflict, true);
  assert.strictEqual(res.severity, 'high');
  delete process.env.WEFT_TEST_KEY;
});

test('govern-decide loads precedents by type and fails closed', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const decisionsDir = path.join(kb, '.kb', 'govern', 'decisions');
  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.writeFileSync(path.join(decisionsDir, 'd1.json'), JSON.stringify({ id: 'd1', decision_type: 'merge', decision: 'approved', ts: '2026-01-01T00:00:00Z', reason: 'r' }));
  const res = await withMock(mockFetchJson(JSON.stringify({
    decision: 'candidate', reason: 'no contradictory precedent', referenced_decisions: ['d1'],
  })), () => runTask('govern-decide', { kbRoot: kb, input: { decision_type: 'merge' } }));
  assert.strictEqual(res.decision, 'candidate');
  assert.deepStrictEqual(res.referenced_decisions, ['d1']);
  delete process.env.WEFT_TEST_KEY;
});

test('chat writes NDJSON stream (quick: light retrieval + answer)', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const out = path.join(kb, 'out.ndjson');
  await withMock(mockFetchStream(sseChunks('hello world')), () => runTask('chat', { kbRoot: kb, input: { question: 'hello', level: 'quick' }, outputPath: out }));
  const lines = slurpLines(out);
  assert.strictEqual(lines[0].type, 'meta');
  assert.ok(lines.some((l) => l.type === 'chunk' && l.text === 'h'));
  assert.strictEqual(lines.at(-1).type, 'done');
  delete process.env.WEFT_TEST_KEY;
});

test('deep-research writes NDJSON stream', async () => {
  const kb = makeKb(tmpDir());
  writeModelsConfig(kb, MODELS);
  process.env.WEFT_TEST_KEY = 'key';
  const out = path.join(kb, 'research.ndjson');
  await withMock(mockFetchStream(sseChunks('research answer')), () => runTask('deep-research', {
    kbRoot: kb,
    input: { question: 'q', opts: { maxRounds: 1, hitsPerRound: 2, readTop: 1 } },
    outputPath: out,
  }));
  const lines = slurpLines(out);
  assert.ok(lines.some((l) => l.type === 'search'));
  assert.ok(lines.some((l) => l.type === 'done'));
  delete process.env.WEFT_TEST_KEY;
});
