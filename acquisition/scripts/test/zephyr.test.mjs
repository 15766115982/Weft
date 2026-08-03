// Phase-1 tests: Zephyr Squad test steps (ZAPI) against a mock node:http server.
// Covers: happy path (steps table, numeric issue.id, extra.test_steps),
// auto-probe degrade on 404/403 (one probe per run), zephyr:false, forced-true
// failure isolation, Scale hint, shape-mismatch diagnostics (no values),
// custom test_issue_types, parseTestSteps units, probeZephyr shape output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { run, parseTestSteps, testStepsToMarkdown, probeZephyr } from '../connectors/jira.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const PAT_ENV = 'JIRA_PAT_TEST_ZEPHYR';
const PAT = 'test-secret-pat';

function makeIssue(key, id, type = 'Test', over = {}) {
  return {
    key,
    id: String(id),
    fields: {
      summary: `${key} summary`,
      description: `${key} description`,
      status: { name: 'Open' },
      issuetype: { name: type },
      priority: { name: 'High' },
      labels: [],
      components: [],
      assignee: { displayName: 'Alice' },
      reporter: { displayName: 'Bob' },
      created: '2026-07-01T09:00:00.000+0800',
      updated: '2026-07-28T10:30:00.000+0800',
      comment: { comments: [] },
      fixVersions: [],
      ...over,
    },
  };
}

const STEPS = [
  { id: 11, orderId: 2, step: 'second step', data: 'data-2', result: 'result-2' },
  { id: 10, orderId: 1, step: 'first | step', data: 'data-1\ntwo lines', result: 'result-1' },
];

/** Mock Jira + ZAPI: zapiSets maps numeric issue id -> steps array (or
 *  {status}), atmStatus is the Scale probe's HTTP code. */
async function mockJira(t, jqlSets, { zapiSets = {}, atmStatus = 404 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${PAT}`) return json(401, {});
    if (u.pathname === '/rest/api/2/search') {
      const set = jqlSets[u.searchParams.get('jql')] || [];
      const startAt = Number(u.searchParams.get('startAt') || 0);
      const maxResults = Number(u.searchParams.get('maxResults') || 50);
      return json(200, { issues: set.slice(startAt, startAt + maxResults), total: set.length, startAt, maxResults });
    }
    const zapi = u.pathname.match(/^\/rest\/zapi\/latest\/teststep\/(\d+)$/);
    if (zapi) {
      const v = zapiSets[zapi[1]];
      if (v === undefined) return json(404, {});
      if (v.status) return json(v.status, {});
      return json(200, v);
    }
    const atm = u.pathname.match(/^\/rest\/atm\/1\.0\/testcase\/(.+)$/);
    if (atm) return json(atmStatus, atmStatus === 200 ? { key: atm[1] } : {});
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const zapiRequests = () => requests.filter((r) => r.path.startsWith('/rest/zapi/'));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, zapiRequests };
}

let kb;
before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-zephyr-'));
  process.env[PAT_ENV] = PAT;
});
after(() => {
  delete process.env[PAT_ENV];
  fs.rmSync(kb, { recursive: true, force: true });
});

const kbConf = (baseUrl, extra = {}) => ({
  version: 1,
  connectors: { jira: { base_url: baseUrl, pat_env: PAT_ENV, jql: ['project = PROJ'], ...extra } },
});

test('happy: Test issue gets ordered steps table; Bug issues never hit ZAPI', async (t) => {
  const { baseUrl, zapiRequests } = await mockJira(t, {
    'project = PROJ': [makeIssue('PROJ-T1', 1001), makeIssue('PROJ-B1', 1002, 'Bug')],
  }, { zapiSets: { 1001: STEPS } });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(s.zephyr, 'available');
  assert.equal(s.test_steps, 2);
  assert.deepEqual(s.errors, []);

  // numeric issue.id in the ZAPI path, exactly one ZAPI call (not for the Bug)
  assert.equal(zapiRequests().length, 1);
  assert.equal(zapiRequests()[0].path, '/rest/zapi/latest/teststep/1001');
  assert.equal(zapiRequests()[0].auth, `Bearer ${PAT}`);

  const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-T1.md'), 'utf8'));
  assert.equal(fields.extra.test_steps, '2');
  // ordered by orderId (step orderId:1 comes first), pipes escaped, newlines collapsed
  assert.match(body, /## Test Steps\n\n\| # \| Step \| Test Data \| Expected Result \|/);
  assert.match(body, /\| 1 \| first \\\| step \| data-1 two lines \| result-1 \|/);
  assert.match(body, /\| 2 \| second step \| data-2 \| result-2 \|/);

  const bug = fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-B1.md'), 'utf8');
  assert.ok(!bug.includes('## Test Steps'));
});

test('auto + ZAPI 404: probes once per run, degrades to plain issues', async (t) => {
  const { baseUrl, zapiRequests } = await mockJira(t, {
    'project = PROJ': [makeIssue('PROJ-T2', 2001), makeIssue('PROJ-T3', 2002)],
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(s.zephyr, 'unavailable');
  assert.equal(zapiRequests().length, 1, 'auto mode must not retry every Test issue');
  assert.equal(s.created.length, 2);
  const body = fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-T2.md'), 'utf8');
  assert.ok(!body.includes('## Test Steps'));
});

test('auto + ZAPI 404 + Scale endpoint 200: zephyr_hint points at Scale', async (t) => {
  const { baseUrl } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-T4', 4001)] }, { atmStatus: 200 });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(s.zephyr, 'unavailable');
  assert.match(s.zephyr_hint, /Zephyr Scale/);
});

test('zephyr:false never calls ZAPI; zephyr field reads disabled', async (t) => {
  const { baseUrl, zapiRequests } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-T5', 5001)] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { zephyr: false }) });
  assert.equal(s.zephyr, 'disabled');
  assert.equal(zapiRequests().length, 0);
});

test('no Test-type issues: zephyr field omitted entirely', async (t) => {
  const { baseUrl, zapiRequests } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-B2', 6001, 'Bug')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.ok(!('zephyr' in s));
  assert.equal(zapiRequests().length, 0);
});

test('forced true + ZAPI 500: plain issue lands, failure is recorded, run continues', async (t) => {
  const { baseUrl } = await mockJira(t, {
    'project = PROJ': [makeIssue('PROJ-T6', 7001), makeIssue('PROJ-T7', 7002)],
  }, { zapiSets: { 7001: { status: 500 }, 7002: STEPS } });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { zephyr: true }) });
  assert.equal(s.zephyr, 'available');
  assert.equal(s.created.length, 2);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].key, 'PROJ-T6');
  assert.match(s.errors[0].error, /zephyr steps: zapi teststep HTTP 500/);
  const ok = fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-T7.md'), 'utf8');
  assert.match(ok, /## Test Steps/);
});

test('shape mismatch: ZAPI returns an object — error names keys, never values', async (t) => {
  const secret = 'S3CRET-STEP-CONTENT';
  const { baseUrl } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-T8', 8001)] }, {
    zapiSets: { 8001: { stepBeanCollection: [{ step: secret }], totalCount: 1 } },
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].error, /expected array, got object\(keys=stepBeanCollection,totalCount\)/);
  assert.ok(!s.errors[0].error.includes(secret), 'diagnostics must never contain values');
});

test('custom test_issue_types are honored', async (t) => {
  const { baseUrl, zapiRequests } = await mockJira(t, {
    'project = PROJ': [makeIssue('PROJ-C1', 9001, 'TestCase')],
  }, { zapiSets: { 9001: STEPS } });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { test_issue_types: ['TestCase'] }) });
  assert.equal(s.zephyr, 'available');
  assert.equal(zapiRequests().length, 1);
});

test('config validation: bad zephyr / test_issue_types values throw', async (t) => {
  const { baseUrl } = await mockJira(t, {});
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl, { zephyr: 'yes' }) }),
    /connectors\.jira\.zephyr must be "auto" \| true \| false/);
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl, { test_issue_types: 'Test' }) }),
    /test_issue_types must be an array/);
});

test('probeZephyr: shape summary with no values; ORDER BY stays last', async (t) => {
  const { baseUrl, requests } = await mockJira(t, {
    'project = PROJ AND issuetype = "Test" ORDER BY updated DESC': [makeIssue('PROJ-TP', 9101)],
  }, { zapiSets: { 9101: STEPS } });
  const out = await probeZephyr(kbConf(baseUrl, { jql: ['project = PROJ ORDER BY updated DESC'] }));
  assert.equal(out.probe, true);
  assert.equal(out.issue_key, 'PROJ-TP');
  assert.deepEqual(out.zephyr, {
    http: 200, isArray: true, count: 2,
    firstItemKeys: ['id', 'orderId', 'step', 'data', 'result'],
  });
  assert.equal(requests.find((r) => r.path === '/rest/api/2/search').query.jql,
    'project = PROJ AND issuetype = "Test" ORDER BY updated DESC');
});

test('probeZephyr: no Test issue / ZAPI down both report safely', async (t) => {
  const empty = await mockJira(t, {});
  const none = await probeZephyr(kbConf(empty.baseUrl));
  assert.equal(none.note, 'no-test-issue-found');

  const down = await mockJira(t, { 'project = PROJ AND issuetype = "Test"': [makeIssue('PROJ-TQ', 9201)] });
  const out = await probeZephyr(kbConf(down.baseUrl));
  assert.equal(out.zephyr.http, 404);
  assert.equal(out.scale.http, 404);
});

test('unit: parseTestSteps ordering, html fallback, missing fields, non-array', () => {
  const parsed = parseTestSteps([
    { orderId: 2, htmlStep: '<p>html <b>step</b></p>', htmlData: '&lt;tag&gt;', htmlResult: 'ok' },
    { orderId: 1, step: 'plain' }, // data/result missing
  ]);
  assert.deepEqual(parsed, [
    { n: 1, orderId: 1, step: 'plain', data: '', result: '' },
    { n: 2, orderId: 2, step: 'html step', data: '<tag>', result: 'ok' },
  ]);
  assert.throws(() => parseTestSteps({ steps: [] }), /expected array, got object\(keys=steps\)/);
  assert.equal(testStepsToMarkdown([]), '');
  assert.equal(testStepsToMarkdown(null), '');
});
