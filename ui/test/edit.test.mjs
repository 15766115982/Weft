// M7d wiki edit tests (contract §1 whitelist ⑤, rulings ⑨/⑩): demote-to-
// candidate on save, provenance untouched, byte-preserving frontmatter
// surgery, portal log entry, G6 snapshot, and the governance-side contract —
// sweep backfills review flips on `portal | candidate:*` exactly like
// `govern | candidate:*`, and the unlogged-flip guard recognizes it too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter, parseFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';
import { sweep, applyTopicPage } from '../../governance/scripts/lib/govern.mjs';
import { flipStatus } from '../../governance/scripts/lib/statusflip.mjs';

let kb, server, base, token;

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-m7d-'));
  writePage('wiki/syntheses/ok-page.md', {
    type: 'synthesis', status: 'approved', title: 'Approved Page',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Original body.');
  writePage('wiki/syntheses/cand-one.md', {
    type: 'synthesis', status: 'candidate', title: 'Candidate One', review_note: 'agent draft',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Candidate body.');
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});
after(() => {
  server.close();
  fs.rmSync(kb, { recursive: true, force: true });
});

const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});
const readPage = (rel) => parseFrontmatter(fs.readFileSync(path.join(kb, rel), 'utf8'));
const logLines = () => fs.readFileSync(path.join(kb, 'log.md'), 'utf8').split('\n').filter((l) => l.includes('portal |'));

test('edit approved page: demoted + noted + logged + snapshot, provenance untouched', async () => {
  const res = await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: 'Rewritten body with [[cand-one]] link.' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { page: 'wiki/syntheses/ok-page.md', demoted: true });

  const { fields, body } = readPage('wiki/syntheses/ok-page.md');
  assert.equal(fields.status, 'candidate', 'save demotes (ruling ⑨)');
  assert.match(String(fields.review_note), /^manual edit via portal @ /);
  assert.ok(fields.updated_at > '2026-08-02', 'updated_at stamped');
  assert.equal(fields.title, 'Approved Page', 'other fields preserved');
  assert.deepEqual(fields.sources, ['local-aaaa1111-pay.md'], 'provenance read-only (ruling ⑩)');
  assert.equal(body.trim(), 'Rewritten body with [[cand-one]] link.');

  assert.ok(logLines().some((l) => l.includes('portal | candidate:manual | wiki/syntheses/ok-page.md') && l.includes('(demoted to candidate)')));

  // ruling ⑨c: non-git KB → G6 copy snapshot holds the ORIGINAL text
  const snaps = fs.readdirSync(path.join(kb, '.kb', 'ui', 'snapshots'));
  assert.equal(snaps.length, 1);
  const snapText = fs.readFileSync(path.join(kb, '.kb', 'ui', 'snapshots', snaps[0], 'wiki', 'syntheses', 'ok-page.md'), 'utf8');
  assert.ok(snapText.includes('Original body.'), 'snapshot preserves the pre-edit original');
  assert.ok(snapText.includes('status: approved'));
});

test('edit candidate page: content only, no status transition, prev note preserved (ruling ⑨a + P3)', async () => {
  const res = await post('/api/edit', { path: 'wiki/syntheses/cand-one.md', body: 'Edited candidate body.' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { page: 'wiki/syntheses/cand-one.md', demoted: false });
  const { fields, body } = readPage('wiki/syntheses/cand-one.md');
  assert.equal(fields.status, 'candidate');
  assert.equal(body.trim(), 'Edited candidate body.');
  assert.match(String(fields.review_note), /^manual edit via portal @ /);
  assert.ok(String(fields.review_note).includes('; prev: agent draft'), 'agent governance note is not silently dropped');
  assert.ok(logLines().some((l) => l.includes('portal | candidate:manual | wiki/syntheses/cand-one.md') && !l.includes('demoted')));
});

test('optimistic lock: stale base_hash → 409; re-based force save succeeds (final-review P2)', async () => {
  const pageRes = await fetch(base + '/api/page?path=wiki/syntheses/ok-page.md');
  assert.equal(pageRes.status, 200);
  const { hash } = await pageRes.json();
  assert.ok(hash, 'page endpoint carries the content hash');

  // external change behind the editor's back (agent round, another save)
  fs.appendFileSync(path.join(kb, 'wiki', 'syntheses', 'ok-page.md'), 'External touch.\n', 'utf8');

  const stale = await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: 'My edit.', base_hash: hash }, { 'x-ui-token': token });
  assert.equal(stale.status, 409, 'stale base refuses loudly');
  assert.match((await stale.json()).error, /^edit conflict:/);
  assert.ok(fs.readFileSync(path.join(kb, 'wiki', 'syntheses', 'ok-page.md'), 'utf8').includes('External touch.'),
    'the conflicting save did NOT overwrite');

  // force path: re-base on the fresh hash, one locked retry
  const fresh = await (await fetch(base + '/api/page?path=wiki/syntheses/ok-page.md')).json();
  const force = await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: 'My edit.', base_hash: fresh.hash }, { 'x-ui-token': token });
  assert.equal(force.status, 200);
  assert.equal(readPage('wiki/syntheses/ok-page.md').body.trim(), 'My edit.');
});

test('governance contract: portal candidate action feeds sweep backfill + flip guard', async () => {
  // human re-approves via the review flip (no log, viewer primitive)…
  flipStatus(path.join(kb, 'wiki', 'syntheses', 'ok-page.md'), 'candidate', 'approved');
  // …the rewrite guard must refuse until sweep solidifies the review record,
  // recognizing `portal | candidate:manual` as pending-review (not only govern's)
  assert.throws(
    () => applyTopicPage(kb, { slug: 'ok-page', title: 'X', sources: ['local-aaaa1111-pay.md'] }, 'synthesis'),
    /unlogged review flip/,
  );
  const { backfilled } = sweep(kb);
  assert.deepEqual(backfilled, [{ page: 'wiki/syntheses/ok-page.md', status: 'approved' }],
    'sweep backfills the review line on a portal candidate action too');
  const { fields } = readPage('wiki/syntheses/ok-page.md');
  assert.equal(fields.status, 'approved');
});

test('edit guards: traversal, empty body, pasted frontmatter, missing page, security', async () => {
  assert.equal((await post('/api/edit', { path: '../log.md', body: 'x' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/edit', { path: 'wiki/index.md', body: 'x' }, { 'x-ui-token': token })).status, 400, 'index.md not editable (write gate)');
  assert.equal((await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: '   ' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: '---\nstatus: approved\n---\nhacked' }, { 'x-ui-token': token })).status, 400,
    'frontmatter paste rejected — provenance is governance-owned');
  const missing = await post('/api/edit', { path: 'wiki/syntheses/nope.md', body: 'x' }, { 'x-ui-token': token });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /does not exist/);
  assert.equal((await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: 'x' })).status, 403, 'no token');
  assert.equal((await post('/api/edit', { path: 'wiki/syntheses/ok-page.md', body: 'x' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403, 'forged Origin');
});

// ---- J7 page history ----

test('history on a non-git KB: G6 snapshots + git-init hint', async () => {
  // runs after the edit test above, which created one snapshot of ok-page
  const res = await fetch(base + '/api/history?path=wiki/syntheses/ok-page.md');
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.kind, 'snapshots');
  assert.ok(h.hint.includes('git init'), 'version-management constraint hint');
  assert.ok(h.entries.length >= 1);
  assert.ok(h.entries[0].subject.includes('快照'));
});

test('history on a git KB: git log --follow entries, newest first', async () => {
  const kb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-j7-'));
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', ['-C', kb2, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  fs.mkdirSync(path.join(kb2, 'wiki', 'syntheses'), { recursive: true });
  const page = path.join(kb2, 'wiki', 'syntheses', 'p.md');
  fs.writeFileSync(page, buildFrontmatter({ type: 'synthesis', status: 'approved', title: 'P' }) + '\nv1\n', 'utf8');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'govern | approved:synthesis | wiki/syntheses/p.md | initial');
  fs.writeFileSync(page, buildFrontmatter({ type: 'synthesis', status: 'candidate', title: 'P', review_note: 'manual edit via portal @ x' }) + '\nv2\n', 'utf8');
  git('add', '.');
  git('commit', '-q', '-m', 'ui: snapshot before wiki-edit (abc123)');

  const s2 = createPortal({ kb: kb2, port: 0 });
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const hRes = await fetch(b2 + '/api/history?path=wiki/syntheses/p.md');
  assert.equal(hRes.status, 200);
  const h = await hRes.json();
  s2.close();
  fs.rmSync(kb2, { recursive: true, force: true });

  assert.equal(h.kind, 'git');
  assert.equal(h.entries.length, 2);
  assert.ok(h.entries[0].subject.includes('snapshot before wiki-edit'), 'newest first');
  assert.ok(h.entries[1].subject.includes('approved:synthesis'));
  assert.ok(h.entries.every((e) => e.hash && e.ts));
});
