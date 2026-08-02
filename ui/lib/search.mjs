// Search integration (S2: read-hot path, in-process import — no spawn overhead).
// Imports the retrieval service's libs directly; better-sqlite3 resolves from
// retrieval/scripts/node_modules relative to those files. Zero behavior change
// on the retrieval side: ensureFresh runs exactly as the CLI would run it.
//
// `routed` (per-term routing legs: latin/cjk/like) comes from search()'s return
// value (query.mjs) — B4 needs no CLI change. The candidates_file is read
// immediately and never referenced later: retrieval keeps only the 20 newest
// (KEEP=20), so holding paths across requests would 404.
import fs from 'node:fs';
import path from 'node:path';
import { ensureFresh } from '../../retrieval/scripts/lib/store.mjs';
import { search } from '../../retrieval/scripts/lib/query.mjs';

export function runSearch(kbRoot, q, { limit = 50 } = {}) {
  if (!q || !String(q).trim()) throw new Error('search requires a query string');
  ensureFresh(kbRoot); // lazy reconciliation, same as the CLI
  const result = search(kbRoot, String(q), { limit });
  let candidates = result.preview;
  if (result.candidates_file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(kbRoot, result.candidates_file), 'utf8'));
      candidates = parsed.candidates;
    } catch { /* file churned or unreadable — degrade to preview */ }
  }
  return {
    query: result.query,
    routed: result.routed,
    total: result.total,
    preview: result.preview,
    candidates,
  };
}
