// A7 relationship graph data layer. Edges come from THREE sources:
//   1. retrieval index docs.outlinks — approved pages' AUTHORED edges, resolved
//      at index time (kind:'authored'). Reusing them is what lets backlinks()
//      stop full-scanning the wiki on every call (reviewer suggestion folded
//      into A7).
//   2. retrieval index docs.provlinks (ADR-0007) — approved topics' DERIVED
//      topic→source provenance edges (kind:'derived'), forward-only; reverse
//      (source→topic) is computed at read time by backlinks() and the query
//      expansion, never stored.
//   3. a UI-side scan of the pages retrieval never indexes (candidates and
//      wiki/index.md), using retrieval's own extractWikilinks — the minority
//      of pages, so the full scan is gone but coverage is not. Candidate
//      topics get the same forward provenance derivation via the shared
//      deriveProvlinks helper, resolved against the APPROVED source pages from
//      docs (ADR-0007: provlinks targets approved source pages only — a source
//      page demoted to candidate loses its provenance in-edges, accepted
//      asymmetry). index.md never has provenance edges.
// Known incremental caveat (inherited from retrieval, by design): an approved
// page's outlinks are frozen until the page itself changes — a link to a page
// created later appears only after the source page is next re-indexed (or a
// rebuild-index run, available on the govern console).
// Unresolved [[targets]] are dropped here; dangling links stay plan()'s domain.
import fs from 'node:fs';
import path from 'node:path';
import { walkMd } from './paths.mjs';
import { parseFrontmatter } from './review.mjs';
import { ensureFresh, openDb, resolveLinks, deriveProvlinks } from '../../retrieval/scripts/lib/store.mjs';
import { extractWikilinks } from '../../retrieval/scripts/lib/chunk.mjs';

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
  const push = (from, to, kind) => { if (to !== from && known.has(to)) edges.push({ from, to, kind }); };

  // Approved pages: authored outlinks + ADR-0007 derived provlinks straight
  // from the retrieval index. provlinks is forward-only (topic→source);
  // reverse is read-time in backlinks()/expansion — never stored.
  const db = openDb(kbRoot);
  const rows = db.prepare('SELECT path, source_ref, outlinks, provlinks FROM docs').all();
  db.close();
  const indexed = new Set();
  const approvedSources = []; // { path, source_ref } — join targets for the candidate scan
  for (const r of rows) {
    if (!known.has(r.path)) continue; // stale row (e.g. archived) — skip
    indexed.add(r.path);
    for (const to of JSON.parse(r.outlinks || '[]')) push(r.path, to, 'authored');
    for (const to of JSON.parse(r.provlinks || '[]')) push(r.path, to, 'derived');
    if (r.source_ref) approvedSources.push({ path: r.path, source_ref: r.source_ref });
  }

  // Pages retrieval skipped (candidates, index.md): scan UI-side with the
  // same extractor, resolved against the graph's own node set. Candidate
  // topics additionally get forward provenance via the shared deriveProvlinks
  // (ADR-0007) — candidate-T→S edges exist, read-time reverse makes S→T
  // symmetric.
  const knownSorted = [...known].sort();
  for (const n of nodes) {
    if (indexed.has(n.path)) continue;
    const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(kbRoot, n.path), 'utf8'));
    for (const to of resolveLinks(extractWikilinks(body), knownSorted)) push(n.path, to, 'authored');
    if (n.type === 'topic' && Array.isArray(fields.sources) && fields.sources.length) {
      for (const to of deriveProvlinks(approvedSources, fields.sources).links) push(n.path, to, 'derived');
    }
  }

  // per-topic coverage count (number of derived sources) for the navigation
  // tree; per-source it's the number of covering topics, derivable at read time
  const coverage = new Map();
  for (const e of edges) if (e.kind === 'derived') {
    coverage.set(e.from, (coverage.get(e.from) || 0) + 1);
    coverage.set(e.to, (coverage.get(e.to) || 0) + 1);
  }
  for (const n of nodes) {
    if (coverage.has(n.path)) n.coverage = coverage.get(n.path);
  }

  return { nodes, edges };
}

// Backlinks (A6) over the shared edge list. ADR-0007 splits the panel into two
// groups: authored "references" and derived "coverage sources" (the topics
// built on this source). The additive `kind` field (references | coverage)
// keeps the existing {path, title} shape and its stability comment intact for
// callers/tests that predate it.
export function backlinks(kbRoot, pageRel) {
  const { nodes, edges } = buildGraph(kbRoot);
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.to !== pageRel || seen.has(e.from)) continue;
    seen.add(e.from);
    out.push({
      path: e.from,
      title: byPath.get(e.from)?.title || path.basename(e.from, '.md'),
      kind: e.kind === 'derived' ? 'coverage' : 'references', // additive group tag
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
