// Chat connector tests (ADR-0013): ingest → identity rules → fail-closed
// validation → idempotent re-distillation → incremental skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, parseDistillationDoc, CONNECTOR_ID } from '../connectors/chat.mjs';
import { ensureKbSkeleton } from '../lib/kb.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-chat-test-'));
  ensureKbSkeleton(kbRoot);
  const inbox = path.join(kbRoot, 'inbox-chat');
  fs.mkdirSync(inbox, { recursive: true });
  return { kbRoot, inbox };
}

function doc({ title = '对话整理:重试策略', body = '要点:指数退避 [T1]。\n\n细节:见回答 [T2]。', extraEntry = '' } = {}) {
  return `# ${title}\n\n${body}\n\n## 附录:对话转录\n<!-- transcript-appendix -->\n\n` +
    `### [T1] user · 2026-08-11T10:00:00+08:00\n\n重试策略是什么?\n\n` +
    `### [T2] assistant · 2026-08-11T10:00:05+08:00\n\n指数退避,见 [[retry-policy]]。${extraEntry}\n`;
}

test('chat connector: ingest + identity quintuple + chat-specific rules', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, 'conv-x.md'), doc(), 'utf8');

  const s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 1, JSON.stringify(s));
  assert.equal(s.errors.length, 0);

  const rel = s.created[0];
  assert.match(rel, /^raw\/chat\/conv-[0-9a-f]{8}\.md$/); // pure-identity filename, no title slug
  const parsed = parseFrontmatter(fs.readFileSync(path.join(kbRoot, rel), 'utf8'));
  const f = parsed.fields;
  assert.equal(f.source, 'chat');
  assert.match(f.source_id, /^conv-[0-9a-f]{8}$/);
  assert.equal(f.source_url, `weft://chat/${f.source_id}`);
  assert.equal(f.source_version, '2026-08-11T10:00:05+08:00'); // last message time
  assert.equal(f.connector, CONNECTOR_ID);
  assert.equal(f.title, '对话整理:重试策略');
  assert.equal(f.extra.message_count, '2'); // extra scalars round-trip as strings (frontmatter lib subset)
  assert.match(f.content_hash, /^sha256:[0-9a-f]{64}$/);
});

test('chat connector: fail-closed validation rejects malformed docs', () => {
  const { kbRoot, inbox } = makeKb();
  const cases = {
    'no-marker.md': '# T\n\n要点 [T1]。\n',
    'no-title.md': '要点 [T1]。\n\n<!-- transcript-appendix -->\n\n### [T1] user · 2026-08-11T10:00:00+08:00\n\nhi\n',
    'no-refs.md': doc({ body: '要点:没有引用标记。' }),
    'bad-ref.md': doc({ body: '要点 [T1] [T99]。' }),
    'broken-numbering.md': doc().replace('### [T2]', '### [T3]'),
    'frontmatter.md': '---\ntitle: x\n---\n' + doc(),
  };
  for (const [name, text] of Object.entries(cases)) {
    fs.writeFileSync(path.join(inbox, name), text, 'utf8');
  }
  const s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 0, JSON.stringify(s));
  assert.equal(s.errors.length, 6, JSON.stringify(s.errors, null, 2));
  assert.ok(!fs.existsSync(path.join(kbRoot, 'raw', 'chat')) || fs.readdirSync(path.join(kbRoot, 'raw', 'chat')).length === 0);
});

test('chat connector: same conversation re-distilled overwrites; identical content skips', () => {
  const { kbRoot, inbox } = makeKb();
  const staged = path.join(inbox, 'conv-x.md');

  fs.writeFileSync(staged, doc(), 'utf8');
  let s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 1);
  const rel = s.created[0];

  // identical staged file → incremental skip
  s = run(kbRoot, { inbox });
  assert.equal(s.unchanged.length, 1);
  assert.deepEqual(s.unchanged[0], rel);

  // same transcript, new distillation (different body, different title) →
  // same source_id, same filename, action = updated (never a second file)
  fs.writeFileSync(staged, doc({ title: '另一个标题', body: '完全不同的蒸馏 [T2]。' }), 'utf8');
  s = run(kbRoot, { inbox });
  assert.equal(s.updated.length, 1, JSON.stringify(s));
  assert.deepEqual(s.updated[0], rel);
  assert.equal(fs.readdirSync(path.join(kbRoot, 'raw', 'chat')).length, 1);
});

test('chat connector: unusable last timestamp falls back to staged mtime; missing inbox is a no-op', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, 'conv-y.md'), doc().replace('2026-08-11T10:00:05+08:00', 'unknown-time'), 'utf8');
  const s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 1, JSON.stringify(s));
  const f = parseFrontmatter(fs.readFileSync(path.join(kbRoot, s.created[0]), 'utf8')).fields;
  assert.ok(!Number.isNaN(Date.parse(f.source_version)), `source_version must stay ISO, got ${f.source_version}`);

  const empty = run(kbRoot, { inbox: path.join(kbRoot, 'absent-inbox') });
  assert.equal(empty.total, 0);
  assert.equal(empty.errors.length, 0);
});

test('parseDistillationDoc: CRLF normalized before hashing', () => {
  const lf = parseDistillationDoc(doc());
  const crlf = parseDistillationDoc(doc().replace(/\n/g, '\r\n'));
  assert.equal(lf.transcriptHash, crlf.transcriptHash);
});
