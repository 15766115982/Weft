// Cross-service e2e for ADR-0013: the chat distillation chain driven through
// the REAL CLIs — agent distill-chat (stub mode) → staged in inbox-chat/ →
// acquire chat → govern plan/apply-source → rebuild-index → retrieval finds
// the approved source page. (The portal's pre-check and endpoint are covered
// by ui/test/distill.test.mjs; this file proves the services compose.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SCRIPTS, runCli, makeScratchKb, govern, runLlm } from '../helpers/kb.mjs';

let kb;
before(() => { kb = makeScratchKb('kb-chat-distill-'); });
after(() => fs.rmSync(kb, { recursive: true, force: true }));

const MESSAGES = [
  { role: 'user', text: '重试策略是什么?', ts: '2026-08-11T10:00:00+08:00' },
  { role: 'assistant', text: '指数退避,上限五次。', ts: '2026-08-11T10:00:05+08:00' },
];

test('agent distill-chat (stub) emits a valid chat distillation document', () => {
  // PYTHONIOENCODING: python's stdout follows the Windows locale codec (GBK)
  // and would corrupt the CJK JSON the body carries (the P1-C5 bug class).
  const out = runLlm(kb, 'distill-chat', { messages: MESSAGES }, null,
    { WEFT_LLM_STUB: '1', PYTHONIOENCODING: 'utf-8' });
  assert.equal(out.task, 'distill-chat');
  assert.equal(out.message_count, 2);
  assert.ok(out.body.includes('<!-- transcript-appendix -->'));
  assert.ok(out.body.includes('### [T2] assistant · 2026-08-11T10:00:05+08:00'));

  // stage exactly like the portal does after its pre-check
  const inbox = path.join(kb, 'inbox-chat');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'conv-stub.md'), out.body, 'utf8');
});

test('acquire chat lands the staged doc in raw/chat/ with chat identity', () => {
  const s = runCli(SCRIPTS.acquire, ['chat', '--kb', kb]);
  assert.equal(s.errors.length, 0, JSON.stringify(s.errors));
  assert.equal(s.created.length, 1);
  const rel = s.created[0];
  assert.match(rel, /^raw\/chat\/conv-[0-9a-f]{8}\.md$/);
  const fm = fs.readFileSync(path.join(kb, rel), 'utf8').split('---')[1];
  for (const re of [/source: chat/, /source_id: conv-[0-9a-f]{8}/, /source_url: "?weft:\/\/chat\//,
    /source_version: "?2026-08-11T10:00:05/, /content_hash: "?sha256:/, /connector: "?chat@1\.0\.0"?/]) {
    assert.match(fm, re, `chat frontmatter missing ${re}`);
  }
});

test('governance treats the chat doc like any raw: plan → apply-source → index', () => {
  const rel = fs.readdirSync(path.join(kb, 'raw', 'chat')).map((f) => `raw/chat/${f}`)[0];
  const p = govern(kb, ['plan']);
  const item = p.pending.find((i) => i.raw === rel);
  assert.ok(item, `plan must pend the chat raw: ${JSON.stringify(p.pending)}`);

  govern(kb, ['apply-source', '--raw', rel, '--tags', 'retry,chat'],
    '## Key Points\n\n- Stub summary: retry backoff distilled from a chat.\n');
  assert.deepEqual(govern(kb, ['plan']).pending, []);
  govern(kb, ['rebuild-index']);
  const index = fs.readFileSync(path.join(kb, 'wiki', 'index.md'), 'utf8');
  assert.ok(index.includes('chat-conv-'), 'index.md lists the chat source page');
});

test('retrieval finds the approved chat source page', () => {
  const s = runCli(SCRIPTS.search, ['search', 'retry backoff distilled', '--kb', kb]);
  assert.ok(s.preview.some((c) => c.page.startsWith('wiki/sources/chat-conv-')),
    JSON.stringify(s.preview));
});
