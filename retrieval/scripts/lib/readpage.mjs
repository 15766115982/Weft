// Page resolution and gates for the read command (retrieval-side double
// protection, same level as search's approved gate):
// 1. path must resolve inside <kb>/wiki/ (trailing path.sep blocks the
//    wiki-evil/ prefix bypass; case-insensitive Windows FS compared lowercase);
// 2. pages under wiki/archive/ are never readable (archived = void, contract §4);
// 3. whitelist gate: only wiki/index.md (navigation page without status) is
//    exempt; every other page must carry explicit status: approved — a
//    frontmatter parse failure (BOM/malformed) presents as "no status" and is
//    fail-closed, same as the search side; not let through.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.mjs';

export function readWikiPage(kbRoot, pageRel) {
  const rel = String(pageRel || '').replace(/\\/g, '/');
  if (!rel) throw new Error('read requires <page-path>[#anchor]');
  const relMd = /\.md$/i.test(rel) ? rel : rel + '.md';
  const wikiRoot = path.resolve(kbRoot, 'wiki');
  const abs = path.resolve(kbRoot, relMd);
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (!norm(abs).startsWith(norm(wikiRoot) + path.sep) || !fs.existsSync(abs)) {
    throw new Error(`page not found or not under wiki/: ${rel}`);
  }
  // normRel goes through the same norm() normalization: path.relative is pure
  // string ops and preserves input case, so on Windows a wiki/ARCHIVE/ case
  // variant could bypass the archive check (leftover from review round 3)
  const normRel = norm(path.relative(kbRoot, abs)).replace(/\\/g, '/');
  if (normRel.startsWith('wiki/archive/')) {
    throw new Error(`archived page is outside the retrieval candidate space, read refused: ${normRel}`);
  }
  const { fields, body } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  if (normRel !== 'wiki/index.md' && fields.status !== 'approved') {
    throw new Error(`page not approved (status: ${fields.status ?? 'missing/parse-failed'}), retrieval service reads approved pages only: ${normRel}`);
  }
  return { body, rel: normRel };
}
