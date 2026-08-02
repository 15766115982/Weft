// A7 relationship graph data layer. Edges come from TWO sources with the same
// reading caliber (fence-aware wikilink extraction — the M4/M6 lesson: all
// consumers of one convention must read it the same way):
//   1. retrieval index docs.outlinks — approved pages' edges, resolved at
//      index time. Reusing them is what lets backlinks() stop full-scanning
//      the wiki on every call (reviewer suggestion folded into A7).
//   2. a UI-side scan of the pages retrieval never indexes (candidates and
//      wiki/index.md), using retrieval's own extractWikilinks — the minority
//      of pages, so the full scan is gone but coverage is not.
// Known incremental caveat (inherited from retrieval, by design): an approved
// page's outlinks are frozen until the page itself changes — a link to a page
// created later appears only after the source page is next re-indexed (or a
// rebuild-index run, available on the govern console).
// Unresolved [[targets]] are dropped here; dangling links stay plan()'s domain.
import fs from 'node:fs';
import path from 'node:path';
import { walkMd } from './paths.mjs';
import { parseFrontmatter } from './review.mjs';
import { ensureFresh, openDb } from '../../retrieval/scripts/lib/store.mjs';
import { extractWikilinks } from '../../retrieval/scripts/lib/chunk.mjs';

// wikilink target → page path, replicated from retrieval store.mjs
// resolveLinks (not exported there; the calibers must match): full relative
// form first, then unique-suffix match; anchors/.md stripped by callers'
// convention — here done inline.
function resolveLinks(links, knownPaths) {
  const out = [];
  for (const l of links) {
    const norm = l.split('#')[0].replace(/\.md$/i, '');
    if (!norm) continue;
    const hit = knownPaths.find((p) => p.replace(/\.md$/i, '') === norm)
      || knownPaths.find((p) => p.replace(/\.md$/i, '').endsWith('/' + norm));
    if (hit) out.push(hit);
  }
  return out;
}

export function buildGraph(kbRoot) {
  ensureFresh(kbRoot); // same lazy reconciliation the search read path runs

  // Nodes: one walk, frontmatter parsed once. index.md is a real node (A4
  // entry page, usually a hub) even though retrieval never indexes it.
  const nodes = [];
  const indexAbs = path.join(kbRoot, 'wiki', 'index.md');
  if (fs.existsSync(indexAbs)) {
    const { fields } = parseFrontmatter(fs.readFileSync(indexAbs, 'utf8'));
    nodes.push({ path: 'wiki/index.md', title: fields.title || 'Index', type: fields.type, status: fields.status, isIndex: true });
  }
  for (const sub of ['sources', 'topics']) {
    for (const abs of walkMd(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      nodes.push({
        path: rel, title: fields.title || path.basename(rel, '.md'),
        type: fields.type, status: fields.status,
      });
    }
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  const known = new Set(nodes.map((n) => n.path));

  const edges = [];
  const push = (from, to) => { if (to !== from && known.has(to)) edges.push({ from, to }); };

  // Approved pages: resolved edges straight from the retrieval index.
  const db = openDb(kbRoot);
  const rows = db.prepare('SELECT path, outlinks FROM docs').all();
  db.close();
  const indexed = new Set();
  for (const r of rows) {
    if (!known.has(r.path)) continue; // stale row (e.g. archived) — skip
    indexed.add(r.path);
    for (const to of JSON.parse(r.outlinks || '[]')) push(r.path, to);
  }

  // Pages retrieval skipped (candidates, index.md): scan UI-side with the
  // same extractor, resolved against the graph's own node set.
  const knownSorted = [...known].sort();
  for (const n of nodes) {
    if (indexed.has(n.path)) continue;
    const { body } = parseFrontmatter(fs.readFileSync(path.join(kbRoot, n.path), 'utf8'));
    for (const to of resolveLinks(extractWikilinks(body), knownSorted)) push(n.path, to);
  }

  return { nodes, edges };
}

// Backlinks (A6) over the shared edge list — same return shape the endpoint
// always had ({path, title}), so callers/tests are unaffected.
export function backlinks(kbRoot, pageRel) {
  const { nodes, edges } = buildGraph(kbRoot);
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.to !== pageRel || seen.has(e.from)) continue;
    seen.add(e.from);
    out.push({ path: e.from, title: byPath.get(e.from)?.title || path.basename(e.from, '.md') });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
