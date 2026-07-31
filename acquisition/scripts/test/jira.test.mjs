// M5 tests: Jira connector against a mock node:http server (zero real network).
// Covers: happy path + identity five-tuple + extra fields, JQL pagination,
// incremental skip/update, Bearer auth + 401, config/PAT/JQL/--max errors,
// ADF extraction, non-compliant issue key, comment rendering, date normalization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { run, check, normalizeJiraDate, adfToText, issueToMarkdown, CONNECTOR_ID } from '../connectors/jira.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const PAT_ENV = 'JIRA_PAT_TEST_M5';
const PAT = 'test-secret-pat';

function makeIssue(key, over = {}) {
  return {
    key,
    fields: {
      summary: `${key} summary`,
      description: `${key} description body`,
      status: { name: 'Open' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      labels: ['backend'],
      components: [{ name: 'gateway' }],
      assignee: { displayName: 'Alice' },
      reporter: { name: 'bob' },
      created: '2026-07-01T09:00:00.000+0800',
      updated: '2026-07-28T10:30:00.000+0800',
      comment: {
        comments: [
          { author: { displayName: 'Alice' }, created: '2026-07-02T11:00:00.000+0800', body: 'first comment\nsecond line' },
        ],
      },
      fixVersions: [{ name: '1.2.0' }],
      ...over,
    },
  };
}

/** Mock Jira: routes myself + search; jqlSets maps JQL string -> issue array,
 *  errorSets maps JQL string -> HTTP error status. Records requests for
 *  assertions. Returns {baseUrl, requests, close}. */
async function mockJira(t, jqlSets, { requirePat = PAT, errorSets = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const authed = req.headers.authorization === `Bearer ${requirePat}`;
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!authed) return json(401, { errorMessages: ['Unauthorized'] });
    if (u.pathname === '/rest/api/2/myself') {
      return json(200, { name: 'alice', displayName: 'Alice A', emailAddress: 'a@example.com' });
    }
    if (u.pathname === '/rest/api/2/search') {
      const errStatus = errorSets[u.searchParams.get('jql')];
      if (errStatus) return json(errStatus, { errorMessages: ['bad JQL'] });
      const set = jqlSets[u.searchParams.get('jql')] || [];
      const startAt = Number(u.searchParams.get('startAt') || 0);
      const maxResults = Number(u.searchParams.get('maxResults') || 50);
      return json(200, { issues: set.slice(startAt, startAt + maxResults), total: set.length, startAt, maxResults });
    }
    return json(404, { errorMessages: ['not found'] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

let kb;
before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-jira-'));
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

test('happy path: issues land in raw/jira/<KEY>.md with identity five-tuple + extra', async (t) => {
  const { baseUrl } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-1'), makeIssue('PROJ-2')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.created.sort(), ['raw/jira/PROJ-1.md', 'raw/jira/PROJ-2.md']);
  assert.equal(s.total, 2);
  assert.deepEqual(s.errors, []);

  const raw = fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-1.md'), 'utf8');
  const { fields, body } = parseFrontmatter(raw);
  assert.equal(fields.source, 'jira');
  assert.equal(fields.source_id, 'PROJ-1');
  assert.equal(fields.source_url, `${baseUrl}/browse/PROJ-1`);
  // "+0800" offset normalized to strict ISO 8601
  assert.equal(fields.source_version, '2026-07-28T02:30:00.000Z');
  assert.equal(fields.connector, CONNECTOR_ID);
  assert.match(fields.content_hash, /^sha256:/);
  assert.equal(fields.title, '[PROJ-1] PROJ-1 summary');
  assert.equal(fields.extra.issue_type, 'Bug');
  assert.equal(fields.extra.status, 'Open');
  assert.equal(fields.extra.assignee, 'Alice');
  assert.equal(fields.extra.labels, 'backend');
  assert.equal(fields.extra.fix_versions, '1.2.0');
  assert.match(body, /# \[PROJ-1\] PROJ-1 summary/);
  // full-precision timestamps: the hash covers them, so same-day edits are visible
  assert.match(body, /- Created: 2026-07-01T01:00:00\.000Z {2}Updated: 2026-07-28T02:30:00\.000Z/);
  assert.match(body, /## Description\n\nPROJ-1 description body/);
  assert.match(body, /## Comments\n\n> \*\*Alice\*\* \(2026-07-02\):\n> first comment\n> second line/);

  const log = fs.readFileSync(path.join(kb, 'log.md'), 'utf8');
  assert.match(log, /acquire \| jira:created \| raw\/jira\/PROJ-1\.md \| key PROJ-1/);
});

test('incremental: second run is unchanged; changed issue is updated', async (t) => {
  const issues = [makeIssue('PROJ-3')];
  const { baseUrl } = await mockJira(t, { 'project = PROJ': issues });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  const again = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(again.unchanged, ['raw/jira/PROJ-3.md']);
  assert.deepEqual(again.created, []);

  issues[0] = makeIssue('PROJ-3', { summary: 'revised summary', updated: '2026-07-30T08:00:00.000+0800' });
  const third = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(third.updated, ['raw/jira/PROJ-3.md']);
  const { fields } = parseFrontmatter(fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-3.md'), 'utf8'));
  assert.equal(fields.source_version, '2026-07-30T00:00:00.000Z');
});

test('pagination: >PAGE_SIZE issues pulled across multiple search pages', async (t) => {
  const many = Array.from({ length: 120 }, (_, i) => makeIssue(`PROJ-${100 + i}`));
  const { baseUrl, requests } = await mockJira(t, { 'project = BIG': many });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { jql: ['project = BIG'] }) });
  assert.equal(s.created.length, 120);
  const starts = requests.filter((r) => r.path === '/rest/api/2/search').map((r) => r.query.startAt);
  assert.deepEqual(starts, ['0', '50', '100']);
});

test('dedupe: an issue matched by several JQLs is written once', async (t) => {
  const { baseUrl } = await mockJira(t, {
    'project = PROJ': [makeIssue('PROJ-7'), makeIssue('PROJ-8')],
    'assignee = alice': [makeIssue('PROJ-7')],
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { jql: ['project = PROJ', 'assignee = alice'] }) });
  assert.equal(s.total, 2);
  assert.deepEqual(s.created.sort(), ['raw/jira/PROJ-7.md', 'raw/jira/PROJ-8.md']);
});

test('auth: Bearer header is sent; 401 fails without leaking the PAT', async (t) => {
  const { baseUrl, requests } = await mockJira(t, { 'project = PROJ': [] });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(requests[0].auth, `Bearer ${PAT}`);

  process.env[PAT_ENV] = 'wrong-pat';
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl) }), /jira authentication failed HTTP 401/);
  process.env[PAT_ENV] = PAT;
  try {
    process.env[PAT_ENV] = 'wrong-pat';
    await run(kb, { kbConfig: kbConf(baseUrl) });
  } catch (err) {
    assert.ok(!err.message.includes('wrong-pat'), 'error message must not contain the PAT');
  } finally {
    process.env[PAT_ENV] = PAT;
  }
});

test('config errors: missing base_url / PAT / JQL / bad --max', async (t) => {
  const { baseUrl } = await mockJira(t, {});
  await assert.rejects(() => run(kb, { kbConfig: { connectors: { jira: {} } } }),
    /jira connector is not configured: set connectors\.jira\.base_url in kb\.json/);

  delete process.env[PAT_ENV];
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl) }),
    new RegExp(`jira PAT not available: environment variable ${PAT_ENV} is not set`));
  process.env[PAT_ENV] = PAT;

  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl, { jql: [] }) }),
    /no JQL scope: pass --jql or set connectors\.jira\.jql in kb\.json/);
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl), maxResults: 'abc' }),
    /--max must be a positive integer/);
});

test('CLI --jql override wins over kb.json scope', async (t) => {
  const { baseUrl, requests } = await mockJira(t, { 'project = ONE': [makeIssue('PROJ-9')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl), jql: 'project = ONE' });
  assert.deepEqual(s.created, ['raw/jira/PROJ-9.md']);
  assert.equal(requests.find((r) => r.path === '/rest/api/2/search').query.jql, 'project = ONE');
});

test('non-compliant issue key is skipped with an error, never written', async (t) => {
  const { baseUrl } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ 1'), makeIssue('PROJ-10')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.created, ['raw/jira/PROJ-10.md']);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].error, /non-compliant issue key \(contract §2\): PROJ 1/);
  assert.ok(!fs.existsSync(path.join(kb, 'raw', 'jira', 'PROJ 1.md')));
});

test('same-day second edit is NOT invisible (full-precision updated in the hashed body)', async (t) => {
  const issues = [makeIssue('PROJ-11')];
  const { baseUrl } = await mockJira(t, { 'project = PROJ': issues });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  // edit again the SAME day (Jira bumps `updated` on every edit)
  issues[0] = makeIssue('PROJ-11', { summary: 'edited again', updated: '2026-07-28T15:00:00.000+0800' });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.updated, ['raw/jira/PROJ-11.md'], 'same-day edit must not be skipped as unchanged');
  const { fields } = parseFrontmatter(fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-11.md'), 'utf8'));
  assert.equal(fields.source_version, '2026-07-28T07:00:00.000Z');
});

test('--max truncation is reported, never silent (no-silent-caps)', async (t) => {
  const { baseUrl } = await mockJira(t, { 'project = PROJ': [makeIssue('PROJ-20'), makeIssue('PROJ-21'), makeIssue('PROJ-22')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl), maxResults: 2 });
  assert.equal(s.created.length, 2);
  assert.deepEqual(s.truncated, [{ jql: 'project = PROJ', fetched: 2, total: 3 }]);
});

test('per-scope failure is recorded and the remaining scopes still run', async (t) => {
  const { baseUrl } = await mockJira(
    t,
    { 'project = GOOD': [makeIssue('PROJ-30')] },
    { errorSets: { 'project = BROKEN jql': 400 } },
  );
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { jql: ['project = BROKEN jql', 'project = GOOD'] }) });
  assert.deepEqual(s.created, ['raw/jira/PROJ-30.md']);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].jql, 'project = BROKEN jql');
  assert.match(s.errors[0].error, /jira request failed HTTP 400/);
});

test('auth failure (401/403) fails fast instead of degrading to per-scope errors', async (t) => {
  const { baseUrl } = await mockJira(
    t,
    { 'project = GOOD': [makeIssue('PROJ-31')] },
    { errorSets: { 'project = PROJ': 403 } },
  );
  await assert.rejects(
    () => run(kb, { kbConfig: kbConf(baseUrl, { jql: ['project = PROJ', 'project = GOOD'] }) }),
    /jira authentication failed HTTP 403/,
  );
});

test('check(): myself endpoint round-trip', async (t) => {
  const { baseUrl } = await mockJira(t, {});
  const me = await check(kbConf(baseUrl));
  assert.deepEqual(me, { name: 'alice', displayName: 'Alice A', emailAddress: 'a@example.com' });
});

test('unit: normalizeJiraDate / adfToText / issueToMarkdown edge cases', () => {
  assert.equal(normalizeJiraDate('2026-07-28T10:30:00.000+0800'), '2026-07-28T02:30:00.000Z');
  assert.equal(normalizeJiraDate('not a date'), 'not a date');
  assert.equal(normalizeJiraDate(''), '');

  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] }] };
  // minimal fallback: sibling nodes are newline-joined, format fidelity is not a goal
  assert.equal(adfToText(adf), '\nhello\n world');
  assert.equal(adfToText('plain string'), 'plain string');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText({ type: 'hardBreak' }), '\n');
  assert.equal(adfToText({ type: 'mention', attrs: { text: '@Alice' } }), '@Alice');

  const md = issueToMarkdown(makeIssue('PROJ-1', {
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'adf body' }] }] },
    comment: { comments: [] },
  }), 'https://jira.example.com');
  assert.match(md, /## Description\n\nadf body/);
  assert.ok(!md.includes('## Comments'), 'no comments section when there are no comments');
});
