// Index layer: .kb/index.sqlite (derived artifact, exclusively written by the
// retrieval service). Dual FTS5 tables: fts_latin (porter unicode61) /
// fts_cjk (trigram); only status=approved pages are indexed; incremental
// rebuild keyed on page content hash (lazy reconciliation driven by ensureFresh).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { chunkPage, extractWikilinks } from './chunk.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// schema version: bump = full rebuild (the index is a derived artifact,
// contract §1: deleting .kb/ does not affect correctness)
const SCHEMA_VERSION = 3;

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
      source TEXT, tags TEXT, outlinks TEXT, hash TEXT, updated TEXT, src_updated TEXT);
    CREATE TABLE IF NOT EXISTS chunks(
      id INTEGER PRIMARY KEY, doc_path TEXT, anchor TEXT, heading TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS skips(path TEXT PRIMARY KEY, hash TEXT);
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
// in sorted path order (deterministic)
function resolveLinks(links, knownPaths) {
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

function indexDoc(db, kbRoot, rel, knownPaths, hash) {
  const abs = path.join(kbRoot, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const { fields, body } = parseFrontmatter(text);
  if (fields.status !== 'approved') return false; // contract: approved only

  const insertDoc = db.prepare(
    'INSERT INTO docs VALUES(?,?,?,?,?,?,?,?,?,?)');
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
  insertDoc.run(rel, fields.type || '', fields.title || '', fields.source_ref || '',
    source, JSON.stringify(fields.tags || []), JSON.stringify(outlinks), hash,
    toUtc(fields.updated_at) || String(fields.updated_at || ''), srcUpdated);
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
  const onDisk = new Map(); // rel → hash
  for (const abs of walk(wikiDir)) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    if (rel === 'wiki/index.md') continue;
    // archive/ is never in the candidate space (contract §4: archived = void;
    // the status flip is the governance-side double protection)
    if (rel.startsWith('wiki/archive/')) continue;
    onDisk.set(rel, sha256(fs.readFileSync(abs, 'utf8')));
  }
  const indexed = new Map(db.prepare('SELECT path, hash FROM docs').all().map(r => [r.path, r.hash]));
  // non-approved pages never enter docs, but their hash must still be recorded
  // — otherwise every ensureFresh would re-parse them for nothing
  const skipped = new Map(db.prepare('SELECT path, hash FROM skips').all().map(r => [r.path, r.hash]));

  // reconciliation keys on both docs ∪ skips must be cleaned: when a skipped
  // candidate page is deleted, its skips row must go too
  const toRemove = [...new Set([...indexed.keys(), ...skipped.keys()])].filter(p => !onDisk.has(p));
  const toIndex = [...onDisk.entries()]
    .filter(([p, h]) => indexed.get(p) !== h && skipped.get(p) !== h).map(([p]) => p);

  const tx = db.transaction(() => {
    for (const p of toRemove) removeDoc(db, p);
    const known = [...onDisk.keys()].sort();
    for (const p of toIndex) {
      removeDoc(db, p);
      const ok = indexDoc(db, kbRoot, p, known, onDisk.get(p));
      if (!ok) db.prepare('INSERT OR REPLACE INTO skips VALUES(?,?)').run(p, onDisk.get(p));
    }
  });
  tx();
  const stats = { added_or_updated: toIndex.length, removed: toRemove.length, total: onDisk.size };
  db.close();
  return stats;
}
