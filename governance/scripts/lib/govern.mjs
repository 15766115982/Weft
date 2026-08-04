// Governance v1 core: plan (diff scan + conflict detection), applySourcePage,
// applyTopicPage, review (approve / reject-with-restore / archive), sweep, merge,
// rebuild-index. Log actor=govern.
// Contract: wiki/sources/ maps 1:1 to raw/ BY DEFAULT — adjudicated loser-archive
// and exact-dedup are the documented exceptions (ADR-0008 / plan 0001); source pages
// are normally approved but may be archived (with the raw tombstoned). `.kb/govern/`
// holds the governance service's adjudication memory: source-tombstones.json,
// conflict-dismissals.json, conflicts.json (plan 0001 §1).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildFrontmatter, parseFrontmatter } from './frontmatter.mjs';
import { flipStatus, readStatus, normalizeWikiRel } from './statusflip.mjs';
import { findGroups, tokenize, titleTokensOverlap } from './similarity.mjs';

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

/* ---------------- adjudication-memory state files (.kb/govern/, plan 0001 §1) ----------------
 * Three side-channel files turn "adjudicated" into system memory:
 *   source-tombstones.json     archived/auto-deduped loser raws → not re-pended, not revived
 *                               without --force (P0-1);
 *   conflict-dismissals.json   "parallel documents" pairs → not re-flagged every run (P1-3);
 *   conflicts.json             plan's per-run detection output + raw-set freshness fingerprint
 *                               (P1-4), consumed by apply-topic.
 * The directory is governance-owned; portal owns .kb/ui/, retrieval owns .kb/index.sqlite
 * (contract §1 / plan 0001 §3.3). */

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

/** Is this group's raw set already adjudicated as parallel (dismissed)? */
export function isDismissedGroup(kbRoot, groupRaws) {
  const key = [...groupRaws].sort().join('\x00');
  return readDismissals(kbRoot).some((d) => [...d.raws].sort().join('\x00') === key);
}

/* ---------- raw-set freshness fingerprint (P1-4) ---------- */

function hashText(text) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Walk raw/ and map rel -> content_hash, falling back to a hash of the raw file
 *  text for raws whose frontmatter omits content_hash (not a required field, §2.2).
 *  The fallback keeps a changed raw detectable even without a stored hash. */
function currentRawHashes(kbRoot) {
  const map = {};
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const text = fs.readFileSync(abs, 'utf8');
    const { fields } = parseFrontmatter(text);
    map[rel] = fields.content_hash || hashText(text);
  }
  return map;
}

/** Fingerprint = sha256 over the sorted (rel, hash) pairs. Any new/removed/changed
 *  raw flips it, so apply-topic can detect a stale side-channel. */
function fingerprintOf(rawHashes) {
  const entries = Object.entries(rawHashes).map(([rel, h]) => `${rel}\t${h}`).sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

/** { generated_at, fingerprint, raw_hashes, groups } or null when absent/unparseable. */
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

// source/source_id whitelist: used as path components; reject path separators and traversal (#4a)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Topic slug whitelist (contract §3.3): the slug is a path component and the topic's identity
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

// Contract §2: required fields for raw docs
const RAW_REQUIRED = ['source', 'source_id', 'source_url', 'source_version', 'title'];

function missingRawFields(fields) {
  return RAW_REQUIRED.filter(k => !fields[k]);
}

export function sourcePageRelPath(rawFields) {
  for (const k of ['source', 'source_id']) {
    if (!SAFE_ID.test(String(rawFields[k] || ''))) {
      throw new Error(`${k} contains illegal characters (path injection rejected): ${JSON.stringify(rawFields[k])}`);
    }
  }
  return path.join('wiki', 'sources', `${rawFields.source}-${rawFields.source_id}.md`);
}

/** Flatten title: prevents index.md injection (#4b); the one-line-per-page contract must not be broken */
function flatten(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Normalize raw relative path: forward slashes, must stay under raw/ (#2); `..` is checked per path segment so v1..2.md is not falsely rejected */
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
 * pending:   new (raw has no corresponding source page) or stale (raw updated, source_version behind)
 * anomalies: hash changed + version unchanged (high-risk signal of an out-of-band source modification; feeds the M4 review flow)
 * orphaned_pages: source pages whose source_ref points to a vanished raw (report only;
 *                 archival is a human-adjudicated action via archivePage)
 * errors:    raw docs missing contract fields or with illegal IDs (no phantom paths generated)
 * review_queue: wiki pages with status candidate awaiting human review (contract §4)
 */
export function plan(kbRoot) {
  const pending = [], anomalies = [], errors = [], reviewQueue = [], suppressed = [];
  const raws = new Map();
  const rawBodies = new Map();      // rel -> { body, filename } (for similarity)
  const rawHashes = {};             // rel -> content_hash || text-hash fallback (fingerprint)
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
    // Tombstone suppression (P0-1): an archived/auto-deduped loser raw is not
    // re-pended by the next plan() — visible in `suppressed`, never silent.
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
      const page = readDoc(pageAbs).fields;
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
    const { fields } = readDoc(abs);
    if (fields.source_ref && !raws.has(fields.source_ref)) {
      orphanedPages.push({ page: rel, missing_raw: fields.source_ref, title: fields.title });
    }
  }
  // Topic pages: every provenance entry is re-checked, not only newly added ones —
  // a raw deleted later (e.g. acquire --prune) leaves dangling provenance otherwise.
  // topicsBySource (raw rel -> topic page rels) feeds conflict-group provenance.
  const topicsBySource = new Map();
  for (const abs of walk(path.join(kbRoot, 'wiki', 'topics'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const { fields } = readDoc(abs);
    for (const ref of Array.isArray(fields.sources) ? fields.sources : []) {
      if (!raws.has(ref)) orphanedPages.push({ page: rel, missing_raw: ref, title: fields.title });
      const list = topicsBySource.get(ref) ?? [];
      list.push(rel);
      topicsBySource.set(ref, list);
    }
  }
  const known = new Set();   // wikilink targets: 'topics/x', 'sources/x', and bare slugs
  const VALID_STATUS = new Set(['candidate', 'approved', 'rejected', 'archived']);
  for (const sub of ['sources', 'topics']) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const noExt = rel.replace(/^wiki\//, '').replace(/\.md$/, '');
      known.add(noExt);
      known.add(noExt.replace(/^(sources|topics)\//, ''));
      const { fields } = readDoc(abs);
      if (fields.status === 'candidate') {
        reviewQueue.push({ page: rel, type: fields.type, title: fields.title, updated_at: fields.updated_at });
      } else if (!fields.status) {
        // fail-closed visibility: a page whose status the parser cannot read must
        // surface as an error, not silently vanish from every queue
        errors.push({ page: rel, error: 'page missing status field (malformed frontmatter?)' });
      } else if (!VALID_STATUS.has(fields.status)) {
        // a typo'd status (e.g. "apprved") is fail-closed everywhere — and must be SEEN
        errors.push({ page: rel, error: `page has illegal status "${flatten(fields.status)}" (expected candidate|approved|rejected|archived)` });
      }
    }
  }
  // Dangling wikilinks: nobody else reports them (retrieval silently skips). Fenced
  // code blocks and inline code are stripped first — retrieval's chunker excludes
  // them too, so both sides agree on what counts as a link.
  const dangling = [];
  for (const sub of ['sources', 'topics']) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const { body } = readDoc(abs);
      for (const m of stripCode(body).matchAll(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        const target = m[1].trim().replace(/\.md$/, '');
        if (!known.has(target)) dangling.push({ page: rel, link: target });
      }
    }
  }
  // Dangling tombstones: a raw pruned out of raw/ (e.g. acquire --prune) leaves its
  // tombstone as a dangling record — clean it up, but keep it visible (plan 0001 §5).
  let tombstonesCleaned = 0;
  for (const rel of Object.keys(tombstones)) {
    if (!raws.has(rel)) {
      delete tombstones[rel];
      suppressed.push({ raw: rel, reason: 'dangling-tombstone (cleaned; raw no longer present)' });
      tombstonesCleaned++;
    }
  }
  if (tombstonesCleaned) writeTombstones(kbRoot, tombstones);

  // Conflict detection over the whole KB (plan 0001 §2): every raw in raw/ is in the
  // comparison space (pending + imported-but-ungoverned + governed). Orphan pages
  // (raw vanished) are not — their raw is outside the space; source-page summaries
  // are not — they are LLM distillations that would score near-zero anyway (§2.1).
  // Tombstoned raws are also excluded: they are adjudicated away (auto-dedup /
  // loser-archive), so a group that has converged to the surviving copy must not
  // keep flagging it every plan (the survivor is visible via `suppressed` instead).
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

  // Dismissed pairs are still reported (audit-visible) but marked so apply-topic
  // skips them — "parallel documents" is a persisted adjudication (P1-3).
  const dismissedKeys = new Set(readDismissals(kbRoot).map((d) => [...d.raws].sort().join('\x00')));
  const conflicts = conflictGroups.map((g) => {
    const provenance = {};
    for (const rel of g.raws) {
      const fields = raws.get(rel);
      let page = null;
      if (fields && fields.source && fields.source_id) {
        try { page = sourcePageRelPath(fields).replace(/\\/g, '/'); } catch { /* report-only */ }
      }
      provenance[rel] = { page, topics: topicsBySource.get(rel) ?? [] };
    }
    return { ...g, dismissed: dismissedKeys.has([...g.raws].sort().join('\x00')), provenance };
  });

  // Idempotent side-channel: recomputed from scratch every run, so a re-run never
  // duplicates groups. apply-topic reads it and verifies the fingerprint (P1-4).
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

/** Another raw with the same content_hash that already has an approved source page
 *  (the surviving copy of an exact duplicate). Raw-layer comparison — the source
 *  page's stored content_hash could have been hand-edited (P3-3). Returns
 *  { raw, page } or null. Null when both sides lack content_hash (§2.2: only
 *  present-hash pairs are ever compared; null == null is never a duplicate). */
function findApprovedDuplicateRaw(kbRoot, rawRel, hash) {
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    if (rel === rawRel) continue;
    const { fields: f } = readDoc(abs);
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
 * Write one source summary page. The summary body is supplied by the caller (Claude);
 * the script mechanically generates the frontmatter and validates it. Source pages are
 * normally approved (contract §4: 1:1 mechanical mapping is a low-risk automatic
 * operation), with two exceptions (ADR-0008 / plan 0001 §3.1.3):
 *  - an exact duplicate of a raw that already has an approved source page is NOT
 *    written — the redundant raw is tombstoned and logged `auto:dedup-source`
 *    (target = the surviving page, so every log line still names a page path);
 *  - a tombstoned raw is refused outright — only `--force` revives it, and a
 *    successful revive clears the tombstone (page + tombstone coexistence is an
 *    inconsistent state).
 * When tags is omitted the existing value is kept (same treatment as created_at); an
 * explicit empty array clears it.
 */
export function applySourcePage(kbRoot, rawRelInput, summaryBody, { tags, force = false } = {}) {
  const rawRel = normalizeRawRel(rawRelInput);
  const rawAbs = path.join(kbRoot, rawRel);
  if (!fs.existsSync(rawAbs)) throw new Error(`raw doc does not exist: ${rawRel}`);
  const body = (summaryBody || '').trim();
  if (!body) throw new Error('empty summary body, refusing to write');

  const { fields } = readDoc(rawAbs);
  const missing = missingRawFields(fields);
  if (missing.length) throw new Error(`raw doc missing contract fields ${missing.join(', ')}: ${rawRel}`);

  // Tombstone gate: an archived/auto-deduped loser raw is not revived silently.
  const tombstones = readTombstones(kbRoot);
  if (tombstones[rawRel] && !force) {
    throw new Error(`raw is tombstoned (${tombstones[rawRel].reason}); use --force to revive: ${rawRel}`);
  }

  // Exact-duplicate auto-dedup: write NO page; tombstone this raw and log against
  // the surviving page (P3-1/P3-3). Both-new same-batch duplicates (neither side
  // approved yet) fall through — the first apply-source writes, the second dedups.
  if (!force && fields.content_hash) {
    const dup = findApprovedDuplicateRaw(kbRoot, rawRel, fields.content_hash);
    if (dup) {
      addTombstone(kbRoot, rawRel, { reason: 'auto-dedup', page: dup.page });
      appendLog(kbRoot, 'govern', 'auto:dedup-source', dup.page,
        `redundant ${rawRel} (identical content_hash to ${dup.raw})`);
      return { action: 'auto:dedup-source', page: dup.page, raw: rawRel, note: `duplicate of ${dup.raw}` };
    }
  }

  const pageRel = sourcePageRelPath(fields);
  const pageAbs = path.join(kbRoot, pageRel);
  const existed = fs.existsSync(pageAbs);
  const now = new Date().toISOString();
  const old = existed ? readDoc(pageAbs).fields : {};

  const fm = buildFrontmatter({
    type: 'source',
    status: 'approved',
    title: fields.title,
    source_ref: rawRel,
    source_url: fields.source_url,
    source_version: fields.source_version,
    content_hash: fields.content_hash,   // contract §3.2: stale double-check (see §2)
    tags: tags === undefined ? (Array.isArray(old.tags) ? old.tags : []) : tags,
    created_at: old.created_at || now,
    updated_at: now,
  });
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, fm + '\n' + body + '\n', 'utf8');
  // --force revive: a successful write clears the tombstone (avoid the
  // "page exists + tombstone exists" inconsistent state).
  if (tombstones[rawRel]) removeTombstone(kbRoot, rawRel);
  const action = existed ? 'auto:update-source' : 'auto:create-source';
  appendLog(kbRoot, 'govern', action, pageRel.replace(/\\/g, '/'), `from ${rawRel}`);
  return { action, page: pageRel.replace(/\\/g, '/') };
}

/** Remove fenced code blocks and inline code spans so wikilink detection agrees with
 * retrieval's chunker. Fence rules match retrieval (chunk.mjs stripCode — keep in
 * sync): ``` or ~~~ (3+), any amount of leading whitespace tolerated (deliberately
 * more permissive than CommonMark's 3-space limit), closing fence same char with
 * length >= opening; an opening line whose remainder contains the fence char again
 * is inline code (```code```), not a fence. */
function stripCode(body) {
  const out = [];
  let fence = null; // {char,len}
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

/** The last log.md action recorded for a page path, e.g. 'govern | candidate:topic',
 * or null when the page was never logged (or no log exists yet). */
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

/** Shared guard for EVERY command that rewrites or removes a wiki page (apply-topic,
 * merge, archive): a page whose last log line is candidate:* but whose status is no
 * longer candidate carries an unlogged viewer flip — refuse until the sweep has
 * solidified the review record, so the audit narrative cannot be silently truncated
 * (contract §4). Only topics can be candidates, but the guard is path-agnostic. */
function assertNoUnloggedFlip(kbRoot, pageRel, currentStatus) {
  if (currentStatus && currentStatus !== 'candidate') {
    const last = lastLogAction(kbRoot, pageRel);
    if (last && isPendingCandidateAction(last)) {
      throw new Error(`unlogged review flip pending on this page; run sweep first: ${pageRel}`);
    }
  }
}

/** content_hash of a raw doc's frontmatter, or null when absent (not required, §2.2). */
function readContentHash(kbRoot, rawRel) {
  const abs = path.join(kbRoot, rawRel);
  if (!fs.existsSync(abs)) return null;
  return readDoc(abs).fields.content_hash || null;
}

/** Does this raw already have an approved source page (the survivor of an exact dup)? */
function sourcePageApproved(kbRoot, rawRel) {
  try {
    const pageRel = sourcePageRelPath(readDoc(path.join(kbRoot, rawRel)).fields).replace(/\\/g, '/');
    const abs = path.join(kbRoot, pageRel);
    return fs.existsSync(abs) && readStatus(abs) === 'approved';
  } catch { return false; }
}

/**
 * Write one topic synthesis page (contract §3.3). The synthesis body is supplied by the
 * caller (Claude); the script mechanically validates and generates the frontmatter.
 * The slug is the topic's identity: re-applying an existing slug is an UPDATE of the same
 * topic — sources are union-merged (provenance is never silently dropped), created_at is
 * preserved; aliases/tags omitted = keep, explicit empty array = clear (apply-source
 * convention). New topics and non-contradictory updates are approved (contract §4);
 * contradictions/merges pass candidate: true.
 * Candidate protection (risk tiering is enforced here, not left to the caller):
 *  - re-applying a page that is STILL candidate without --candidate keeps it candidate
 *    (a pending review is never silently approved by a re-apply);
 *  - a page whose last log line is candidate:* but whose status is no longer candidate
 *    carries an unlogged viewer flip — refuse until sweep solidifies it (contract §4).
 */
export function applyTopicPage(kbRoot, { slug, title, sources, aliases, tags, candidate, note } = {}, body) {
  const text = (body || '').trim();
  if (!text) throw new Error('empty synthesis body, refusing to write');
  if (!SAFE_SLUG.test(String(slug || ''))) {
    throw new Error(`slug must be lowercase kebab-case [a-z0-9-]: ${JSON.stringify(slug)}`);
  }
  if (!title || !String(title).trim()) throw new Error('apply-topic requires --title');

  const pageRel = path.join('wiki', 'topics', `${slug}.md`);
  const pageAbs = path.join(kbRoot, pageRel);
  const existed = fs.existsSync(pageAbs);
  const old = existed ? readDoc(pageAbs).fields : {};
  const pageRelPosix = pageRel.replace(/\\/g, '/');

  // Guards read status via the TOLERANT reader (same as merge/archive): the strict
  // parser misses a hand-mangled "status:candidate" (no space), which would let both
  // guards fall simultaneously — one status-reading convention per service.
  const currentStatus = existed ? readStatus(pageAbs) : null;
  if (existed) assertNoUnloggedFlip(kbRoot, pageRelPosix, currentStatus);
  // A still-pending candidate stays candidate unless... it always stays candidate:
  // approval is a review outcome (approve command / viewer), never an apply side effect.
  const keepCandidate = existed && currentStatus === 'candidate';

  // Provenance is fail-closed: every newly listed source must be a raw/ path that exists.
  const newSources = sources === undefined ? [] : sources;
  for (const ref of newSources) {
    const rel = normalizeRawRel(ref);   // throws on traversal / non-raw paths
    if (!fs.existsSync(path.join(kbRoot, rel))) throw new Error(`topic source does not exist: ${rel}`);
  }
  const oldSources = Array.isArray(old.sources) ? old.sources : [];
  let mergedSources = [...new Set([...oldSources, ...newSources.map((s) => normalizeRawRel(s))])].sort();
  if (!mergedSources.length) throw new Error('apply-topic requires --sources (no existing sources to keep)');

  // Exact-duplicate collapse within the topic's own sources (§3.1.4): two raw paths
  // with identical content_hash reference the same document. Converge on one — an
  // already-referenced raw with an approved source page when there is one, else the
  // lexicographically first. Logs `auto:dedup-topic` so the collapse is auditable.
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

  // --- conflict fail-closed gate (plan §3.1.4) ---
  // Read the plan-produced side-channel and verify its raw-set fingerprint. A missing
  // OR stale side-channel degrades identically — stale data is NOT trusted — to an
  // in-topic pairwise check, and both warn. Fingerprint recompute walks all raws
  // (O(M×N) across M apply-topic runs); acceptable for typical KBs. (A stat-level
  // mtime/size variant could lean on the attached raw_hashes list; a content-hash
  // recompute stays exact.)
  const conflictsState = readConflicts(kbRoot);
  let warning = null;
  const flaggedRaws = new Set(); // raws inside non-dismissed flagged groups
  if (!conflictsState || !Array.isArray(conflictsState.groups)) {
    warning = 'conflicts side-channel missing, degraded to in-topic check';
  } else if (fingerprintOf(currentRawHashes(kbRoot)) !== conflictsState.fingerprint) {
    warning = 'conflicts side-channel stale, degraded to in-topic check';
  } else {
    const tombstones = readTombstones(kbRoot);
    for (const g of conflictsState.groups) {
      // Skip dismissed groups. The side-channel's baked-in dismissed flag can be
      // STALE — a dismissal written after the last plan() is not reflected until
      // the next plan. Consulting conflict-dismissals.json directly closes that
      // window (a dismissed pair must not force candidate in the interim).
      if (g.dismissed || isDismissedGroup(kbRoot, g.raws)) continue;
      // A group whose non-tombstoned members have converged to fewer than two is
      // already resolved (auto-dedup / loser-archive wrote a tombstone). The
      // survivor must not keep being forced to candidate — even while the stale
      // side-channel still lists the whole group.
      if (g.raws.filter((r) => !tombstones[r]).length < 2) continue;
      for (const r of g.raws) flaggedRaws.add(r);
    }
  }
  if (warning) {
    // Degraded fallback: pairwise similarity among THIS topic's sources. Only similar
    // groups matter here — exact-duplicate pairs among sources were collapsed above.
    const srcDocs = mergedSources.map((rel) => {
      const { fields, body } = readDoc(path.join(kbRoot, rel));
      return { rel, title: fields.title, filename: path.basename(rel), body, content_hash: fields.content_hash || undefined };
    });
    const tombstones = readTombstones(kbRoot);
    for (const g of findGroups(srcDocs).groups) {
      if (g.category !== 'similar') continue;
      // A dismissed pair must not force candidate even on the degraded path —
      // "parallel documents" is a persisted adjudication, not a side-channel flag.
      if (isDismissedGroup(kbRoot, g.raws)) continue;
      // Same convergence rule as the fresh path: a group already reduced to a
      // single surviving copy (tombstoned members) no longer flags.
      if (g.raws.filter((r) => !tombstones[r]).length < 2) continue;
      if (g.raws.some((r) => newSources.includes(r))) {
        for (const r of g.raws) flaggedRaws.add(r);
      }
    }
  }

  // Fail-closed: a new source inside a flagged (non-dismissed) group forces candidate
  // regardless of the caller's --candidate — the fused-topic approval from bug 0001
  // must be structurally impossible. review_note records the triggering group.
  const forcedConflict = [...flaggedRaws].some((r) => mergedSources.includes(r));
  let groupDesc = '';
  if (forcedConflict && conflictsState && Array.isArray(conflictsState.groups)) {
    groupDesc = conflictsState.groups
      .filter((g) => (g.dismissed || isDismissedGroup(kbRoot, g.raws)) === false && g.raws.some((r) => mergedSources.includes(r)))
      .map((g) => `${g.category}[${g.raws.join('|')}${g.score !== undefined ? ` score:${g.score}` : ''}]`)
      .join('; ');
  }
  const conflictNote = forcedConflict ? `forced candidate: ${groupDesc || 'in-topic similarity'}` : undefined;

  // semantic_check_required (P2-10): a new source whose title/alias overlaps an
  // existing topic's title/aliases is a factual-conflict surface the LLM MUST compare
  // against. This changes nothing about status — it turns the mandatory self-check
  // into a visible output contract rather than a memory burden.
  const semantic = [];
  if (newSources.length) {
    const newTitleTokens = newSources.map((rel) => {
      try { return tokenize(readDoc(path.join(kbRoot, rel)).fields.title ?? ''); } catch { return new Set(); }
    });
    const seen = new Set();
    for (const abs of walk(path.join(kbRoot, 'wiki', 'topics'))) {
      const { fields } = readDoc(abs);
      if (fields.status === 'archived' || fields.status === 'rejected') continue;
      const against = new Set();
      for (const t of [fields.title, ...(Array.isArray(fields.aliases) ? fields.aliases : [])]) {
        for (const x of tokenize(t ?? '')) against.add(x);
      }
      if (against.size && newTitleTokens.some((nt) => titleTokensOverlap(nt, against))) {
        const slug = path.basename(abs).replace(/\.md$/, '');
        if (!seen.has(slug)) { seen.add(slug); semantic.push(slug); }
      }
    }
  }

  const now = new Date().toISOString();
  const status = (candidate || keepCandidate || forcedConflict) ? 'candidate' : 'approved';
  const effectiveNote = [note, conflictNote,
    keepCandidate && !candidate && !note && !conflictNote ? 'kept candidate (pending review)' : undefined,
  ].filter(Boolean).join(' | ') || undefined;
  const fm = buildFrontmatter({
    type: 'topic',
    status,
    title: String(title).trim(),
    sources: mergedSources,
    aliases: aliases === undefined ? old.aliases : aliases,
    tags: tags === undefined ? old.tags : tags,
    // candidate reason, visible to reviewers (contract §3.3); meaningful while
    // candidate, dropped when the page is written as approved
    review_note: status === 'candidate' ? (note ?? conflictNote ?? old.review_note) : undefined,
    created_at: old.created_at || now,
    updated_at: now,
  });
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, fm + '\n' + text + '\n', 'utf8');
  const action = status === 'candidate' ? 'candidate:topic' : (existed ? 'auto:update-topic' : 'auto:create-topic');
  appendLog(kbRoot, 'govern', action, pageRelPosix,
    `sources:${mergedSources.length}${effectiveNote ? ` ${flatten(effectiveNote)}` : ''}`);
  const result = { action, page: pageRelPosix, status, semantic_check_required: semantic };
  if (warning) result.warning = warning;
  return result;
}

/** Mechanically rebuild index.md from the frontmatter of each wiki/ page (contract §3.4). */
export function rebuildIndex(kbRoot) {
  const topics = [], sources = [];
  for (const abs of walk(path.join(kbRoot, 'wiki', 'topics'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/').replace(/^wiki\//, '').replace(/\.md$/, '');
    const { fields } = readDoc(abs);
    const n = Array.isArray(fields.sources) ? fields.sources.length : 0;
    topics.push(`- [[${rel}]] — ${flatten(fields.title) || rel}(status:${fields.status}, sources:${n})`);
  }
  for (const abs of walk(path.join(kbRoot, 'wiki', 'sources'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/').replace(/^wiki\//, '').replace(/\.md$/, '');
    const { fields } = readDoc(abs);
    const src = (fields.source_ref || '').split('/')[1] || '?';
    const date = (fields.source_version || '').slice(0, 10);
    sources.push(`- [[${rel}]] — ${flatten(fields.title) || rel}(${src}, ${date})`);
  }

  const parts = ['# Wiki Index', ''];
  if (topics.length) parts.push('## Topics', ...topics.sort(), '');
  if (sources.length) parts.push('## Sources', ...sources.sort(), '');
  const out = parts.join('\n');
  const indexAbs = path.join(kbRoot, 'wiki', 'index.md');
  // No-op guard (openwiki-inspired): a byte-identical regeneration leaves the
  // file and log.md untouched, so scheduled/manual rebuilds don't churn.
  if (fs.existsSync(indexAbs) && fs.readFileSync(indexAbs, 'utf8') === out) {
    return { topics: topics.length, sources: sources.length, skipped: true };
  }
  fs.writeFileSync(indexAbs, out, 'utf8');
  appendLog(kbRoot, 'govern', 'auto:rebuild-index', 'wiki/index.md', `topics:${topics.length} sources:${sources.length}`);
  return { topics: topics.length, sources: sources.length, skipped: false };
}

/* ---------------- candidate state machine (contract §4) ---------------- */

function resolvePage(kbRoot, pageRelInput) {
  const rel = normalizeWikiRel(pageRelInput);
  const abs = path.join(kbRoot, rel);
  if (!fs.existsSync(abs)) throw new Error(`page does not exist: ${rel}`);
  return { rel, abs };
}

/** Human review outcome: candidate → approved. Logs immediately (review actor). */
export function approvePage(kbRoot, pageRelInput, { via = 'session' } = {}) {
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  flipStatus(abs, 'candidate', 'approved');
  appendLog(kbRoot, 'review', 'approve', rel, `via ${via}`);
  return { action: 'approve', page: rel, status: 'approved' };
}

function gitIsInsideWorkTree(kbRoot) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: kbRoot, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Most recent committed version of <rel> whose frontmatter status is approved, or
 *  null when none exists (a topic never approved). rel is posix-ized for git
 *  pathspecs regardless of platform (P3-2). */
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
    } catch { continue; } // file absent at that commit (created later)
    if (parseFrontmatter(text).fields.status === 'approved') {
      return { commit, text: text.replace(/\n+$/, '') };
    }
  }
  return null;
}

/**
 * Human review outcome: candidate → rejected. When the candidate OVERWROTE an
 * approved version (bug 0001's fused-topic flow), the default is reject-and-restore
 * (plan 0001 §3.1.5 / ADR-0008): revert the page to its most recent git-committed
 * approved version, logging synchronously — so the sweep backfill cannot mis-record
 * the rejection as an approval (P1-5). Non-git KBs and topics with no approved
 * history fall back to a plain reject (transient; sweep archives it), distinguished
 * in the returned restore_reason.
 */
export function rejectPage(kbRoot, pageRelInput, { via = 'session' } = {}) {
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  if (gitIsInsideWorkTree(kbRoot)) {
    const prev = findPreviousApproved(kbRoot, rel);
    if (prev) {
      // Restore first, then log — in that order, so the page's last log action is
      // 'review | reject', never 'candidate:*' (P1-5).
      fs.writeFileSync(abs, prev.text + '\n', 'utf8');
      const st = readStatus(abs);
      if (st !== 'approved') flipStatus(abs, st, 'approved');
      appendLog(kbRoot, 'review', 'reject', rel,
        `via ${via} | restored previous approved version (${prev.commit.slice(0, 8)})`);
      return { action: 'reject', page: rel, status: 'approved', restored: true, from_commit: prev.commit };
    }
    flipStatus(abs, 'candidate', 'rejected');
    appendLog(kbRoot, 'review', 'reject', rel, `via ${via}`);
    return { action: 'reject', page: rel, status: 'rejected', restored: false, restore_reason: 'no-approved-version-in-git-history' };
  }
  flipStatus(abs, 'candidate', 'rejected');
  appendLog(kbRoot, 'review', 'reject', rel, `via ${via}`);
  return { action: 'reject', page: rel, status: 'rejected', restored: false, restore_reason: 'not-a-git-repo' };
}

/** Collision-free archive target: wiki/archive/foo.md taken → foo-2.md, foo-3.md, ... */
function archiveTarget(kbRoot, basename) {
  const dir = path.join(kbRoot, 'wiki', 'archive');
  const stem = basename.replace(/\.md$/, '');
  for (let n = 1; ; n++) {
    const name = n === 1 ? basename : `${stem}-${n}.md`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
}

/** Move a page into wiki/archive/ with status flipped to archived. Crash-safe order:
 * write the flipped archive copy first, then delete the original. (There is still a
 * narrow crash window between copy and flip where an approved page sits inside
 * archive/ — harmless in practice because retrieval both skips the archive/
 * directory and indexes only approved pages.) Returns the archive-relative path. */
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

/** Human-adjudicated archival of an APPROVED page (e.g. an orphan from plan's
 * orphaned_pages). Candidates must be rejected instead — the sweep archives them. */
export function archivePage(kbRoot, pageRelInput, { note = '' } = {}) {
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  const status = readStatus(abs);
  assertNoUnloggedFlip(kbRoot, rel, status);
  if (status !== 'approved') {
    throw new Error(`only approved pages can be archived (candidates should be rejected): ${rel}`);
  }
  const { fields } = readDoc(abs);
  const target = moveToArchive(kbRoot, rel, abs);
  // Archiving a SOURCE page is the loser-archive action (plan §3.1.6): the
  // underlying raw is tombstoned so plan() does not re-pend it and apply-source
  // refuses to revive it without --force. Skipped when the raw is already gone
  // (orphan archive) — a dangling tombstone would be meaningless churn.
  if (fields.source_ref && fs.existsSync(path.join(kbRoot, fields.source_ref))) {
    addTombstone(kbRoot, fields.source_ref, { reason: 'loser-archive', page: target });
  }
  appendLog(kbRoot, 'govern', 'archive', target, `from ${rel}${note ? ` | ${flatten(note)}` : ''}`);
  return { action: 'archive', page: target, from: rel };
}

/** Stateless reconciliation run at the start of every governance session (contract §4).
 * Phase A (backfill): pages whose last governance log line is candidate:* with no later
 *   review line — the viewer flipped them without logging; append the missing review line
 *   reflecting the CURRENT status (approved/rejected; still-candidate and vanished = skip).
 * Phase B (rejected sweep): move status:rejected pages into wiki/archive/ as archived.
 * Idempotent: a second sweep finds nothing and appends zero log lines. */
export function sweep(kbRoot) {
  const logPath = path.join(kbRoot, 'log.md');
  const lines = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n') : [];
  const lastAction = new Map(); // page path -> last log action touching it
  for (const line of lines) {
    const m = line.match(/^## \[[^\]]*\] (\S+) \| (\S+) \| (\S+)/);
    if (m) lastAction.set(m[3], `${m[1]} | ${m[2]}`);
  }
  const backfilled = [];
  for (const [page, action] of lastAction) {
    if (!isPendingCandidateAction(action)) continue;
    const abs = path.join(kbRoot, page);
    if (!fs.existsSync(abs) || !/^wiki\/(sources|topics)\//.test(page)) continue;
    const status = readStatus(abs);
    if (status === 'approved' || status === 'rejected') {
      appendLog(kbRoot, 'review', status === 'approved' ? 'approve' : 'reject', page, 'via viewer (backfilled)');
      backfilled.push({ page, status });
    }
  }
  const archived = [];
  for (const sub of ['sources', 'topics']) {
    for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
      if (readStatus(abs) !== 'rejected') continue;
      const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
      const target = moveToArchive(kbRoot, rel, abs);
      appendLog(kbRoot, 'govern', 'auto:archive-rejected', target, `from ${rel}`);
      archived.push({ from: rel, page: target });
    }
  }
  return { backfilled, archived };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge topic <fromSlug> into <toSlug> (contract §4: merging approved topics is a
 * human-adjudicated action — the human decides in-session, this executes mechanically):
 *  1. rewrite every backlink [[fromSlug]] / [[topics/fromSlug]] (display and #anchor
 *     preserved) across wiki/sources + wiki/topics to point at toSlug — no dangling
 *     wikilinks left behind (archive/ is a frozen record and is not rewritten);
 *  2. union the from-page's provenance into the to-page's sources;
 *  3. archive the from-page (status archived);
 *  4. log the merge.
 * The merged BODY is the caller's intellectual work: re-apply the target with
 * apply-topic afterwards (use --candidate when the merge involves contradictions).
 */
export function mergeTopics(kbRoot, fromSlug, toSlug, { note = '' } = {}) {
  for (const s of [fromSlug, toSlug]) {
    if (!SAFE_SLUG.test(String(s || ''))) {
      throw new Error(`slug must be lowercase kebab-case [a-z0-9-]: ${JSON.stringify(s)}`);
    }
  }
  if (fromSlug === toSlug) throw new Error('merge requires two distinct topic slugs');
  const fromRel = `wiki/topics/${fromSlug}.md`;
  const toRel = `wiki/topics/${toSlug}.md`;
  const fromAbs = path.join(kbRoot, fromRel);
  const toAbs = path.join(kbRoot, toRel);
  for (const [rel, abs] of [[fromRel, fromAbs], [toRel, toAbs]]) {
    if (!fs.existsSync(abs)) throw new Error(`page does not exist: ${rel}`);
    const st = readStatus(abs);
    assertNoUnloggedFlip(kbRoot, rel, st);
    // Contract §4 scopes merging to already-APPROVED topics; a candidate in the pair
    // must be reviewed first — merging it would bypass the review queue and silently
    // discard its review_note (or fuse provenance into a page still under review).
    if (st !== 'approved') {
      throw new Error(`merge involves a non-approved page (status: ${st ?? 'missing'}); review candidates first (approve or reject): ${rel}`);
    }
  }

  const linkRe = new RegExp(`\\[\\[(topics\\/)?${escapeRe(fromSlug)}(\\.md)?(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g');
  const rewritten = [];
  for (const sub of ['sources', 'topics']) {
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

  // Provenance union into the target page (frontmatter is governance-managed, so a
  // parse/rebuild round-trip is safe here — unlike the viewer's byte-preserving flips)
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
  return { action: 'merge', page: toRel, archived: archivedRel, rewritten, sources: mergedSources.length };
}
