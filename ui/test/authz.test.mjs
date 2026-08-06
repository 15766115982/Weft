// ADR-0009 role-gating regression suite (plan §2): the full operator-GET
// matrix in all three auth states (reader / admin / unconfigured), session
// lifecycle, settings masking, chat reader-access, and the known G1 gap.
// Harness: test/helpers/auth.mjs + test/fixtures/kb.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createPortal } from '../serve.mjs';
import {
  TEST_ADMIN_PASSWORD, useTestAdminEnv, clearTestAdminEnv, adminLogin, adminCookie,
} from './helpers/auth.mjs';
import { buildFixtureKb, rmFixtureKb, writeLlmStub } from './fixtures/kb.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every operator GET with the query params it needs to reach a 200.
const OPERATOR_GETS = [
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

const READER_GETS = [
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

let kb, kbNoConfig, server, serverOpen, serverNoCfg, base, baseOpen, baseNoCfg, token, cookie, llmStubDir;

async function listen(s) {
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}`;
}

before(async () => {
  kb = buildFixtureKb();
  kbNoConfig = buildFixtureKb({ config: false, detect: false });
  llmStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-stub-'));
  process.env.WEFT_LLM_CLI = writeLlmStub(llmStubDir);

  // adminAuth captures the env var at createPortal() time — toggle per server.
  useTestAdminEnv();
  server = createPortal({ kb, port: 0 });
  base = await listen(server);

  clearTestAdminEnv();
  serverOpen = createPortal({ kb, port: 0 }); // unconfigured variant
  baseOpen = await listen(serverOpen);

  useTestAdminEnv();
  serverNoCfg = createPortal({ kb: kbNoConfig, port: 0 }); // no .kb/config variant
  baseNoCfg = await listen(serverNoCfg);

  const html = await (await fetch(base + '/')).text();
  token = html.match(/name="ui-token" content="([^"]+)"/)[1];
  cookie = await adminCookie(base);
});

after(() => {
  server.close();
  serverOpen.close();
  serverNoCfg.close();
  rmFixtureKb(kb);
  rmFixtureKb(kbNoConfig);
  fs.rmSync(llmStubDir, { recursive: true, force: true });
  delete process.env.WEFT_LLM_CLI;
  clearTestAdminEnv();
});

const get = (p, hdrs = {}) => fetch(base + p, { headers: hdrs });
const authed = (p) => get(p, { cookie });
const post = (p, obj, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj),
});

// ---- drift protection: the table above must match serve.mjs exactly ----

test('OPERATOR_GET_PATHS drift guard: table matches serve.mjs', () => {
  const src = fs.readFileSync(path.join(UI_DIR, 'serve.mjs'), 'utf8');
  const m = src.match(/const OPERATOR_GET_PATHS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, 'OPERATOR_GET_PATHS set found in serve.mjs');
  const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  const table = OPERATOR_GETS.map(([p]) => p).sort();
  assert.deepEqual(listed, table, 'a new operator endpoint missing from the test table (or vice versa)');
});

// ---- A: session lifecycle ----

test('A1 session state: configured, logged out → admin false', async () => {
  const res = await get('/api/session');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { admin: false, configured: true });
});

test('A2 session state after login → admin true', async () => {
  const res = await authed('/api/session');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { admin: true, configured: true });
});

test('A3 session state on an unconfigured portal → configured false', async () => {
  const res = await fetch(baseOpen + '/api/session');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { admin: false, configured: false });
});

test('A4 login with a wrong password → 401, no set-cookie', async () => {
  const { res, cookie: c } = await adminLogin(base, 'wrong-password');
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /invalid password/);
  assert.equal(c, null, 'no session cookie issued');
});

test('A5 login on an unconfigured portal → 401 not configured', async () => {
  const { res } = await adminLogin(baseOpen, TEST_ADMIN_PASSWORD);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /not configured/);
});

test('A6 login sets the session cookie (HttpOnly, SameSite=Strict)', async () => {
  const { res, cookie: c } = await adminLogin(base);
  assert.equal(res.status, 200);
  assert.match(c, /^weft_session=.+/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Path=\//);
  assert.match(c, /SameSite=Strict/);
});

test('A7 logout invalidates the session', async () => {
  const c = await adminCookie(base);
  const out = await post('/api/admin/logout', {}, { cookie: c });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /weft_session=;/, 'cookie cleared');
  const after2 = await get('/api/settings', { cookie: c });
  assert.equal(after2.status, 401, 'replayed cookie no longer authenticates');
});

// ---- A8-A11: the operator/reader GET matrix ----

test('A8 operator GETs reject readers with 401 (parametrized)', async () => {
  for (const [p, q] of OPERATOR_GETS) {
    const res = await get(p + q);
    assert.equal(res.status, 401, `${p} must refuse readers`);
    assert.match((await res.json()).error, /admin session required/, p);
  }
});

test('A9 operator GETs on an unconfigured portal → 403 not configured', async () => {
  for (const [p, q] of OPERATOR_GETS) {
    const res = await fetch(baseOpen + p + q);
    assert.equal(res.status, 403, `${p}: 403 (disabled) must be distinct from 401 (log in)`);
    assert.match((await res.json()).error, /not configured/, p);
  }
});

test('A10 operator GETs succeed as admin (parametrized) + shape spot-checks', async () => {
  for (const [p, q] of OPERATOR_GETS) {
    const res = await authed(p + q);
    assert.equal(res.status, 200, `${p} as admin → 200 (got ${res.status})`);
  }
  const queue = await (await authed('/api/queue')).json();
  assert.deepEqual(queue.pages.map((p) => p.path), ['wiki/syntheses/alpha.md'], 'queue is candidates only');
  const detect = await (await authed('/api/detect')).json();
  assert.equal(detect.connector, 'jira');
  assert.ok(detect.generated_at);
  assert.ok(Array.isArray(detect.detect.new), 'buckets wrapped under detect');
  const settings = await (await authed('/api/settings')).json();
  assert.equal(settings.admin_configured, true);
  assert.ok(settings.config && settings.prompts && settings.env, 'settings shape');
  const detectOpen = await (await authed('/api/detect')).json();
  assert.ok(detectOpen.detect, 'detect report present from fixture');
});

test('A10b detect null-shape when no report exists', async () => {
  const res = await fetch(baseNoCfg + '/api/detect', { headers: { cookie: await adminCookie(baseNoCfg) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connector: null, generated_at: null, detect: null });
});

test('A11 reader endpoints stay public (parametrized, no cookie)', async () => {
  for (const p of READER_GETS) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} must stay public (over-gating regression)`);
  }
});

test('A12 SSE /api/events stays open to readers', async () => {
  const first = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/events', (res) => {
      res.setEncoding('utf8');
      res.once('data', (chunk) => { req.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], chunk }); });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('no SSE data')); }, 3000);
  }).catch((e) => { throw e; });
  assert.equal(first.status, 200);
  assert.match(first.type, /text\/event-stream/);
  assert.ok(first.chunk.startsWith(': connected'), `first frame is the connected comment: ${JSON.stringify(first.chunk)}`);
});

// ---- S: settings ----

test('S1 settings masks secrets (env: prefix, never the raw value)', async () => {
  const data = await (await authed('/api/settings')).json();
  assert.equal(data.config.auth.api_key, 'env:WEFT_LLM_API_KEY');
  assert.notEqual(data.config.auth.api_key, 'WEFT_LLM_API_KEY', 'raw env var name unmasked');
});

test('S2 settings without models.json → config null, prompts []', async () => {
  const c = await adminCookie(baseNoCfg);
  const res = await fetch(baseNoCfg + '/api/settings', { headers: { cookie: c } });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.config, null);
  assert.deepEqual(data.prompts, []);
});

test('S3 settings lists prompts (file, title from first heading, size; sorted)', async () => {
  const { prompts } = await (await authed('/api/settings')).json();
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map((p) => p.file), ['chat.md', 'govern.md'], 'sorted by file name');
  assert.equal(prompts[0].title, 'Chat prompt', 'title from the first # heading');
  assert.equal(prompts[1].title, 'Govern prompt');
  assert.ok(prompts.every((p) => p.size > 0));
});

test('S4 settings env flags reflect the harness', async () => {
  const { env } = await (await authed('/api/settings')).json();
  assert.equal(env.WEFT_ADMIN_PASSWORD_HASH, true);
  assert.equal(env.KB_PATH, !!process.env.KB_PATH, 'KB_PATH mirrors the environment (harness uses --kb, not KB_PATH)');
});

test('S5 settings/check requires admin', async () => {
  const res = await post('/api/settings/check', {});
  assert.equal(res.status, 401);
});

test('S6 settings/check enqueues an llm-check job', async () => {
  const res = await post('/api/settings/check', {}, { cookie });
  assert.equal(res.status, 202);
  const { job } = await res.json();
  assert.equal(job.type, 'llm-check');
});

test('S7 init-prompts default vs force (force flag reaches the job spec)', async () => {
  const jobsDir = path.join(kb, '.kb', 'ui', 'jobs');
  const before2 = new Set(fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : []);

  const def = await post('/api/settings/init-prompts', {}, { cookie });
  assert.equal(def.status, 202);
  assert.equal((await def.json()).job.type, 'llm-init-prompts');

  const forced = await post('/api/settings/init-prompts', { force: true }, { cookie });
  assert.equal(forced.status, 202);
  assert.equal((await forced.json()).job.type, 'llm-init-prompts');

  // llmJobSpec writes the transient input file synchronously at enqueue time;
  // the spawned job deletes it on completion — poll briefly for it.
  let spec = null;
  for (let i = 0; i < 50 && !spec; i++) {
    const fresh = (fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [])
      .filter((f) => f.startsWith('init-prompts-in-') && !before2.has(f));
    if (fresh.length) spec = JSON.parse(fs.readFileSync(path.join(jobsDir, fresh[fresh.length - 1]), 'utf8'));
    else await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(spec, 'init-prompts input file observed before the job cleaned it up');
  assert.equal(spec.force, true, 'force flag propagated to the job spec');
});

// ---- C: chat is a reader feature ----

async function readSseFrames(res) {
  const text = await res.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    frames.push({
      event: eventLine ? eventLine.slice(6).trim() : 'message',
      data: dataLine && dataLine.slice(5).trim() ? JSON.parse(dataLine.slice(5).trim()) : null,
    });
  }
  return frames;
}

test('C1 chat needs no admin cookie (token only) and streams meta/chunk/done', async () => {
  const res = await post('/api/chat', { question: 'hi', level: 'quick' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const frames = await readSseFrames(res);
  const data = frames.map((f) => f.data).filter(Boolean);
  assert.equal(data[0].type, 'meta');
  assert.ok(data.some((d) => d.type === 'chunk' && d.text === 'hello '));
  assert.ok(data.some((d) => d.type === 'chunk' && d.text === 'world'));
  assert.ok(data.some((d) => d.type === 'done'));
});

test('C2 chat still requires the write token', async () => {
  const res = await post('/api/chat', { question: 'hi' });
  assert.equal(res.status, 403);
});

test('C3 chat validates input', async () => {
  for (const body of [{ question: '' }, { question: '   ' }, {}]) {
    const res = await post('/api/chat', body, { 'x-ui-token': token });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /question required/);
  }
});

test('C4 chat level falls back to quick', async () => {
  const res = await post('/api/chat', { question: 'hi', level: 'bogus' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  const frames = await readSseFrames(res);
  assert.equal(frames[0].data.level, 'quick', 'stub received the normalized level');
});

test('C5 deep-research streams search/read steps before done with citations', async () => {
  const res = await post('/api/chat', { question: 'deep dive', level: 'deep' }, { 'x-ui-token': token });
  assert.equal(res.status, 200);
  const data = (await readSseFrames(res)).map((f) => f.data).filter(Boolean);
  const idx = (t) => data.findIndex((d) => d.type === t);
  assert.ok(idx('search') > -1 && idx('read') > -1, 'step frames present');
  assert.ok(idx('search') < idx('done') && idx('read') < idx('done'), 'steps precede done');
  assert.deepEqual(data[idx('done')].citations, ['wiki/sources/x.md']);
});

test('C6 chat child failure surfaces as SSE error, then close (no hang)', async () => {
  const good = process.env.WEFT_LLM_CLI;
  process.env.WEFT_LLM_CLI = writeLlmStub(llmStubDir, { fail: true });
  try {
    const res = await post('/api/chat', { question: 'boom', level: 'quick' }, { 'x-ui-token': token });
    assert.equal(res.status, 200);
    const frames = await readSseFrames(res);
    const err = frames.find((f) => f.event === 'error');
    assert.ok(err, 'an event:error frame is emitted');
    assert.match(err.data.message, /stub llm failure/);
    assert.ok(frames.some((f) => f.event === 'close'), 'stream closes after the error');
  } finally {
    process.env.WEFT_LLM_CLI = good;
  }
});

// ---- G1: decided gap — writes stay token-gated (DEVLOG 2026-08-06) ----

test('G1 DECIDED: mutating POSTs are token-gated only, not session-gated', async () => {
  // ADR-0009 gates operator GETs; writes pass with only the UI token. Decision
  // recorded in DEVLOG (2026-08-06): writes stay token-gated — chat/feedback are
  // reader features that write, and the token + loopback Host/Origin checks are
  // the write boundary. Operator-only writes would be a new ADR; then flip this
  // to expect 401 without a session cookie.
  const res = await post('/api/review', {
    path: 'wiki/syntheses/alpha.md', action: 'approve', reason: 'G1 probe',
  }, { 'x-ui-token': token });
  assert.equal(res.status, 200, 'current behavior: write succeeds without an admin session');
});
