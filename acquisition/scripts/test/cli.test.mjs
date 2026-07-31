// CLI-level tests: boolean flag strictness (L1 review fix) + jira end-to-end
// against a mock node:http server (async spawn — a sync spawn would block the
// event loop and starve the mock server).
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
