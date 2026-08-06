// C5 batch review tests: one queued job, per-page flips with per-page fault
// isolation (a 409-lost page never aborts the batch), validation, security.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter, parseFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';

let kb, server, base, token;

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}
const statusOf = (rel) => parseFrontmatter(fs.readFileSync(path.join(kb, rel), 'utf8')).fields.status;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-c5-'));
  for (const slug of ['a-one', 'b-two', 'c-three']) {
    writePage(`wiki/syntheses/${slug}.md`, {
      type: 'synthesis', status: 'candidate', title: slug, updated_at: '2026-08-01T00:00:00Z',
    }, `body of ${slug}`);
  }
  writePage('wiki/syntheses/already-ok.md', {
    type: 'synthesis', status: 'approved', title: 'already', updated_at: '2026-08-01T00:00:00Z',
  }, 'approved body');
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

test('batch approve: all candidates flipped, per-page results', async () => {
  const res = await post('/api/review-batch', { paths: ['wiki/syntheses/a-one.md', 'wiki/syntheses/b-two.md'], action: 'approve', reason: 'batch ok' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(results, [
    { path: 'wiki/syntheses/a-one.md', ok: true },
    { path: 'wiki/syntheses/b-two.md', ok: true },
  ]);
  assert.equal(statusOf('wiki/syntheses/a-one.md'), 'approved');
  assert.equal(statusOf('wiki/syntheses/b-two.md'), 'approved');
  assert.equal(statusOf('wiki/syntheses/c-three.md'), 'candidate', 'untouched page stays');
});

test('batch with a 409-lost page: batch completes, per-page error recorded', async () => {
  const res = await post('/api/review-batch', {
    paths: ['wiki/syntheses/already-ok.md', 'wiki/syntheses/c-three.md', '../evil.md', 'wiki/syntheses/nope.md'],
    action: 'reject',
    reason: 'batch reject',
  }, { 'x-ui-token': token });
  assert.equal(res.status, 200, 'mixed batch is NOT a job failure');
  const { results } = await res.json();
  assert.equal(results.length, 4);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /page status is/, 'already-approved page loses the expected-from check');
  assert.deepEqual(results[1], { path: 'wiki/syntheses/c-three.md', ok: true });
  assert.equal(results[2].ok, false, 'traversal fails per-page, not the batch');
  assert.equal(results[3].ok, false, 'missing page fails per-page');
  assert.equal(statusOf('wiki/syntheses/c-three.md'), 'rejected');
});

test('batch validation + security', async () => {
  assert.equal((await post('/api/review-batch', { paths: ['wiki/syntheses/a-one.md'], action: 'nuke' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/review-batch', { paths: [], action: 'approve' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/review-batch', { paths: 'wiki/syntheses/a-one.md', action: 'approve' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/review-batch', { paths: ['wiki/syntheses/a-one.md'], action: 'approve' })).status, 403, 'no token');
  assert.equal((await post('/api/review-batch', { paths: ['wiki/syntheses/a-one.md'], action: 'approve' }, { 'x-ui-token': token, origin: 'http://evil.example' })).status, 403, 'forged Origin');
});
