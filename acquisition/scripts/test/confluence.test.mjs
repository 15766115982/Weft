// M6 tests: Confluence connector against a mock node:http server (zero real network).
// Covers: happy path + identity five-tuple + extra fields, CQL pagination,
// incremental skip/update, Bearer auth + 401, config/PAT/scope/--max errors,
// storage XHTML -> markdown conversion, non-compliant page id, date normalization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  run, check, normalizeConfluenceDate, storageToMarkdown, pageToMarkdown, CONNECTOR_ID, detect,
} from '../connectors/confluence.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const PAT_ENV = 'CONFLUENCE_PAT_TEST_M6';
const PAT = 'test-secret-pat';
const SPACE_CQL = 'space = "DEV" AND type = page'; // built from kb.json spaces: ["DEV"]

const XHTML = [
  '<h2>Overview</h2>',
  '<p>The gateway retries <strong>three</strong> times.</p>',
  '<ul><li>first</li><li>second</li></ul>',
  '<ac:structured-macro ac:name="code">',
  '<ac:parameter ac:name="language">bash</ac:parameter>',
  '<ac:plain-text-body><![CDATA[curl -X POST http://gw/pay && echo ok]]></ac:plain-text-body>',
  '</ac:structured-macro>',
  '<table><tbody><tr><th>Field</th><th>Meaning</th></tr>',
  '<tr><td>amount</td><td>cents</td></tr></tbody></table>',
].join('');

function makePage(id, over = {}) {
  return {
    id: String(id),
    type: 'page',
    title: `Page ${id} title`,
    status: 'current',
    space: { key: 'DEV', name: 'Development' },
    version: { number: 3, when: '2026-07-28T10:30:00.000+08:00', by: { displayName: 'Alice' } },
    ancestors: [{ id: '100', title: 'Platform' }, { id: '101', title: 'Payments' }],
    metadata: { labels: { results: [{ name: 'backend' }, { name: 'retry' }] } },
    body: { storage: { value: XHTML, representation: 'storage' } },
    _links: { webui: `/pages/viewpage.action?pageId=${id}` },
    ...over,
  };
}

/** Mock Confluence: routes user/current + content/search; cqlSets maps CQL
 *  string -> page array, errorSets maps CQL string -> HTTP error status.
 *  Records requests for assertions. Returns {baseUrl, requests, close}. */
async function mockConfluence(t, cqlSets, { requirePat = PAT, errorSets = {} } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://mock');
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const authed = req.headers.authorization === `Bearer ${requirePat}`;
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!authed) return json(401, { message: 'Unauthorized' });
    if (u.pathname === '/rest/api/user/current') {
      return json(200, { username: 'alice', displayName: 'Alice A', userKey: 'ff8080abc' });
    }
    if (u.pathname === '/rest/api/content/search') {
      const errStatus = errorSets[u.searchParams.get('cql')];
      if (errStatus) return json(errStatus, { message: 'bad CQL' });
      const set = cqlSets[u.searchParams.get('cql')] || [];
      const start = Number(u.searchParams.get('start') || 0);
      const limit = Number(u.searchParams.get('limit') || 50);
      const batch = set.slice(start, start + limit);
      return json(200, { results: batch, start, limit, size: batch.length, totalSize: set.length });
    }
    return json(404, { message: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

let kb;
before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-confluence-'));
  process.env[PAT_ENV] = PAT;
});
after(() => {
  delete process.env[PAT_ENV];
  fs.rmSync(kb, { recursive: true, force: true });
});

const kbConf = (baseUrl, extra = {}) => ({
  version: 1,
  connectors: { confluence: { base_url: baseUrl, pat_env: PAT_ENV, spaces: ['DEV'], ...extra } },
});

test('happy path: pages land in raw/confluence/<id>.md with identity five-tuple + extra', async (t) => {
  const { baseUrl } = await mockConfluence(t, { [SPACE_CQL]: [makePage('123456'), makePage('123457')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.created.sort(), ['raw/confluence/123456.md', 'raw/confluence/123457.md']);
  assert.equal(s.total, 2);
  assert.deepEqual(s.errors, []);

  const raw = fs.readFileSync(path.join(kb, 'raw', 'confluence', '123456.md'), 'utf8');
  const { fields, body } = parseFrontmatter(raw);
  assert.equal(fields.source, 'confluence');
  assert.equal(fields.source_id, '123456');
  assert.equal(fields.source_url, `${baseUrl}/pages/viewpage.action?pageId=123456`);
  assert.equal(fields.source_version, '2026-07-28T02:30:00.000Z');
  assert.equal(fields.connector, CONNECTOR_ID);
  assert.match(fields.content_hash, /^sha256:/);
  assert.equal(fields.title, 'Page 123456 title');
  assert.equal(fields.extra.space, 'DEV');
  assert.equal(fields.extra.version, '3');
  assert.equal(fields.extra.labels, 'backend, retry');
  assert.equal(fields.extra.content_type, 'page');

  assert.match(body, /# Page 123456 title/);
  // full-precision version + timestamp: the hash covers them, so same-day edits are visible
  assert.match(body, /- Space: DEV {2}Version: 3 {2}Last modified: 2026-07-28T02:30:00\.000Z {2}By: Alice/);
  assert.match(body, /- Location: DEV > Platform > Payments/);
  assert.match(body, /- Labels: backend, retry/);
  // storage XHTML -> markdown conversion
  assert.match(body, /## Overview\n\nThe gateway retries \*\*three\*\* times\./);
  assert.match(body, /- first\n- second/);
  assert.match(body, /```bash\ncurl -X POST http:\/\/gw\/pay && echo ok\n```/);
  assert.match(body, /\| Field \| Meaning \|\n\| --- \| --- \|\n\| amount \| cents \|/);

  const log = fs.readFileSync(path.join(kb, 'log.md'), 'utf8');
  assert.match(log, /acquire \| confluence:created \| raw\/confluence\/123456\.md \| id 123456/);
});

test('incremental: second run is unchanged; changed page is updated', async (t) => {
  const pages = [makePage('223456')];
  const { baseUrl } = await mockConfluence(t, { [SPACE_CQL]: pages });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  const again = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(again.unchanged, ['raw/confluence/223456.md']);
  assert.deepEqual(again.created, []);

  pages[0] = makePage('223456', {
    title: 'revised title',
    version: { number: 4, when: '2026-07-30T08:00:00.000+08:00', by: { displayName: 'Bob' } },
  });
  const third = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(third.updated, ['raw/confluence/223456.md']);
  const { fields } = parseFrontmatter(fs.readFileSync(path.join(kb, 'raw', 'confluence', '223456.md'), 'utf8'));
  assert.equal(fields.source_version, '2026-07-30T00:00:00.000Z');
});

test('same-day second edit is NOT invisible (version.number + full-precision time in the hashed body)', async (t) => {
  const pages = [makePage('223457')];
  const { baseUrl } = await mockConfluence(t, { [SPACE_CQL]: pages });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  // edit again the SAME day (Confluence bumps version.number on every edit)
  pages[0] = makePage('223457', {
    title: 'edited again',
    version: { number: 4, when: '2026-07-28T15:00:00.000+08:00', by: { displayName: 'Alice' } },
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.updated, ['raw/confluence/223457.md'], 'same-day edit must not be skipped as unchanged');
});

test('pagination: >PAGE_SIZE pages pulled across multiple search pages', async (t) => {
  const many = Array.from({ length: 120 }, (_, i) => makePage(String(300000 + i)));
  const { baseUrl, requests } = await mockConfluence(t, { 'space = "BIG" AND type = page': many });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { spaces: ['BIG'] }) });
  assert.equal(s.created.length, 120);
  const starts = requests.filter((r) => r.path === '/rest/api/content/search').map((r) => r.query.start);
  assert.deepEqual(starts, ['0', '50', '100']);
});

test('dedupe: a page matched by several scopes is written once', async (t) => {
  const { baseUrl } = await mockConfluence(t, {
    [SPACE_CQL]: [makePage('400001'), makePage('400002')],
    'label = kb': [makePage('400001')],
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { cql: [SPACE_CQL, 'label = kb'] }) });
  assert.equal(s.total, 2);
  assert.deepEqual(s.created.sort(), ['raw/confluence/400001.md', 'raw/confluence/400002.md']);
});

test('auth: Bearer header is sent; 401 fails without leaking the PAT', async (t) => {
  const { baseUrl, requests } = await mockConfluence(t, { [SPACE_CQL]: [] });
  await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.equal(requests[0].auth, `Bearer ${PAT}`);

  try {
    process.env[PAT_ENV] = 'wrong-pat';
    await run(kb, { kbConfig: kbConf(baseUrl) });
    assert.fail('expected auth failure');
  } catch (err) {
    assert.match(err.message, /confluence authentication failed HTTP 401/);
    assert.ok(!err.message.includes('wrong-pat'), 'error message must not contain the PAT');
  } finally {
    process.env[PAT_ENV] = PAT;
  }
});

test('config errors: missing base_url / PAT / scope / bad --max', async (t) => {
  const { baseUrl } = await mockConfluence(t, {});
  await assert.rejects(() => run(kb, { kbConfig: { connectors: { confluence: {} } } }),
    /confluence connector is not configured: set connectors\.confluence\.base_url in kb\.json/);

  delete process.env[PAT_ENV];
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl) }),
    new RegExp(`confluence PAT not available: environment variable ${PAT_ENV} is not set`));
  process.env[PAT_ENV] = PAT;

  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl, { spaces: [] }) }),
    /no CQL scope: pass --cql or set connectors\.confluence\.spaces/);
  await assert.rejects(() => run(kb, { kbConfig: kbConf(baseUrl), maxResults: 'abc' }),
    /--max must be a positive integer/);
});

test('CLI --cql override wins over kb.json scope', async (t) => {
  const { baseUrl, requests } = await mockConfluence(t, { 'space = "ONE"': [makePage('500001')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl), cql: 'space = "ONE"' });
  assert.deepEqual(s.created, ['raw/confluence/500001.md']);
  assert.equal(requests.find((r) => r.path === '/rest/api/content/search').query.cql, 'space = "ONE"');
});

test('non-compliant page id is skipped with an error, never written', async (t) => {
  const { baseUrl } = await mockConfluence(t, { [SPACE_CQL]: [makePage('12 3'), makePage('600001')] });
  const s = await run(kb, { kbConfig: kbConf(baseUrl) });
  assert.deepEqual(s.created, ['raw/confluence/600001.md']);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0].error, /non-compliant page id \(contract §2\): 12 3/);
  assert.ok(!fs.existsSync(path.join(kb, 'raw', 'confluence', '12 3.md')));
});

test('--max truncation is reported, never silent (no-silent-caps)', async (t) => {
  const { baseUrl } = await mockConfluence(t, {
    [SPACE_CQL]: [makePage('700001'), makePage('700002'), makePage('700003')],
  });
  const s = await run(kb, { kbConfig: kbConf(baseUrl), maxResults: 2 });
  assert.equal(s.created.length, 2);
  assert.deepEqual(s.truncated, [{ cql: SPACE_CQL, fetched: 2, total: 3 }]);
});

test('per-scope failure is recorded and the remaining scopes still run', async (t) => {
  const { baseUrl } = await mockConfluence(
    t,
    { [SPACE_CQL]: [makePage('800001')] },
    { errorSets: { 'space = "BROKEN" AND type = page': 400 } },
  );
  const s = await run(kb, { kbConfig: kbConf(baseUrl, { spaces: ['BROKEN', 'DEV'] }) });
  assert.deepEqual(s.created, ['raw/confluence/800001.md']);
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].cql, 'space = "BROKEN" AND type = page');
  assert.match(s.errors[0].error, /confluence request failed HTTP 400/);
});

test('auth failure (401/403) fails fast instead of degrading to per-scope errors', async (t) => {
  const { baseUrl } = await mockConfluence(
    t,
    { [SPACE_CQL]: [makePage('900001')] },
    { errorSets: { 'space = "DEV" AND type = page': 403 } },
  );
  await assert.rejects(
    () => run(kb, { kbConfig: kbConf(baseUrl) }),
    /confluence authentication failed HTTP 403/,
  );
});

test('check(): user/current endpoint round-trip', async (t) => {
  const { baseUrl } = await mockConfluence(t, {});
  const me = await check(kbConf(baseUrl));
  assert.deepEqual(me, { username: 'alice', displayName: 'Alice A', userKey: 'ff8080abc' });
});

test('detect: classifies pages as new/changed/unchanged/removed_upstream without writing raw', async (t) => {
  const dkb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-conf-detect-'));
  t.after(() => fs.rmSync(dkb, { recursive: true, force: true }));
  const pages = [makePage('100001'), makePage('100002')];
  const { baseUrl } = await mockConfluence(t, { [SPACE_CQL]: pages });
  await run(dkb, { kbConfig: kbConf(baseUrl) });

  let d = await detect(dkb, { kbConfig: kbConf(baseUrl) });
  assert.equal(d.unchanged.length, 2);
  assert.equal(d.new.length, 0);

  pages[0] = makePage('100001', { title: 'revised', version: { number: 4, when: '2026-07-30T08:00:00.000+08:00', by: { displayName: 'Bob' } } });
  pages[1] = makePage('100003'); // replaces 100002 in upstream
  d = await detect(dkb, { kbConfig: kbConf(baseUrl) });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].id, '100001');
  assert.equal(d.new.length, 1);
  assert.equal(d.new[0].id, '100003');
  assert.equal(d.removed_upstream.length, 1);
  assert.equal(d.removed_upstream[0].source_id, '100002');
});

test('detect: asks Confluence for expand=version only; pull keeps full EXPAND', async (t) => {
  const dkb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-conf-detect-expand-'));
  t.after(() => fs.rmSync(dkb, { recursive: true, force: true }));
  const { baseUrl, requests } = await mockConfluence(t, { [SPACE_CQL]: [makePage('100010')] });
  await run(dkb, { kbConfig: kbConf(baseUrl) });
  await detect(dkb, { kbConfig: kbConf(baseUrl) });
  const searches = requests.filter((r) => r.path === '/rest/api/content/search');
  assert.equal(searches.length, 2, 'one search per pull/detect');
  assert.ok(searches[0].query.expand.includes('body.storage'), 'pull keeps the full expand list');
  assert.equal(searches[1].query.expand, 'version', 'detect carries no body.storage payload');
});

test('unit: normalizeConfluenceDate / storageToMarkdown / pageToMarkdown edge cases', () => {
  assert.equal(normalizeConfluenceDate('2026-07-28T10:30:00.000+08:00'), '2026-07-28T02:30:00.000Z');
  assert.equal(normalizeConfluenceDate('2026-07-28T10:30:00.000+0800'), '2026-07-28T02:30:00.000Z');
  assert.equal(normalizeConfluenceDate('not a date'), 'not a date');
  assert.equal(normalizeConfluenceDate(''), '');

  // info macro -> labeled blockquote
  assert.match(
    storageToMarkdown('<ac:structured-macro ac:name="info"><ac:rich-text-body><p>remember this</p></ac:rich-text-body></ac:structured-macro>'),
    /> \*\*Info:\*\*\n> remember this/,
  );
  // unknown macros leave a visible placeholder, never silently dropped
  assert.match(storageToMarkdown('<ac:structured-macro ac:name="drawio"/>'), /\[macro: drawio\]/);
  // toc is navigation chrome: dropped
  assert.equal(storageToMarkdown('<ac:structured-macro ac:name="toc"/><p>body</p>'), 'body');
  // internal page link resolves to its title
  assert.equal(storageToMarkdown('<p>see <ac:link><ri:page ri:content-title="Other Page"/></ac:link></p>'), 'see Other Page');
  // entities decoded
  assert.equal(storageToMarkdown('<p>Tom &amp; Jerry &lt;3 &#65;</p>'), 'Tom & Jerry <3 A');
  // attachment image -> placeholder with filename
  assert.equal(storageToMarkdown('<ac:image><ri:attachment ri:filename="arch.png"/></ac:image>'), '[attachment: arch.png]');
  // ordered list + blockquote + time
  assert.equal(storageToMarkdown('<ol><li>one</li><li>two</li></ol>'), '1. one\n2. two');
  assert.equal(storageToMarkdown('<blockquote><p>quoted</p></blockquote>'), '> quoted');
  assert.equal(storageToMarkdown('<p>due <time datetime="2026-07-01"/></p>'), 'due 2026-07-01');
  // heading with inline code
  assert.equal(storageToMarkdown('<h3>Use <code>curl</code></h3>'), '### Use `curl`');

  const md = pageToMarkdown(makePage('123456', { body: { storage: { value: '' } } }), 'https://wiki.example.com');
  assert.match(md, /\(empty page\)/);
});

test('unit: fenced code is evidence — cleanup, fences, and degradation rules respect it (review round 1)', () => {
  // finding 1: blank lines and trailing spaces inside code survive the global cleanup
  const withBlanks = storageToMarkdown(
    '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[line1\n\n\nline2  ]]></ac:plain-text-body></ac:structured-macro>',
  );
  assert.match(withBlanks, /line1\n\n\nline2 {2}\n```/);

  // finding 2: code containing ``` gets a longer fence instead of bursting
  const withFence = storageToMarkdown(
    '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[before\n```\nafter]]></ac:plain-text-body></ac:structured-macro>',
  );
  assert.equal(withFence, '````\nbefore\n```\nafter\n````');

  // finding 3: a table nested in a cell degrades to a visible placeholder, not garbage
  assert.match(
    storageToMarkdown('<table><tr><th>a</th></tr><tr><td><table><tr><td>inner1</td></tr></table></td></tr></table>'),
    /\| a \|\n\| --- \|\n\| \[table\] \|/,
  );

  // finding 4: <br> inside a paragraph is a real line break, not a collapsed space
  assert.equal(storageToMarkdown('<p>line one<br>line two</p>'), 'line one\nline two');

  // finding 5: a table without <th> gets an empty header; the first row stays data
  assert.equal(
    storageToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'),
    '|  |  |\n| --- | --- |\n| a | b |\n| c | d |',
  );
});

test('unit: br sentinel is a line boundary for every line-splitting consumer (review round 2)', () => {
  // blockquote: the post-br line must stay inside the quote
  assert.equal(
    storageToMarkdown('<blockquote><p>first<br>second</p></blockquote>'),
    '> first\n> second',
  );
  // panel macro: same
  assert.equal(
    storageToMarkdown('<ac:structured-macro ac:name="info"><ac:rich-text-body><p>first<br>second</p></ac:rich-text-body></ac:structured-macro>'),
    '> **Info:**\n> first\n> second',
  );
  // list item: the post-br line keeps the continuation indent
  assert.equal(
    storageToMarkdown('<ul><li>first<br>second</li></ul>'),
    '- first\n  second',
  );
  // heading is a single-line context: br degrades to a space
  assert.equal(storageToMarkdown('<h2>one<br>two</h2>'), '## one two');
});
