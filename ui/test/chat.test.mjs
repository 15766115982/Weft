// Phase 4: chat / deep-research streaming endpoint tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createPortal } from '../serve.mjs';

let kb, server, base, token, llmStub;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-chat-'));
  fs.mkdirSync(path.join(kb, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki'), { recursive: true });

  // Stub LLM CLI: writes fixed NDJSON based on the input payload.
  llmStub = path.join(kb, 'llm-stub.mjs');
  fs.writeFileSync(llmStub, `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input-file');
const outputIdx = args.indexOf('--output-file');
const input = inputIdx >= 0 ? JSON.parse(fs.readFileSync(args[inputIdx + 1], 'utf8')) : {};
const output = outputIdx >= 0 ? args[outputIdx + 1] : path.join(os.tmpdir(), 'out.ndjson');
fs.mkdirSync(path.dirname(output), { recursive: true });
const level = input.level || 'quick';
const lines = [
  JSON.stringify({ type: 'meta', level }),
  ...(level === 'deep' || level === 'deep-research' ? [
    JSON.stringify({ type: 'search', query: input.question, round: 1 }),
    JSON.stringify({ type: 'read', page: 'wiki/sources/x.md', round: 1 }),
  ] : []),
  JSON.stringify({ type: 'chunk', text: 'hello ' }),
  JSON.stringify({ type: 'chunk', text: 'world' }),
  JSON.stringify({ type: 'done', citations: ['wiki/sources/x.md'] }),
];
fs.writeFileSync(output, lines.join('\\n') + '\\n', 'utf8');
console.log(JSON.stringify({ task: 'chat', output }));
`, 'utf8');

  process.env.WEFT_LLM_CLI = llmStub;

  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});

after(() => {
  server.close();
  delete process.env.WEFT_LLM_CLI;
  fs.rmSync(kb, { recursive: true, force: true });
});

async function postChat(body) {
  return fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': token },
    body: JSON.stringify(body),
  });
}

async function readSse(res) {
  const lines = [];
  const text = await res.text();
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (payload) lines.push(JSON.parse(payload));
  }
  return lines;
}

const KB_NAME = 'default';

test('POST /api/chat streams NDJSON as SSE (quick)', async () => {
  const res = await postChat({ question: 'hi', level: 'quick', kb: KB_NAME });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const lines = await readSse(res);
  assert.equal(lines[0].type, 'meta');
  assert.equal(lines[0].level, 'quick');
  assert.ok(lines.some((l) => l.type === 'chunk' && l.text === 'hello '));
  assert.ok(lines.some((l) => l.type === 'chunk' && l.text === 'world'));
  assert.ok(lines.some((l) => l.type === 'done'));
});

test('POST /api/chat streams search/read steps for deep-research', async () => {
  const res = await postChat({ question: 'deep', level: 'deep-research', kb: KB_NAME });
  assert.equal(res.status, 200);
  const lines = await readSse(res);
  assert.equal(lines[0].level, 'deep-research');
  assert.ok(lines.some((l) => l.type === 'search'));
  assert.ok(lines.some((l) => l.type === 'read'));
  assert.ok(lines.some((l) => l.type === 'done'));
});

test('POST /api/chat validates missing question and bad level', async () => {
  const empty = await postChat({ question: '', level: 'quick', kb: KB_NAME });
  assert.equal(empty.status, 400);
  const bad = await postChat({ question: 'x', level: 'magic', kb: KB_NAME });
  assert.equal(bad.status, 200); // falls back to quick
  const lines = await readSse(bad);
  assert.equal(lines[0].level, 'quick');
});

test('POST /api/chat refuses no-token and forged Origin', async () => {
  const noToken = await fetch(base + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x' }),
  });
  assert.equal(noToken.status, 403);
  const badOrigin = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': token, origin: 'http://evil.example' },
    body: JSON.stringify({ question: 'x' }),
  });
  assert.equal(badOrigin.status, 403);
});

// Exercise the SSE parser path with a slow reader (one byte at a time) to ensure
// the parser handles split lines and newline boundaries correctly.
test('POST /api/chat SSE parsing handles split data lines', async () => {
  const res = await postChat({ question: 'split', level: 'quick', kb: KB_NAME });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  const events = [];
  for (const block of raw.split('\n\n')) {
    const data = block.split('\n').find((l) => l.startsWith('data:'));
    if (data) events.push(JSON.parse(data.slice(5).trim()));
  }
  assert.ok(events.some((e) => e.type === 'chunk' && e.text === 'world'));
});
