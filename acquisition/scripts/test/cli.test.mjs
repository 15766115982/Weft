// CLI-level tests: boolean flag strictness (L1 review fix) + jira/confluence
// end-to-end against a mock node:http server (async spawn — a sync spawn would
// block the event loop and starve the mock server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ACQUIRE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'acquire.mjs');

test('--prune with a non-boolean value fails loudly instead of silently degrading to report-only', () => {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-cli-'));
  const bad = spawnSync('node', [ACQUIRE, 'local', '--kb', kb, '--prune', 'yes'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--prune is a boolean flag and takes no value/);
  // `--prune true` spells the same intent and works
  const ok = spawnSync('node', [ACQUIRE, 'local', '--kb', kb, '--prune', 'true'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  fs.rmSync(kb, { recursive: true, force: true });
});

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ACQUIRE, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('detect CLI end-to-end: read-only, writes upstream-detect.json, does not write raw or acquire_runs', async (t) => {
  const baseUrl = await mockJira(t);
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-detect-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({
    version: 1,
    connectors: { jira: { base_url: baseUrl, pat_env: PAT_ENV, jql: ['project = PROJ'] } },
  }));

  const detect1 = await runCli(['detect', 'jira', '--kb', kb], { [PAT_ENV]: 'cli-pat' });
  assert.equal(detect1.code, 0, detect1.stderr);
  const out1 = JSON.parse(detect1.stdout);
  assert.equal(out1.connector, 'jira');
  assert.ok(out1.detect);
  assert.equal(out1.detect.new.length, 1);
  assert.equal(out1.detect.new[0].id, 'PROJ-42');
  assert.ok(fs.existsSync(path.join(kb, '.kb', 'acquire', 'upstream-detect.json')));
  assert.ok(!fs.existsSync(path.join(kb, 'raw', 'jira')), 'detect must not write raw/');
  assert.ok(!fs.existsSync(path.join(kb, '.kb', 'acquire_runs.jsonl')), 'detect must not record a pull');

  // pull then detect again → unchanged
  const pull = await runCli(['jira', '--kb', kb], { [PAT_ENV]: 'cli-pat' });
  assert.equal(pull.code, 0, pull.stderr);
  const detect2 = await runCli(['detect', 'jira', '--kb', kb], { [PAT_ENV]: 'cli-pat' });
  const out2 = JSON.parse(detect2.stdout);
  assert.equal(out2.detect.unchanged.length, 1);
  assert.equal(out2.detect.new.length, 0);
});

const PAT_ENV = 'JIRA_PAT_CLI_M5';

async function mockJira(t) {
  const issue = {
    key: 'PROJ-42',
    fields: {
      summary: 'CLI end-to-end issue', description: 'pulled through the real CLI',
      status: { name: 'Open' }, issuetype: { name: 'Task' }, priority: { name: 'Medium' },
      labels: [], components: [], assignee: null, reporter: { displayName: 'Carol' },
      created: '2026-07-20T09:00:00.000+0800', updated: '2026-07-29T09:00:00.000+0800',
      comment: { comments: [] }, fixVersions: [],
    },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer cli-pat') return json(401, {});
    if (u.pathname === '/rest/api/2/myself') return json(200, { name: 'carol', displayName: 'Carol C' });
    if (u.pathname === '/rest/api/2/search') return json(200, { issues: [issue], total: 1 });
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('jira CLI end-to-end: kb.json config + env PAT → raw/jira doc + JSON summary', async (t) => {
  const baseUrl = await mockJira(t);
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-jira-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({
    version: 1,
    connectors: { jira: { base_url: baseUrl, pat_env: PAT_ENV, jql: ['project = PROJ'] } },
  }));

  const r = await runCli(['jira', '--kb', kb], { [PAT_ENV]: 'cli-pat' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.connector, 'jira');
  assert.deepEqual(out.created, ['raw/jira/PROJ-42.md']);
  const doc = fs.readFileSync(path.join(kb, 'raw', 'jira', 'PROJ-42.md'), 'utf8');
  assert.match(doc, /source_id: PROJ-42/);
  assert.match(doc, /# \[PROJ-42\] CLI end-to-end issue/);

  const me = await runCli(['jira', '--kb', kb, '--check'], { [PAT_ENV]: 'cli-pat' });
  assert.equal(me.code, 0, me.stderr);
  assert.equal(JSON.parse(me.stdout).myself.displayName, 'Carol C');

  const bad = await runCli(['jira', '--kb', kb, '--check', 'yes'], { [PAT_ENV]: 'cli-pat' });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--check is a boolean flag and takes no value/);
});

const CONF_PAT_ENV = 'CONFLUENCE_PAT_CLI_M6';

async function mockConfluence(t) {
  const page = {
    id: '123456', type: 'page', title: 'CLI end-to-end page', status: 'current',
    space: { key: 'DEV' },
    version: { number: 2, when: '2026-07-29T09:00:00.000+08:00', by: { displayName: 'Carol' } },
    ancestors: [], metadata: { labels: { results: [] } },
    body: { storage: { value: '<p>pulled through the real CLI</p>' } },
    _links: { webui: '/pages/viewpage.action?pageId=123456' },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer cli-pat') return json(401, {});
    if (u.pathname === '/rest/api/user/current') return json(200, { username: 'carol', displayName: 'Carol C' });
    if (u.pathname === '/rest/api/content/search') return json(200, { results: [page], size: 1, totalSize: 1 });
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('confluence CLI end-to-end: kb.json config + env PAT → raw/confluence doc + JSON summary', async (t) => {
  const baseUrl = await mockConfluence(t);
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-conf-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({
    version: 1,
    connectors: { confluence: { base_url: baseUrl, pat_env: CONF_PAT_ENV, spaces: ['DEV'] } },
  }));

  const r = await runCli(['confluence', '--kb', kb], { [CONF_PAT_ENV]: 'cli-pat' });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.connector, 'confluence');
  assert.deepEqual(out.created, ['raw/confluence/123456.md']);
  const doc = fs.readFileSync(path.join(kb, 'raw', 'confluence', '123456.md'), 'utf8');
  assert.match(doc, /source_id: "123456"/); // frontmatter quotes numeric-looking ids
  assert.match(doc, /# CLI end-to-end page/);
  assert.match(doc, /pulled through the real CLI/);

  const me = await runCli(['confluence', '--kb', kb, '--check'], { [CONF_PAT_ENV]: 'cli-pat' });
  assert.equal(me.code, 0, me.stderr);
  assert.equal(JSON.parse(me.stdout).myself.displayName, 'Carol C');

  const bad = await runCli(['confluence', '--kb', kb, '--check', 'yes'], { [CONF_PAT_ENV]: 'cli-pat' });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /--check is a boolean flag and takes no value/);
});

// ---- phase 1: --probe + recordRun passthrough ----

const ZEPHYR_ENV = 'JIRA_PAT_CLI_ZEPHYR';

async function mockJiraZephyr(t, { withTest = true } = {}) {
  const testIssue = {
    key: 'PROJ-T1', id: '4242',
    fields: {
      summary: 'CLI test issue', description: 'with zephyr steps',
      status: { name: 'Open' }, issuetype: { name: 'Test' }, priority: { name: 'Medium' },
      labels: [], components: [], assignee: null, reporter: { displayName: 'Carol' },
      created: '2026-07-20T09:00:00.000+0800', updated: '2026-07-29T09:00:00.000+0800',
      comment: { comments: [] }, fixVersions: [],
    },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer cli-pat') return json(401, {});
    if (u.pathname === '/rest/api/2/search') {
      return json(200, { issues: withTest ? [testIssue] : [], total: withTest ? 1 : 0 });
    }
    if (u.pathname === '/rest/zapi/latest/teststep/4242') {
      return json(200, [{ id: 1, orderId: 1, step: 's', data: 'd', result: 'r' }]);
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('jira --probe prints a value-free shape summary; runs record zephyr status', async (t) => {
  const baseUrl = await mockJiraZephyr(t);
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-probe-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({
    version: 1,
    connectors: { jira: { base_url: baseUrl, pat_env: ZEPHYR_ENV, jql: ['project = PROJ'] } },
  }));

  const probe = await runCli(['jira', '--kb', kb, '--probe'], { [ZEPHYR_ENV]: 'cli-pat' });
  assert.equal(probe.code, 0, probe.stderr);
  const out = JSON.parse(probe.stdout);
  assert.equal(out.probe, true);
  assert.equal(out.issue_key, 'PROJ-T1');
  assert.deepEqual(out.zephyr, { http: 200, isArray: true, count: 1, firstItemKeys: ['id', 'orderId', 'step', 'data', 'result'] });
  // probes are not pulls: nothing recorded yet
  assert.ok(!fs.existsSync(path.join(kb, '.kb', 'acquire_runs.jsonl')));

  const pull = await runCli(['jira', '--kb', kb], { [ZEPHYR_ENV]: 'cli-pat' });
  assert.equal(pull.code, 0, pull.stderr);
  assert.equal(JSON.parse(pull.stdout).zephyr, 'available');
  const rec = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'acquire_runs.jsonl'), 'utf8').trim());
  assert.equal(rec.zephyr, 'available');
});

test('confluence --probe requires a page id and reports the gliffy shape', async (t) => {
  const gliffy = JSON.stringify({ stage: { objects: [{ graphic: { Text: { html: '<p>x</p>' } }, x: 0, y: 0 }] } });
  const page = {
    id: '777', type: 'page', title: 'probe page', status: 'current',
    space: { key: 'DEV' }, version: { number: 1, when: '2026-07-29T09:00:00.000+08:00', by: { displayName: 'C' } },
    ancestors: [], metadata: { labels: { results: [] } },
    body: { storage: { value: '<ac:structured-macro ac:name="gliffy"><ac:parameter ac:name="name">dia</ac:parameter></ac:structured-macro>' } },
    _links: {},
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== 'Bearer cli-pat') return json(401, {});
    if (u.pathname === '/rest/api/content/777') return json(200, page);
    if (u.pathname === '/rest/api/content/777/child/attachment') {
      return json(200, {
        results: [{ title: 'dia.gliffy', _links: { download: '/download/attachments/777/dia.gliffy' } }],
        size: 1,
      });
    }
    if (u.pathname === '/download/attachments/777/dia.gliffy') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(gliffy);
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-acq-cprobe-'));
  t.after(() => fs.rmSync(kb, { recursive: true, force: true }));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({
    version: 1,
    connectors: { confluence: { base_url: baseUrl, pat_env: CONF_PAT_ENV, spaces: ['DEV'] } },
  }));

  const missing = await runCli(['confluence', '--kb', kb, '--probe'], { [CONF_PAT_ENV]: 'cli-pat' });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /requires a page id/);

  const ok = await runCli(['confluence', '--kb', kb, '--probe', '777'], { [CONF_PAT_ENV]: 'cli-pat' });
  assert.equal(ok.code, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.probe, true);
  assert.deepEqual(out.gliffy, {
    macro: { name: 'dia', displayName: '', page: '', space: '' },
    page_id: '777',
    attachment_count: 1,
    attachments: ['dia.gliffy'],
    matched: { title: 'dia.gliffy', match: 'nameNoExt', via: 'rest-download' },
    attempts: [],
    http: 200,
    jsonValid: true,
    hasStageObjects: true,
    objectCount: 1,
    labelCount: 1,
  });
});
