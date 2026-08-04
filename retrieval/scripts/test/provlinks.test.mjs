// ADR-0007 derived-edge tests. `deriveProvlinks` is the shared join helper
// (retrieval store; the UI portal's candidate scan reuses it). `ensureFresh`
// runs the post-reconcile pass that fills docs.provlinks from the copied
// `sources` column. Join caliber pinned by review round 2 R3.2:
//   exact `entry === source_ref` primary;
//   fallback `entry.endsWith('/' + basename(source_ref))` (anchored) — the loose
//   browse.mjs `rawRefs` form (e.g. `local-aaaa1111-pay.md`) deliberately does NOT
//   match, so `…/aaaa1111-pay.md` can never mis-match a `pay.md` source_ref.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureFresh, openDb, deriveProvlinks } from '../lib/store.mjs';
import { buildFrontmatter } from '../lib/frontmatter.mjs';

let kb;
function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body, 'utf8');
}

before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-provlinks-'));
  fs.mkdirSync(path.join(kb, 'raw', 'local'), { recursive: true });
});

const srcPage = (slug, ref) => ({
  type: 'source', status: 'approved', title: slug, source_ref: ref,
  updated_at: '2026-08-01T00:00:00Z',
});

test('deriveProvlinks: exact source_ref match is primary', () => {
  const srcs = [{ path: 'wiki/sources/local-bbbb2222.md', source_ref: 'raw/local/bbbb2222-pay.md' }];
  const r = deriveProvlinks(srcs, ['raw/local/bbbb2222-pay.md']);
  assert.deepEqual(r, { links: ['wiki/sources/local-bbbb2222.md'], unmatched: 0, ambiguous: 0 });
});

test('deriveProvlinks: anchored basename fallback across a different raw dir', () => {
  // same basename, different directory — endsWith('/' + basename) still hits
  const srcs = [{ path: 'wiki/sources/local-pay.md', source_ref: 'raw/jira/pay.md' }];
  const r = deriveProvlinks(srcs, ['raw/local/pay.md']);
  assert.deepEqual(r, { links: ['wiki/sources/local-pay.md'], unmatched: 0, ambiguous: 0 });
});

test('deriveProvlinks: loose rawRefs slug does NOT match (anchored caliber)', () => {
  // ui.test.mjs fixture: sources:['local-aaaa1111-pay.md'] vs
  // source_ref: raw/local/aaaa1111-pay.md. Under the anchored join this is
  // deliberately unmatched (review R3.2: stricter than browse.mjs rawRefs).
  const srcs = [{ path: 'wiki/sources/local-aaaa1111.md', source_ref: 'raw/local/aaaa1111-pay.md' }];
  const r = deriveProvlinks(srcs, ['local-aaaa1111-pay.md']);
  assert.equal(r.links.length, 0);
  assert.equal(r.unmatched, 1);
});

test('deriveProvlinks: partial basename never mis-matches (…/aaaa1111-pay.md vs pay.md)', () => {
  const srcs = [{ path: 'wiki/sources/local-pay.md', source_ref: 'raw/local/pay.md' }];
  const r = deriveProvlinks(srcs, ['raw/local/aaaa1111-pay.md']);
  assert.deepEqual(r, { links: [], unmatched: 1, ambiguous: 0 }, 'must not anchor-suffix-match pay.md');
});

test('deriveProvlinks: two same-basename source pages → ambiguous, counted, dropped', () => {
  const srcs = [
    { path: 'wiki/sources/jira-pay.md', source_ref: 'raw/jira/pay.md' },
    { path: 'wiki/sources/confluence-pay.md', source_ref: 'raw/confluence/pay.md' },
  ];
  const r = deriveProvlinks(srcs, ['raw/local/pay.md']);
  assert.equal(r.links.length, 0, 'ambiguous → dropped, never picked arbitrarily');
  assert.equal(r.ambiguous, 1);
});

test('ensureFresh fills provlinks for approved topic, exact + anchored mix', () => {
  fs.mkdirSync(path.join(kb, 'wiki', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'wiki', 'topics'), { recursive: true });
  writePage('wiki/sources/local-bbbb2222.md', srcPage('Pay B', 'raw/local/bbbb2222-pay.md'), 'B.');
  writePage('wiki/sources/jira-cccc3333.md', srcPage('Pay C', 'raw/jira/cccc3333-pay.md'), 'C.');
  writePage('wiki/topics/topic.md', {
    type: 'topic', status: 'approved', title: 'Topic',
    sources: ['raw/local/bbbb2222-pay.md', 'raw/local/cccc3333-pay.md'],
    updated_at: '2026-08-01T00:00:00Z',
  }, 'Synthesis.');
  ensureFresh(kb);
  const db = openDb(kb);
  const row = db.prepare('SELECT provlinks, sources FROM docs WHERE path=?').get('wiki/topics/topic.md');
  db.close();
  assert.equal(row.sources, JSON.stringify(['raw/local/bbbb2222-pay.md', 'raw/local/cccc3333-pay.md']),
    'copied sources column carries the frontmatter list');
  assert.deepEqual(JSON.parse(row.provlinks),
    ['wiki/sources/local-bbbb2222.md', 'wiki/sources/jira-cccc3333.md']);
});

test('ensureFresh derived pass reports dropped edges in stats (retrieval-side)', () => {
  writePage('wiki/sources/jira-pay.md', srcPage('Jira Pay', 'raw/jira/pay.md'), 'J.');
  writePage('wiki/sources/confluence-pay.md', srcPage('Conf Pay', 'raw/confluence/pay.md'), 'C.');
  writePage('wiki/topics/ambiguous.md', {
    type: 'topic', status: 'approved', title: 'Ambiguous',
    sources: ['raw/local/pay.md', 'raw/local/ghost.md'],
    updated_at: '2026-08-01T00:00:00Z',
  }, 'Two sources map to the same basename; one is a ghost.');
  const stats = ensureFresh(kb);
  assert.ok(stats.provlinks, 'derived pass ran');
  assert.equal(stats.provlinks.ambiguous, 1, 'pay.md → ambiguous, dropped');
  assert.equal(stats.provlinks.unmatched, 1, 'ghost.md → unmatched, dropped');
});

test('deriveProvlinks: unmatched is counted, not silently dropped', () => {
  const r = deriveProvlinks([{ path: 'wiki/sources/local-a.md', source_ref: 'raw/local/a.md' }], ['raw/local/missing.md']);
  assert.deepEqual(r, { links: [], unmatched: 1, ambiguous: 0 });
});
