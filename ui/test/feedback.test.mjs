// J9 feedback loop tests: votes land in .kb/ui/feedback.jsonl (whitelist ④)
// via the serial queue, the 👎 read side feeds the golden-set candidate panel,
// validation + security.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';

let kb, server, base, token;

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-j9-'));
  fs.mkdirSync(path.join(kb, 'wiki', 'topics'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'wiki', 'topics', 'p.md'),
    buildFrontmatter({ type: 'topic', status: 'approved', title: 'P' }) + '\nbody\n', 'utf8');
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

test('votes append one JSON line each, newest-first read side', async () => {
  assert.equal((await post('/api/feedback', { q: 'retry policy', page: 'wiki/topics/p.md', vote: 'up' }, { 'x-ui-token': token })).status, 200);
  assert.equal((await post('/api/feedback', { q: 'saga compensation', page: 'wiki/topics/p.md', vote: 'down' }, { 'x-ui-token': token })).status, 200);

  const lines = fs.readFileSync(path.join(kb, '.kb', 'ui', 'feedback.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const down = JSON.parse(lines[1]);
  assert.equal(down.vote, 'down');
  assert.equal(down.q, 'saga compensation');
  assert.ok(down.ts);

  const res = await fetch(base + '/api/feedback?vote=down');
  assert.equal(res.status, 200);
  const { entries } = await res.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].q, 'saga compensation');
  const all = await (await fetch(base + '/api/feedback')).json();
  assert.equal(all.entries.length, 2);
  assert.equal(all.entries[0].vote, 'down', 'newest first');
});

test('feedback validation + security', async () => {
  assert.equal((await post('/api/feedback', { q: 'x', page: 'wiki/topics/p.md', vote: 'meh' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/feedback', { q: '', page: 'wiki/topics/p.md', vote: 'up' }, { 'x-ui-token': token })).status, 400);
  assert.equal((await post('/api/feedback', { q: 'x', page: '../log.md', vote: 'up' }, { 'x-ui-token': token })).status, 400, 'page must be a wiki page');
  assert.equal((await post('/api/feedback', { q: 'x', page: 'wiki/topics/p.md', vote: 'up' })).status, 403, 'no token');
});
