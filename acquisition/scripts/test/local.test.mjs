// M1 smoke test: local connector end-to-end (persist → five-tuple → incremental skip → update → log → reconcile)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, detect } from '../connectors/local.mjs';
import { ensureKbSkeleton } from '../lib/kb.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  ensureKbSkeleton(kbRoot);
  const inbox = path.join(kbRoot, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  return { kbRoot, inbox };
}

test('local connector: ingest + identity tuple + incremental skip + update + log', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, 'payment-requirements.md'), '# Payment Gateway Requirements\n\nSupports timeout retries.\n', 'utf8');
  fs.writeFileSync(path.join(inbox, 'notes.txt'), 'plain text note content', 'utf8');
  fs.writeFileSync(path.join(inbox, 'ignored.docx'), 'binary-ish', 'utf8');

  // first run
  let s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 2, JSON.stringify(s));
  assert.equal(s.unsupported.length, 1);

  // five-tuple and naming
  const rawFiles = fs.readdirSync(path.join(kbRoot, 'raw', 'local'));
  assert.equal(rawFiles.length, 2);
  const doc = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'raw', 'local', rawFiles.find(f => f.includes('payment-requirements'))), 'utf8'));
  for (const k of ['source', 'source_id', 'source_url', 'source_version', 'pulled_at', 'content_hash', 'title', 'connector']) {
    assert.ok(doc.fields[k], `missing field ${k}`);
  }
  assert.equal(doc.fields.source, 'local');
  assert.equal(doc.fields.title, 'Payment Gateway Requirements');
  assert.match(doc.fields.content_hash, /^sha256:[0-9a-f]{64}$/);

  // txt gets wrapped with a title
  const txtDoc = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'raw', 'local', rawFiles.find(f => f.includes('notes'))), 'utf8'));
  assert.match(txtDoc.body.trimStart(), /^# notes\n/);

  // second run: everything skipped (incremental)
  s = run(kbRoot, { inbox });
  assert.equal(s.unchanged.length, 2);
  assert.equal(s.created.length, 0);
  assert.equal(s.updated.length, 0);

  // modified content: same raw doc overwritten (updated), filename unchanged
  fs.writeFileSync(path.join(inbox, 'payment-requirements.md'), '# Payment Gateway Requirements\n\nSupports timeout retries and compensation.\n', 'utf8');
  s = run(kbRoot, { inbox });
  assert.equal(s.updated.length, 1);
  assert.equal(s.unchanged.length, 1);
  assert.equal(fs.readdirSync(path.join(kbRoot, 'raw', 'local')).length, 2, 'should not create a new file');

  // log: 2 create + 1 update, no unchanged entries
  const log = fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  assert.equal((log.match(/^## \[.+\] acquire \|/gm) || []).length, 3);
  assert.ok(log.includes('local:created') && log.includes('local:updated'));

  fs.rmSync(kbRoot, { recursive: true, force: true });
});

test('reconcile: rename → orphan report → --prune explicit cleanup', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, 'old-name.md'), '# Doc\n\ncontent.\n', 'utf8');
  run(kbRoot, { inbox });
  assert.equal(fs.readdirSync(path.join(kbRoot, 'raw', 'local')).length, 1);

  // rename: new file persisted (created), old path gone → old doc orphaned
  fs.renameSync(path.join(inbox, 'old-name.md'), path.join(inbox, 'new-name.md'));
  let s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 1, 'renamed file should count as a new doc');
  assert.equal(s.orphaned.length, 1, 'old doc should enter the orphan list');
  assert.equal(s.pruned.length, 0, 'no deletion by default');
  assert.equal(fs.readdirSync(path.join(kbRoot, 'raw', 'local')).length, 2);

  // only --prune deletes and logs
  s = run(kbRoot, { inbox, prune: true });
  assert.equal(s.pruned.length, 1);
  assert.equal(fs.readdirSync(path.join(kbRoot, 'raw', 'local')).length, 1);
  const log = fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  assert.ok(log.includes('local:pruned'));

  s = run(kbRoot, { inbox });
  assert.equal(s.orphaned.length, 0);

  fs.rmSync(kbRoot, { recursive: true, force: true });
});

test('detect: classifies inbox files as new/changed/unchanged and raw-only as removed_upstream', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, 'pay.md'), '# Pay\n\nv1\n', 'utf8');
  run(kbRoot, { inbox });

  // unchanged
  let d = detect(kbRoot, { inbox });
  assert.equal(d.unchanged.length, 1);
  assert.equal(d.new.length, 0);
  assert.equal(d.changed.length, 0);
  assert.equal(d.removed_upstream.length, 0);

  // changed
  fs.writeFileSync(path.join(inbox, 'pay.md'), '# Pay\n\nv2\n', 'utf8');
  d = detect(kbRoot, { inbox });
  assert.equal(d.changed.length, 1);
  assert.ok(d.changed[0].path.startsWith('raw/local/'));

  // new + removed
  fs.renameSync(path.join(inbox, 'pay.md'), path.join(inbox, 'pay-renamed.md'));
  d = detect(kbRoot, { inbox });
  assert.equal(d.new.length, 1);
  assert.equal(d.new[0].upstream_id, 'pay-renamed.md');
  assert.equal(d.removed_upstream.length, 1);
  assert.equal(d.removed_upstream[0].upstream_id, 'pay.md');

  fs.rmSync(kbRoot, { recursive: true, force: true });
});

test('CJK regression: CJK filename persists correctly (slugify keeps CJK)', () => {
  const { kbRoot, inbox } = makeKb();
  fs.writeFileSync(path.join(inbox, '支付需求.md'), '# 支付网关需求\n\n支持超时重试。\n', 'utf8');
  const s = run(kbRoot, { inbox });
  assert.equal(s.created.length, 1);
  const rawFiles = fs.readdirSync(path.join(kbRoot, 'raw', 'local'));
  assert.ok(rawFiles[0].includes('支付需求'));
  const doc = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'raw', 'local', rawFiles[0]), 'utf8'));
  assert.equal(doc.fields.title, '支付网关需求');
  fs.rmSync(kbRoot, { recursive: true, force: true });
});
