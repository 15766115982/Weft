// raw/ doc persistence (contract §2): deterministic filename + identity five-tuple + incremental skip.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildFrontmatter, parseFrontmatter } from './frontmatter.mjs';

export function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// filename sanitization: keep CJK, replace filesystem-forbidden chars
export function slugify(name) {
  return name
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
}

/**
 * Upsert one raw doc. Incremental rule (contract §2):
 * target exists with matching content_hash → skip; otherwise overwrite
 * (re-pulls keep only the latest version).
 * @returns {{action: 'created'|'updated'|'unchanged', relPath: string}}
 */
export function upsertRawDoc(kbRoot, doc) {
  const relPath = path.join('raw', doc.source, doc.fileName);
  const absPath = path.join(kbRoot, relPath);
  const existed = fs.existsSync(absPath);

  if (existed) {
    const old = parseFrontmatter(fs.readFileSync(absPath, 'utf8'));
    if (old.fields.content_hash === `sha256:${doc.contentHash}`) {
      return { action: 'unchanged', relPath };
    }
  }

  const fm = buildFrontmatter({
    source: doc.source,
    source_id: doc.sourceId,
    source_url: doc.sourceUrl,
    source_version: doc.sourceVersion,
    pulled_at: new Date().toISOString(),
    content_hash: `sha256:${doc.contentHash}`,
    title: doc.title,
    connector: doc.connector,
    ...(doc.extra && Object.keys(doc.extra).length ? { extra: doc.extra } : {}),
  });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, fm + '\n' + doc.body, 'utf8');
  return { action: existed ? 'updated' : 'created', relPath };
}
