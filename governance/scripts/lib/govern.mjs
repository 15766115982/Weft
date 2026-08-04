// Governance v1 core: plan (diff scan), applySourcePage (1:1 summary page write), rebuildIndex.
// Contract: wiki/sources/ maps 1:1 to raw/; source pages are always approved (mechanical mapping, low-risk auto);
// index.md is rebuilt after every governance run; log actor=govern.
import fs from 'node:fs';
import path from 'node:path';
import { buildFrontmatter, parseFrontmatter } from './frontmatter.mjs';
import { flipStatus, readStatus, normalizeWikiRel } from './statusflip.mjs';

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
  const pending = [], anomalies = [], errors = [], reviewQueue = [];
  const raws = new Map();
  for (const abs of walk(path.join(kbRoot, 'raw'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const { fields } = readDoc(abs);
    raws.set(rel, fields);

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
  // a raw deleted later (e.g. acquire --prune) leaves dangling provenance otherwise
  for (const abs of walk(path.join(kbRoot, 'wiki', 'topics'))) {
    const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
    const { fields } = readDoc(abs);
    for (const ref of Array.isArray(fields.sources) ? fields.sources : []) {
      if (!raws.has(ref)) orphanedPages.push({ page: rel, missing_raw: ref, title: fields.title });
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
  reviewQueue.sort((a, b) => a.page.localeCompare(b.page));
  return { pending, anomalies, orphaned_pages: orphanedPages, errors, review_queue: reviewQueue, dangling_links: dangling };
}

/**
 * Write one source summary page. The summary body is supplied by the caller (Claude);
 * the script mechanically generates the frontmatter and validates it. Source pages are always
 * approved (contract §4: 1:1 mechanical mapping is a low-risk automatic operation).
 * When tags is omitted the existing value is kept (same treatment as created_at); an explicit
 * empty array clears it.
 */
export function applySourcePage(kbRoot, rawRelInput, summaryBody, { tags } = {}) {
  const rawRel = normalizeRawRel(rawRelInput);
  const rawAbs = path.join(kbRoot, rawRel);
  if (!fs.existsSync(rawAbs)) throw new Error(`raw doc does not exist: ${rawRel}`);
  const body = (summaryBody || '').trim();
  if (!body) throw new Error('empty summary body, refusing to write');

  const { fields } = readDoc(rawAbs);
  const missing = missingRawFields(fields);
  if (missing.length) throw new Error(`raw doc missing contract fields ${missing.join(', ')}: ${rawRel}`);

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
  const action = existed ? 'auto:update-source' : 'auto:create-source';
  appendLog(kbRoot, 'govern', action, pageRel.replace(/\\/g, '/'), `from ${rawRel}`);
  return { action, page: pageRel.replace(/\\/g, '/') };
}

/** Remove fenced code blocks and inline code spans so wikilink detection agrees with
 * retrieval's chunker. Fence rules match retrieval (chunk.mjs stripCode — keep in
 * sync): ``` or ~~~ (3+), up to 3 leading spaces (CommonMark), closing fence same
 * char with length >= opening; an opening line whose remainder contains the fence
 * char again is inline code (```code```), not a fence. */
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
  const mergedSources = [...new Set([...oldSources, ...newSources.map((s) => normalizeRawRel(s))])].sort();
  if (!mergedSources.length) throw new Error('apply-topic requires --sources (no existing sources to keep)');

  const now = new Date().toISOString();
  const status = (candidate || keepCandidate) ? 'candidate' : 'approved';
  const fm = buildFrontmatter({
    type: 'topic',
    status,
    title: String(title).trim(),
    sources: mergedSources,
    aliases: aliases === undefined ? old.aliases : aliases,
    tags: tags === undefined ? old.tags : tags,
    // candidate reason, visible to reviewers (contract §3.3); meaningful while
    // candidate, dropped when the page is written as approved
    review_note: status === 'candidate' ? (note ?? old.review_note) : undefined,
    created_at: old.created_at || now,
    updated_at: now,
  });
  fs.mkdirSync(path.dirname(pageAbs), { recursive: true });
  fs.writeFileSync(pageAbs, fm + '\n' + text + '\n', 'utf8');
  const action = status === 'candidate' ? 'candidate:topic' : (existed ? 'auto:update-topic' : 'auto:create-topic');
  const effectiveNote = note ?? (keepCandidate && !candidate ? 'kept candidate (pending review)' : undefined);
  appendLog(kbRoot, 'govern', action, pageRelPosix,
    `sources:${mergedSources.length}${effectiveNote ? ` ${flatten(effectiveNote)}` : ''}`);
  return { action, page: pageRelPosix, status };
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

/** Human review outcome: candidate → rejected (transient; sweep archives it). */
export function rejectPage(kbRoot, pageRelInput, { via = 'session' } = {}) {
  const { rel, abs } = resolvePage(kbRoot, pageRelInput);
  flipStatus(abs, 'candidate', 'rejected');
  appendLog(kbRoot, 'review', 'reject', rel, `via ${via}`);
  return { action: 'reject', page: rel, status: 'rejected' };
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
  const target = moveToArchive(kbRoot, rel, abs);
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
