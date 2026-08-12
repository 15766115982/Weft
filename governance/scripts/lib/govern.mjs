// Governance v2 core: plan (diff scan + conflict detection), applySourcePage,
// applyEntityPage / applyConceptPage / applySynthesisPage, review (approve /
// reject-with-restore / archive), sweep, merge, rebuild-index. Log actor=govern.
// Contract v2 (ADR-0009): four wiki page types — source | entity | concept | synthesis.
// Every mutating action writes a decision record to .kb/govern/decisions/<id>.json.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildFrontmatter, parseFrontmatter } from './frontmatter.mjs';
import { flipStatus, readStatus, normalizeWikiRel } from './statusflip.mjs';
import { findGroups, tokenize, titleTokensOverlap } from './similarity.mjs';
import { writeDecision, requireReason, readDecisions } from './decisions.mjs';

function appendLog(kbRoot, actor, action, target, note = '') {
  const line = `## [${new Date().toISOString()}] ${actor} | ${action} | ${target}${note ? ` | ${note}` : ''}\n`;
  fs.appendFileSync(path.join(kbRoot, 'log.md'), line, 'utf8');
}

/** A log action that marks a page as PENDING REVIEW. `govern | candidate:*`
 * is produced by the governance pipeline; `portal | candidate:*` by the UI
 * portal's manual-edit path (M7d, contract §1 whitelist ⑤: every portal wiki
 * edit demotes the page to candidate and logs this action). Both must be
 * treated identically by the sweep backfill and the unlogged-flip guard —
 * same pending-review semantics, same reading caliber. */
function isPendingCandidateAction(action) {
  return action.startsWith('govern | candidate:') || action.startsWith('portal | candidate:');
}

/* ---------------- adjudication-memory state files (.kb/govern/, plan 0001 §1) ---------------- */

function statePath(kbRoot, name) {
  return path.join(kbRoot, '.kb', 'govern', name);
}

function readJsonFile(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** map: rawRel -> { tombstoned_at, reason, page } */
export function readTombstones(kbRoot) {
  return readJsonFile(statePath(kbRoot, 'source-tombstones.json'), {});
}

export function writeTombstones(kbRoot, map) {
  writeJsonFile(statePath(kbRoot, 'source-tombstones.json'), map);
}

export function addTombstone(kbRoot, rawRel, { reason, page }) {
  const map = readTombstones(kbRoot);
  map[rawRel] = { tombstoned_at: new Date().toISOString(), reason, page };
  writeTombstones(kbRoot, map);
}

export function removeTombstone(kbRoot, rawRel) {
  const map = readTombstones(kbRoot);
  if (rawRel in map) {
    delete map[rawRel];
    writeTombstones(kbRoot, map);
  }
}

/** [{ raws: [rel...] (sorted), reason, dismissed_at }] */
export function readDismissals(kbRoot) {
  return readJsonFile(statePath(kbRoot, 'conflict-dismissals.json'), []);
}

export function writeDismissals(kbRoot, list) {
  writeJsonFile(statePath(kbRoot, 'conflict-dismissals.json'), list);
}

export function addDismissal(kbRoot, rawRels, reason) {
  const raws = [...new Set(rawRels)].sort();
  if (raws.length < 2) throw new Error('dismiss-conflict requires at least two distinct raw paths');
  for (const r of raws) normalizeRawRel(r);
  const list = readDismissals(kbRoot);
  const key = [...raws].join('\x00');
  if (!list.some((d) => [...d.raws].sort().join('\x00') === key)) {
    list.push({ raws, reason, dismissed_at: new Date().toISOString() });
    writeDismissals(kbRoot, list);
  }
  return { raws, reason };
}

export function isDismissedGroup(kbRoot, groupRaws) {
  const key = [...groupRaws].sort().join('\x00');
  return readDismissals(kbRoot).some((d) => [...d.raws].sort().join('\x00') === key);
}

/* ---------- raw-set freshness fingerprint (P1-4) ---------- */

function hashText(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function currentRawHashes(kbRoot) {
  const map = {};
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const fields = readFields(abs);
    // full-file fallback hash only when the doc carries no content_hash —
    // head-reading every file turned apply-* from O(N×corpus) IO into frontmatter reads
    map[rel] = fields.content_hash || hashText(fs.readFileSync(abs, 'utf8'));
  }
  return map;
}

function fingerprintOf(rawHashes) {
  const entries = Object.entries(rawHashes).map(([rel, h]) => `${rel}\t${h}`).sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export function readConflicts(kbRoot) {
  return readJsonFile(statePath(kbRoot, 'conflicts.json'), null);
}

export function writeConflicts(kbRoot, data) {
  writeJsonFile(statePath(kbRoot, 'conflicts.json'), data);
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

function readDoc(absPath) {
  return parseFrontmatter(fs.readFileSync(absPath, 'utf8'));
}

const HEAD_BYTES = 16 * 1024; // frontmatter lives at the top of the file

/**
 * Frontmatter-only read via a 16KB head buffer (2026-08-12 audit: apply-* used
 * to full-read every raw file per invocation just for fields — O(N×corpus) IO
 * on a govern run). Falls back to a full read only when the closing fence is
 * beyond the head (unusually long frontmatter).
 */
function readFields(absPath) {
  const fd = fs.openSync(absPath, 'r');
  let head;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
  const startsFm = head.startsWith('---') || head.charCodeAt(0) === 0xFEFF;
  if (startsFm && !head.includes('\n---')) {
    return parseFrontmatter(fs.readFileSync(absPath, 'utf8')).fields;
  }
  return parseFrontmatter(head).fields;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const RAW_REQUIRED = ['source', 'source_id', 'source_url', 'source_version', 'title'];
const VALID_STATUS = new Set(['candidate', 'approved', 'rejected', 'archived']);
const VALID_NON_SOURCE_TYPES = new Set(['entity', 'concept', 'synthesis']);

function missingRawFields(fields) {
  return RAW_REQUIRED.filter(k => !fields[k]);
}

/** Plural directory name for a wiki page type. */
function typeDir(type) {
  if (type === 'synthesis') return 'syntheses';
  return `${type}s`;
}

const WIKI_REVIEW_DIRS = ['sources', 'entities', 'concepts', 'syntheses'];

export function sourcePageRelPath(rawFields) {
  for (const k of ['source', 'source_id']) {
    if (!SAFE_ID.test(String(rawFields[k] || ''))) {
      throw new Error(`${k} contains illegal characters (path injection rejected): ${JSON.stringify(rawFields[k])}`);
    }
  }
  return path.join('wiki', 'sources', `${rawFields.source}-${rawFields.source_id}.md`);
}

function flatten(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeRawRel(rawRel) {
  const rel = String(rawRel).replace(/\\/g, '/');
  const hasTraversal = rel.split('/').some(seg => seg === '..');
  if (!rel.startsWith('raw/') || hasTraversal) {
    throw new Error(`--raw must be a relative path under raw/: ${JSON.stringify(rawRel)}`);
  }
  return rel;
}

/**
 * Scan raw/ vs wiki/sources/ and produce a work list.
 */
export function plan(kbRoot) {
  const pending = [], anomalies = [], errors = [], reviewQueue = [], suppressed = [];
  const raws = new Map();
  const rawBodies = new Map();
  const rawHashes = {};
  const tombstones = readTombstones(kbRoot);
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const text = fs.readFileSync(abs, 'utf8');
    const { fields, body } = parseFrontmatter(text);
    raws.set(rel, fields);
    rawBodies.set(rel, { body, filename: path.basename(abs) });
    rawHashes[rel] = fields.content_hash || hashText(text);

    const missing = missingRawFields(fields);
    if (missing.length) {
      errors.push({ raw: rel, error: `missing contract fields: ${missing.join(', ')}` });
      continue;
    }
    let pageRel;
    try {
      pageRel = sourcePageRelPath(fields).replace(/\\/g, '/');
    } catch (err) {
      errors.push({ raw: rel, error: err.message });
      continue;
    }
    const tomb = tombstones[rel];
    if (tomb) {
      suppressed.push({
        raw: rel, page: pageRel, reason: 'tombstoned',
        detail: tomb.reason, tombstoned_at: tomb.tombstoned_at, archived_page: tomb.page,
      });
      continue;
    }
    const pageAbs = path.join(kbRoot, pageRel);
    if (!fs.existsSync(pageAbs)) {
      pending.push({ raw: rel, page: pageRel, reason: 'new', title: fields.title });
    } else {
      const page = readFields(pageAbs);
      if (page.source_version !== fields.source_version) {
        pending.push({ raw: rel, page: pageRel, reason: 'stale', title: fields.title });
      } else if (page.content_hash && fields.content_hash && page.content_hash !== fields.content_hash) {
        anomalies.push({ raw: rel, page: pageRel, reason: 'hash-changed-version-unchanged', title: fields.title });
      }
    }
  }

  const orphanedPages = [];
  for (const abs of walk(path.join(kbRoot, 'wiki', 'sources'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const fields = readFields(abs);
    if (fields.source_ref && !raws.has(fields.source_ref)) {
      orphanedPages.push({ page: rel, missing_raw: fields.source_ref, title: fields.title });
    }
  }

  // Non-source pages: every provenance entry is re-checked across entities/concepts/syntheses.
  const pagesBySource = new Map();
  for (const sub of ['entities', 'concepts', 'syntheses']) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const fields = readFields(abs);
      for (const ref of Array.isArray(fields.sources) ? fields.sources : []) {
        if (!raws.has(ref)) orphanedPages.push({ page: rel, missing_raw: ref, title: fields.title });
        const list = pagesBySource.get(ref) ?? [];
        list.push(rel);
        pagesBySource.set(ref, list);
      }
    }
  }

  const known = new Set();
  for (const sub of WIKI_REVIEW_DIRS) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const noExt = rel.replace(/^wiki\//, '').replace(/\.md$/, '');
      known.add(noExt);
      known.add(noExt.replace(/^(sources|entities|concepts|syntheses)\//, ''));
      const fields = readFields(abs);
      if (fields.status === 'candidate') {
        reviewQueue.push({ page: rel, type: fields.type, title: fields.title, updated_at: fields.updated_at });
      } else if (!fields.status) {
        errors.push({ page: rel, error: 'page missing status field (malformed frontmatter?)' });
      } else if (!VALID_STATUS.has(fields.status)) {
        errors.push({ page: rel, error: `page has illegal status "${flatten(fields.status)}" (expected candidate|approved|rejected|archived)` });
      }
    }
  }

  const dangling = [];
  for (const sub of WIKI_REVIEW_DIRS) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const { body } = readDoc(abs);
      for (const m of stripCode(body).matchAll(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        const target = m[1].trim().replace(/\.md$/, '');
        if (!known.has(target)) dangling.push({ page: rel, link: target });
      }
    }
  }

  let tombstonesCleaned = 0;
  for (const rel of Object.keys(tombstones)) {
    if (!raws.has(rel)) {
      delete tombstones[rel];
      suppressed.push({ raw: rel, reason: 'dangling-tombstone (cleaned; raw no longer present)' });
      tombstonesCleaned++;
    }
  }
  if (tombstonesCleaned) writeTombstones(kbRoot, tombstones);

  const rawDocs = [...raws.entries()]
    .filter(([rel]) => !tombstones[rel])
    .map(([rel, fields]) => ({
      rel,
      title: fields.title,
      filename: rawBodies.get(rel)?.filename ?? '',
      body: rawBodies.get(rel)?.body ?? '',
      content_hash: fields.content_hash || undefined,
    }));
  const { groups: conflictGroups, warnings: conflictWarnings } = findGroups(rawDocs);

  const dismissedKeys = new Set(readDismissals(kbRoot).map((d) => [...d.raws].sort().join('\x00')));
  const conflicts = conflictGroups.map((g) => {
    const provenance = {};
    for (const rel of g.raws) {
      const fields = raws.get(rel);
      let page = null;
      if (fields && fields.source && fields.source_id) {
        try { page = sourcePageRelPath(fields).replace(/\\/g, '/'); } catch { /* report-only */ }
      }
      provenance[rel] = { page, topics: pagesBySource.get(rel) ?? [] };
    }
    return { ...g, dismissed: dismissedKeys.has([...g.raws].sort().join('\x00')), provenance };
  });

  writeConflicts(kbRoot, {
    generated_at: new Date().toISOString(),
    fingerprint: fingerprintOf(rawHashes),
    raw_hashes: rawHashes,
    groups: conflicts,
  });

  reviewQueue.sort((a, b) => a.page.localeCompare(b.page));
  return {
    pending, anomalies, orphaned_pages: orphanedPages, errors, review_queue: reviewQueue,
    dangling_links: dangling, conflicts, suppressed,
    conflicts_warnings: conflictWarnings, tombstones_cleaned: tombstonesCleaned,
  };
}

function findApprovedDuplicateRaw(kbRoot, rawRel, hash) {
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    if (rel === rawRel) continue;
    const f = readFields(abs);
    if (!f.content_hash || f.content_hash !== hash) continue;
    let pageRel;
    try { pageRel = sourcePageRelPath(f).replace(/\\/g, '/'); } catch { continue; }
    const pageAbs = path.join(kbRoot, pageRel);
    if (fs.existsSync(pageAbs) && readStatus(pageAbs) === 'approved') {
      return { raw: rel, page: pageRel };
    }
  }
  return null;
}

/**
 * Write one source summary page.
 */
export function applySourcePage(kbRoot, rawRelInput, summaryBody, {
  tags, force = false, actor = 'govern', reason, model_version, precedent_ids,
} = {}) {
  const rawRel = normalizeRawRel(rawRelInput);
  const rawAbs = path.join(kbRoot, rawRel);
  if (!fs.existsSync(rawAbs)) throw new Error(`raw doc does not exist: ${rawRel}`);
  const body = (summaryBody || '').trim();
  if (!body) throw new Error('empty summary body, refusing to write');

  const fields = readFields(rawAbs);
  const missing = missingRawFields(fields);
  if (missing.length) throw new Error(`raw doc missing contract fields ${missing.join(', ')}: ${rawRel}`);

  const tombstones = readTombstones(kbRoot);
  if (tombstones[rawRel] && !force) {
    throw new Error(`raw is tombstoned (${tombstones[rawRel].reason}); use --force to revive: ${rawRel}`);
  }

  if (!force && fields.content_hash) {
    const dup = findApprovedDuplicateRaw(kbRoot, rawRel, fields.content_hash);
    if (dup) {
      addTombstone(kbRoot, rawRel, { reason: 'auto-dedup', page: dup.page });
      appendLog(kbRoot, 'govern', 'auto:dedup-source', dup.page,
        `redundant ${rawRel} (identical content_hash to ${dup.raw})`);
      writeDecision(kbRoot, { actor, action: 'auto:dedup-source', page: dup.page, reason: `duplicate of ${dup.raw}`, meta: { raw: rawRel } });
      return { action: 'auto:dedup-source', page: dup.page, raw: rawRel, note: `duplicate of ${dup.raw}` };
    }
  }

  const pageRel = sourcePageRelPath(fields);
  const pageAbs = path.join(kbRoot, pageRel);
  const existed = fs.existsSync(pageAbs);
  const now = new Date().toISOString();
  const old = existed ? readFields(pageAbs) : {};

  const fm = buildFrontmatter({
    type: 'source',
    status: 'approved',
    title: fields.title,
    source_ref: rawRel,
    source_url: fields.source_url,
    source_version: fields.source_version,
    content_hash: fields.content_hash,
    tags: tags === undefined ? (Array.isArray(old.tags) ? old.tags : []) : tags,
    created_at: old.created_at || now,
    updated_at: now,
  });
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, fm + '\n' + body + '\n', 'utf8');
  if (tombstones[rawRel]) removeTombstone(kbRoot, rawRel);
  const action = existed ? 'auto:update-source' : 'auto:create-source';
  appendLog(kbRoot, 'govern', action, pageRel.replace(/\\/g, '/'), `from ${rawRel}`);
  writeDecision(kbRoot, { actor, action, page: pageRel.replace(/\\/g, '/'), reason, model_version, precedent_ids });
  return { action, page: pageRel.replace(/\\/g, '/') };
}

function stripCode(body) {
  const out = [];
  let fence = null;
  for (const line of body.split('\n')) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) {
        const rest = line.slice(fm[0].length);
        if (!rest.includes(fm[1][0])) { fence = { char: fm[1][0], len: fm[1].length }; continue; }
      } else if (fm[1][0] === fence.char && fm[1].length >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence) continue;
    out.push(line);
  }
  return out.join('\n').replace(/`[^`\n]*`/g, '');
}

function lastLogAction(kbRoot, pageRel) {
  const logPath = path.join(kbRoot, 'log.md');
  if (!fs.existsSync(logPath)) return null;
  let last = null;
  for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
    const m = line.match(/^## \[[^\]]*\] (\S+ \| \S+) \| (\S+)/);
    if (m && m[2] === pageRel) last = m[1];
  }
  return last;
}

function assertNoUnloggedFlip(kbRoot, pageRel, currentStatus) {
  if (currentStatus && currentStatus !== 'candidate') {
    const last = lastLogAction(kbRoot, pageRel);
    if (last && isPendingCandidateAction(last)) {
      throw new Error(`unlogged review flip pending on this page; run sweep first: ${pageRel}`);
    }
  }
}

function readContentHash(kbRoot, rawRel) {
  const abs = path.join(kbRoot, rawRel);
  if (!fs.existsSync(abs)) return null;
  return readFields(abs).content_hash || null;
}

function sourcePageApproved(kbRoot, rawRel) {
  try {
    const pageRel = sourcePageRelPath(readFields(path.join(kbRoot, rawRel))).replace(/\\/g, '/');
    const abs = path.join(kbRoot, pageRel);
    return fs.existsSync(abs) && readStatus(abs) === 'approved';
  } catch { return false; }
}

function validateNonSourceType(type) {
  if (!VALID_NON_SOURCE_TYPES.has(type)) {
    throw new Error(`type must be entity|concept|synthesis: ${JSON.stringify(type)}`);
  }
}

/**
 * Write one non-source page (entity / concept / synthesis). The body is supplied
 * by the caller; frontmatter is mechanically generated/merged.
 */
export function applyNonSourcePage(kbRoot, type, {
  slug, title, sources, aliases, tags, candidate, note,
  actor = 'govern', reason, model_version, precedent_ids,
} = {}, body) {
  validateNonSourceType(type);
  const text = (body || '').trim();
  if (!text) throw new Error(`empty ${type} body, refusing to write`);
  if (!SAFE_SLUG.test(String(slug || ''))) {
    throw new Error(`slug must be lowercase kebab-case [a-z0-9-]: ${JSON.stringify(slug)}`);
  }
  if (!title || !String(title).trim()) throw new Error(`apply-${type} requires --title`);

  const dir = typeDir(type);
  const pageRel = path.join('wiki', dir, `${slug}.md`);
  const pageAbs = path.join(kbRoot, pageRel);
  const existed = fs.existsSync(pageAbs);
  const old = existed ? readFields(pageAbs) : {};
  const pageRelPosix = pageRel.replace(/\\/g, '/');

  const currentStatus = existed ? readStatus(pageAbs) : null;
  if (existed) assertNoUnloggedFlip(kbRoot, pageRelPosix, currentStatus);
  const keepCandidate = existed && currentStatus === 'candidate';

  const newSources = sources === undefined ? [] : sources;
  for (const ref of newSources) {
    const rel = normalizeRawRel(ref);
    if (!fs.existsSync(path.join(kbRoot, rel))) throw new Error(`${type} source does not exist: ${rel}`);
  }
  const oldSources = Array.isArray(old.sources) ? old.sources : [];
  let mergedSources = [...new Set([...oldSources, ...newSources.map((s) => normalizeRawRel(s))])].sort();
  if (!mergedSources.length) throw new Error(`apply-${type} requires --sources (no existing sources to keep)`);

  const collapseLog = [];
  {
    const byHash = new Map();
    for (const rel of mergedSources) {
      const h = readContentHash(kbRoot, rel);
      if (!h) continue;
      const list = byHash.get(h) ?? [];
      list.push(rel);
      byHash.set(h, list);
    }
    for (const raws of byHash.values()) {
      if (raws.length < 2) continue;
      const preferred = raws.filter((r) => oldSources.includes(r) && sourcePageApproved(kbRoot, r)).sort()[0]
        ?? [...raws].sort()[0];
      for (const r of raws) {
        if (r !== preferred) {
          collapseLog.push(`${r} into ${preferred}`);
          mergedSources = mergedSources.filter((x) => x !== r);
        }
      }
    }
    if (collapseLog.length) {
      appendLog(kbRoot, 'govern', 'auto:dedup-topic', pageRelPosix, `collapsed ${collapseLog.join('; ')}`);
    }
  }

  const conflictsState = readConflicts(kbRoot);
  let warning = null;
  const flaggedRaws = new Set();
  if (!conflictsState || !Array.isArray(conflictsState.groups)) {
    warning = 'conflicts side-channel missing, degraded to in-topic check';
  } else if (fingerprintOf(currentRawHashes(kbRoot)) !== conflictsState.fingerprint) {
    warning = 'conflicts side-channel stale, degraded to in-topic check';
  } else {
    const tombstones = readTombstones(kbRoot);
    for (const g of conflictsState.groups) {
      if (g.dismissed || isDismissedGroup(kbRoot, g.raws)) continue;
      if (g.raws.filter((r) => !tombstones[r]).length < 2) continue;
      for (const r of g.raws) flaggedRaws.add(r);
    }
  }
  if (warning) {
    const srcDocs = mergedSources.map((rel) => {
      const { fields, body } = readDoc(path.join(kbRoot, rel));
      return { rel, title: fields.title, filename: path.basename(rel), body, content_hash: fields.content_hash || undefined };
    });
    const tombstones = readTombstones(kbRoot);
    // compare against NORMALIZED new sources — raw CLI input may carry Windows
    // backslashes, which would silently miss the forced-candidate flag
    const newSourcesNorm = new Set(newSources.map((s) => normalizeRawRel(s)));
    for (const g of findGroups(srcDocs).groups) {
      if (g.category !== 'similar') continue;
      if (isDismissedGroup(kbRoot, g.raws)) continue;
      if (g.raws.filter((r) => !tombstones[r]).length < 2) continue;
      if (g.raws.some((r) => newSourcesNorm.has(r))) {
        for (const r of g.raws) flaggedRaws.add(r);
      }
    }
  }

  const forcedConflict = [...flaggedRaws].some((r) => mergedSources.includes(r));
  let groupDesc = '';
  if (forcedConflict && conflictsState && Array.isArray(conflictsState.groups)) {
    groupDesc = conflictsState.groups
      .filter((g) => (g.dismissed || isDismissedGroup(kbRoot, g.raws)) === false && g.raws.some((r) => mergedSources.includes(r)))
      .map((g) => `${g.category}[${g.raws.join('|')}${g.score !== undefined ? ` score:${g.score}` : ''}]`)
      .join('; ');
  }
  const conflictNote = forcedConflict ? `forced candidate: ${groupDesc || 'in-topic similarity'}` : undefined;

  const semantic = [];
  if (newSources.length) {
    const newTitleTokens = newSources.map((rel) => {
      try { return tokenize(readFields(path.join(kbRoot, rel)).title ?? ''); } catch { return new Set(); }
    });
    const seen = new Set();
    for (const sub of ['entities', 'concepts', 'syntheses']) {
      for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
        const fields = readFields(abs);
        if (fields.status === 'archived' || fields.status === 'rejected') continue;
        const against = new Set();
        for (const t of [fields.title, ...(Array.isArray(fields.aliases) ? fields.aliases : [])]) {
          for (const x of tokenize(t ?? '')) against.add(x);
        }
        if (against.size && newTitleTokens.some((nt) => titleTokensOverlap(nt, against))) {
          const hitSlug = path.basename(abs).replace(/\.md$/, '');
          if (!seen.has(hitSlug)) { seen.add(hitSlug); semantic.push(`${sub}/${hitSlug}`); }
        }
      }
    }
  }

  const now = new Date().toISOString();
  const status = (candidate || keepCandidate || forcedConflict) ? 'candidate' : 'approved';
  const effectiveNote = [note, conflictNote,
    keepCandidate && !candidate && !note && !conflictNote ? 'kept candidate (pending review)' : undefined,
  ].filter(Boolean).join(' | ') || undefined;
  const fm = buildFrontmatter({
    type,
    status,
    title: String(title).trim(),
    sources: mergedSources,
    aliases: aliases === undefined ? old.aliases : aliases,
    tags: tags === undefined ? old.tags : tags,
    review_note: status === 'candidate' ? (note ?? conflictNote ?? old.review_note) : undefined,
    created_at: old.created_at || now,
    updated_at: now,
  });
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, fm + '\n' + text + '\n', 'utf8');
  const action = status === 'candidate' ? `candidate:${type}` : (existed ? `auto:update-${type}` : `auto:create-${type}`);
  appendLog(kbRoot, 'govern', action, pageRelPosix,
    `sources:${mergedSources.length}${effectiveNote ? ` ${flatten(effectiveNote)}` : ''}`);
  writeDecision(kbRoot, { actor, action, page: pageRelPosix, reason: reason ?? effectiveNote, model_version, precedent_ids });
  const result = { action, page: pageRelPosix, status, semantic_check_required: semantic };
  if (warning) result.warning = warning;
  return result;
}

export { readDecisions };

/** Legacy alias: topic → synthesis (contract v2). */
export function applyTopicPage(kbRoot, opts, body) {
  return applyNonSourcePage(kbRoot, 'synthesis', opts, body);
}

export function applyEntityPage(kbRoot, opts, body) {
  return applyNonSourcePage(kbRoot, 'entity', opts, body);
}

export function applyConceptPage(kbRoot, opts, body) {
  return applyNonSourcePage(kbRoot, 'concept', opts, body);
}

export function applySynthesisPage(kbRoot, opts, body) {
  return applyNonSourcePage(kbRoot, 'synthesis', opts, body);
}

/** Mechanically rebuild index.md from the frontmatter of each wiki/ page. */
export function rebuildIndex(kbRoot) {
  const groups = { entities: [], concepts: [], syntheses: [], sources: [] };
  for (const type of ['entity', 'concept', 'synthesis']) {
    const dir = typeDir(type);
    for (const abs of walk(path.join(kbRoot, 'wiki', dir))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/').replace(/^wiki\//, '').replace(/\.md$/, '');
      const fields = readFields(abs);
      const n = Array.isArray(fields.sources) ? fields.sources.length : 0;
      groups[dir].push(`- [[${rel}]] — ${flatten(fields.title) || rel}(status:${fields.status}, sources:${n})`);
    }
  }
  for (const abs of walk(path.join(kbRoot, 'wiki', 'sources'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/').replace(/^wiki\//, '').replace(/\.md$/, '');
    const fields = readFields(abs);
    const src = (fields.source_ref || '').split('/')[1] || '?';
    const date = (fields.source_version || '').slice(0, 10);
    groups.sources.push(`- [[${rel}]] — ${flatten(fields.title) || rel}(${src}, ${date})`);
  }

  const parts = ['# Wiki Index', ''];
  for (const label of ['Entities', 'Concepts', 'Syntheses', 'Sources']) {
    const key = label.toLowerCase();
    if (groups[key].length) parts.push(`## ${label}`, ...groups[key].sort(), '');
  }
  const out = parts.join('\n');
  const indexAbs = path.join(kbRoot, 'wiki', 'index.md');
  if (fs.existsSync(indexAbs) && fs.readFileSync(indexAbs, 'utf8') === out) {
    return { entities: groups.entities.length, concepts: groups.concepts.length, syntheses: groups.syntheses.length, sources: groups.sources.length, skipped: true };
  }
  fs.writeFileSync(indexAbs, out, 'utf8');
  appendLog(kbRoot, 'govern', 'auto:rebuild-index', 'wiki/index.md',
    `entities:${groups.entities.length} concepts:${groups.concepts.length} syntheses:${groups.syntheses.length} sources:${groups.sources.length}`);
  return { entities: groups.entities.length, concepts: groups.concepts.length, syntheses: groups.syntheses.length, sources: groups.sources.length, skipped: false };
}

/* ---------------- candidate state machine (contract §4) ---------------- */

function resolvePage(kbRoot, pageRelInput) {
  const rel = normalizeWikiRel(pageRelInput);
  const abs = path.join(kbRoot, rel);
  if (!fs.existsSync(abs)) throw new Error(`page does not exist: ${rel}`);
  return { rel, abs };
}

export function approvePage(kbRoot, pageRelInput, { via = 'session', actor = 'review', reason, model_version, precedent_ids } = {}) {
  requireReason(actor, reason, 'approval');
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  flipStatus(abs, 'candidate', 'approved');
  appendLog(kbRoot, 'review', 'approve', rel, `via ${via}${reason ? ` | ${flatten(reason)}` : ''}`);
  writeDecision(kbRoot, { actor, action: 'approve', page: rel, reason, model_version, precedent_ids });
  return { action: 'approve', page: rel, status: 'approved' };
}

function gitIsInsideWorkTree(kbRoot) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: kbRoot, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function findPreviousApproved(kbRoot, rel) {
  const relPosix = rel.replace(/\\/g, '/');
  let commits;
  try {
    commits = execFileSync('git', ['log', '--format=%H', '--', relPosix],
      { cwd: kbRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
  for (const commit of commits) {
    let text;
    try {
      text = execFileSync('git', ['show', `${commit}:${relPosix}`],
        { cwd: kbRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    if (parseFrontmatter(text).fields.status === 'approved') {
      return { commit, text: text.replace(/\n+$/, '') };
    }
  }
  return null;
}

export function rejectPage(kbRoot, pageRelInput, { via = 'session', actor = 'review', reason, model_version, precedent_ids } = {}) {
  requireReason(actor, reason, 'rejection');
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  if (gitIsInsideWorkTree(kbRoot)) {
    const prev = findPreviousApproved(kbRoot, rel);
    if (prev) {
      fs.writeFileSync(abs, prev.text + '\n', 'utf8');
      const st = readStatus(abs);
      if (st !== 'approved') flipStatus(abs, st, 'approved');
      appendLog(kbRoot, 'review', 'reject', rel,
        `via ${via}${reason ? ` | ${flatten(reason)}` : ''} | restored previous approved version (${prev.commit.slice(0, 8)})`);
      writeDecision(kbRoot, { actor, action: 'reject', page: rel, reason, model_version, precedent_ids, meta: { restored: true, from_commit: prev.commit } });
      return { action: 'reject', page: rel, status: 'approved', restored: true, from_commit: prev.commit };
    }
    flipStatus(abs, 'candidate', 'rejected');
    appendLog(kbRoot, 'review', 'reject', rel, `via ${via}${reason ? ` | ${flatten(reason)}` : ''}`);
    writeDecision(kbRoot, { actor, action: 'reject', page: rel, reason, model_version, precedent_ids, meta: { restored: false, restore_reason: 'no-approved-version-in-git-history' } });
    return { action: 'reject', page: rel, status: 'rejected', restored: false, restore_reason: 'no-approved-version-in-git-history' };
  }
  flipStatus(abs, 'candidate', 'rejected');
  appendLog(kbRoot, 'review', 'reject', rel, `via ${via}${reason ? ` | ${flatten(reason)}` : ''}`);
  writeDecision(kbRoot, { actor, action: 'reject', page: rel, reason, model_version, precedent_ids, meta: { restored: false, restore_reason: 'not-a-git-repo' } });
  return { action: 'reject', page: rel, status: 'rejected', restored: false, restore_reason: 'not-a-git-repo' };
}

function archiveTarget(kbRoot, basename) {
  const dir = path.join(kbRoot, 'wiki', 'archive');
  const stem = basename.replace(/\.md$/, '');
  for (let n = 1; ; n++) {
    const name = n === 1 ? basename : `${stem}-${n}.md`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

function moveToArchive(kbRoot, rel, abs) {
  const archiveDir = path.join(kbRoot, 'wiki', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const name = archiveTarget(kbRoot, path.basename(abs));
  const targetAbs = path.join(archiveDir, name);
  fs.copyFileSync(abs, targetAbs);
  flipStatus(targetAbs, readStatus(abs), 'archived');
  fs.unlinkSync(abs);
  return `wiki/archive/${name}`;
}

export function archivePage(kbRoot, pageRelInput, { note = '', actor = 'govern', reason, model_version, precedent_ids } = {}) {
  requireReason(actor, reason || note, 'archive');
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  const status = readStatus(abs);
  assertNoUnloggedFlip(kbRoot, rel, status);
  if (status !== 'approved') {
    throw new Error(`only approved pages can be archived (candidates should be rejected): ${rel}`);
  }
  const fields = readFields(abs);
  const target = moveToArchive(kbRoot, rel, abs);
  if (fields.source_ref && fs.existsSync(path.join(kbRoot, fields.source_ref))) {
    addTombstone(kbRoot, fields.source_ref, { reason: 'loser-archive', page: target });
  }
  appendLog(kbRoot, 'govern', 'archive', target, `from ${rel}${note ? ` | ${flatten(note)}` : ''}`);
  writeDecision(kbRoot, { actor, action: 'archive', page: target, reason: reason || note, model_version, precedent_ids, meta: { from: rel } });
  return { action: 'archive', page: target, from: rel };
}

export function sweep(kbRoot) {
  const logPath = path.join(kbRoot, 'log.md');
  const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n') : [];
  const lastAction = new Map();
  for (const line of lines) {
    const m = line.match(/^## \[[^\]]*\] (\S+) \| (\S+) \| (\S+)/);
    if (m) lastAction.set(m[3], `${m[1]} | ${m[2]}`);
  }
  const backfilled = [];
  for (const [page, action] of lastAction) {
    if (!isPendingCandidateAction(action)) continue;
    const abs = path.join(kbRoot, page);
    if (!fs.existsSync(abs) || !/^wiki\/(sources|entities|concepts|syntheses)\//.test(page)) continue;
    const status = readStatus(abs);
    if (status === 'approved' || status === 'rejected') {
      const reviewAction = status === 'approved' ? 'approve' : 'reject';
      appendLog(kbRoot, 'review', reviewAction, page, 'via viewer (backfilled)');
      writeDecision(kbRoot, { actor: 'review', action: reviewAction, page, reason: 'via viewer (backfilled)' });
      backfilled.push({ page, status });
    }
  }
  const archived = [];
  for (const sub of WIKI_REVIEW_DIRS) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      if (readStatus(abs) !== 'rejected') continue;
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const target = moveToArchive(kbRoot, rel, abs);
      appendLog(kbRoot, 'govern', 'auto:archive-rejected', target, `from ${rel}`);
      writeDecision(kbRoot, { actor: 'govern', action: 'auto:archive-rejected', page: target, reason: 'sweep rejected page', meta: { from: rel } });
      archived.push({ from: rel, page: target });
    }
  }
  return { backfilled, archived };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge one non-source page into another (same type). Both must be approved.
 * The caller must supply the merged body afterwards via apply-* if needed.
 */
export function mergePages(kbRoot, type, fromSlug, toSlug, { note = '', actor = 'govern', reason, model_version, precedent_ids } = {}) {
  validateNonSourceType(type);
  requireReason(actor, reason || note, 'merge');
  for (const s of [fromSlug, toSlug]) {
    if (!SAFE_SLUG.test(String(s || ''))) {
      throw new Error(`slug must be lowercase kebab-case [a-z0-9-]: ${JSON.stringify(s)}`);
    }
  }
  if (fromSlug === toSlug) throw new Error('merge requires two distinct slugs');
  const dir = typeDir(type);
  const fromRel = `wiki/${dir}/${fromSlug}.md`;
  const toRel = `wiki/${dir}/${toSlug}.md`;
  const fromAbs = path.join(kbRoot, fromRel);
  const toAbs = path.join(kbRoot, toRel);
  for (const [rel, abs] of [[fromRel, fromAbs], [toRel, toAbs]]) {
    if (!fs.existsSync(abs)) throw new Error(`page does not exist: ${rel}`);
    const st = readStatus(abs);
    assertNoUnloggedFlip(kbRoot, rel, st);
    if (st !== 'approved') {
      throw new Error(`merge involves a non-approved page (status: ${st ?? 'missing'}); review candidates first (approve or reject): ${rel}`);
    }
  }

  const linkRe = new RegExp(`\\[\\[(${dir}\\/)?${escapeRe(fromSlug)}(\\.md)?(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g');
  const rewritten = [];
  for (const sub of WIKI_REVIEW_DIRS) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      if (path.resolve(abs) === path.resolve(fromAbs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const out = text.replace(linkRe,
        (m, prefix = '', ext = '', anchor = '', display = '') => `[[${prefix}${toSlug}${ext}${anchor}${display}]]`);
      if (out !== text) {
        fs.writeFileSync(abs, out, 'utf8');
        rewritten.push(path.relative(kbRoot, abs).replace(/\\/g, '/'));
      }
    }
  }

  const toDoc = readDoc(toAbs);
  const fromDoc = readDoc(fromAbs);
  const mergedSources = [...new Set([
    ...(Array.isArray(toDoc.fields.sources) ? toDoc.fields.sources : []),
    ...(Array.isArray(fromDoc.fields.sources) ? fromDoc.fields.sources : []),
  ])].sort();
  const fm = buildFrontmatter({ ...toDoc.fields, sources: mergedSources, updated_at: new Date().toISOString() });
  fs.writeFileSync(toAbs, fm + '\n' + toDoc.body.replace(/\n$/, '') + '\n', 'utf8');

  const archivedRel = moveToArchive(kbRoot, fromRel, fromAbs);
  appendLog(kbRoot, 'govern', 'merge', toRel,
    `from ${fromRel} (archived, ${rewritten.length} backlink files)${note ? ` | ${flatten(note)}` : ''}`);
  writeDecision(kbRoot, { actor, action: 'merge', page: toRel, reason: reason || note, model_version, precedent_ids, meta: { from: fromRel, archived: archivedRel, rewritten: rewritten.length } });
  return { action: 'merge', page: toRel, archived: archivedRel, rewritten, sources: mergedSources.length };
}

/** Legacy alias: merge-topic → synthesis merge. */
export function mergeTopics(kbRoot, fromSlug, toSlug, opts = {}) {
  return mergePages(kbRoot, 'synthesis', fromSlug, toSlug, opts);
}
