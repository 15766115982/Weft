// Query layer: structured query parse → per-term routing (FTS latin / FTS
// trigram / LIKE for short terms) → AND intersection → BM25 ranking → ≤2
// snippets per page → wikilink graph expansion → candidate space.
// Design per ADR-0003: the logical query defines the candidate set, BM25
// defines the ranking; the vector leg is off by default.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './store.mjs';

const CJK = /[　-鿿豈-﫿]/;

/** Structured query parse: "phrase" field:value bare-term (AND semantics).
 *  Fields: type/source/tag exact match; after:/before: filter by "the
 *  document's own update time" (source_version preferred when it is an ISO
 *  date, falling back to updated_at); ISO lexicographic comparison */
export function parseQuery(input) {
  const filters = [];
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of input.matchAll(re)) {
    const tok = m[1] ?? m[2];
    const f = m[1] === undefined && tok.match(/^(type|source|tag|after|before):(.+)$/);
    if (f) filters.push({ field: f[1], value: f[2] });
    else terms.push(tok);
  }
  return { terms, filters };
}

// FTS term sanitization: wrap in double quotes + double internal quotes, so
// hyphens/special chars are no longer interpreted as operators
const ftsQuote = (t) => `"${t.replace(/"/g, '""')}"`;

/** Per-term routing: CJK ≥3 chars → fts_cjk; CJK <3 → LIKE (trigram's
 *  physical blind spot); everything else → fts_latin */
function routeTerm(term) {
  if (CJK.test(term)) return [...term].length >= 3 ? 'cjk' : 'like';
  return 'latin';
}

function makeSnippet(text, terms) {
  let pos = -1;
  for (const t of terms) { pos = text.indexOf(t); if (pos >= 0) break; }
  const start = Math.max(0, (pos < 0 ? 0 : pos) - 60);
  return text.slice(start, start + 200).trim();
}

export function search(kbRoot, input, { within = [], limit = 50 } = {}) {
  const { terms, filters } = parseQuery(input);
  const db = openDb(kbRoot);
  try {
    // 1. Document-level filtering (field filters + --within; within tolerates
    // Windows backslashes and trailing slashes)
    let docRows = db.prepare('SELECT * FROM docs').all();
    const withinNorm = within.map(w => w.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.md$/i, ''));
    if (withinNorm.length) {
      docRows = docRows.filter(d => withinNorm.some(w => d.path.replace(/\.md$/i, '') === w || d.path.startsWith(w + '/')));
    }
    for (const f of filters) {
      docRows = docRows.filter(d => {
        if (f.field === 'type') return d.type === f.value;
        if (f.field === 'source') return d.source === f.value;
        if (f.field === 'tag') return JSON.parse(d.tags || '[]').includes(f.value);
        // effective date = source-system update time (src_updated) preferred,
        // falling back to governance time (updated); ISO8601 lexicographic
        // order is chronological; after includes that day, before includes
        // that day's midnight
        const eff = d.src_updated || d.updated || '';
        if (f.field === 'after') return eff >= f.value;
        if (f.field === 'before') return eff !== '' && eff <= f.value;
        return true;
      });
    }
    const allowedDocs = new Set(docRows.map(d => d.path));
    const docMeta = new Map(docRows.map(d => [d.path, d]));

    // 2. Per-term hit sets, AND intersection (logical query defines the
    // candidate set)
    const score = new Map(); // chunkId → score
    let candidate = null;    // Set<chunkId>
    const routed = { latin: [], cjk: [], like: [] };
    for (const t of terms) {
      const mode = routeTerm(t);
      routed[mode].push(t);
      let hits = new Map(); // chunkId → termScore
      if (mode === 'like') {
        for (const r of db.prepare('SELECT id, text FROM chunks').all()) {
          const n = r.text.split(t).length - 1;
          if (n > 0) hits.set(r.id, Math.min(n, 5));
        }
      } else {
        const table = mode === 'cjk' ? 'fts_cjk' : 'fts_latin';
        for (const r of db.prepare(`SELECT rowid, bm25(${table}) b FROM ${table} WHERE ${table} MATCH ?`).all(ftsQuote(t))) {
          hits.set(r.rowid, -r.b);
        }
      }
      candidate = candidate === null ? new Set(hits.keys())
        : new Set([...candidate].filter(id => hits.has(id)));
      for (const [id, s] of hits) if (candidate.has(id)) score.set(id, (score.get(id) || 0) + s);
    }

    // no free terms = pure field filtering; all chunks become candidates
    if (candidate === null) {
      candidate = new Set(db.prepare('SELECT id FROM chunks').all().map(r => r.id));
      for (const id of candidate) score.set(id, 1);
    }

    // 3. Filter to allowed docs, rank, ≤2 snippets per page
    const chunkStmt = db.prepare('SELECT * FROM chunks WHERE id=?');
    const hits = [...candidate]
      .map(id => ({ ...chunkStmt.get(id), score: score.get(id) || 0 }))
      .filter(c => allowedDocs.has(c.doc_path))
      .sort((a, b) => b.score - a.score);
    const perPage = new Map();
    const candidates = [];
    for (const c of hits) {
      const n = perPage.get(c.doc_path) || 0;
      if (n >= 2) continue; // contract: ≤2 snippets per page, controls context cost
      perPage.set(c.doc_path, n + 1);
      const meta = docMeta.get(c.doc_path);
      candidates.push({
        page: c.doc_path, anchor: c.anchor, heading: c.heading,
        score: Math.round(c.score * 1000) / 1000,
        snippet: makeSnippet(c.text, terms), title: meta?.title || '', via: 'search',
      });
      if (candidates.length >= limit) break;
    }

    // 4. wikilink graph expansion: outlink neighbors of top-hit pages join the
    // candidates (the retrieval dividend of governance structure)
    const GRAPH_EXPAND_TOP = 10; // expand links only from the top-10 most relevant pages, bounding candidate growth
    const seen = new Set(candidates.map(c => c.page));
    for (const c of candidates.slice(0, GRAPH_EXPAND_TOP)) {
      const meta = docMeta.get(c.page);
      for (const link of JSON.parse(meta?.outlinks || '[]')) {
        if (seen.has(link) || !allowedDocs.has(link)) continue;
        seen.add(link);
        const nm = docMeta.get(link);
        candidates.push({ page: link, anchor: '', heading: '', score: 0, snippet: '', title: nm?.title || '', via: 'link' });
      }
    }

    // 5. Candidate space on disk: preview (top-10) + full list written to
    // .kb/candidates/
    const id = crypto.createHash('sha256').update(input + Date.now()).digest('hex').slice(0, 8);
    const dir = path.join(kbRoot, '.kb', 'candidates');
    fs.mkdirSync(dir, { recursive: true });
    const file = `.kb/candidates/${id}.json`;
    fs.writeFileSync(path.join(kbRoot, file), JSON.stringify({ query: input, candidates }, null, 2), 'utf8');
    // the contract calls these "temporary": besides this run's file keep only
    // the 19 newest (≤20 total), preventing unbounded growth; exclude this
    // run's file — on a same-millisecond mtime tie we must not delete the
    // candidates just written
    const KEEP = 20;
    const stale = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== `${id}.json`)
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(KEEP - 1);
    for (const s of stale) fs.unlinkSync(path.join(dir, s.f));

    return {
      query: input, routed,
      total: candidates.length,
      preview: candidates.slice(0, 10),
      candidates_file: file,
      hint: 'use read <page>#<anchor> for the full section; narrow the scope with --within and search again',
    };
  } finally {
    db.close();
  }
}
