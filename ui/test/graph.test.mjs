// A7 relationship graph tests: /api/graph node/edge shape, the two edge
// sources (retrieval outlinks for approved pages, UI scan for candidates),
// unresolved links dropped, backlinks parity after the move to the shared
// edge list, and the read-side Host gate on the new endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createPortal } from '../serve.mjs';
import { buildFrontmatter } from '../../governance/scripts/lib/frontmatter.mjs';

let kb, server, base;

function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body + '\n', 'utf8');
}

before(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-portal-a7-'));
  // approved hub ← approved source (edge must come from the retrieval index)
  writePage('wiki/syntheses/hub.md', {
    type: 'synthesis', status: 'approved', title: 'Hub', updated_at: '2026-08-01T00:00:00Z',
  }, 'The hub page.');
  writePage('wiki/sources/local-a1.md', {
    type: 'source', status: 'approved', title: 'Source A1', source_ref: 'raw/local/a1.md',
    updated_at: '2026-08-01T00:00:00Z',
  }, 'Evidence summary pointing at [[hub]] and a [[ghost-page]].\n\n```\n[[fenced-link]]\n```');
  // candidate → hub (edge must come from the UI-side scan)
  writePage('wiki/syntheses/cand.md', {
    type: 'synthesis', status: 'candidate', title: 'Cand', updated_at: '2026-08-01T00:00:00Z',
  }, 'Draft citing [[syntheses/hub]] by path.');
  fs.writeFileSync(path.join(kb, 'wiki', 'index.md'), '# Index\n\n- [[hub]]\n', 'utf8');
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'raw', 'local', 'a1.md'), 'raw body', 'utf8');
  server = createPortal({ kb, port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(kb, { recursive: true, force: true }); });

test('graph: every wiki page is a node, index.md included and flagged', async () => {
  const res = await fetch(base + '/api/graph');
  assert.equal(res.status, 200, `graph must not error (native module healthy?): ${await res.clone().text().catch(() => '')}`);
  const g = await res.json();
  const paths = g.nodes.map((n) => n.path).sort();
  assert.deepEqual(paths, ['wiki/index.md', 'wiki/sources/local-a1.md', 'wiki/syntheses/cand.md', 'wiki/syntheses/hub.md']);
  assert.equal(g.nodes.find((n) => n.isIndex)?.path, 'wiki/index.md');
  assert.equal(g.nodes.find((n) => n.path === 'wiki/syntheses/cand.md').status, 'candidate');
});

test('graph edges: approved via index, candidate via scan, unresolved dropped', async () => {
  const res = await fetch(base + '/api/graph');
  assert.equal(res.status, 200);
  const { edges } = await res.json();
  const pairs = edges.map((e) => `${e.from} → ${e.to}`).sort();
  assert.ok(pairs.includes('wiki/sources/local-a1.md → wiki/syntheses/hub.md'), 'approved outlink from retrieval index');
  assert.ok(pairs.includes('wiki/syntheses/cand.md → wiki/syntheses/hub.md'), 'candidate edge from UI scan (pathed target)');
  assert.ok(pairs.includes('wiki/index.md → wiki/syntheses/hub.md'), 'index.md is a hub by convention');
  assert.equal(edges.length, 3, 'ghost-page and fenced-link never become edges');
});

test('backlinks over the shared edge list keep the old shape and caliber', async () => {
  const res = await fetch(base + '/api/backlinks?path=wiki/syntheses/hub.md');
  assert.equal(res.status, 200);
  const { pages } = await res.json();
  assert.deepEqual(pages.map((p) => p.path), ['wiki/index.md', 'wiki/sources/local-a1.md', 'wiki/syntheses/cand.md']);
  assert.ok(pages.every((p) => p.title), 'title carried through');
  const r2 = await fetch(base + '/api/backlinks?path=wiki/syntheses/cand.md');
  assert.equal(r2.status, 200);
  const none = await r2.json();
  assert.deepEqual(none.pages, [], 'nobody links the candidate');
});

test('ADR-0007 derived edges: approved + candidate topics, kind + coverage, reverse backlinks', async () => {
  // approved topic covering local-a1 (raw/local/a1.md) → derived topic→source
  writePage('wiki/syntheses/topic-a.md', {
    type: 'synthesis', status: 'approved', title: 'Topic A',
    sources: ['raw/local/a1.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Synthesis over source a1.');
  // candidate topic covering local-a1 → derived edge via the UI-side scan
  writePage('wiki/syntheses/cand-topic.md', {
    type: 'synthesis', status: 'candidate', title: 'Cand Topic',
    sources: ['raw/local/a1.md'], updated_at: '2026-08-01T00:00:00Z',
  }, 'Draft over a1.');
  const g = await (await fetch(base + '/api/graph')).json();
  const derived = g.edges.filter((e) => e.kind === 'derived');
  const dFrom = derived.map((e) => `${e.from} → ${e.to}`).sort();
  assert.ok(dFrom.includes('wiki/syntheses/topic-a.md → wiki/sources/local-a1.md'), 'approved topic derived edge');
  assert.ok(dFrom.includes('wiki/syntheses/cand-topic.md → wiki/sources/local-a1.md'), 'candidate topic derived edge (UI scan)');
  assert.ok(derived.every((e) => e.kind === 'derived'), 'kind tag present');
  // per-topic coverage count on nodes
  const topicA = g.nodes.find((n) => n.path === 'wiki/syntheses/topic-a.md');
  assert.equal(topicA.coverage, 1, 'coverage = number of derived sources');
  // reverse: source page backlinks include covering topics, grouped as coverage
  const bl = await (await fetch(base + '/api/backlinks?path=wiki/sources/local-a1.md')).json();
  const cov = bl.pages.filter((p) => p.kind === 'coverage').map((p) => p.path);
  assert.ok(cov.includes('wiki/syntheses/topic-a.md'), 'approved covering topic appears in coverage group');
  assert.ok(cov.includes('wiki/syntheses/cand-topic.md'), 'candidate covering topic appears in coverage group');
  // no authored edge points at local-a1 in this fixture → every backlink is
  // a coverage entry (the hub is local-a1's OUT-link, not an in-link)
  assert.ok(bl.pages.every((p) => p.kind === 'coverage'),
    `source's in-edges are all derived coverage: ${JSON.stringify(bl.pages)}`);
  // cleanup — restore the fixture for later tests
  fs.rmSync(path.join(kb, 'wiki', 'syntheses', 'topic-a.md'));
  fs.rmSync(path.join(kb, 'wiki', 'syntheses', 'cand-topic.md'));
});

test('graph endpoint passes through the loopback Host gate (P2-2)', async () => {
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/graph', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode));
    req.end();
  });
  assert.equal(status, 403);
});
