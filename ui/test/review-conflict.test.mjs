// Conflict adjudication over the UI portal API (plan 0001 §3.2 / §6): the five
// review actions, /api/conflicts, reject-restore logging (P1-5 — the sweep must
// not backfill an approval for a restore), and the loser-archive → dangling_links
// side effect (P2-7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPortal } from '../serve.mjs';
import { applyTopicPage, applySourcePage } from '../../governance/scripts/lib/govern.mjs';
import { buildFrontmatter, parseFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';
import { useTestAdminEnv, clearTestAdminEnv, adminCookie } from './helpers/auth.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let kb, server, base, token, cookie;

const writePage = (rel, fields, body) => {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
};
const readPage = (rel) => parseFrontmatter(fs.readFileSync(path.join(kb, rel), 'utf8'));
const gitCommit = (msg) => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: kb });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], { cwd: kb });
};

before(async () => {
  useTestAdminEnv(); // ADR-0009: /api/plan and /api/conflicts are operator-only GETs
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-conflict-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  const rawA = 'raw/local/pay-v1.md';
  const rawB = 'raw/local/pay-v2.md';
  fs.writeFileSync(path.join(kb, rawA), [
    buildFrontmatter({
      source: 'local', source_id: 'pay-v1', source_url: 'file:///inbox/pay-v1.md',
      source_version: '2026-08-01T00:00:00Z', pulled_at: '2026-08-01T00:00:00Z',
      content_hash: 'sha256:v1', title: 'Payment Gateway Requirements', connector: 'local@1.0.0',
    }),
    '', 'The payment gateway must support timeout retries with exponential backoff and honor the retry budget.',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(kb, rawB), [
    buildFrontmatter({
      source: 'local', source_id: 'pay-v2', source_url: 'file:///inbox/pay-v2.md',
      source_version: '2026-08-01T00:00:00Z', pulled_at: '2026-08-01T00:00:00Z',
      content_hash: 'sha256:v2', title: 'Payment Gateway Requirements v2', connector: 'local@1.0.0',
    }),
    '', 'The payment gateway must support timeout retries with exponential backoff and honor the retry budget. It also implements connection jitter.',
  ].join('\n'), 'utf8');
  // one approved topic baseline, committed (reject-restore reads git history)
  applyTopicPage(kb, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [rawA] }, 'approved baseline body');
  applySourcePage(kb, rawB, 'Summary of the v2 version.');
  execFileSync('git', ['init', '-q'], { cwd: kb });
  gitCommit('approved baseline');

  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
  cookie = await adminCookie(base);
});
after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
  clearTestAdminEnv();
});

const post = (p, obj) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-ui-token': token }, body: JSON.stringify(obj),
});
const get = (p) => fetch(base + p, { headers: { cookie } });

test('/api/conflicts exposes the plan side-channel (conflict group + fingerprint)', async () => {
  // trigger plan via the health/plan read path so the side-channel is fresh
  await get('/api/plan');
  const res = await (await get('/api/conflicts')).json();
  assert.ok(res.fingerprint);
  const g = (res.groups || []).find((x) => x.category === 'similar');
  assert.ok(g, `similar group expected from the version pair: ${JSON.stringify(res.groups)}`);
  assert.ok(g.raws.includes('raw/local/pay-v1.md') && g.raws.includes('raw/local/pay-v2.md'));
});

test('reject is reject-and-restore with a synchronous log (P1-5): sweep backfills nothing', async () => {
  // overwrite the approved topic with a wrong candidate (bug 0001 flow), uncommitted
  applyTopicPage(kb, { slug: 'payment-timeout', title: 'Payment Timeout (fused)', sources: ['raw/local/pay-v1.md'], candidate: true }, 'wrong fusion body');
  assert.equal(readPage('wiki/syntheses/payment-timeout.md').fields.status, 'candidate');
  const r = await post('/api/review', { path: 'wiki/syntheses/payment-timeout.md', action: 'reject', reason: 'wrong fusion' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.result.restored, true);
  assert.equal(readPage('wiki/syntheses/payment-timeout.md').fields.title, 'Payment Timeout', 'restored approved baseline');
  // the synchronous log line is written (portal actor) — lastLogAction is not candidate:*
  const log = fs.readFileSync(path.join(kb, 'log.md'), 'utf8');
  assert.match(log, /review \| reject \| wiki\/syntheses\/payment-timeout\.md \| via portal.*restored previous approved version/);
  // P1-5: the sweep must NOT backfill an approval for this restore
  const out = JSON.parse(execFileSync('node', [path.join(UI_DIR, '..', 'governance', 'scripts', 'govern.mjs'), 'sweep', '--kb', kb], { encoding: 'utf8' }));
  assert.deepEqual(out.backfilled, [], 'restore log prevents a mis-recorded backfilled approve');
});

test('archive-source archives the loser source page + tombstones its raw', async () => {
  const loserPage = 'wiki/sources/local-pay-v2.md';
  assert.ok(fs.existsSync(path.join(kb, loserPage)));
  const r = await post('/api/review', { path: loserPage, action: 'archive-source', reason: 'loser archive' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.result.page.endsWith('.md'), `archived into wiki/archive: ${body.result.page}`);
  assert.ok(!fs.existsSync(path.join(kb, loserPage)), 'loser page moved out of sources/');
  const tombstones = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'govern', 'source-tombstones.json'), 'utf8'));
  assert.ok(tombstones['raw/local/pay-v2.md'], 'loser raw tombstoned');
  // P0-1/P2-7: the next plan reports the loser as suppressed (never re-pended)
  // and its raw is out of the pending scan
  const p = await (await get('/api/plan')).json();
  assert.ok(p.suppressed.some((s) => s.raw === 'raw/local/pay-v2.md'), 'archived loser reported in suppressed');
  assert.ok(!p.pending.some((x) => x.raw === 'raw/local/pay-v2.md'), 'archived loser never re-pended');
});

test('dismiss-conflict persists a pair as parallel documents', async () => {
  const r = await post('/api/review', {
    path: 'wiki/syntheses/payment-timeout.md', action: 'dismiss-conflict',
    raws: ['raw/local/pay-v1.md', 'raw/local/pay-v2.md'], reason: 'parallel docs',
  });
  assert.equal(r.status, 200);
  const state = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'govern', 'conflict-dismissals.json'), 'utf8'));
  assert.equal(state.length, 1);
  assert.deepEqual(state[0].raws, ['raw/local/pay-v1.md', 'raw/local/pay-v2.md']);
  // a non-git/ghost action that never existed must 404 (write gate)
  const bad = await post('/api/review', { path: 'wiki/syntheses/ghost.md', action: 'approve', reason: 'x' });
  assert.equal(bad.status, 404);
});
