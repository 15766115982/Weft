// M4 topic page generation tests (contract §3.3): applyTopicPage mechanics —
// slug whitelist, fail-closed provenance, union-merge update semantics, candidate flag,
// candidate protection (M1/M2 review-fix round).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyTopicPage, sweep } from '../lib/govern.mjs';
import { flipStatus } from '../lib/statusflip.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-topic-'));
  fs.mkdirSync(path.join(kbRoot, 'raw', 'local'), { recursive: true });
  const writeRaw = (name, title) => {
    const fm = buildFrontmatter({
      source: 'local', source_id: name, source_url: `file:///inbox/${name}.md`,
      source_version: '2026-07-01T00:00:00Z', pulled_at: '2026-07-01T00:00:00Z',
      content_hash: `sha256:${name}`, title, connector: 'local@1.0.0',
    });
    fs.writeFileSync(path.join(kbRoot, 'raw', 'local', `${name}.md`), fm + '\nBody text.\n', 'utf8');
    return `raw/local/${name}.md`;
  };
  const readPage = (slug) => parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'topics', `${slug}.md`), 'utf8'));
  const log = () => fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  const cleanup = () => fs.rmSync(kbRoot, { recursive: true, force: true });
  return { kbRoot, writeRaw, readPage, log, cleanup };
}

test('create: approved topic page with mechanical frontmatter + log line', () => {
  const { kbRoot, writeRaw, readPage, log, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  const b = writeRaw('bbbb2222-timeout', 'Session Timeout Policy');
  const out = applyTopicPage(kbRoot, {
    slug: 'payment-timeout', title: 'Payment Timeout Handling',
    sources: [b, a], aliases: ['payment retry'], tags: ['payment', 'resilience'],
  }, 'Payment timeout handling across the gateway and session layers.');
  assert.equal(out.action, 'auto:create-topic');
  assert.equal(out.page, 'wiki/topics/payment-timeout.md');
  assert.equal(out.status, 'approved');
  const { fields, body } = readPage('payment-timeout');
  assert.equal(fields.type, 'topic');
  assert.equal(fields.status, 'approved');
  assert.deepEqual(fields.sources, [a, b].sort(), 'sources stored sorted');
  assert.deepEqual(fields.aliases, ['payment retry']);
  assert.deepEqual(fields.tags, ['payment', 'resilience']);
  assert.equal(fields.created_at, fields.updated_at);
  assert.ok(body.includes('Payment timeout handling across'));
  assert.match(log(), /govern \| auto:create-topic \| wiki\/topics\/payment-timeout\.md \| sources:2/);
  cleanup();
});

test('slug whitelist: traversal, uppercase, spaces, CJK all refused, no file created', () => {
  const { kbRoot, writeRaw, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  for (const bad of ['../evil', 'UPPER', 'has space', '中文slug', 'under_score', '-lead']) {
    assert.throws(
      () => applyTopicPage(kbRoot, { slug: bad, title: 'T', sources: [a] }, 'body'),
      /slug must be lowercase kebab-case/, `should refuse: ${bad}`);
  }
  assert.ok(!fs.existsSync(path.join(kbRoot, 'wiki', 'topics')), 'no topic page may be created');
  cleanup();
});

test('fail-closed validation: empty body, missing title, missing/traversal sources', () => {
  const { kbRoot, writeRaw, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  assert.throws(() => applyTopicPage(kbRoot, { slug: 'x-topic', title: 'T', sources: [a] }, '   '),
    /empty synthesis body, refusing to write/);
  assert.throws(() => applyTopicPage(kbRoot, { slug: 'x-topic', sources: [a] }, 'body'),
    /apply-topic requires --title/);
  assert.throws(() => applyTopicPage(kbRoot, { slug: 'x-topic', title: 'T', sources: ['raw/local/ghost.md'] }, 'body'),
    /topic source does not exist: raw\/local\/ghost\.md/);
  assert.throws(() => applyTopicPage(kbRoot, { slug: 'x-topic', title: 'T', sources: ['raw/../escape.md'] }, 'body'),
    /must be a relative path under raw\//);
  assert.throws(() => applyTopicPage(kbRoot, { slug: 'x-topic', title: 'T' }, 'body'),
    /apply-topic requires --sources/);
  cleanup();
});

test('re-apply is an update: sources union-merged, created_at kept, omitted fields kept', () => {
  const { kbRoot, writeRaw, readPage, log, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  const b = writeRaw('bbbb2222-timeout', 'Session Timeout Policy');
  const c = writeRaw('cccc3333-retry', 'Retry Budget Design');
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [b, a], tags: ['payment'] },
    'version one body');
  const first = readPage('payment-timeout').fields;
  const out = applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout v2', sources: [c, a] },
    'version two body');
  assert.equal(out.action, 'auto:update-topic');
  const second = readPage('payment-timeout').fields;
  assert.deepEqual(second.sources, [a, b, c].sort(), 'provenance union-merged, never dropped');
  assert.equal(second.created_at, first.created_at, 'created_at preserved');
  assert.deepEqual(second.tags, ['payment'], 'tags omitted = kept');
  assert.equal(second.title, 'Payment Timeout v2');
  assert.match(log(), /govern \| auto:update-topic \| wiki\/topics\/payment-timeout\.md \| sources:3/);
  cleanup();
});

test('--candidate: status candidate, candidate:topic log, note recorded', () => {
  const { kbRoot, writeRaw, readPage, log, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  const out = applyTopicPage(kbRoot, {
    slug: 'payment-timeout', title: 'Conflicting Synthesis', sources: [a],
    candidate: true, note: 'conflicts with sources/local-aaaa1111-pay.md on retry budget',
  }, 'A synthesis that contradicts an approved page.');
  assert.equal(out.action, 'candidate:topic');
  assert.equal(out.status, 'candidate');
  assert.equal(readPage('payment-timeout').fields.status, 'candidate');
  assert.match(log(), /govern \| candidate:topic \| wiki\/topics\/payment-timeout\.md \| sources:1 conflicts with sources\/local-aaaa1111-pay\.md/);
  cleanup();
});

test('M1 regression: re-applying a still-candidate page keeps it candidate', () => {
  const { kbRoot, writeRaw, readPage, log, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Draft', sources: [a], candidate: true, note: 'conflict' }, 'draft body');
  // caller forgets --candidate on the re-apply: approval must NOT happen as a side effect
  const out = applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Draft v2', sources: [a] }, 'revised body');
  assert.equal(out.status, 'candidate');
  assert.equal(out.action, 'candidate:topic');
  const { fields, body } = readPage('payment-timeout');
  assert.equal(fields.status, 'candidate');
  assert.equal(fields.review_note, 'conflict', 'old review note kept when no new note given');
  assert.ok(body.includes('revised body'));
  assert.match(log(), /candidate:topic \| wiki\/topics\/payment-timeout\.md \| sources:1 kept candidate \(pending review\)/);
  cleanup();
});

test('review_note: recorded while candidate, dropped when written as approved', () => {
  const { kbRoot, writeRaw, readPage, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  applyTopicPage(kbRoot, { slug: 'retry-budget', title: 'Draft', sources: [a], candidate: true, note: 'conflicts with X' }, 'body');
  assert.equal(readPage('retry-budget').fields.review_note, 'conflicts with X');
  // session review approves (logged), then a normal update proceeds as approved
  flipStatus(path.join(kbRoot, 'wiki', 'topics', 'retry-budget.md'), 'candidate', 'approved');
  fs.appendFileSync(path.join(kbRoot, 'log.md'),
    '## [2026-07-31T00:00:00.000Z] review | approve | wiki/topics/retry-budget.md | via session\n', 'utf8');
  applyTopicPage(kbRoot, { slug: 'retry-budget', title: 'Final', sources: [a] }, 'final body');
  assert.equal(readPage('retry-budget').fields.status, 'approved');
  assert.equal(readPage('retry-budget').fields.review_note, undefined, 'note dropped on approved write');
  cleanup();
});

test('M2 regression: unlogged viewer flip refuses overwrite until sweep solidifies it', () => {
  const { kbRoot, writeRaw, readPage, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Draft', sources: [a], candidate: true }, 'draft');
  flipStatus(path.join(kbRoot, 'wiki', 'topics', 'payment-timeout.md'), 'candidate', 'approved'); // viewer: no log
  assert.throws(
    () => applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Sneaky', sources: [a] }, 'overwrite'),
    /unlogged review flip pending on this page; run sweep first/);
  assert.equal(readPage('payment-timeout').fields.title, 'Draft', 'page untouched by the refused write');
  const r = sweep(kbRoot);   // solidifies the backfilled review line
  assert.deepEqual(r.backfilled, [{ page: 'wiki/topics/payment-timeout.md', status: 'approved' }]);
  const out = applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Now OK', sources: [a] }, 'body');
  assert.equal(out.action, 'auto:update-topic');
  cleanup();
});

test('N1 regression: hand-mangled "status:candidate" (no space) cannot pierce the guards', () => {
  const { kbRoot, writeRaw, readPage, cleanup } = makeKb();
  const a = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements');
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Draft', sources: [a], candidate: true }, 'draft');
  const abs = path.join(kbRoot, 'wiki', 'topics', 'payment-timeout.md');
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('status: candidate', 'status:candidate'), 'utf8');
  // the strict parser reads no status here — the guards must still hold
  const out = applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Sneaky', sources: [a] }, 'overwrite');
  assert.equal(out.status, 'candidate', 're-apply must NOT approve a mangled candidate');
  assert.equal(out.action, 'candidate:topic');
  const { fields } = readPage('payment-timeout');
  assert.equal(fields.status, 'candidate');
  const raw = fs.readFileSync(abs, 'utf8');
  assert.ok(raw.includes('status: candidate\n'), 'rewrite also heals the mangled format');
  cleanup();
});
