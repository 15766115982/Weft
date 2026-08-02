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
  writePage('wiki/topics/ok-page.md', {
    type: 'topic', status: 'approved', title: 'Approved Page',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Original body.');
  writePage('wiki/topics/cand-one.md', {
    type: 'topic', status: 'candidate', title: 'Candidate One', review_note: 'agent draft',
    sources: ['local-aaaa1111-pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Candidate body.');
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});
after(() => { server.close(); fs.rmSync(kb, { recursive: true, force: true }); });

const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});
const readPage = (rel) => parseFrontmatter(fs.readFileSync(path.join(kb, rel), 'utf8'));
const logLines = () => fs.readFileSync(path.join(kb, 'log.md'), 'utf8').split('\n').filter((l) => l.includes('portal |'));

test('edit approved page: demoted + noted + logged + snapshot, provenance untouched', async () => {
  const res = await post('/api/edit', { path: 'wiki/topics/ok-page.md', body: 'Rewritten body with [[cand-one]] link.' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { page: 'wiki/topics/ok-page.md', demoted: true });

  const { fields, body } = readPage('wiki/topics/ok-page.md');
  assert.equal(fields.status, 'candidate', 'save demotes (ruling ⑨)');
  assert.match(String(fields.review_note), /^manual edit via portal @ /);
  assert.ok(fields.updated_at > '2026-08-02', 'updated_at stamped');
  assert.equal(fields.title, 'Approved Page', 'other fields preserved');
  assert.deepEqual(fields.sources, ['local-aaaa1111-pay.md'], 'provenance read-only (ruling ⑩)');
  assert.equal(body.trim(), 'Rewritten body with [[cand-one]] link.');

  assert.ok(logLines().some((l) => l.includes('portal | candidate:manual | wiki/topics/ok-page.md') && l.includes('(demoted to candidate)')));

  // ruling ⑨c: non-git KB → G6 copy snapshot holds the ORIGINAL text
  const snaps = fs.readdirSync(path.join(kb, '.kb', 'ui', 'snapshots'));
  assert.equal(snaps.length, 1);
  const snapText = fs.readFileSync(path.join(kb, '.kb', 'ui', 'snapshots', snaps[0], 'wiki', 'topics', 'ok-page.md'), 'utf8');
  assert.ok(snapText.includes('Original body.'), 'snapshot preserves the pre-edit original');
  assert.ok(snapText.includes('status: approved'));
});

test('edit candidate page: content only, no status transition (ruling ⑨a)', async () => {
  const res = await post('/api/edit', { path: 'wiki/topics/cand-one.md', body: 'Edited candidate body.' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { page: 'wiki/topics/cand-one.md', demoted: false });
  const { fields, body } = readPage('wiki/topics/cand-one.md');
  assert.equal(fields.status, 'candidate');
  assert.equal(body.trim(), 'Edited candidate body.');
  assert.ok(logLines().some((l) => l.includes('portal | candidate:manual | wiki/topics/cand-one.md') && !l.includes('demoted')));
});

test('governance contract: portal candidate action feeds sweep backfill + flip guard', async () => {
  // human re-approves via the review flip (no log, viewer primitive)…
  flipStatus(path.join(kb, 'wiki', 'topics', 'ok-page.md'), 'candidate', 'approved');
  // …the rewrite guard must refuse until sweep solidifies the review record,
  // recognizing `portal | candidate:manual` as pending-review (not only govern's)
  assert.throws(
    () => applyTopicPage(kb, { slug: 'ok-page', title: 'X', sources: ['local-aaaa1111-pay.md'] }, 'synthesis'),
    /unlogged review flip/,
  );
  const { backfilled } = sweep(kb);
  assert.deepEqual(backfilled, [{ page: 'wiki/topics/ok-page.md', status: 'approved' }],
    'sweep backfills the review line on a portal candidate action too');
  const { fields } = readPage('wiki/topics/ok-page.md');
  assert.equal(fields.status, 'approved');
});

test('edit guards: traversal, empty body, pasted frontmatter, missing page, security', async () => {
  assert.equal((await post('/api/edit', { path: '../log.md', body: 'x' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/edit', { path: 'wiki/index.md', body: 'x' }, { 'x-ui-token': token })).status, 400, 'index.md not editable (write gate)');
  assert.equal((await post('/api/edit', { path: 'wiki/topics/ok-page.md', body: '   ' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/edit', { path: 'wiki/topics/ok-page.md', body: '---\nstatus: approved\n---\nhacked' }, { 'x-ui-token': token })).status, 400,
    'frontmatter paste rejected — provenance is governance-owned');
  const missing = await post('/api/edit', { path: 'wiki/topics/nope.md', body: 'x' }, { 'x-ui-token': token });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /does not exist/);
  assert.equal((await post('/api/edit', { path: 'wiki/topics/ok-page.md', body: 'x' })).status, 403, 'no token');
  assert.equal((await post('/api/edit', { path: 'wiki/topics/ok-page.md', body: 'x' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403, 'forged Origin');
});
