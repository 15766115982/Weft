// Path gates for the UI portal (S8, ADR-0006). Same discipline as the thin viewer:
// one shared normalized product (lowercased on win32) feeds every comparison —
// the M3 wiki/ARCHIVE bypass was exactly the "normalize one, compare the other raw" bug.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);

// Resolved-path prefix check under an expected root.
export function resolveUnder(kbRoot, rel, mustStartWith) {
  const abs = path.resolve(kbRoot, rel);
  const root = path.resolve(kbRoot, mustStartWith);
  if (norm(abs) !== norm(root) && !norm(abs).startsWith(norm(root) + path.sep)) {
    throw new Error(`path escapes ${mustStartWith}: ${rel}`);
  }
  return abs;
}

// wiki page read gate: forward slashes, under wiki/, per-segment `..` rejection,
// .md only. (Same shape as governance's normalizeWikiRel, re-declared here so the
// read path does not depend on the write primitive's module.)
export function normalizeWikiRelRead(input) {
  const rel = String(input).replace(/\\/g, '/');
  if (!rel.startsWith('wiki/') || rel.split('/').some((s) => s === '..') || !rel.endsWith('.md')) {
    throw new Error(`wiki path must be a relative .md path under wiki/: ${input}`);
  }
  return rel;
}

// raw/ read gate (evidence pane): same rules, under raw/.
export function normalizeRawRel(input) {
  const rel = String(input).replace(/\\/g, '/');
  if (!rel.startsWith('raw/') || rel.split('/').some((s) => s === '..') || !rel.endsWith('.md')) {
    throw new Error(`raw path must be a relative .md path under raw/: ${input}`);
  }
  return rel;
}

// inbox upload target gate (whitelist ①): a bare filename, no separators at all.
export function normalizeInboxName(input) {
  const name = String(input).replace(/\\/g, '/');
  if (!name || name.includes('/') || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error(`inbox filename must be a bare filename: ${input}`);
  }
  return name;
}

// F3 KB-root file gate (GOVERNANCE.md editing): bare filename + whitelist.
// The whitelist — not a pattern — is the security boundary; add entries
// deliberately, never user-controlled.
const KBFILE_WHITELIST = new Set(['GOVERNANCE.md']);
export function normalizeKbFileName(input) {
  const name = normalizeInboxName(input);
  if (!KBFILE_WHITELIST.has(name)) {
    throw new Error(`KB-root file not editable via portal: ${input} (allowed: ${[...KBFILE_WHITELIST].join(', ')})`);
  }
  return name;
}

// raw-asset read gate (phase 1: Gliffy PNG sidecars, contract §1 amendment
// 2026-08-03): under raw/, inside a *.assets/ directory, image extensions
// only, per-segment traversal rejection. Whitelists, not patterns.
const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
const ASSET_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
export function normalizeRawAssetRel(input) {
  const rel = String(input).replace(/\\/g, '/');
  const segs = rel.split('/');
  if (!rel.startsWith('raw/') || segs.some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`asset path must be under raw/ without traversal: ${input}`);
  }
  // parent directory must be a sidecar dir: raw/<source>/<id>.assets/<file>
  if (segs.length !== 4 || !segs[2].endsWith('.assets')) {
    throw new Error(`asset path must be raw/<source>/<id>.assets/<file>: ${input}`);
  }
  const ext = path.posix.extname(rel).toLowerCase();
  if (!ASSET_EXT.has(ext)) {
    throw new Error(`asset extension not allowed: ${ext} (allowed: ${[...ASSET_EXT].join(', ')})`);
  }
  return rel;
}
export function assetMime(rel) {
  return ASSET_MIME[path.posix.extname(rel).toLowerCase()];
}

export function* walkMd(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield p;
  }
}
