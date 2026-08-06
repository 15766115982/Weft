// Open-portal regression suite (2026-08-06): the role gating experiment was
// reverted — every GET is public, writes stay token-gated. This suite pins the
// full endpoint matrix so the gates cannot silently come back, and keeps the
// settings masking / write-token contract checks from the old authz suite.
// Harness: test/fixtures/kb.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPortal } from '../serve.mjs';
import { buildFixtureKb, rmFixtureKb, writeLlmStub } from './fixtures/kb.mjs';

// Every formerly operator-only GET with the query params it needs to reach 200.
const FORMER_OPERATOR_GETS = [
  ['/api/settings', ''],
  ['/api/plan', ''],
  ['/api/conflicts', ''],
  ['/api/decisions', ''],
  ['/api/detect', ''],
  ['/api/rawlist', ''],
  ['/api/raw', '?path=' + encodeURIComponent('raw/jira/PROJ-1.md')],
  ['/api/raw-asset', '?path=' + encodeURIComponent('raw/jira/PROJ-1.assets/diagram.png')],
  ['/api/inbox', ''],
  ['/api/sources', ''],
  ['/api/jobs', ''],
  ['/api/diff', '?path=' + encodeURIComponent('wiki/sources/jira-proj-1.md')],
  ['/api/kbfile', '?path=GOVERNANCE.md'],
  ['/api/history', '?path=' + encodeURIComponent('wiki/sources/jira-proj-1.md')],
  ['/api/queue', ''],
];

const PUBLIC_GETS = [
  '/api/tree',
  '/api/health',
  '/api/page?path=' + encodeURIComponent('wiki/syntheses/alpha.md'),
  '/api/backlinks?path=' + encodeURIComponent('wiki/sources/jira-proj-1.md'),
  '/api/graph',
  '/api/rawrefs?path=' + encodeURIComponent('raw/jira/PROJ-1.md'),
  '/api/search?q=payment',
  '/api/log',
  '/api/feedback',
  '/api/govern-context',
  '/api/kbs',
];

let kb, server, base, token, llmStubDir;

before(async () => {
  kb = buildFixtureKb();
  llmStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stub-'));
  process.env.WEFT_LLM_CLI = writeLlmStub(llmStubDir);
  server = createPortal({ kb, port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
});

after(() => {
  server.close();
  delete process.env.WEFT_LLM_CLI;
  rmFixtureKb(kb);
  fs.rmSync(llmStubDir, { recursive: true, force: true });
});

test('open portal: every formerly operator-only GET is public', async () => {
  for (const [p, qs] of FORMER_OPERATOR_GETS) {
    const res = await fetch(base + p + qs);
    assert.equal(res.status, 200, `${p} must be public (got ${res.status})`);
  }
});

test('public GETs still work (guard against accidental new gates)', async () => {
  for (const p of PUBLIC_GETS) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `${p} must stay public (got ${res.status})`);
  }
});

test('role artifacts are gone: /api/session and /api/admin/* 404', async () => {
  assert.equal((await fetch(base + '/api/session')).status, 404);
  // POSTs pass the write-token gate first, then hit the (now absent) route.
  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': token },
    body: '{}',
  });
  assert.equal(login.status, 404);
});

test('SSE /api/events opens without any auth', async () => {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  await res.body.cancel();
});

test('settings masks secret values', async () => {
  const res = await fetch(base + '/api/settings');
  const data = await res.json();
  assert.equal(res.status, 200);
  if (data.config?.auth?.api_key) {
    assert.match(data.config.auth.api_key, /^env:/);
  }
});

test('writes still require the per-startup token', async () => {
  const res = await fetch(base + '/api/settings/check', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 403);
  const ok = await fetch(base + '/api/settings/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': token },
    body: '{}',
  });
  assert.equal(ok.status, 202);
});
