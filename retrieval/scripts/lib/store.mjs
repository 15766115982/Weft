// Index layer: .kb/index.sqlite (derived artifact). .kb/ ownership is
// partitioned (contract §1 / plan 0001 §3.3): retrieval owns index.sqlite +
// search_state.json + candidates/; governance owns .kb/govern/ (tombstones,
// dismissals, conflicts); the portal owns .kb/ui/ + govern_runs.jsonl. Dual
// FTS5 tables: fts_latin (porter unicode61) / fts_cjk (trigram); only
// status=approved pages are indexed; incremental rebuild keyed on page content
// hash (lazy reconciliation driven by ensureFresh).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { chunkPage, extractWikilinks } from './chunk.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// schema version: bump = full rebuild (the index is a derived artifact,
// contract §1: deleting .kb/ does not affect correctness).
// History: 2 = docs.updated column; 3 = docs.src_updated column;
// 4 = both date columns normalized to UTC at index time (existing rows kept
// their raw offsets, which mis-sort lexicographically — force a rebuild);
// 5 = mtime/size columns on docs+skips so ensureFresh can skip re-hashing
// files whose stat is unchanged (review 2026-08-04: the per-request full-corpus
// re-hash made every search O(N files) of disk reads)
// 6 = ADR-0007: provlinks (forward topic→source provenance edges, separate from
// authored outlinks) + a copied `sources` column (so the post-reconcile derived
// pass joins via pure SQL — reading topic frontmatter directly would revive
// O(topics) disk reads on deletion-heavy reconciles)
const SCHEMA_VERSION = 6;

export function openDb(kbRoot) {
  const dir = path.join(kbRoot, '.kb');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'index.sqlite'));
  db.pragma('journal_mode = WAL');
  if (db.pragma('user_version', { simple: true }) < SCHEMA_VERSION) {
    db.exec('DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS chunks;' +
      'DROP TABLE IF EXISTS fts_latin; DROP TABLE IF EXISTS fts_cjk;' +
      'DROP TABLE IF EXISTS skips;');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs(
      path TEXT PRIMARY KEY, type TEXT, title TEXT, source_ref TEXT,
      source TEXT, tags TEXT, outlinks TEXT, provlinks TEXT, sources TEXT, hash TEXT, updated TEXT, src_updated TEXT,
      mtime REAL, size INTEGER);
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY, doc_path TEXT, anchor TEXT, heading TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS skips(path TEXT PRIMARY KEY, hash TEXT, mtime REAL, size INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_latin USING fts5(text, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_cjk USING fts5(text, tokenize='trigram');
  `);
  return db;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && /\.md$/i.test(e.name)) yield p;
  }
}

// wikilink target → page path resolution: [[x]] may be sources/local-a1, a
// bare slug, or carry #anchor (the anchor only affects read positioning; graph
// expansion takes the page); with multiple same-basename pages, take the first
// in sorted path order (deterministic).
// Exported for the UI portal's graph layer (ui/lib/graph.mjs imports it
// in-process) — one caliber, one implementation (review 2026-08-04: the
// hand-copy had drift risk).
export function resolveLinks(links, knownPaths) {
  const out = [];
  for (const l of links) {
    const norm = l.split('#')[0].replace(/\.md$/i, '');
    if (!norm) continue;
    const hit = knownPaths.find(p => p.replace(/\.md$/i, '') === norm)
      || knownPaths.find(p => p.replace(/\.md$/i, '').endsWith('/' + norm));
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * ADR-0007: join a topic's `sources:` frontmatter entries (raw paths) to the
 * approved source pages they trace to. Forward-only (topic → source); reverse
 * edges are computed at read time. Join caliber (review round 2 R3.2, pinned):
 *   exact `entry === source_ref` primary;
 *   fallback `entry.endsWith('/' + basename(source_ref))` — the '/' anchor
 *   follows resolveLinks' `endsWith('/' + norm)` (above), deliberately stricter
 *   than browse.mjs rawRefs' loose caliber so `…/aaaa1111-pay.md` cannot
 *   mis-match a `pay.md` source_ref.
 * Unmatched → dropped, counted. Ambiguous (two source pages share the basename
 * and both anchor-match) → dropped, counted. Never silently: the caller
 * reports the counts (retrieval-side reindex output / health — NOT governance
 * plan(), which has zero import of retrieval).
 * Exported so the UI portal's candidate scan (ui/lib/graph.mjs) reuses the
 * same function — one caliber, one implementation (resolveLinks precedent).
 */
export function deriveProvlinks(sourcePages, entries) {
  const byRef = new Map();
  const byBase = new Map();
  for (const sp of sourcePages) {
    if (!sp.source_ref) continue;
    if (!byRef.has(sp.source_ref)) byRef.set(sp.source_ref, sp.path);
    const base = String(sp.source_ref).split('/').pop();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(sp.path);
  }
  const links = [];
  let unmatched = 0, ambiguous = 0;
  for (const raw of entries) {
    const e = String(raw);
    const exact = byRef.get(e);
    if (exact) { links.push(exact); continue; }
    const base = e.split('/').pop();
    const cands = (byBase.get(base) || []).filter(p => e.endsWith('/' + base));
    if (cands.length === 1) links.push(cands[0]);
    else if (cands.length === 0) unmatched++;
    else ambiguous++;
  }
  return { links, unmatched, ambiguous };
}

/** Post-reconcile derived pass (ADR-0007): recompute `provlinks` for every
 *  approved topic from its copied `sources` column, pure SQL — no disk reads
 *  (R3.1: reading topic frontmatter would revive O(topics) disk reads on
 *  deletion-heavy reconciles). Runs after the reconcile transaction, when the
 *  whole approved source_ref set is visible (fixes the A.3.10 join-window). */
function recomputeProvlinks(db) {
  const rows = db.prepare('SELECT path, source_ref, sources FROM docs').all();
  const sourcePages = rows.filter(r => r.source_ref);
  const update = db.prepare('UPDATE docs SET provlinks=? WHERE path=?');
  let edges = 0, unmatched = 0, ambiguous = 0;
  for (const r of rows) {
    let entries;
    try { entries = JSON.parse(r.sources || '[]'); } catch { entries = []; }
    if (!Array.isArray(entries) || !entries.length) continue;
    const { links, unmatched: u, ambiguous: a } = deriveProvlinks(sourcePages, entries);
    edges += links.length; unmatched += u; ambiguous += a;
    update.run(JSON.stringify(links), r.path);
  }
  return { edges, unmatched, ambiguous };
}

function indexDoc(db, kbRoot, rel, knownPaths, hash, stat) {
  const abs = path.join(kbRoot, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const { fields, body } = parseFrontmatter(text);
  if (fields.status !== 'approved') return false; // contract: approved only

  const insertDoc = db.prepare(
    'INSERT INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertChunk = db.prepare(
    'INSERT INTO chunks(doc_path,anchor,heading,text) VALUES(?,?,?,?)');
  const insertLatin = db.prepare('INSERT INTO fts_latin(rowid,text) VALUES(?,?)');
  const insertCjk = db.prepare('INSERT INTO fts_cjk(rowid,text) VALUES(?,?)');

  const outlinks = resolveLinks(extractWikilinks(body), knownPaths);
  const source = fields.source_ref ? (fields.source_ref.split('/')[1] || '') : '';
  // source-system update time (when source_version is an ISO date) lets
  // after:/before: filter by "the document's own update time"; non-ISO (plain
  // version number) stays empty, falling back to governance time updated_at.
  // Both dates are normalized to UTC (Z): query.mjs compares them
  // lexicographically, which is only chronological within one offset —
  // a future connector emitting +08:00 must not silently mis-sort
  const toUtc = (s) => {
    const v = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  };
  const srcUpdated = toUtc(fields.source_version);
  // sources copy column (ADR-0007): topic frontmatter `sources:` array, copied
  // so the post-reconcile derived pass joins pure SQL without touching disk.
  // provlinks is written empty here; the derived pass fills it after the
  // reconcile transaction (it needs the whole approved source_ref set in one pass).
  insertDoc.run(rel, fields.type || '', fields.title || '', fields.source_ref || '',
    source, JSON.stringify(fields.tags || []), JSON.stringify(outlinks),
    JSON.stringify([]), JSON.stringify(fields.sources || []), hash,
    toUtc(fields.updated_at) || String(fields.updated_at || ''), srcUpdated,
    stat.mtime, stat.size);
  for (const c of chunkPage(body)) {
    const { lastInsertRowid } = insertChunk.run(rel, c.anchor, c.heading, c.text);
    insertLatin.run(lastInsertRowid, c.text);
    insertCjk.run(lastInsertRowid, c.text);
  }
  return true;
}

function removeDoc(db, rel) {
  const ids = db.prepare('SELECT id FROM chunks WHERE doc_path=?').all(rel).map(r => r.id);
  const delFts = (table, id) => db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(id);
  for (const id of ids) { delFts('fts_latin', id); delFts('fts_cjk', id); }
  db.prepare('DELETE FROM chunks WHERE doc_path=?').run(rel);
  db.prepare('DELETE FROM docs WHERE path=?').run(rel);
  db.prepare('DELETE FROM skips WHERE path=?').run(rel);
}

/**
 * Lazy reconciliation: compare actual wiki/ files against indexed hashes and
 * rebuild only the diff (added/changed/deleted). Called automatically before
 * search; no governance-side callback needed (ADR-0001: zero coupling between
 * the two services).
 */
export function ensureFresh(kbRoot) {
  const db = openDb(kbRoot);
  const wikiDir = path.join(kbRoot, 'wiki');
  // stat-only pass first (review 2026-08-04): hashing every file on every call
  // made each search/graph/backlinks request read the whole wiki. A file whose
  // mtime+size both match the indexed row keeps its recorded hash — the same
  // trust level git gives its own stat cache. Residual blind spot, documented:
  // a same-size rewrite within one mtime tick is missed until the next real change.
  const stat = new Map(); // rel → {mtime, size}
  for (const abs of walk(wikiDir)) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    if (rel === 'wiki/index.md') continue;
    // archive/ is never in the candidate space (contract §4: archived = void;
    // the status flip is the governance-side double protection)
    if (rel.startsWith('wiki/archive/')) continue;
    const st = fs.statSync(abs);
    stat.set(rel, { mtime: st.mtimeMs, size: st.size });
  }
  const indexed = new Map(db.prepare('SELECT path, hash, mtime, size FROM docs').all().map(r => [r.path, r]));
  // non-approved pages never enter docs, but their hash must still be recorded
  // — otherwise every ensureFresh would re-parse them for nothing
  const skipped = new Map(db.prepare('SELECT path, hash, mtime, size FROM skips').all().map(r => [r.path, r]));

  const onDisk = new Map(); // rel → hash (read+hashed only when the stat changed)
  for (const [rel, st] of stat) {
    const row = indexed.get(rel) || skipped.get(rel);
    onDisk.set(rel, row && row.mtime === st.mtime && row.size === st.size
      ? row.hash
      : sha256(fs.readFileSync(path.join(kbRoot, rel), 'utf8')));
  }

  // reconciliation keys on both docs ∪ skips must be cleaned: when a skipped
  // candidate page is deleted, its skips row must go too
  const toRemove = [...new Set([...indexed.keys(), ...skipped.keys()])].filter(p => !onDisk.has(p));
  const toIndex = [...onDisk.entries()]
    .filter(([p, h]) => indexed.get(p)?.hash !== h && skipped.get(p)?.hash !== h).map(([p]) => p);

  const tx = db.transaction(() => {
    for (const p of toRemove) removeDoc(db, p);
    const known = [...onDisk.keys()].sort();
    for (const p of toIndex) {
      removeDoc(db, p);
      const ok = indexDoc(db, kbRoot, p, known, onDisk.get(p), stat.get(p));
      if (!ok) db.prepare('INSERT OR REPLACE INTO skips VALUES(?,?,?,?)')
        .run(p, onDisk.get(p), stat.get(p).mtime, stat.get(p).size);
    }
  });
  tx();
  // ADR-0007 derived pass: run whenever the reconcile changed anything — a pure
  // deletion (toRemove non-empty, toIndex empty) must still refresh ambiguity
  // resolution (two same-basename sources, one removed → the surviving unique
  // match must reappear). Never on the read path (keeps the fixed per-request
  // O(N) disk-scan regression dead); reads only the copied sources column.
  const provlinks = (toIndex.length || toRemove.length) ? recomputeProvlinks(db) : null;
  const stats = {
    added_or_updated: toIndex.length, removed: toRemove.length, total: onDisk.size,
    provlinks,
  };
  db.close();
  return stats;
}
