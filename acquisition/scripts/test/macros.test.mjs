// Phase-1 tests: Confluence macro adaptation (gliffy / jira-filter / gallery)
// against mock node:http servers. Covers: placeholder purity (storageToMarkdown
// stays sync), gliffy double-attachment resolution (labels + PNG sidecar,
// byte-independent asset updates, degrades), jira key/jql resolution with
// per-run JQL dedupe, gallery sync rendering, probeGliffy shape output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { run, storageToMarkdown, parseGliffyLabels, probeGliffy } from '../connectors/confluence.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const CONF_ENV = 'CONFLUENCE_PAT_TEST_MACRO';
const JIRA_ENV = 'JIRA_PAT_TEST_MACRO';
const PAT = 'test-secret-pat';
const STX = String.fromCharCode(2); // token sentinel (matches connector impl)

const GLIFFY_JSON = JSON.stringify({
  contentType: 'application/gliffy+json',
  version: '1.1',
  metadata: {},
  stage: {
    objects: [
      { id: 2, uid: 'com.gliffy.shape.basic.basic_v1.default.rectangle', x: 50, y: 200, graphic: { type: 'Shape', Text: { html: '<p>下游服务</p>' } } },
      { id: 1, uid: 'com.gliffy.shape.basic.basic_v1.default.rectangle', x: 50, y: 100, graphic: { type: 'Shape', Text: { html: '<p>登录页 <b>Login</b></p>' } } },
      { id: 3, uid: 'com.gliffy.shape.basic.basic_v1.default.line', x: 100, y: 150 },
      { id: 4, uid: 'com.gliffy.shape.basic.basic_v1.default.text', x: 10, y: 100, graphic: { type: 'Text', Text: { html: '<p>侧注</p>' } } },
      { id: 5, uid: 'com.gliffy.shape.basic.basic_v1.default.rectangle', x: 0, y: 300, children: [
        { id: 6, x: 0, y: 300, graphic: { Text: { html: '<p>嵌套子标签</p>' } } },
      ] },
    ],
  },
});
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);

function makePage(id, storage, over = {}) {
  return {
    id, type: 'page', title: `Page ${id}`, status: 'current',
    space: { key: 'DEV' },
    version: { number: 1, when: '2026-07-29T09:00:00.000+08:00', by: { displayName: 'Carol' } },
    ancestors: [], metadata: { labels: { results: [] } },
    body: { storage: { value: storage } },
    _links: { webui: `/pages/viewpage.action?pageId=${id}` },
    ...over,
  };
}

const GLIFFY_MACRO = (name) => `<ac:structured-macro ac:name="gliffy" ac:schema-version="1" ac:macro-id="m1">`
  + `<ac:parameter ac:name="name">${name}</ac:parameter>`
  + `<ac:parameter ac:name="displayName">${name}.png</ac:parameter>`
  + `</ac:structured-macro>`;

/** Mock Confluence: content/search keyed by CQL; attachments maps
 *  "pageId/filename" -> {status?, body(string|Buffer)}; contentById for probe. */
async function mockConfluence(t, cqlSets, { attachments = {}, contentById = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${PAT}`) return json(401, {});
    if (u.pathname === '/rest/api/user/current') return json(200, { username: 'carol', displayName: 'Carol C' });
    if (u.pathname === '/rest/api/content/search') {
      const set = cqlSets[u.searchParams.get('cql')] || [];
      const start = Number(u.searchParams.get('start') || 0);
      const limit = Number(u.searchParams.get('limit') || 50);
      return json(200, { results: set.slice(start, start + limit), start, limit, size: Math.min(limit, set.length - start), totalSize: set.length });
    }
    const content = u.pathname.match(/^\/rest\/api\/content\/(\d+)$/);
    if (content && contentById[content[1]]) return json(200, contentById[content[1]]);
    const dl = u.pathname.match(/^\/download\/attachments\/(\d+)\/(.+)$/);
    if (dl) {
      const hit = attachments[`${dl[1]}/${decodeURIComponent(dl[2])}`];
      if (!hit) return json(404, {});
      if (hit.status && hit.status !== 200) return json(hit.status, {});
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(hit.body);
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

/** Mock Jira for jira-filter resolution: issueByKey + jqlSets (with total). */
async function mockJiraForMacro(t, { issueByKey = {}, jqlSets = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${PAT}`) return json(401, {});
    const issue = u.pathname.match(/^\/rest\/api\/2\/issue\/([A-Z0-9-]+)$/);
    if (issue && issueByKey[issue[1]]) return json(200, issueByKey[issue[1]]);
    if (u.pathname === '/rest/api/2/search') {
      const set = jqlSets[u.searchParams.get('jql')] || { issues: [], total: 0 };
      const maxResults = Number(u.searchParams.get('maxResults') || 50);
      return json(200, { issues: set.issues.slice(0, maxResults), total: set.total, startAt: 0, maxResults });
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

let kb;
before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-macro-'));
  process.env[CONF_ENV] = PAT;
  process.env[JIRA_ENV] = PAT;
});
after(() => {
  delete process.env[CONF_ENV];
  delete process.env[JIRA_ENV];
  fs.rmSync(kb, { recursive: true, force: true });
});

const kbConf = (baseUrl, jiraBaseUrl) => ({
  version: 1,
  connectors: {
    confluence: { base_url: baseUrl, pat_env: CONF_ENV, spaces: ['DEV'] },
    ...(jiraBaseUrl ? { jira: { base_url: jiraBaseUrl, pat_env: JIRA_ENV, jql: ['project = PROJ'] } } : {}),
  },
});

const readDoc = (id) => parseFrontmatter(fs.readFileSync(path.join(kb, 'raw', 'confluence', `${id}.md`), 'utf8'));

test('gliffy happy: labels y/x-ordered + PNG sidecar embedded, macros counted', async (t) => {
  const { baseUrl, requests } = await mockConfluence(t, {
    'space = "DEV" AND type = page': [makePage('501', `<p>intro</p>${GLIFFY_MACRO('arch-diagram')}`)],
  }, { attachments: { '501/arch-diagram.gliffy': { body: GLIFFY_JSON }, '501/arch-diagram.png': { body: PNG_BYTES } } });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.macros, { gliffy: 1 });

  const { body } = readDoc('501');
  assert.match(body, /\*\*Gliffy 图: arch-diagram\*\*/);
  assert.match(body, /!\[gliffy: arch-diagram\]\(raw\/confluence\/501\.assets\/arch-diagram\.png\)/);
  const order = ['侧注', '登录页 Login', '下游服务', '嵌套子标签'];
  const at = order.map((l) => body.indexOf(`- ${l}`));
  assert.ok(at.every((i) => i > 0), `all labels present: ${at}`);
  assert.ok(at[0] < at[1] && at[1] < at[2] && at[2] < at[3], 'labels ordered by y then x');
  // attachment download carried the PAT
  assert.equal(requests.find((r) => r.path.includes('/download/attachments/')).auth, `Bearer ${PAT}`);
  // sidecar bytes on disk
  const png = fs.readFileSync(path.join(kb, 'raw', 'confluence', '501.assets', 'arch-diagram.png'));
  assert.ok(png.equals(PNG_BYTES));
});

test('gliffy degrades: missing .gliffy / bad JSON / missing PNG (labels survive)', async (t) => {
  const page = (id, name) => makePage(id, GLIFFY_MACRO(name));
  const { baseUrl } = await mockConfluence(t, {
    'space = "DEV" AND type = page': [page('511', 'gone'), page('512', 'broken'), page('513', 'norender')],
  }, {
    attachments: {
      '512/broken.gliffy': { body: '{not json' },
      '513/norender.gliffy': { body: GLIFFY_JSON }, // no .png for this one
    },
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(s.macros.gliffy, 1, 'resolved ones count');
  assert.equal(s.macros.degraded, 2);

  assert.match(readDoc('511').body, /\[gliffy 图: gone — HTTP 404\]/);
  assert.match(readDoc('512').body, /\[gliffy 图: broken — gliffy attachment: expected JSON document/);
  const okBody = readDoc('513').body;
  assert.match(okBody, /\*\*Gliffy 图: norender\*\*/);
  assert.ok(!okBody.includes('![gliffy:'), 'PNG 404 omits the image line only');
  assert.match(okBody, /- 下游服务/);
});

test('PNG sidecar updates independently of the doc content_hash skip', async (t) => {
  const pages = [makePage('521', GLIFFY_MACRO('flow'))];
  const pngV2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x09, 0x09]);
  const attachments = { '521/flow.gliffy': { body: GLIFFY_JSON }, '521/flow.png': { body: PNG_BYTES } };
  const { baseUrl } = await mockConfluence(t, { 'space = "DEV" AND type = page': pages }, { attachments });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  attachments['521/flow.png'] = { body: pngV2 }; // PNG changes, page does not
  const again = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(again.unchanged, ['raw/confluence/521.md'], 'doc itself is a content_hash skip');
  assert.ok(fs.readFileSync(path.join(kb, 'raw', 'confluence', '521.assets', 'flow.png')).equals(pngV2),
    'asset still updates');
});

test('jira macro: key card + jql table with per-run dedupe and truncation note', async (t) => {
  const jql = 'project = PROJ AND status != Done';
  const storage = `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter></ac:structured-macro>`
    + `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jql">${jql}</ac:parameter></ac:structured-macro>`
    + `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jql">${jql}</ac:parameter></ac:structured-macro>`;
  const { baseUrl } = await mockConfluence(t, { 'space = "DEV" AND type = page': [makePage('531', storage)] });
  const jira = await mockJiraForMacro(t, {
    issueByKey: { 'PROJ-1': { key: 'PROJ-1', fields: { summary: 'First issue', status: { name: 'Open' }, assignee: { displayName: 'Alice' } } } },
    jqlSets: {
      [jql]: {
        issues: [
          { key: 'PROJ-2', fields: { summary: 'A | piped', status: { name: 'Open' }, assignee: { displayName: 'Alice' } } },
          { key: 'PROJ-3', fields: { summary: 'Third', status: { name: 'Doing' }, assignee: null } },
        ],
        total: 25,
      },
    },
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, jira.baseUrl) });
  assert.equal(s.macros.jira_filter, 3);

  const { body } = readDoc('531');
  assert.match(body, /- \[PROJ-1\] First issue \(Open · Alice\) — http:\/\/127\.0\.0\.1:\d+\/browse\/PROJ-1/);
  assert.match(body, /\| Key \| Summary \| Status \| Assignee \|/);
  assert.match(body, /\| \[PROJ-2\]\(http:\/\/127\.0\.0\.1:\d+\/browse\/PROJ-2\) \| A \\\| piped \| Open \| Alice \|/);
  assert.match(body, /\| \[PROJ-3\]\([^)]*\) \| Third \| Doing \| unassigned \|/);
  assert.match(body, /\(showing 2 of 25\)/);
  const searches = jira.requests.filter((r) => r.path === '/rest/api/2/search');
  assert.equal(searches.length, 1, 'identical JQL executes once per run');
});

test('jira macro degrades when the jira connector is not configured', async (t) => {
  const jql = 'project = PROJ';
  const { baseUrl } = await mockConfluence(t, {
    'space = "DEV" AND type = page': [makePage('541', `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jql">${jql}</ac:parameter></ac:structured-macro>`)],
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) }); // no jira in kbConfig
  assert.equal(s.macros.degraded, 1);
  assert.match(readDoc('541').body, /\[jira filter: project = PROJ — jira connector not configured\]/);
});

test('gallery renders synchronously: filenames, cross-page, external, cap', () => {
  const imgs = Array.from({ length: 25 }, (_, i) => `<ac:image><ri:attachment ri:filename="pic-${i}.png"/></ac:image>`).join('');
  const xhtml = `<ac:structured-macro ac:name="gallery"><ac:parameter ac:name="title">资产</ac:parameter>`
    + `<ac:image><ri:attachment ri:filename="local.png"/></ac:image>`
    + `<ac:image><ri:attachment ri:filename="other.png"><ri:page ri:content-title="Brand Assets"/></ri:attachment></ac:image>`
    + `<ac:image><ri:url ri:value="https://cdn.example.com/hero.png"/></ac:image>`
    + imgs
    + `</ac:structured-macro>`;
  const md = storageToMarkdown(xhtml, 'https://wiki.example.com');
  assert.match(md, /\*\*Gallery: 资产\*\*/);
  assert.match(md, /- local\.png/);
  assert.match(md, /- other\.png \(from page: Brand Assets\)/);
  assert.match(md, /- cdn\.example\.com \(external image\)/);
  assert.match(md, /- … \+8 more/, 'cap at 20 entries');
});

test('placeholder purity: collect emits STX tokens, zero network, unknown macros degrade', () => {
  const collect = [];
  const md = storageToMarkdown(
    `<p>a</p>${GLIFFY_MACRO('x')}<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">K-1</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="roadmap"/>`,
    'https://wiki.example.com', collect);
  assert.equal(collect.length, 2);
  assert.equal(collect[0].type, 'gliffy');
  assert.equal(collect[1].type, 'jira');
  assert.equal(collect[1].params.key, 'K-1');
  assert.ok(md.includes(collect[0].token) && md.includes(collect[1].token));
  assert.equal(collect[0].token, `${STX}MACRO:0${STX}`);
  assert.match(md, /\[macro: roadmap\]/);
  // without a collector the classic degrade applies (pre-phase-1 behavior)
  assert.match(storageToMarkdown(GLIFFY_MACRO('x')), /\[macro: gliffy\]/);
});

test('unit: parseGliffyLabels ordering, nesting, shape errors are relay-safe', () => {
  assert.deepEqual(parseGliffyLabels(GLIFFY_JSON), ['侧注', '登录页 Login', '下游服务', '嵌套子标签']);
  const grab = (fn) => { try { fn(); } catch (e) { return e; } return null; };
  const notJson = grab(() => parseGliffyLabels('<xml>old format</xml>'));
  assert.match(notJson.message, /expected JSON document, got string/);
  assert.ok(notJson.shapeSafe);
  const noStage = grab(() => parseGliffyLabels('{"foo":1}'));
  assert.match(noStage.message, /expected stage\.objects array, got object\(keys=foo\)/);
});

test('probeGliffy: shape summary; missing macro / missing pageId handled', async (t) => {
  const withGliffy = makePage('551', GLIFFY_MACRO('arch-diagram'));
  const plain = makePage('552', '<p>no macros</p>');
  const { baseUrl } = await mockConfluence(t, {}, {
    attachments: { '551/arch-diagram.gliffy': { body: GLIFFY_JSON } },
    contentById: { 551: withGliffy, 552: plain },
  });
  const out = await probeGliffy(kbConf(baseUrl), '551');
  assert.deepEqual(out, {
    probe: true, page: '551',
    gliffy: { http: 200, jsonValid: true, hasStageObjects: true, objectCount: 5, labelCount: 4 },
  });
  const none = await probeGliffy(kbConf(baseUrl), '552');
  assert.equal(none.note, 'no-gliffy-macro');
  await assert.rejects(() => probeGliffy(kbConf(baseUrl), ''), /requires a page id/);
});
