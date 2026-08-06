// Local-file fallback connector (contract §1 raw/local/, §2 spec).
// Until a dedicated connector is ready, any source enters the KB by manually
// exporting files into the inbox.
// Converter registry dispatches by extension; adding docx/pdf later does not
// change this file's framework logic.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, slugify, upsertRawDoc } from '../lib/rawdoc.mjs';
import { appendLog } from '../lib/log.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

export const CONNECTOR_ID = 'local@1.0.0';

// extension → (raw text, {fileName}) => normalized markdown body
const converters = {
  '.md': (text) => text,
  '.markdown': (text) => text,
  '.txt': (text, { title }) => `# ${title}\n\n${text}`,
};

function normalizeBody(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim() + '\n';
}

function extractTitle(body, fallback) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/**
 * Reconcile: docs in raw/local/ whose inbox source is gone → orphaned.
 * Report-only by default; prune=true deletes and logs (explicit cleanup, irreversible).
 */
function reconcile(kbRoot, inbox, { prune }) {
  const orphaned = [], pruned = [];
  const rawLocalDir = path.join(kbRoot, 'raw', 'local');
  if (!fs.existsSync(rawLocalDir)) return { orphaned, pruned };
  for (const f of fs.readdirSync(rawLocalDir)) {
    if (!f.endsWith('.md')) continue;
    const abs = path.join(rawLocalDir, f);
    const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
    const inboxPath = fields.extra?.inbox_path;
    if (!inboxPath) continue;
    if (!fs.existsSync(path.join(inbox, inboxPath))) {
      const rel = `raw/local/${f}`;
      orphaned.push(rel);
      if (prune) {
        fs.unlinkSync(abs);
        pruned.push(rel);
        appendLog(kbRoot, 'acquire', 'local:pruned', rel, `inbox source gone: ${inboxPath}`);
      }
    }
  }
  return { orphaned, pruned };
}

export function detect(kbRoot, { inbox }) {
  const result = { new: [], changed: [], unchanged: [], removed_upstream: [], errors: [] };
  if (!fs.existsSync(inbox)) {
    result.errors.push({ inbox, error: 'inbox directory does not exist' });
    return result;
  }

  // Map existing raw/local docs by their inbox path.
  const byInbox = new Map();
  const rawLocalDir = path.join(kbRoot, 'raw', 'local');
  if (fs.existsSync(rawLocalDir)) {
    for (const f of fs.readdirSync(rawLocalDir)) {
      if (!f.endsWith('.md')) continue;
      const abs = path.join(rawLocalDir, f);
      try {
        const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
        const inboxPath = fields.extra?.inbox_path;
        if (inboxPath) {
          byInbox.set(inboxPath, {
            path: `raw/local/${f}`,
            version: String(fields.source_version || ''),
            title: String(fields.title || ''),
            source_id: String(fields.source_id || ''),
          });
        }
      } catch { /* skip malformed */ }
    }
  }

  const seen = new Set();
  for (const absPath of walk(inbox)) {
    const ext = path.extname(absPath).toLowerCase();
    const relInbox = path.relative(inbox, absPath).replace(/\\/g, '/');
    if (!converters[ext]) continue; // same extension filter as run()
    try {
      const stat = fs.statSync(absPath);
      const version = stat.mtime.toISOString();
      const stem = path.basename(absPath, ext);
      const sourceId = sha256(relInbox).slice(0, 8);
      const existing = byInbox.get(relInbox);
      const item = {
        id: sourceId,
        upstream_id: relInbox,
        version,
        title: extractTitle(normalizeBody(converters[ext](fs.readFileSync(absPath, 'utf8'), { title: stem })), stem),
      };
      if (!existing) {
        result.new.push(item);
      } else if (existing.version !== version) {
        result.changed.push({ ...item, path: existing.path, local_version: existing.version });
      } else {
        result.unchanged.push({ ...item, path: existing.path });
      }
      seen.add(relInbox);
    } catch (err) {
      result.errors.push({ file: relInbox, error: err.message });
    }
  }

  for (const [inboxPath, local] of byInbox) {
    if (!seen.has(inboxPath)) {
      result.removed_upstream.push({ path: local.path, source_id: local.source_id, upstream_id: inboxPath, title: local.title });
    }
  }
  return result;
}

export function run(kbRoot, { inbox, prune = false }) {
  const summary = { created: [], updated: [], unchanged: [], unsupported: [], orphaned: [], pruned: [], errors: [] };
  if (!fs.existsSync(inbox)) {
    summary.errors.push({ inbox, error: 'inbox directory does not exist' });
    return summary;
  }

  for (const absPath of walk(inbox)) {
    const ext = path.extname(absPath).toLowerCase();
    const relInbox = path.relative(inbox, absPath);
    const convert = converters[ext];
    if (!convert) {
      summary.unsupported.push(relInbox);
      continue;
    }
    try {
      const stat = fs.statSync(absPath);
      const stem = path.basename(absPath, ext);
      const rawText = fs.readFileSync(absPath, 'utf8');
      const body = normalizeBody(convert(rawText, { title: stem }));
      const sourceId = sha256(relInbox.replace(/\\/g, '/')).slice(0, 8);
      const result = upsertRawDoc(kbRoot, {
        source: 'local',
        sourceId,
        fileName: `${sourceId}-${slugify(stem)}.md`,
        sourceUrl: `file:///${absPath.replace(/\\/g, '/')}`,
        sourceVersion: stat.mtime.toISOString(),
        title: extractTitle(body, stem),
        connector: CONNECTOR_ID,
        extra: { inbox_path: relInbox.replace(/\\/g, '/') },
        contentHash: sha256(body),
        body,
      });
      summary[result.action === 'created' ? 'created' : result.action === 'updated' ? 'updated' : 'unchanged']
        .push(result.relPath.replace(/\\/g, '/'));
      if (result.action !== 'unchanged') {
        appendLog(kbRoot, 'acquire', `local:${result.action}`, result.relPath.replace(/\\/g, '/'), `from ${relInbox.replace(/\\/g, '/')}`);
      }
    } catch (err) {
      summary.errors.push({ file: relInbox, error: err.message });
    }
  }

  const { orphaned, pruned } = reconcile(kbRoot, inbox, { prune });
  summary.orphaned = orphaned;
  summary.pruned = pruned;
  return summary;
}
