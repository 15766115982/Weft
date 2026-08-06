// Read-side browse/health aggregations (A browsing, D dashboard, D5 freshness).
// plan() is imported in-process (read-only hot path, S2): its six lists are the
// dashboard's health metrics (D3, review P2-2) and the freshness indicator's
// data source — no UI-side re-scan, no violation of the dumb-consumer rule.
import fs from 'node:fs';
import path from 'node:path';
import { walkMd } from './paths.mjs';
import { parseFrontmatter } from './review.mjs';
import { plan } from '../../governance/scripts/lib/govern.mjs';

export function listWikiPages(kbRoot) {
  const pages = [];
  // index.md is the retrieval entry contract and the browse landing page —
  // it must be navigable in the tree (A4); flagged so health counts skip it.
  const indexAbs = path.join(kbRoot, 'wiki', 'index.md');
  if (fs.existsSync(indexAbs)) {
    pages.push({ path: 'wiki/index.md', title: 'Index', isIndex: true });
  }
  for (const sub of ['sources', 'entities', 'concepts', 'syntheses']) {
    for (const abs of walkMd(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      pages.push({
        path: rel, type: fields.type, status: fields.status,
        title: fields.title || path.basename(rel, '.md'), updated_at: fields.updated_at,
        // source system for source pages (search chips build from this, P2)
        source: fields.source_ref ? String(fields.source_ref).split('/')[1] : undefined,
      });
    }
  }
  return pages.sort((a, b) => a.path.localeCompare(b.path));
}

// raw → wiki reverse references (A5 second half; same frontmatter scan that
// G5's delete impact preview will reuse in M7b): source pages via source_ref,
// topic pages via their sources[] provenance list.
export function rawRefs(kbRoot, rawRel) {
  const out = [];
  for (const sub of ['sources', 'entities', 'concepts', 'syntheses']) {
    for (const abs of walkMd(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
      const hit = fields.source_ref === rawRel
        || (Array.isArray(fields.sources) && fields.sources.some((s) => s === rawRel || String(s).endsWith(rawRel.split('/').pop())));
      if (hit) out.push({ path: rel, title: fields.title || path.basename(rel, '.md'), status: fields.status });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Backlinks (A6) moved to lib/graph.mjs (A7): they are now served from the
// shared edge list (retrieval outlinks + candidate scan) instead of a
// per-request full-wiki scan.

// Dashboard health (D1/D3/D5): plan() six lists + page/status counts.
export function health(kbRoot) {
  const pages = listWikiPages(kbRoot).filter((p) => !p.isIndex);
  const byStatus = {};
  const byType = {};
  for (const p of pages) {
    byStatus[p.status || 'unknown'] = (byStatus[p.status || 'unknown'] || 0) + 1;
    byType[p.type || 'unknown'] = (byType[p.type || 'unknown'] || 0) + 1;
  }
  const p = plan(kbRoot);
  return {
    pages: { total: pages.length, byStatus, byType },
    plan: {
      pending: p.pending.length, anomalies: p.anomalies.length,
      orphaned_pages: p.orphaned_pages.length, errors: p.errors.length,
      review_queue: p.review_queue.length, dangling_links: p.dangling_links.length,
    },
    // D5: anything in pending/anomalies/review_queue means "wiki is behind raw
    // or awaits humans" — the client renders the governance call-to-action.
    stale: p.pending.length + p.anomalies.length + p.review_queue.length > 0,
  };
}
