// Cross-service end-to-end pipeline regression: a scratch KB built from the
// fixture corpus (tests/fixtures/inbox) walks the REAL CLIs through every
// function except the real Jira/Confluence connections:
//   acquire local (create/skip/update/orphan/prune) → govern (plan, apply-source,
//   stale/anomaly/errors detection, topics, candidate state machine via CLI and
//   the real viewer over HTTP, merge, archive, sweep idempotency, rebuild-index,
//   log.md audit) → retrieval gates (approved-only search/read, archive bypass).
// Tests in this file are order-dependent and share one scratch KB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  SCRIPTS, MTIMES, GOVERNABLE, hash8, rawRelFor, sourcePageFor,
  runCli, runCliText, copyInbox, makeScratchKb, acquire, govern, applyAllSources, snapshot,
} from '../helpers/kb.mjs';

let kb;
const log = () => fs.readFileSync(path.join(kb, 'log.md'), 'utf8');
const readKb = (rel) => fs.readFileSync(path.join(kb, rel), 'utf8');
const existsKb = (rel) => fs.existsSync(path.join(kb, rel));
const rawOf = (name) => rawRelFor(name);
const search = (q, extra = []) => runCli(SCRIPTS.search, ['search', q, '--kb', kb, ...extra]);
const setMtime = (relInbox, iso) => { const t = new Date(iso); fs.utimesSync(path.join(kb, 'inbox', relInbox), t, t); };

before(() => {
  kb = makeScratchKb();
  copyInbox(kb);
});
after(() => fs.rmSync(kb, { recursive: true, force: true }));

// ---------------------------------------------------------------- phase 1: acquisition
test('acquire: first pull creates 11 raws, docx unsupported, frontmatter quintuple, log lines', () => {
  const s = acquire(kb);
  assert.equal(s.created.length, GOVERNABLE.length, JSON.stringify(s));
  assert.deepEqual(s.unsupported, ['manual.docx']);
  assert.deepEqual(s.errors, []);
  for (const rel of s.created) {
    assert.match(rel, /^raw\/local\/[0-9a-f]{8}-.+\.md$/);
    const fm = readKb(rel).split('---')[1];
    for (const re of [/source: local/, /source_id:/, /source_url: "?file:\/\/\//, /source_version: "?/, /pulled_at: "?/, /content_hash: "?sha256:/, /title:/, /connector: "?local@1\.0\.0"?/]) {
      assert.match(fm, re, `${rel} frontmatter missing ${re}`);
    }
    const sid = fm.match(/source_id: "?([^"\n]+)"?/)[1];
    assert.match(sid, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, `source_id whitelist: ${sid}`);
  }
  assert.equal((log().match(/acquire \| local:created/g) || []).length, GOVERNABLE.length);
  assert.equal(Object.keys(snapshot(path.join(kb, 'wiki'))).length, 0, 'acquisition must not write any wiki content');
});

test('acquire: second pull is a full incremental skip', () => {
  const s = acquire(kb);
  assert.equal(s.created.length + s.updated.length, 0);
  assert.equal(s.unchanged.length, GOVERNABLE.length);
});

test('acquire: content change with new mtime → updated', () => {
  fs.appendFileSync(path.join(kb, 'inbox', 'rate-limiting.md'), '\nAddendum: merchant-tier overrides ship in Q3.\n');
  setMtime('rate-limiting.md', '2026-07-26T08:00:00.000Z');
  const s = acquire(kb);
  assert.deepEqual(s.updated, [rawOf('rate-limiting.md')]);
});

test('acquire: vanished inbox source → orphaned (report-only), --prune deletes + logs', () => {
  fs.rmSync(path.join(kb, 'inbox', 'notes.txt'));
  const s1 = acquire(kb);
  assert.deepEqual(s1.orphaned, [rawOf('notes.txt')]);
  assert.ok(existsKb(rawOf('notes.txt')), 'report-only: still on disk');
  const s2 = acquire(kb, ['--prune']);
  assert.deepEqual(s2.pruned, [rawOf('notes.txt')]);
  assert.ok(!existsKb(rawOf('notes.txt')));
  assert.match(log(), /acquire \| local:pruned \| raw\/local\/[0-9a-f]{8}-notes\.md/);
});

// ---------------------------------------------------------------- phase 2: governance
const N_DOCS = GOVERNABLE.length - 1; // notes.txt pruned

test('govern: sweep no-op, plan lists all raws pending', () => {
  assert.deepEqual(govern(kb, ['sweep']), { backfilled: [], archived: [] });
  const p = govern(kb, ['plan']);
  assert.equal(p.pending.length, N_DOCS, JSON.stringify(p.pending));
  assert.ok(p.pending.every((i) => i.reason === 'new'));
  for (const k of ['anomalies', 'orphaned_pages', 'errors', 'review_queue', 'dangling_links']) assert.deepEqual(p[k], []);
});

test('govern: apply-source for every pending doc → approved pages, plan drains', () => {
  const applied = applyAllSources(kb);
  assert.equal(applied.length, N_DOCS);
  const p = govern(kb, ['plan']);
  assert.deepEqual(p.pending, []);
  for (const name of GOVERNABLE.filter((n) => n !== 'notes.txt')) {
    const page = sourcePageFor(name);
    assert.match(readKb(page), /status: approved/, page);
  }
});

test('govern: raw updated after governance → pending reason stale; re-apply drains', () => {
  fs.appendFileSync(path.join(kb, 'inbox', 'reconciliation.md'), '\nAddendum: weekend cutoffs shift to 22:00 UTC.\n');
  setMtime('reconciliation.md', '2026-08-01T08:00:00.000Z');
  acquire(kb);
  const p = govern(kb, ['plan']);
  const stale = p.pending.filter((i) => i.reason === 'stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].raw, rawOf('reconciliation.md'));
  govern(kb, ['apply-source', '--raw', rawOf('reconciliation.md')], '## Key Points\n\n- Updated reconciliation summary.\n');
  assert.deepEqual(govern(kb, ['plan']).pending, []);
});

test('govern: anomaly detection — hash changed with version unchanged, cleared by re-apply', () => {
  // out-of-band source modification: content changes but mtime (= version) is reset
  fs.appendFileSync(path.join(kb, 'inbox', 'idempotency-design.md'), '\nTampered out of band.\n');
  setMtime('idempotency-design.md', MTIMES['idempotency-design.md']);
  const a = acquire(kb);
  assert.deepEqual(a.updated, [rawOf('idempotency-design.md')]);
  const p = govern(kb, ['plan']);
  assert.deepEqual(p.anomalies.map((i) => i.raw), [rawOf('idempotency-design.md')]);
  assert.equal(p.anomalies[0].reason, 'hash-changed-version-unchanged');
  // human confirmed; re-apply makes the new hash authoritative
  govern(kb, ['apply-source', '--raw', rawOf('idempotency-design.md')], '## Key Points\n\n- Re-governed after anomaly confirmation.\n');
  assert.deepEqual(govern(kb, ['plan']).anomalies, []);
});

test('govern: contract-violating raws land in errors item by item', () => {
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'deadbeef-broken.md'), [
    '---', 'source: local', 'source_id: deadbeef-broken',
    'source_version: "2026-07-30T00:00:00Z"', 'pulled_at: "2026-07-30T00:00:00Z"',
    'content_hash: "sha256:x"', 'title: "Broken"', 'connector: "local@1.0.0"', '---', '', 'body',
  ].join('\n')); // missing source_url
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'badid.md'), [
    '---', 'source: local', 'source_id: "bad id with spaces"',
    'source_url: "file:///x"', 'source_version: "2026-07-30T00:00:00Z"', 'pulled_at: "2026-07-30T00:00:00Z"',
    'content_hash: "sha256:x"', 'title: "BadId"', 'connector: "local@1.0.0"', '---', '', 'body',
  ].join('\n'));
  const p = govern(kb, ['plan']);
  assert.ok(p.errors.length >= 2, JSON.stringify(p.errors));
  assert.ok(p.errors.some((e) => /missing contract fields/.test(e.error)));
  assert.ok(p.errors.some((e) => /bad id with spaces|source_id/i.test(e.error)));
  fs.rmSync(path.join(kb, 'raw', 'local', 'deadbeef-broken.md'));
  fs.rmSync(path.join(kb, 'raw', 'local', 'badid.md'));
  assert.deepEqual(govern(kb, ['plan']).errors, []);
});

test('govern: topics — approved creation, candidate creation, candidate protection on re-apply', () => {
  const t1 = govern(kb, ['apply-topic', '--slug', 'retry-resilience', '--title', 'Retry Resilience',
    '--sources', [rawOf('payment-timeout-retry.md'), rawOf('idempotency-design.md'), rawOf('订单超时关闭.md')].join(','),
    '--tags', 'retry,resilience'],
    'How PayCore keeps payment calls resilient: bounded retries with exponential backoff, idempotency keys, and order-close interplay. See [[payment-safety]] and [[throttling-b]].\n');
  assert.equal(t1.status, 'approved');
  const t2 = govern(kb, ['apply-topic', '--slug', 'payment-safety', '--title', 'Payment Safety',
    '--sources', [rawOf('idempotency-design.md'), rawOf('payment-compensation.md')].join(',')],
    'Idempotency keys and saga compensation together prevent double charges and half-applied payments. Related: [[retry-resilience]].\n');
  assert.equal(t2.status, 'approved');
  const c = govern(kb, ['apply-topic', '--slug', 'retry-budget-draft', '--title', 'Retry Budget (draft)',
    '--sources', rawOf('payment-timeout-retry.md'), '--candidate', '--note', 'conflicts with retry-resilience on the budget figure'],
    'A draft claiming the retry budget is five attempts, conflicting with [[retry-resilience]].\n');
  assert.equal(c.status, 'candidate');
  // candidate protection: re-apply without --candidate must NOT approve it
  const re = govern(kb, ['apply-topic', '--slug', 'retry-budget-draft', '--title', 'Retry Budget (draft)',
    '--sources', rawOf('payment-timeout-retry.md')], 'Updated draft body.\n');
  assert.equal(re.status, 'candidate');
  assert.match(readKb('wiki/topics/retry-budget-draft.md'), /status: candidate/);
  const p = govern(kb, ['plan']);
  assert.deepEqual(p.review_queue.map((i) => i.page), ['wiki/topics/retry-budget-draft.md']);
});

test('govern: CLI approve and reject write review log lines immediately; sweep archives rejected', () => {
  govern(kb, ['apply-topic', '--slug', 'order-lifecycle', '--title', 'Order Lifecycle',
    '--sources', rawOf('订单超时关闭.md'), '--candidate', '--note', 'needs a second pair of eyes'],
    'Orders close automatically after 30 unpaid minutes; in-flight retries stop and edge-case charges auto-refund.\n');
  const ap = govern(kb, ['approve', '--page', 'wiki/topics/order-lifecycle.md']);
  assert.equal(ap.status, 'approved');
  const rj = govern(kb, ['reject', '--page', 'wiki/topics/retry-budget-draft.md']);
  assert.equal(rj.status, 'rejected');
  assert.match(log(), /review \| approve \| wiki\/topics\/order-lifecycle\.md \| via session/);
  assert.match(log(), /review \| reject \| wiki\/topics\/retry-budget-draft\.md \| via session/);
  const s = govern(kb, ['sweep']);
  assert.deepEqual(s.backfilled, []); // CLI reviews are logged at flip time — nothing to backfill
  assert.deepEqual(s.archived, [{ from: 'wiki/topics/retry-budget-draft.md', page: 'wiki/archive/retry-budget-draft.md' }]);
  assert.match(readKb('wiki/archive/retry-budget-draft.md'), /status: archived/);
  assert.match(log(), /govern \| auto:archive-rejected \| wiki\/archive\/retry-budget-draft\.md/);
});

test('viewer: queue, flip over HTTP, 409 on double flip, unlogged-flip guard, sweep backfill idempotent', async () => {
  govern(kb, ['apply-topic', '--slug', 'recon-ops', '--title', 'Reconciliation Operations',
    '--sources', [rawOf('reconciliation.md'), rawOf('支付对账流程.md')].join(','),
    '--candidate', '--note', 'cross-source merge of EN/CJK reconciliation docs'],
    'Daily reconciliation compares settlement files with the ledger; discrepancies follow a two-business-day SLA.\n');

  const viewer = spawn('node', [SCRIPTS.viewer, '--kb', kb, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve, reject) => {
    viewer.stdout.on('data', (d) => { const m = String(d).match(/127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
    viewer.on('exit', () => reject(new Error('viewer exited before listening')));
  });
  const api = async (p, opts) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, opts);
    return { status: r.status, body: await r.json() };
  };
  try {
    const q = await api('/api/queue');
    assert.deepEqual(q.body.pages.map((i) => i.path), ['wiki/topics/recon-ops.md']);
    const pg = await api('/api/page?path=wiki/topics/recon-ops.md');
    assert.equal(pg.body.fields.status, 'candidate');
    assert.equal(pg.body.fields.review_note, 'cross-source merge of EN/CJK reconciliation docs');
    const ev = await api(`/api/raw?path=${rawOf('reconciliation.md')}`);
    assert.match(ev.body.body, /settlement cutoff/);
    const diff = await api('/api/diff?path=wiki/topics/recon-ops.md');
    assert.equal(diff.body.baseline, null); // scratch KB has no git history — graceful null
    // flip candidate → approved over HTTP (no log line — that is the design)
    const flip = await api('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'wiki/topics/recon-ops.md', action: 'approve' }) });
    assert.equal(flip.status, 200);
    assert.equal(flip.body.status, 'approved');
    // optimistic concurrency: the same flip again conflicts loudly
    const again = await api('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'wiki/topics/recon-ops.md', action: 'approve' }) });
    assert.equal(again.status, 409);
  } finally {
    viewer.kill();
  }
  assert.ok(!log().includes('recon-ops.md | via'), 'viewer writes no log');
  // tool-layer guard: governance refuses to touch a page with an unlogged flip
  assert.throws(
    () => govern(kb, ['apply-topic', '--slug', 'recon-ops', '--title', 'Reconciliation Operations'], 'x\n'),
    /unlogged review flip pending.*run sweep first/s);
  const s1 = govern(kb, ['sweep']);
  assert.deepEqual(s1.backfilled, [{ page: 'wiki/topics/recon-ops.md', status: 'approved' }]);
  assert.match(log(), /review \| approve \| wiki\/topics\/recon-ops\.md \| via viewer \(backfilled\)/);
  assert.deepEqual(govern(kb, ['sweep']), { backfilled: [], archived: [] }, 'sweep is idempotent');
});

test('govern: merge-topic rewrites backlinks, unions provenance, archives loser, no dangling links', () => {
  govern(kb, ['apply-topic', '--slug', 'throttling-a', '--title', 'Throttling Overview',
    '--sources', rawOf('rate-limiting.md')], 'Token-bucket rate limiting for merchant traffic.\n');
  govern(kb, ['apply-topic', '--slug', 'throttling-b', '--title', 'Throttling Details',
    '--sources', rawOf('rate-limiting.md')], 'Bucket sizing, 429 semantics and Retry-After handling.\n');
  const m = govern(kb, ['merge-topic', '--from', 'throttling-b', '--to', 'throttling-a', '--note', 'duplicate topics']);
  assert.equal(m.action, 'merge');
  const survivor = readKb('wiki/topics/throttling-a.md');
  assert.match(survivor, /status: approved/);
  assert.match(readKb('wiki/topics/retry-resilience.md'), /\[\[throttling-a\]\]/, 'backlink rewritten');
  assert.ok(!readKb('wiki/topics/retry-resilience.md').includes('[[throttling-b]]'));
  assert.match(log(), /govern \| merge \| wiki\/topics\/throttling-a\.md \| from wiki\/topics\/throttling-b\.md/);
  assert.ok(existsKb('wiki/archive/throttling-b.md'));
  assert.deepEqual(govern(kb, ['plan']).dangling_links, []);
});

test('govern: orphaned_pages after prune → human-adjudicated archive', () => {
  fs.rmSync(path.join(kb, 'inbox', 'empty.md'));
  acquire(kb, ['--prune']);
  const orphanPage = sourcePageFor('empty.md');
  const p = govern(kb, ['plan']);
  assert.deepEqual(p.orphaned_pages.map((i) => i.page), [orphanPage]);
  const a = govern(kb, ['archive', '--page', orphanPage, '--note', 'raw pruned, page obsolete']);
  assert.equal(a.action, 'archive');
  const archived = readKb(`wiki/archive/${path.basename(orphanPage)}`);
  assert.match(archived, /status: archived/);
  assert.match(log(), /govern \| archive \| wiki\/archive\/.+ \| from wiki\/sources\/.+/);
});

test('govern: hand-made dangling wikilink is reported, then fixable', () => {
  const page = path.join(kb, 'wiki', 'topics', 'payment-safety.md');
  fs.appendFileSync(page, '\nSee also [[ghost-page]].\n');
  const p = govern(kb, ['plan']);
  assert.deepEqual(p.dangling_links, [{ page: 'wiki/topics/payment-safety.md', link: 'ghost-page' }]);
  const fixed = readKb('wiki/topics/payment-safety.md').replace('\nSee also [[ghost-page]].\n', '');
  fs.writeFileSync(page, fixed);
  assert.deepEqual(govern(kb, ['plan']).dangling_links, []);
});

test('govern: rebuild-index matches contract §3.4 format; govern never writes raw/', () => {
  const rawBefore = snapshot(path.join(kb, 'raw'));
  govern(kb, ['rebuild-index']);
  const index = readKb('wiki/index.md');
  const lines = index.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length >= 14, `expected ≥14 index lines, got ${lines.length}`);
  for (const l of lines) assert.match(l, /^- \[\[(topics|sources)\/[^\]]+\]\] — .+\(.+\)$/, l);
  assert.ok(!index.includes('retry-budget-draft') && !index.includes('throttling-b'), 'archived pages excluded');
  assert.match(index, /\[\[topics\/recon-ops\]\]/);
  assert.deepEqual(snapshot(path.join(kb, 'raw')), rawBefore, 'governance must not write raw/');
});

test('log.md audit: every line matches contract §5 format; key narrative present in order', () => {
  const lines = log().split('\n').filter((l) => l.trim());
  for (const l of lines) {
    assert.match(l, /^## \[\d{4}-\d{2}-\d{2}T[^\]]+\] (acquire|govern|review) \| [^|]+ \| [^|]+ \| .+$/, l);
  }
  const sequence = [
    /acquire \| local:created/,
    /govern \| auto:create-source/,
    /govern \| auto:create-topic \| wiki\/topics\/retry-resilience\.md/,
    /govern \| candidate:topic \| wiki\/topics\/retry-budget-draft\.md/,
    /review \| reject \| wiki\/topics\/retry-budget-draft\.md \| via session/,
    /govern \| auto:archive-rejected/,
    /review \| approve \| wiki\/topics\/recon-ops\.md \| via viewer \(backfilled\)/,
    /govern \| merge \| wiki\/topics\/throttling-a\.md/,
    /govern \| archive \|/,
    /govern \| auto:rebuild-index \| wiki\/index\.md/,
  ];
  let pos = 0;
  const text = log();
  for (const re of sequence) {
    const m = text.slice(pos).match(re);
    assert.ok(m, `log narrative missing/out of order: ${re}`);
    pos += m.index + 1;
  }
});

// ---------------------------------------------------------------- phase 3: retrieval gates
test('retrieval: candidate page is invisible to search and read; approved peers are found', () => {
  govern(kb, ['apply-topic', '--slug', 'draft-noise', '--title', 'Draft Noise',
    '--sources', rawOf('mixed-locale.md'), '--candidate', '--note', 'gate fixture'],
    'The zephyranthes protocol draft.\n');
  const s = search('zephyranthes');
  assert.equal(s.total, 0, 'candidate must not be indexed');
  const r = runCli(SCRIPTS.search, ['read', 'wiki/topics/draft-noise.md', '--kb', kb], { expectFail: true });
  assert.ok(r.failed, 'read of a candidate page must be refused');
  const ok = search('retry budget');
  assert.ok(ok.preview.some((c) => c.page === sourcePageFor('payment-timeout-retry.md')));
  assert.ok(ok.preview.every((c) => !c.page.includes('draft-noise')));
});

test('retrieval: archived pages and archive-directory bypass are refused', () => {
  for (const p of ['wiki/archive/retry-budget-draft.md', 'wiki/../raw/local/x.md']) {
    const r = runCli(SCRIPTS.search, ['read', p, '--kb', kb], { expectFail: true });
    assert.ok(r.failed, `read must refuse ${p}`);
  }
  if (process.platform === 'win32') {
    const r = runCli(SCRIPTS.search, ['read', 'wiki/ARCHIVE/retry-budget-draft.md', '--kb', kb], { expectFail: true });
    assert.ok(r.failed, 'case-variant archive bypass must be refused on win32');
  }
  const s = search('retry budget is five attempts');
  assert.ok(!JSON.stringify(s.preview).includes('archive/'), 'archived content never surfaces');
});

test('retrieval: anchored read returns the section; fences preserved through acquire', () => {
  const page = sourcePageFor('deep/structured-doc.md');
  const out = runCliText(SCRIPTS.search, ['read', `${page}#Key Points`, '--kb', kb]);
  assert.ok(out.includes('gateway'), 'anchor read returns the section body');
  // fence fidelity survives acquire: the 4-backtick fence is intact in raw/
  const raw = readKb(rawOf('deep/structured-doc.md'));
  assert.match(raw, /````bash\npaycore-admin retry-queue drain/);
  assert.ok(raw.includes('[[not-a-real-link]]'), 'code-fence wikilink text preserved verbatim');
});
