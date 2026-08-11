// ADR-0013: POST /api/distill-chat — one-click chat distillation end-to-end
// through the portal job queue: agent stub → portal pre-check → staging →
// the REAL acquisition chat connector → raw/chat/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';

let kb, server, base, token;

const MESSAGES = [
  { role: 'user', text: '重试策略是什么?', ts: '2026-08-11T10:00:00+08:00' },
  { role: 'assistant', text: '指数退避,上限 3 次。', ts: '2026-08-11T10:00:05+08:00' },
];

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-distill-'));
  fs.mkdirSync(path.join(kb, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki'), { recursive: true });

  // Agent stub: handles distill-chat; DISTILL_STUB_BAD=1 makes it emit an
  // unresolvable reference so the portal pre-check must fail closed.
  const stub = path.join(kb, 'agent-stub.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';
const args = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input-file') + 1], 'utf8'));
const output = args[args.indexOf('--output-file') + 1];
const msgs = input.messages || [];
const refs = process.env.DISTILL_STUB_BAD === '1' ? '[T99]' : '[T1]';
const appendix = msgs.map((m, i) =>
  '### [T' + (i + 1) + '] ' + m.role + ' · ' + (m.ts || 'unknown-time') + '\\n\\n' + m.text
).join('\\n\\n');
const body = '# Stub 对话整理\\n\\nStub distilled point ' + refs + '.\\n\\n'
  + '## 附录:对话转录\\n<!-- transcript-appendix -->\\n\\n' + appendix + '\\n';
fs.writeFileSync(output, JSON.stringify({ task: 'distill-chat', title: 'Stub 对话整理', body, message_count: msgs.length }));
console.log(JSON.stringify({ task: 'distill-chat', output }));
`, 'utf8');
  process.env.WEFT_AGENT_STUB = stub;

  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});

after(() => {
  server.close();
  delete process.env.WEFT_AGENT_STUB;
  delete process.env.DISTILL_STUB_BAD;
  fs.rmSync(kb, { recursive: true, force: true });
});

function postDistill(messages, withToken = true) {
  return fetch(base + '/api/distill-chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withToken ? { 'x-ui-token': token } : {}) },
    body: JSON.stringify({ messages, kb: 'default' }),
  });
}

async function waitJob(id) {
  for (;;) {
    const { jobs } = await (await fetch(`${base}/api/jobs?kb=default`)).json();
    const j = jobs.find((x) => x.id === id);
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('distill-chat: full chain lands raw/chat/conv-*.md and cleans staging', async () => {
  const res = await postDistill(MESSAGES);
  assert.equal(res.status, 202);
  const { job } = await res.json();
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(done.result.action, 'created');
  assert.match(done.result.path, /^raw\/chat\/conv-[0-9a-f]{8}\.md$/);
  assert.equal(done.result.title, 'Stub 对话整理');

  const abs = path.join(kb, done.result.path);
  const text = fs.readFileSync(abs, 'utf8');
  assert.match(text, /source: chat\n/);
  assert.match(text, /source_url: "weft:\/\/chat\/conv-[0-9a-f]{8}"\n/);
  assert.match(text, /source_version: "2026-08-11T10:00:05\+08:00"|source_version: 2026-08-11T10:00:05\+08:00\n/);
  assert.ok(text.includes('<!-- transcript-appendix -->'));
  assert.ok(text.includes('### [T2] assistant · 2026-08-11T10:00:05+08:00'));

  // staging consumed; audit line written
  const staged = path.join(kb, 'inbox-chat');
  assert.ok(!fs.existsSync(staged) || fs.readdirSync(staged).length === 0);
  assert.match(fs.readFileSync(path.join(kb, 'log.md'), 'utf8'), /acquire \| chat:created/);
});

test('distill-chat: identical re-distillation reports unchanged (idempotent)', async () => {
  const res = await postDistill(MESSAGES);
  const { job } = await res.json();
  const done = await waitJob(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.action, 'unchanged');
});

test('distill-chat: portal pre-check fails closed on unresolvable refs, no half-product', async () => {
  process.env.DISTILL_STUB_BAD = '1';
  try {
    const res = await postDistill(MESSAGES);
    const { job } = await res.json();
    const done = await waitJob(job.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /\[T99\]/);
  } finally {
    delete process.env.DISTILL_STUB_BAD;
  }
  const rawChat = path.join(kb, 'raw', 'chat');
  assert.equal(fs.readdirSync(rawChat).length, 1); // only the first test's doc
  const staged = path.join(kb, 'inbox-chat');
  assert.ok(!fs.existsSync(staged) || fs.readdirSync(staged).length === 0);
});

test('distill-chat: input validation and auth', async () => {
  const empty = await postDistill([]);
  assert.equal(empty.status, 400);
  const noToken = await postDistill(MESSAGES, false);
  assert.equal(noToken.status, 403);
  const huge = await postDistill([{ role: 'user', text: 'x'.repeat(30001) }]);
  assert.equal(huge.status, 400);
  assert.match((await huge.json()).error, /对话过长/);
});
