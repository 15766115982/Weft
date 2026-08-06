// M4 candidate state machine tests (contract §4): review_queue, approve/reject,
// archive adjudication, sweep (backfill + rejected archive), idempotency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { plan, applyTopicPage, approvePage, rejectPage, archivePage, sweep, mergeTopics } from '../lib/govern.mjs';
import { flipStatus, readStatus } from '../lib/statusflip.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-'));
  fs.mkdirSync(path.join(kbRoot, 'raw', 'local'), { recursive: true });
  const fm = buildFrontmatter({
    source: 'local', source_id: 'aaaa1111-pay', source_url: 'file:///inbox/pay.md',
    source_version: '2026-07-01T00:00:00Z', pulled_at: '2026-07-01T00:00:00Z',
    content_hash: 'sha256:x', title: 'Payment Gateway Requirements', connector: 'local@1.0.0',
  });
  fs.writeFileSync(path.join(kbRoot, 'raw', 'local', 'aaaa1111-pay.md'), fm + '\nBody.\n', 'utf8');
  const RAW = 'raw/local/aaaa1111-pay.md';
  const pageAbs = (slug) => path.join(kbRoot, 'wiki', 'syntheses', `${slug}.md`);
  const writePage = (rel, fields, body) => {
    const abs = path.join(kbRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
  };
  const log = () => fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  const cleanup = () => fs.rmSync(kbRoot, { recursive: true, force: true });
  return { kbRoot, RAW, pageAbs, writePage, log, cleanup };
}

test('plan review_queue lists candidate pages only, with type/title/updated_at', () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [RAW], candidate: true }, 'body');
  applyTopicPage(kbRoot, { slug: 'ok-page', title: 'Approved Page', sources: [RAW] }, 'body');
  writePage('wiki/index.md', {}, '# Wiki Index\n');
  const q = plan(kbRoot).review_queue;
  assert.equal(q.length, 1);
  assert.equal(q[0].page, 'wiki/syntheses/cand-one.md');
  assert.equal(q[0].type, 'synthesis');
  assert.equal(q[0].title, 'Candidate One');
  assert.ok(q[0].updated_at);
  cleanup();
});

test('approve: candidate → approved + review log; wrong status/path fail loudly', () => {
  const { kbRoot, RAW, pageAbs, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [RAW], candidate: true }, 'body');
  const out = approvePage(kbRoot, 'wiki/syntheses/cand-one.md');
  assert.equal(out.status, 'approved');
  assert.equal(readStatus(pageAbs('cand-one')), 'approved');
  assert.match(log(), /review \| approve \| wiki\/syntheses\/cand-one\.md \| via session/);
  assert.throws(() => approvePage(kbRoot, 'wiki/syntheses/cand-one.md'),
    /page status is "approved", expected "candidate"/);
  assert.throws(() => approvePage(kbRoot, 'wiki/index.md'), /page path must be wiki\/sources\|entities\|concepts\|syntheses/);
  assert.throws(() => approvePage(kbRoot, 'wiki/archive/old.md'), /page path must be wiki\/sources\|entities\|concepts\|syntheses/);
  assert.throws(() => approvePage(kbRoot, 'wiki/syntheses/ghost.md'), /page does not exist/);
  cleanup();
});

test('reject → sweep: page archived as status archived; second sweep is a no-op', () => {
  const { kbRoot, RAW, pageAbs, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [RAW], candidate: true }, 'body');
  rejectPage(kbRoot, 'wiki/syntheses/cand-one.md');
  assert.equal(readStatus(pageAbs('cand-one')), 'rejected');
  assert.match(log(), /review \| reject \| wiki\/syntheses\/cand-one\.md \| via session/);

  const r1 = sweep(kbRoot);
  assert.equal(r1.archived.length, 1);
  assert.equal(r1.archived[0].page, 'wiki/archive/cand-one.md');
  assert.ok(!fs.existsSync(pageAbs('cand-one')), 'original location vacated');
  const archived = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'archive', 'cand-one.md'), 'utf8'));
  assert.equal(archived.fields.status, 'archived');
  assert.match(log(), /govern \| auto:archive-rejected \| wiki\/archive\/cand-one\.md \| from wiki\/syntheses\/cand-one\.md/);

  const before = log();
  const r2 = sweep(kbRoot);
  assert.deepEqual(r2, { backfilled: [], archived: [] });
  assert.equal(log(), before, 'idempotent: zero new log lines on second sweep');
  cleanup();
});

test('archive name collision: second archival of same basename lands at -2', () => {
  const { kbRoot, RAW, pageAbs, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'dup', title: 'V1', sources: [RAW], candidate: true }, 'v1');
  rejectPage(kbRoot, 'wiki/syntheses/dup.md');
  sweep(kbRoot);
  applyTopicPage(kbRoot, { slug: 'dup', title: 'V2', sources: [RAW], candidate: true }, 'v2');
  rejectPage(kbRoot, 'wiki/syntheses/dup.md');
  const r = sweep(kbRoot);
  assert.equal(r.archived[0].page, 'wiki/archive/dup-2.md');
  assert.ok(fs.existsSync(path.join(kbRoot, 'wiki', 'archive', 'dup.md')));
  assert.ok(fs.existsSync(path.join(kbRoot, 'wiki', 'archive', 'dup-2.md')));
  assert.ok(!fs.existsSync(pageAbs('dup')));
  cleanup();
});

test('backfill: viewer-style flip without log is recorded exactly once by sweep', () => {
  const { kbRoot, RAW, pageAbs, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [RAW], candidate: true }, 'body');
  flipStatus(pageAbs('cand-one'), 'candidate', 'approved');   // viewer writes no log
  const r = sweep(kbRoot);
  assert.deepEqual(r.backfilled, [{ page: 'wiki/syntheses/cand-one.md', status: 'approved' }]);
  assert.match(log(), /review \| approve \| wiki\/syntheses\/cand-one\.md \| via viewer \(backfilled\)/);
  const r2 = sweep(kbRoot);
  assert.deepEqual(r2.backfilled, [], 'backfill is not duplicated');
  assert.equal(log().match(/via viewer \(backfilled\)/g).length, 1);
  cleanup();
});

test('archivePage: approved page archived with note; candidate refused', () => {
  const { kbRoot, RAW, pageAbs, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'ok-page', title: 'Approved Page', sources: [RAW] }, 'body');
  const out = archivePage(kbRoot, 'wiki/syntheses/ok-page.md', { note: 'superseded by payment-timeout' });
  assert.equal(out.page, 'wiki/archive/ok-page.md');
  assert.equal(out.from, 'wiki/syntheses/ok-page.md');
  assert.ok(!fs.existsSync(pageAbs('ok-page')));
  const archived = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'archive', 'ok-page.md'), 'utf8'));
  assert.equal(archived.fields.status, 'archived');
  assert.match(log(), /govern \| archive \| wiki\/archive\/ok-page\.md \| from wiki\/syntheses\/ok-page\.md \| superseded by payment-timeout/);

  applyTopicPage(kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [RAW], candidate: true }, 'body');
  assert.throws(() => archivePage(kbRoot, 'wiki/syntheses/cand-one.md'),
    /only approved pages can be archived \(candidates should be rejected\)/);
  cleanup();
});

test('merge: backlinks rewritten (forms + anchor + display preserved), sources unioned, loser archived', () => {
  const { kbRoot, RAW, writePage, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'payment-retry', title: 'Payment Retry (old)', sources: [RAW] }, 'old body');
  writePage('wiki/syntheses/payment-timeout.md', { type: 'synthesis', status: 'approved', title: 'Payment Timeout' }, 'surviving body');
  writePage('wiki/sources/local-aaaa1111-pay.md', {
    type: 'source', status: 'approved', title: 'Pay', source_ref: RAW,
  }, 'See [[payment-retry]] and [[syntheses/payment-retry#budget|the budget section]].');
  const out = mergeTopics(kbRoot, 'payment-retry', 'payment-timeout', { note: 'dedup' });
  assert.equal(out.action, 'merge');
  assert.equal(out.archived, 'wiki/archive/payment-retry.md');
  assert.deepEqual(out.rewritten, ['wiki/sources/local-aaaa1111-pay.md']);
  const linking = fs.readFileSync(path.join(kbRoot, 'wiki', 'sources', 'local-aaaa1111-pay.md'), 'utf8');
  assert.ok(linking.includes('[[payment-timeout]]'), 'bare form preserved');
  assert.ok(linking.includes('[[syntheses/payment-timeout#budget|the budget section]]'), 'prefixed form + anchor + display preserved');
  const survivor = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'syntheses', 'payment-timeout.md'), 'utf8'));
  assert.deepEqual(survivor.fields.sources, [RAW], 'provenance unioned');
  assert.equal(survivor.body.trim(), 'surviving body', 'survivor body untouched (merge is Claude work)');
  const loser = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'archive', 'payment-retry.md'), 'utf8'));
  assert.equal(loser.fields.status, 'archived');
  assert.match(log(), /govern \| merge \| wiki\/syntheses\/payment-timeout\.md \| from wiki\/syntheses\/payment-retry\.md \(archived, 1 backlink files\) \| dedup/);
  assert.equal(plan(kbRoot).dangling_links.length, 0, 'merge leaves no dangling links');
  cleanup();
});

test('merge validation: bad slug, same slug, missing page', () => {
  const { kbRoot, RAW, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'T', sources: [RAW] }, 'body');
  assert.throws(() => mergeTopics(kbRoot, '../evil', 'payment-timeout'), /slug must be lowercase kebab-case/);
  assert.throws(() => mergeTopics(kbRoot, 'payment-timeout', 'payment-timeout'), /merge requires two distinct slugs/);
  assert.throws(() => mergeTopics(kbRoot, 'ghost', 'payment-timeout'), /page does not exist: wiki\/syntheses\/ghost\.md/);
  cleanup();
});

test('M5 regression: plan reports topic provenance dangling after raw deletion', () => {
  const { kbRoot, RAW, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [RAW] }, 'body');
  assert.equal(plan(kbRoot).orphaned_pages.length, 0);
  fs.unlinkSync(path.join(kbRoot, 'raw', 'local', 'aaaa1111-pay.md'));   // acquire --prune did this
  const orphans = plan(kbRoot).orphaned_pages;
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].page, 'wiki/syntheses/payment-timeout.md');
  assert.equal(orphans[0].missing_raw, RAW);
  cleanup();
});

test('dangling_links: hand-made dead links reported, valid links not', () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  writePage('wiki/sources/local-aaaa1111-pay.md', { type: 'source', status: 'approved', title: 'Pay', source_ref: RAW }, 'body');
  applyTopicPage(kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [RAW] },
    'See [[payment-retry|retry page]] and [[sources/local-aaaa1111-pay]].');
  writePage('wiki/syntheses/broken.md', { type: 'synthesis', status: 'approved', title: 'Broken', sources: [RAW] },
    'Links to [[ghost-topic]] and [[topics/also-ghost#sec|display]].');
  const d = plan(kbRoot).dangling_links;
  assert.deepEqual(d, [
    { page: 'wiki/syntheses/broken.md', link: 'ghost-topic' },
    { page: 'wiki/syntheses/broken.md', link: 'topics/also-ghost' },
    { page: 'wiki/syntheses/payment-timeout.md', link: 'payment-retry' },
  ]);
  cleanup();
});

test('L4 regression: page with malformed status (no space) surfaces in errors, not silently dropped', () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'ok-page', title: 'OK', sources: [RAW] }, 'body');
  const abs = path.join(kbRoot, 'wiki', 'syntheses', 'ok-page.md');
  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('status: approved', 'status:candidate'), 'utf8');
  const p = plan(kbRoot);
  assert.equal(p.review_queue.length, 0, 'parser cannot read the malformed status');
  assert.ok(p.errors.some((e) => e.page === 'wiki/syntheses/ok-page.md' && /missing status field/.test(e.error)),
    'but the page must be VISIBLE in errors');
  cleanup();
});

test("M1' regression: merge target with an unlogged viewer flip refuses until sweep", () => {
  const { kbRoot, RAW, log, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'a-page', title: 'A', sources: [RAW] }, 'a');
  applyTopicPage(kbRoot, { slug: 'b-page', title: 'B', sources: [RAW], candidate: true }, 'b');
  flipStatus(path.join(kbRoot, 'wiki', 'syntheses', 'b-page.md'), 'candidate', 'approved'); // viewer: no log
  assert.throws(() => mergeTopics(kbRoot, 'a-page', 'b-page'),
    /unlogged review flip pending on this page; run sweep first: wiki\/syntheses\/b-page\.md/);
  sweep(kbRoot);
  const out = mergeTopics(kbRoot, 'a-page', 'b-page');
  assert.equal(out.action, 'merge');
  assert.match(log(), /review \| approve \| wiki\/syntheses\/b-page\.md \| via viewer \(backfilled\)/);
  cleanup();
});

test("M1' regression: merge source with an unlogged viewer flip refuses until sweep", () => {
  const { kbRoot, RAW, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'c-page', title: 'C', sources: [RAW], candidate: true }, 'c');
  applyTopicPage(kbRoot, { slug: 'd-page', title: 'D', sources: [RAW] }, 'd');
  flipStatus(path.join(kbRoot, 'wiki', 'syntheses', 'c-page.md'), 'candidate', 'approved'); // viewer: no log
  assert.throws(() => mergeTopics(kbRoot, 'c-page', 'd-page'),
    /unlogged review flip pending on this page; run sweep first: wiki\/syntheses\/c-page\.md/);
  cleanup();
});

test("M1' regression: archive with an unlogged viewer flip refuses until sweep", () => {
  const { kbRoot, RAW, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'e-page', title: 'E', sources: [RAW], candidate: true }, 'e');
  flipStatus(path.join(kbRoot, 'wiki', 'syntheses', 'e-page.md'), 'candidate', 'approved'); // viewer: no log
  assert.throws(() => archivePage(kbRoot, 'wiki/syntheses/e-page.md'),
    /unlogged review flip pending on this page; run sweep first: wiki\/syntheses\/e-page\.md/);
  sweep(kbRoot);   // backfills the approve, then archiving is legitimate
  const out = archivePage(kbRoot, 'wiki/syntheses/e-page.md');
  assert.equal(out.page, 'wiki/archive/e-page.md');
  cleanup();
});

test("M2' regression: merge refuses candidate pages on either side", () => {
  const { kbRoot, RAW, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'ok-page', title: 'OK', sources: [RAW] }, 'ok');
  applyTopicPage(kbRoot, { slug: 'cand-page', title: 'C', sources: [RAW], candidate: true, note: 'why' }, 'c');
  assert.throws(() => mergeTopics(kbRoot, 'cand-page', 'ok-page'),
    /merge involves a non-approved page \(status: candidate\); review candidates first \(approve or reject\): wiki\/syntheses\/cand-page\.md/);
  assert.throws(() => mergeTopics(kbRoot, 'ok-page', 'cand-page'),
    /merge involves a non-approved page \(status: candidate\)/);
  // the candidate page and its review_note survive untouched
  const cand = parseFrontmatter(fs.readFileSync(path.join(kbRoot, 'wiki', 'syntheses', 'cand-page.md'), 'utf8'));
  assert.equal(cand.fields.status, 'candidate');
  assert.equal(cand.fields.review_note, 'why');
  cleanup();
});

test("L4' regression: merge rewrites the [[from.md]] extension form too", () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  applyTopicPage(kbRoot, { slug: 'payment-retry', title: 'Old', sources: [RAW] }, 'old');
  writePage('wiki/syntheses/payment-timeout.md', { type: 'synthesis', status: 'approved', title: 'T' }, 'survivor');
  writePage('wiki/sources/local-aaaa1111-pay.md', { type: 'source', status: 'approved', title: 'Pay', source_ref: RAW },
    'See [[payment-retry.md|with extension]].');
  mergeTopics(kbRoot, 'payment-retry', 'payment-timeout');
  const linking = fs.readFileSync(path.join(kbRoot, 'wiki', 'sources', 'local-aaaa1111-pay.md'), 'utf8');
  assert.ok(linking.includes('[[payment-timeout.md|with extension]]'), 'extension form rewritten, form preserved');
  assert.equal(plan(kbRoot).dangling_links.length, 0);
  cleanup();
});

test("L2' regression: dangling scan ignores links inside code fences and inline code", () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  writePage('wiki/syntheses/code-page.md', { type: 'synthesis', status: 'approved', title: 'Code', sources: [RAW] },
    [
      'Real link to [[ghost-real]].',
      '',
      '```',
      'example: [[ghost-in-fence]]',
      '```',
      '',
      'Inline `[[ghost-inline]]` code.',
      '',
      '~~~',
      '[[ghost-in-tilde-fence]]',
      '~~~',
      '',
      '```code``` inline-fence-lookalike with [[ghost-inline-fence]]',
    ].join('\n'));
  const d = plan(kbRoot).dangling_links;
  assert.deepEqual(d, [
    { page: 'wiki/syntheses/code-page.md', link: 'ghost-real' },
    // the ```code``` span itself is stripped, but prose after it on the same
    // line is still prose — matching retrieval's inline-code exclusion
    { page: 'wiki/syntheses/code-page.md', link: 'ghost-inline-fence' },
  ]);
  cleanup();
});

test("L3' regression: typo'd status surfaces in errors", () => {
  const { kbRoot, RAW, writePage, cleanup } = makeKb();
  writePage('wiki/syntheses/typo-page.md', { type: 'synthesis', status: 'apprved', title: 'Typo', sources: [RAW] }, 'body');
  const p = plan(kbRoot);
  assert.equal(p.review_queue.length, 0);
  assert.ok(p.errors.some((e) => e.page === 'wiki/syntheses/typo-page.md' && /illegal status "apprved"/.test(e.error)));
  cleanup();
});
