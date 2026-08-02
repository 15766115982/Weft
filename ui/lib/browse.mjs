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
  for (const sub of ['sources', 'topics']) {
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
  for (const sub of ['sources', 'topics']) {
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

// Backlinks (A6): scan wiki bodies for [[target]] references. Cheap at the
// expected scale (≤2k pages); fences/inline code are stripped first so code
// samples don't become edges (same reading convention as retrieval/governance).
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
// Fenced blocks are dropped whole, inline code blanked; closing fence must use
// the same character with length >= opening (retrieval chunker rules; a line of
// inline-code-only backticks is not a fence — CommonMark info-string rule).
function stripCode(text) {
  const out = [];
  let inFence = false, fenceCh = '', fenceLen = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inFence && m) {
      const rest = line.slice(line.indexOf(m[1]) + m[1].length);
      if (m[1][0] === '`' && rest.includes('`')) { out.push(line.replace(/`[^`\n]*`/g, '')); continue; }
      inFence = true; fenceCh = m[1][0]; fenceLen = m[1].length; out.push(''); continue;
    }
    if (inFence) {
      if (m && m[1][0] === fenceCh && m[1].length >= fenceLen) inFence = false;
      out.push(''); continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return out.join('\n');
}

export function backlinks(kbRoot, pageRel) {
  const base = path.basename(pageRel, '.md');
  const out = [];
  for (const sub of ['sources', 'topics']) {
    for (const abs of walkMd(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      if (rel === pageRel) continue;
      const text = stripCode(fs.readFileSync(abs, 'utf8'));
      WIKILINK_RE.lastIndex = 0;
      let m;
      while ((m = WIKILINK_RE.exec(text))) {
        const target = m[1].trim().replace(/\.md$/, '');
        // match by bare name, full relative form, or basename of a pathed link
        if (target === base || target.endsWith('/' + base) || path.basename(target) === base) {
          const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
          out.push({ path: rel, title: fields.title || path.basename(rel, '.md') });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

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
