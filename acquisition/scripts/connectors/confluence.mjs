// Confluence connector (contract §1 raw/confluence/<page-id>.md, §2 spec, §6 kb.json).
// Confluence Server / Data Center PAT auth: Authorization: Bearer <pat>
// (Cloud email+API-token Basic auth is out of scope).
//
// Config (kb.json, secrets by env-var NAME only — the PAT itself never
// touches disk, logs, or error messages):
//   "connectors": { "confluence": {
//     "base_url": "https://wiki.example.com",
//     "pat_env": "CONFLUENCE_PAT",
//     "spaces": ["DEV", "REQ"],          // one CQL scope per space
//     "cql": "type = page AND label = kb" // optional: explicit CQL overrides spaces
//   } }
//
// Storage-format XHTML -> markdown is a MINIMAL conversion (like the Jira ADF
// fallback): headings/lists/tables/code+panel macros/links are preserved;
// unknown macros degrade to a [macro: name] placeholder instead of being
// silently dropped. The original XHTML is not retained (contract §2).
import fs from 'node:fs';
import path from 'node:path';
import { upsertRawDoc, sha256 } from '../lib/rawdoc.mjs';
import { writeDetectReport, classify, loadLocalBySource } from '../lib/detect.mjs';
import { appendLog } from '../lib/log.mjs';
import { shapeError } from '../lib/shape.mjs';
import { normalizeConnectorDate, decodeEntities } from './shared.mjs';

export const CONNECTOR_ID = 'confluence@1.0.0';

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPAND = 'body.storage,version,space,metadata.labels,ancestors';
// contract §2: source/source_id are spliced into wiki paths, so they are
// whitelisted; a non-compliant page id is skipped with an error, never escaped
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Confluence emits ISO offsets (with or without colon); normalize to Z.
 *  Unparseable values pass through unchanged (kept visible, not invented).
 *  Implementation lives in shared.mjs (same code as the Jira side). */
export const normalizeConfluenceDate = normalizeConnectorDate;

// ---------------------------------------------------------------------------
// storage XHTML -> markdown (minimal, hand-rolled: zero new dependencies)
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'img', 'hr', 'col', 'input', 'link', 'meta']);

// decodeEntities: shared.mjs (was a verbatim copy of the Jira decoder —
// review 2026-08-04); imported above

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(s || ''))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** Tokenize storage XHTML into a node tree. Tolerant: unclosed tags are
 *  auto-closed at the parent boundary, stray close tags are ignored. */
function parseStorage(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<![^>]*>|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      top().children.push({ text: m[1], cdata: true });
    } else if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) { stack.length = i; break; }
      }
    } else if (m[3] !== undefined) {
      const name = m[3].toLowerCase();
      const node = { tag: name, attrs: parseAttrs(m[4]), children: [] };
      top().children.push(node);
      if (!m[5] && !VOID_TAGS.has(name)) stack.push(node);
    } else if (m[6] !== undefined) {
      top().children.push({ text: decodeEntities(m[6]) });
    }
  }
  return root;
}

function findChild(node, tag, attrName, attrValue) {
  for (const c of node.children) {
    if (c.tag === tag && (attrName === undefined || c.attrs?.[attrName] === attrValue)) return c;
  }
  return null;
}

/** Raw text content (CDATA preserved verbatim), for pre / code bodies. */
function rawText(node) {
  return node.children
    .map((c) => (c.text !== undefined ? c.text : rawText(c)))
    .join('');
}

function renderNodes(children, ctx) {
  return children.map((c) => renderNode(c, ctx)).join('');
}

// <br> is meaningful; pretty-print whitespace between tags is not. br renders
// as a sentinel so the inline collapse eats only the meaningless newlines;
// the sentinel becomes a real '\n' after the global cleanup.
const HARD_BREAK = String.fromCharCode(1); // <br> sentinel, restored to newline after cleanup

// Line structure must be computed on BOTH real newlines and the br sentinel:
// the sentinel is restored to '\n' only AFTER the global cleanup, so any
// render-time line splitting (blockquote / panel macro / list items) that
// looked only at '\n' would let the post-br line escape its structure
const splitLines = (s) => s.split('\n').flatMap((l) => l.split(HARD_BREAK));

/** Inline rendering: block structure collapsed away (table cells, headings).
 *  Marks ctx.inline so block-level constructs (tables) degrade to a visible
 *  placeholder instead of pipe-escaped garbage. */
function renderInline(children, ctx) {
  return renderNodes(children, { ...ctx, inline: true }).replace(/[ \t]*\n[ \t]*/g, ' ').trim();
}

/** Fence length = longest backtick run in the content + 1 (min 3): a code
 *  block whose content contains ``` must not burst its own fence (the
 *  retrieval chunker already recognizes 4+ backtick fences — both sides of
 *  the convention must agree). */
function fenceFor(code) {
  let max = 0;
  for (const m of String(code).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

function renderTable(node, ctx) {
  // nested in a cell/heading: a visible placeholder beats pipe-escaped garbage
  // (same philosophy as unknown macros); collect() below stops at the first
  // <tr>, so a nested table's rows never leak into the outer table either
  if (ctx.inline) return '[table]';
  const rows = [];
  const collect = (n) => {
    if (n.tag === 'tr') rows.push(n);
    else (n.children || []).forEach(collect);
  };
  (node.children || []).forEach(collect);
  const cells = rows
    .map((tr) => ({
      isHeader: tr.children.some((c) => c.tag === 'th'),
      cells: tr.children
        .filter((c) => c.tag === 'th' || c.tag === 'td')
        .map((c) => renderInline(c.children, ctx).replaceAll(HARD_BREAK, ' ').replace(/\|/g, '\\|')),
    }))
    .filter((r) => r.cells.length);
  if (!cells.length) return '';
  // markdown forces a header row; a table with no <th> gets an EMPTY header
  // instead of promoting the first data row (that would distort the data)
  const header = cells[0].isHeader ? cells[0].cells : cells[0].cells.map(() => '');
  const bodyRows = cells[0].isHeader ? cells.slice(1) : cells;
  const lines = [header, header.map(() => '---'), ...bodyRows.map((r) => r.cells)]
    .map((r) => `| ${r.join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

// Placeholder token sentinel (phase 1): gliffy/jira macros need the network,
// but storageToMarkdown stays pure+sync. renderMacro emits a token and pushes
// the macro record into ctx.collect; run() resolves them async afterwards.
// STX (U+0002) via fromCharCode — storageToMarkdown strips it from the input
// at entry, so the token is collision-proof by construction (same philosophy
// as the HARD_BREAK U+0001 sentinel), and tokens never reach disk (always
// replaced or degraded before hashing).
const STX = String.fromCharCode(2);

function macroParam(node, name) {
  return (findChild(node, 'ac:parameter', 'ac:name', name)?.children || [])
    .map((c) => c.text || '').join('').trim();
}

/** Gallery macro: filenames ride inside the macro body (<ac:image>), so it
 *  renders synchronously — no placeholder needed. Cross-page attachments and
 *  external URLs are noted by name only (never fetched). */
function renderGallery(node) {
  const title = macroParam(node, 'title');
  const items = [];
  for (const img of node.children.filter((c) => c.tag === 'ac:image')) {
    const att = findChild(img, 'ri:attachment');
    if (att?.attrs['ri:filename']) {
      const pg = findChild(att, 'ri:page');
      items.push(pg
        ? `${att.attrs['ri:filename']} (from page: ${pg.attrs['ri:content-title'] || '?'})`
        : att.attrs['ri:filename']);
      continue;
    }
    const u = findChild(img, 'ri:url');
    if (u?.attrs['ri:value']) {
      let host = u.attrs['ri:value'];
      try { host = new URL(u.attrs['ri:value']).host; } catch { /* keep raw */ }
      items.push(`${host} (external image)`);
    }
  }
  if (!items.length) return '\n\n[gallery: page attachments]\n\n';
  const shown = items.slice(0, 20);
  const more = items.length > shown.length ? `\n- … +${items.length - shown.length} more` : '';
  return `\n\n**Gallery${title ? `: ${title}` : ''}**\n${shown.map((i) => `- ${i}`).join('\n')}${more}\n\n`;
}

function renderMacro(node, ctx) {
  const name = node.attrs['ac:name'] || '';
  if (name === 'code') {
    const lang = (findChild(node, 'ac:parameter', 'ac:name', 'language')?.children || [])
      .map((c) => c.text || '').join('').trim();
    const bodyNode = findChild(node, 'ac:plain-text-body');
    const code = bodyNode ? rawText(bodyNode).replace(/\n+$/, '') : '';
    const fence = fenceFor(code);
    return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
  }
  if (['info', 'note', 'warning', 'tip'].includes(name)) {
    const bodyNode = findChild(node, 'ac:rich-text-body');
    const inner = bodyNode ? renderNodes(bodyNode.children, ctx).trim() : '';
    const label = name[0].toUpperCase() + name.slice(1);
    const quoted = splitLines(inner).map((l) => `> ${l}`.trimEnd()).join('\n');
    return `\n\n> **${label}:**\n${quoted}\n\n`;
  }
  if (name === 'toc') return ''; // navigation chrome, not content
  if (name === 'status') {
    const title = (findChild(node, 'ac:parameter', 'ac:name', 'title')?.children || [])
      .map((c) => c.text || '').join('').trim();
    return `[status: ${title}]`;
  }
  if (name === 'gallery') {
    const rendered = renderGallery(node);
    if (!ctx.collect) return rendered;
    const token = `${STX}MACRO:${ctx.collect.length}${STX}`;
    ctx.collect.push({ token, type: 'gallery', rendered });
    return token;
  }
  // async macros (phase 1): emit a token, resolve in run() afterwards;
  // without a collector (pure unit tests) the placeholder degrade applies
  if (ctx.collect && (name === 'gliffy' || name === 'jira')) {
    const token = `${STX}MACRO:${ctx.collect.length}${STX}`;
    const params = {};
    for (const c of node.children) {
      if (c.tag === 'ac:parameter') {
        params[c.attrs['ac:name'] || ''] = (c.children || []).map((t) => t.text || '').join('').trim();
      }
    }
    ctx.collect.push({ token, type: name, params });
    return token;
  }
  // nothing is silently dropped: unknown macros leave a visible placeholder
  return `\n\n[macro: ${name}]\n\n`;
}

function renderNode(node, ctx) {
  if (node.text !== undefined) return node.text;
  const { tag, attrs, children } = node;
  switch (tag) {
    case '#root': return renderNodes(children, ctx);
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      // single-line context: a <br> in a heading degrades to a space
      return `\n\n${'#'.repeat(Number(tag[1]))} ${renderInline(children, ctx).replaceAll(HARD_BREAK, ' ')}\n\n`;
    case 'p': return `\n\n${renderInline(children, ctx)}\n\n`;
    case 'br': return HARD_BREAK;
    case 'hr': return '\n\n---\n\n';
    case 'strong': case 'b': return `**${renderInline(children, ctx)}**`;
    case 'em': case 'i': return `*${renderInline(children, ctx)}*`;
    case 'code': {
      const raw = rawText(node).trim();
      if (!raw.includes('`')) return `\`${raw}\``;
      // content with backticks: CommonMark inline code with a longer run
      const f = fenceFor(raw);
      return `${f} ${raw} ${f}`;
    }
    case 'pre': {
      const code = rawText(node).replace(/\n+$/, '');
      const fence = fenceFor(code);
      return `\n\n${fence}\n${code}\n${fence}\n\n`;
    }
    case 'blockquote': {
      const inner = renderNodes(children, ctx).trim();
      return `\n\n${splitLines(inner).map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n`;
    }
    case 'ul': case 'ol': {
      const items = children.filter((c) => c.tag === 'li');
      const lines = items.map((li, i) => {
        const marker = tag === 'ol' ? `${i + 1}. ` : '- ';
        const inner = renderNodes(li.children, { ...ctx, depth: ctx.depth + 1 }).trim();
        const indent = '  '.repeat(ctx.depth);
        const body = splitLines(inner).map((l, k) => (k === 0 ? l : `${indent}  ${l}`)).join('\n');
        return `${indent}${marker}${body}`;
      });
      return `\n${lines.join('\n')}\n`;
    }
    case 'li': return renderNodes(children, ctx); // stray li outside a list
    case 'table': return renderTable(node, ctx);
    case 'a': {
      const text = renderInline(children, ctx);
      const href = attrs.href || '';
      if (!href) return text;
      const url = href.startsWith('/') ? ctx.baseUrl + href : href;
      return `[${text || url}](${url})`;
    }
    case 'img': {
      const src = attrs.src || '';
      const url = src.startsWith('/') ? ctx.baseUrl + src : src;
      return `![${attrs.alt || ''}](${url})`;
    }
    case 'ac:structured-macro': return renderMacro(node, ctx);
    case 'ac:link': {
      const body = renderInline(children, ctx);
      const riPage = findChild(node, 'ri:page');
      const riUrl = findChild(node, 'ri:url');
      if (riUrl?.attrs['ri:value']) return `[${body || riUrl.attrs['ri:value']}](${riUrl.attrs['ri:value']})`;
      return body || riPage?.attrs['ri:content-title'] || '';
    }
    case 'ac:link-body': return renderNodes(children, ctx);
    case 'ac:image': {
      const att = findChild(node, 'ri:attachment');
      if (att?.attrs['ri:filename']) return `[attachment: ${att.attrs['ri:filename']}]`;
      const riUrl = findChild(node, 'ri:url');
      if (riUrl?.attrs['ri:value']) return `![](${riUrl.attrs['ri:value']})`;
      return '[image]';
    }
    case 'ac:emoticon': return `[emoji: ${attrs['ac:name'] || ''}]`;
    case 'time': return attrs.datetime || renderInline(children, ctx);
    // layout/structure chrome: unwrap and keep the children
    default: return renderNodes(children, ctx);
  }
}

/** Storage-format XHTML -> markdown (minimal fidelity, declared).
 *  collect (optional array): async macros (gliffy/jira) and gallery are
 *  emitted as STX tokens + records pushed here, for run() to resolve. */
export function storageToMarkdown(xhtml, baseUrl = '', collect) {
  const root = parseStorage(String(xhtml || '').replaceAll(STX, ''));
  const md = renderNodes(root.children, { depth: 0, baseUrl, collect });
  return cleanupOutsideFences(md).replaceAll(HARD_BREAK, '\n').trim();
}

// Whitespace cleanup must NOT touch fenced code: code macros/pre are the
// highest-evidence content (config snippets, command examples) and raw/ is
// the evidence layer — their blank lines and trailing spaces are content
// (same lesson as the M4 reading-convention drift: the chunker is
// fence-aware, so the converter must be too)
const FENCE_RE = /(`{3,})[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g;

function cleanupOutsideFences(md) {
  let out = '';
  let last = 0;
  for (const m of md.matchAll(FENCE_RE)) {
    out += tidy(md.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + tidy(md.slice(last));
}

const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

// ---------------------------------------------------------------------------

/** One page -> normalized markdown body (English scaffold; the page's own
 *  text keeps its source language — raw/ is the evidence layer).
 *  out (optional object): receives out.pendingMacros for run() to resolve. */
export function pageToMarkdown(page, baseUrl, out) {
  const id = String(page.id || '');
  const title = page.title || '';
  const version = page.version?.number ?? '';
  // version.number bumps on EVERY edit and the full-precision timestamp rides
  // along: the body is what content_hash covers, so no same-day blind spot
  const when = normalizeConfluenceDate(page.version?.when);
  const by = page.version?.by?.displayName || '';
  const spaceKey = page.space?.key || '';
  const labels = (page.metadata?.labels?.results || []).map((l) => l.name || '');
  const crumbs = (page.ancestors || []).map((a) => a.title || '');

  const head = [
    `# ${title}`,
    '',
    `- Link: ${pageUrl(page, baseUrl)}`,
    `- Space: ${spaceKey}  Version: ${version}  Last modified: ${when}${by ? `  By: ${by}` : ''}`,
  ];
  if (crumbs.length) head.push(`- Location: ${[spaceKey, ...crumbs].filter(Boolean).join(' > ')}`);
  if (labels.length) head.push(`- Labels: ${labels.join(', ')}`);
  head.push('', '---', '');

  const collect = [];
  const body = storageToMarkdown(page.body?.storage?.value || '', baseUrl, collect);
  if (out) out.pendingMacros = collect.map((m) => ({ ...m, pageId: id }));
  return head.join('\n') + (body || '(empty page)') + '\n';
}

// ---------------------------------------------------------------------------
// async macro resolution (phase 1): gliffy attachments / jira-filter JQL
// ---------------------------------------------------------------------------

/** Raw (non-JSON) Confluence GET of an absolute URL on the configured host.
 *  Error carries .status only — response bodies may contain intranet content
 *  and must never leak into degrade text or summaries. */
async function confFetchUrl(cfg, url, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(url, {
    headers: { Authorization: `Bearer ${cfg.pat}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`attachment download HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** Server-provided links are context-path-relative; make them absolute. */
function absolutizeLink(cfg, link) {
  if (/^https?:\/\//i.test(link)) return link;
  return `${cfg.baseUrl}${link.startsWith('/') ? '' : '/'}${link}`;
}

// ---- Gliffy diagram attachment resolution (round-2 hardening 2026-08-04) ----
// Round 1 assumed diagram filename = macro name + ".gliffy" and only changed
// WHERE the URL came from — but the real failure was the NAME: a genuine
// Gliffy diagram attachment is stored WITHOUT an extension ("the diagram name
// without a file extension", help.gliffy.com), and Server/DC has NO REST binary
// download endpoint (_links.download points right back at the
// /download/attachments/ servlet). So resolution now lists the page's REAL
// attachments and matches the macro name against their titles, then downloads
// via the matched attachment's own _links.download. Research & decisions:
// docs/research/gliffy-404-round2.md.

const IMAGE_EXT = /\.(png|svg|jpe?g)$/i;

/** Strip the final extension (ANY extension — the real attachment may carry
 *  one we never guessed, or none at all). */
function stripExt(s) {
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

/** Paginated attachment list for a content id (titles/extension metadata only). */
async function listAttachments(cfg, pageId, fetchImpl) {
  const base = `/rest/api/content/${encodeURIComponent(String(pageId))}/child/attachment`;
  const out = [];
  for (let start = 0; ; ) {
    const data = await confGet(cfg, `${base}?${new URLSearchParams({ limit: '200', start: String(start) })}`, fetchImpl);
    const batch = data.results || [];
    out.push(...batch);
    if (batch.length < 200) break;
    start += batch.length;
  }
  return out;
}

/** D4: a Gliffy macro may carry page/space params pointing the diagram at a
 *  DIFFERENT page (wiki syntax {gliffy:name=X|space=~u|page=p}). Resolve that
 *  page's id; absent params → the macro's own page. `title` search is a LIKE
 *  match, so the first hit is taken (residual fuzziness, accepted for a
 *  rarely-used path). */
async function resolveDiagramPageId(cfg, params, defaultPageId, fetchImpl) {
  const pageParam = String(params?.page || '').trim();
  if (!pageParam) return defaultPageId;
  const q = new URLSearchParams({ title: pageParam, expand: 'version' });
  const spaceParam = String(params?.space || '').trim();
  if (spaceParam) q.set('spaceKey', spaceParam);
  const data = await confGet(cfg, `/rest/api/content?${q}`, fetchImpl);
  const hit = (data.results || [])[0];
  if (!hit?.id) {
    const err = new Error(`gliffy page param did not resolve: ${pageParam}`);
    err.safe = true;
    throw err;
  }
  return String(hit.id);
}

/** D1: match the macro's name against attachment titles by normalized name.
 *  Priority: verbatim title == name → title-stripped == name → title-stripped
 *  == base (name with any known diagram/image extension removed) → a UNIQUE
 *  prefix candidate. Returns { att, via, name, base, prefix } — prefix holds
 *  the ambiguous candidates for content-sniffing when nothing else matched. */
function matchDiagramAttachment(list, params) {
  const name = String(params?.name || params?.displayName || '').trim();
  const base = gliffyBaseName(params);
  const targetName = name.toLowerCase();
  const targetBase = base.toLowerCase();
  const pools = { exact: [], nameNoExt: [], baseNoExt: [], prefix: [] };
  for (const a of list || []) {
    const title = String(a.title || '').trim();
    if (!title) continue;
    const noExt = stripExt(title).toLowerCase();
    if (title.toLowerCase() === targetName) pools.exact.push(a);
    else if (noExt === targetName) pools.nameNoExt.push(a);
    else if (noExt === targetBase) pools.baseNoExt.push(a);
    else if (targetBase && noExt.startsWith(targetBase)) pools.prefix.push(a);
  }
  for (const key of ['exact', 'nameNoExt', 'baseNoExt']) {
    if (pools[key].length) return { att: pools[key][0], via: key, name, base, prefix: pools.prefix };
  }
  if (pools.prefix.length === 1) return { att: pools.prefix[0], via: 'prefix', name, base, prefix: pools.prefix };
  return { att: null, via: 'none', name, base, prefix: pools.prefix };
}

/** True when body parses as a Gliffy diagram JSON (stage.objects present). */
function isGliffyJson(text) {
  try {
    return Array.isArray(JSON.parse(text)?.stage?.objects);
  } catch { return false; }
}

/** D3 + download: fetch an attachment's bytes. Candidate order:
 *  1. _links.download verbatim (server-canonical, carries version/modificationDate);
 *  2. same, with &modificationDate= stripped (CONFSERVER-60328: proxies mangle it);
 *  3. bare legacy /download/attachments/<id>/<encoded-title> (proxies that
 *     choke on query strings to that path).
 *  A non-404 failure stops the chain (auth/server problems hit every path
 *  alike). Returns { res, via, attempts }; attempts = value-free {via, http}
 *  per candidate, feeds the --probe diagnostic. */
async function downloadAttachment(cfg, pageId, attachment, fetchImpl) {
  const title = String(attachment?.title || '');
  const candidates = [];
  const dl = attachment?._links?.download;
  if (dl) {
    candidates.push({ url: absolutizeLink(cfg, dl), via: 'rest-download' });
    const stripped = String(dl).replace(/&modificationDate=\d+/i, '');
    if (stripped !== dl) candidates.push({ url: absolutizeLink(cfg, stripped), via: 'rest-download-stripped' });
  }
  if (title) candidates.push({ url: `${cfg.baseUrl}/download/attachments/${pageId}/${encodeURIComponent(title)}`, via: 'legacy' });
  const attempts = [];
  for (const cand of candidates) {
    try {
      return { res: await confFetchUrl(cfg, cand.url, fetchImpl), via: cand.via, attempts };
    } catch (err) {
      attempts.push({ via: cand.via, http: err.status || 0 });
      if (err.status && err.status !== 404) break;
    }
  }
  const last = attempts[attempts.length - 1] || {};
  const err = new Error(`attachment download HTTP ${last.http || 'all routes failed'}`);
  err.status = last.http || 0;
  err.attempts = attempts;
  throw err;
}

/** Download the diagram body given the macro + its page. Primary path: list
 *  the page's attachments (D1 match → D3 download). When the REST list itself
 *  FAILS (endpoint dead/auth), fall back to the round-1 guess path so
 *  REST-down servers don't regress. When the list SUCCEEDS but nothing
 *  matches, the diagram is genuinely missing (help.gliffy defines 404 exactly
 *  that way) — degrade with a value-free count rather than guess. Ambiguous
 *  prefix candidates get a content-sniff tie-break (cap 3): the one that
 *  parses as Gliffy JSON IS the diagram.
 *  Returns { text, attachments, via, attempts }. */
async function fetchDiagramBody(cfg, params, pageId, fetchImpl) {
  let attachments = [];
  try {
    attachments = await listAttachments(cfg, pageId, fetchImpl);
  } catch (err) {
    const base = gliffyBaseName(params);
    const guesses = [...new Set([base, `${base}.gliffy`])].filter(Boolean);
    let lastStatus = err.status || 0;
    for (const g of guesses) {
      try {
        const { res, via, attempts } = await downloadAttachment(cfg, pageId, { title: g }, fetchImpl);
        return { text: await res.text(), attachments: [], via, attempts };
      } catch (e2) { lastStatus = e2.status || lastStatus; }
    }
    const e = new Error(`attachment download HTTP ${lastStatus || 'failed'}`);
    e.status = lastStatus;
    throw e;
  }
  const match = matchDiagramAttachment(attachments, params);
  if (!match.att && match.prefix.length > 1) {
    for (const cand of match.prefix.slice(0, 3)) {
      try {
        const { res, via } = await downloadAttachment(cfg, pageId, cand, fetchImpl);
        const text = await res.text();
        if (isGliffyJson(text)) return { text, attachments, via, attempts: [{ via, http: 200 }] };
      } catch { /* not this one */ }
    }
  }
  if (!match.att) {
    const err = new Error(`no matching diagram attachment on page (${attachments.length} attachments listed)`);
    err.safe = true;
    throw err;
  }
  const { res, via, attempts } = await downloadAttachment(cfg, pageId, match.att, fetchImpl);
  return { text: await res.text(), attachments, via, attempts };
}

/** .gliffy attachment JSON -> label strings, ordered top-to-bottom, left-to-
 *  right (each shape's text lives in graphic.Text.html). Shape-tolerant:
 *  mismatches throw shapeError (relay-safe diagnostics, no values). */
export function parseGliffyLabels(text) {
  let g;
  try {
    g = JSON.parse(text);
  } catch {
    throw shapeError('gliffy attachment', 'JSON document', text.slice(0, 0));
  }
  const objects = g?.stage?.objects;
  if (!Array.isArray(objects)) {
    throw shapeError('gliffy attachment', 'stage.objects array', g?.stage?.objects === undefined ? g : objects);
  }
  const labels = [];
  const visit = (obj) => {
    const html = obj?.graphic?.Text?.html;
    if (typeof html === 'string' && html.trim()) {
      const label = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (label) labels.push({ x: Number(obj.x) || 0, y: Number(obj.y) || 0, label });
    }
    for (const c of obj?.children || []) visit(c);
  };
  objects.forEach(visit);
  labels.sort((a, b) => a.y - b.y || a.x - b.x);
  return labels.map((l) => l.label);
}

function gliffyBaseName(params) {
  return String(params?.name || params?.displayName || '')
    .replace(/\.(gliffy|png|svg|jpe?g)$/i, '')
    .trim();
}

function safeFileName(name) {
  const s = String(name)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return s && s !== '..' ? s : 'diagram';
}

/** Binary evidence sidecar (contract §1 amendment 2026-08-03):
 *  raw/confluence/<page-id>.assets/<file>. Byte-compared independently of the
 *  doc's content_hash — the PNG can change while the page text doesn't. */
function writeAsset(kbRoot, pageId, fileName, buf) {
  const rel = path.posix.join('raw', 'confluence', `${pageId}.assets`, fileName);
  const abs = path.join(kbRoot, rel);
  if (fs.existsSync(abs) && fs.readFileSync(abs).equals(buf)) return rel;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}

async function resolveGliffy(m, cfg, kbRoot, fetchImpl) {
  const base = gliffyBaseName(m.params);
  if (!base) {
    const err = new Error('gliffy macro without name parameter');
    err.safe = true;
    throw err;
  }
  const diagramPageId = await resolveDiagramPageId(cfg, m.params, m.pageId, fetchImpl);
  const { text, attachments } = await fetchDiagramBody(cfg, m.params, diagramPageId, fetchImpl);
  const labels = parseGliffyLabels(text);
  // D2: the PNG render is best-effort and only from a REAL image attachment in
  // the listing — a true Gliffy diagram is one extensionless attachment and the
  // raster is rendered on the fly, so a blind <base>.png guess would only 404.
  let assetRel = '';
  try {
    const image = (attachments || []).find((a) => {
      const t = String(a.title || '').trim();
      return IMAGE_EXT.test(t) && stripExt(t).toLowerCase() === base.toLowerCase();
    });
    if (image) {
      const { res } = await downloadAttachment(cfg, diagramPageId, image, fetchImpl);
      const buf = Buffer.from(await res.arrayBuffer());
      assetRel = writeAsset(kbRoot, m.pageId, `${safeFileName(base)}.png`, buf);
    }
  } catch { /* no PNG available — image line omitted, labels still land */ }
  const parts = [`**Gliffy diagram: ${base}**`];
  if (assetRel) parts.push('', `![gliffy: ${base}](${assetRel})`);
  if (labels.length) parts.push('', ...labels.map((l) => `- ${l}`));
  return `\n\n${parts.join('\n')}\n\n`;
}

function mdCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** Single-server assumption (documented in SKILL.md): the macro's serverId
 *  cannot be mapped to a base_url without the applinks API, so key/JQL are
 *  always executed against the one configured Jira. */
async function resolveJiraMacro(m, kbConfig, jira, jqlCache, fetchImpl) {
  const notConfigured = () => {
    const err = new Error('jira connector not configured');
    err.safe = true;
    return err;
  };
  const key = m.params?.key || '';
  const jql = m.params?.jql || m.params?.jqlQuery || '';
  if (!jira) throw notConfigured();
  const baseUrl = String(kbConfig.connectors.jira.base_url).replace(/\/+$/, '');
  if (key) {
    const issue = await jira.getIssue(kbConfig, key, { fetchImpl });
    const f = issue.fields || {};
    return `\n\n- [${issue.key || key}] ${f.summary || ''} (${f.status?.name || '?'} · ${f.assignee?.displayName || 'unassigned'}) — ${baseUrl}/browse/${issue.key || key}\n\n`;
  }
  if (!jql) {
    const err = new Error('jira macro without key/jql parameter');
    err.safe = true;
    throw err;
  }
  if (!jqlCache.has(jql)) jqlCache.set(jql, jira.searchJql(kbConfig, jql, { max: 20, fetchImpl }));
  const { issues, total } = await jqlCache.get(jql);
  const rows = issues.map((it) => {
    const f = it.fields || {};
    return `| [${it.key}](${baseUrl}/browse/${it.key}) | ${mdCell(f.summary)} | ${mdCell(f.status?.name)} | ${mdCell(f.assignee?.displayName || 'unassigned')} |`;
  });
  const note = total > issues.length ? `\n(showing ${issues.length} of ${total})` : '';
  return `\n\nJira filter: \`${jql}\`\n\n| Key | Summary | Status | Assignee |\n|---|---|---|---|\n${rows.join('\n')}${note}\n\n`;
}

/** Degrade text: the macro's own parameters are already page content (safe),
 *  but error messages from jiraGet embed response snippets (unsafe) — only
 *  err.safe/shapeSafe messages or bare HTTP codes are quoted. */
function degradeFor(m, err) {
  const why = err?.safe || err?.shapeSafe ? err.message : err?.status ? `HTTP ${err.status}` : 'fetch/parse failed';
  if (m.type === 'gliffy') return `[gliffy diagram: ${gliffyBaseName(m.params) || '?'} — ${why}]`;
  if (m.type === 'jira') return `[jira filter: ${m.params?.jql || m.params?.jqlQuery || m.params?.key || ''} — ${why}]`;
  return `[macro: ${m.type}]`;
}

/** Replace STX tokens in body with resolved content. Per-macro failures
 *  degrade in place (counted, NOT summary.errors — the page itself succeeded). */
export async function resolveMacros(body, pending, { cfg, kbRoot, kbConfig, jira, jqlCache, counts, fetchImpl } = {}) {
  let out = body;
  for (const m of pending || []) {
    let rendered = m.rendered;
    try {
      if (m.type === 'gliffy') rendered = await resolveGliffy(m, cfg, kbRoot, fetchImpl);
      else if (m.type === 'jira') rendered = await resolveJiraMacro(m, kbConfig, jira, jqlCache, fetchImpl);
      if (counts) {
        const k = m.type === 'jira' ? 'jira_filter' : m.type;
        counts[k] = (counts[k] || 0) + 1;
      }
    } catch (err) {
      rendered = `\n\n${degradeFor(m, err)}\n\n`;
      if (counts) counts.degraded = (counts.degraded || 0) + 1;
    }
    out = out.split(m.token).join(rendered ?? '');
  }
  return out;
}

/** Shape probe (acquire.mjs `confluence --probe <pageId>`): download the
 *  page's first Gliffy diagram and report (a) the macro's own params, (b) the
 *  page's REAL attachment titles — metadata, never bodies — (c) which one
 *  matched and by which route, (d) per-attempt {url-ish via, http} status. The
 *  point is to turn the next 404 into a two-line diagnosis: "name didn't
 *  match" vs "the /download/attachments/ servlet itself is broken" vs
 *  "the diagram attachment is genuinely missing". */
export async function probeGliffy(kbConfig, pageId, { fetchImpl } = {}) {
  if (!pageId || !String(pageId).trim()) {
    throw new Error('confluence --probe requires a page id (pick any page containing a Gliffy diagram)');
  }
  const auth = resolveAuth(kbConfig);
  const page = await confGet(auth, `/rest/api/content/${encodeURIComponent(String(pageId))}?expand=body.storage`, fetchImpl);
  const xhtml = page?.body?.storage?.value || '';
  const root = parseStorage(xhtml);
  let params = null;
  const walk = (n) => {
    if (params) return;
    if (n.tag === 'ac:structured-macro' && n.attrs['ac:name'] === 'gliffy') {
      params = {};
      for (const c of n.children) {
        if (c.tag === 'ac:parameter') {
          params[c.attrs['ac:name'] || ''] = (c.children || []).map((t) => t.text || '').join('').trim();
        }
      }
    }
    (n.children || []).forEach(walk);
  };
  walk(root);
  if (!params) return { probe: true, page: String(pageId), note: 'no-gliffy-macro' };
  const gliffy = { macro: {
    name: params.name || '',
    displayName: params.displayName || '',
    page: params.page || '',
    space: params.space || '',
  } };
  try {
    const diagramPageId = await resolveDiagramPageId(auth, params, pageId, fetchImpl);
    gliffy.page_id = String(diagramPageId);
    const attachments = await listAttachments(auth, diagramPageId, fetchImpl);
    gliffy.attachment_count = attachments.length;
    gliffy.attachments = attachments.map((a) => String(a.title || ''));
    const match = matchDiagramAttachment(attachments, params);
    let text = null;
    if (match.att) {
      try {
        const { res, via, attempts } = await downloadAttachment(auth, diagramPageId, match.att, fetchImpl);
        gliffy.matched = { title: String(match.att.title || ''), match: match.via, via };
        gliffy.attempts = attempts;
        gliffy.http = 200;
        text = await res.text();
      } catch (err) {
        gliffy.matched = { title: String(match.att.title || ''), match: match.via };
        gliffy.attempts = err.attempts || [];
        gliffy.http = err.status || 0;
        gliffy.error = 'download failed';
      }
    } else {
      gliffy.matched = null;
      // distinguishes "name mismatch" from "the servlet itself is broken":
      // if the legacy <name>.gliffy guess ALSO 404s, the servlet is the
      // problem; if it 200s, the real attachment is simply named differently
      const guess = `${gliffyBaseName(params)}.gliffy`;
      try {
        await downloadAttachment(auth, diagramPageId, { title: guess }, fetchImpl);
        gliffy.legacy_guess = { title: guess, http: 200 };
      } catch (err) {
        gliffy.legacy_guess = { title: guess, http: err.status || 0 };
      }
    }
    if (text !== null) {
      let g;
      let jsonValid = true;
      try { g = JSON.parse(text); } catch { jsonValid = false; }
      const objects = g?.stage?.objects;
      let labelCount = 0;
      if (jsonValid && Array.isArray(objects)) {
        try { labelCount = parseGliffyLabels(text).length; } catch { /* counted as 0 */ }
      }
      gliffy.jsonValid = jsonValid;
      gliffy.hasStageObjects = Array.isArray(objects);
      gliffy.objectCount = Array.isArray(objects) ? objects.length : null;
      gliffy.labelCount = labelCount;
    }
    return { probe: true, page: String(pageId), gliffy };
  } catch (err) {
    gliffy.http = err.status || 0;
    gliffy.error = err.safe ? err.message : 'probe failed';
    return { probe: true, page: String(pageId), gliffy };
  }
}

function pageUrl(page, baseUrl) {
  const webui = page._links?.webui || '';
  if (webui) return webui.startsWith('http') ? webui : `${baseUrl}${webui.startsWith('/') ? '' : '/'}${webui}`;
  return `${baseUrl}/pages/viewpage.action?pageId=${page.id}`;
}

/** Shared auth/config resolution for run() and check() — one reading
 *  convention, so future rules cannot drift between the two entry points. */
function resolveAuth(kbConfig) {
  const c = kbConfig?.connectors?.confluence || {};
  if (!c.base_url) {
    throw new Error('confluence connector is not configured: set connectors.confluence.base_url in kb.json');
  }
  const patEnv = c.pat_env || 'CONFLUENCE_PAT';
  const pat = process.env[patEnv];
  if (!pat) {
    throw new Error(`confluence PAT not available: environment variable ${patEnv} is not set (kb.json connectors.confluence.pat_env)`);
  }
  return { baseUrl: String(c.base_url).replace(/\/+$/, ''), pat, patEnv, connectorConfig: c };
}

function resolveConfig(kbConfig, { cql, maxResults } = {}) {
  const auth = resolveAuth(kbConfig);
  const c = auth.connectorConfig;
  const spaces = Array.isArray(c.spaces) ? c.spaces : c.spaces ? [c.spaces] : [];
  const cqlList = cql
    ? [cql]
    : Array.isArray(c.cql)
      ? c.cql
      : c.cql
        ? [c.cql]
        : spaces.map((s) => `space = "${s}" AND type = page`);
  if (!cqlList.length) {
    throw new Error('no CQL scope: pass --cql or set connectors.confluence.spaces (or connectors.confluence.cql) in kb.json');
  }
  let max = maxResults === undefined ? 200 : Number(maxResults);
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`--max must be a positive integer (got ${JSON.stringify(maxResults)})`);
  }
  return { ...auth, cqlList, max };
}

async function confGet(cfg, pathAndQuery, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(cfg.baseUrl + pathAndQuery, {
    headers: { Authorization: `Bearer ${cfg.pat}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`confluence authentication failed HTTP ${res.status}: check the PAT in env var ${cfg.patEnv}`);
    err.authFailed = true; // every scope would fail identically — callers fail fast
    throw err;
  }
  if (!res.ok) {
    const snippet = await res.text().catch(() => '');
    throw new Error(`confluence request failed HTTP ${res.status}: ${snippet.slice(0, 300)}`);
  }
  return res.json();
}

/** PAT sanity check: GET /rest/api/user/current. */
export async function check(kbConfig, { fetchImpl } = {}) {
  const auth = resolveAuth(kbConfig);
  const me = await confGet(auth, '/rest/api/user/current', fetchImpl);
  return { username: me.username || '', displayName: me.displayName || '', userKey: me.userKey || '' };
}

/** CQL search with start/limit pagination (per-CQL cap = cfg.max).
 *  @returns {pages, total} — total is the server-reported hit count, so the
 *  caller can surface truncation instead of letting it look complete. */
async function searchAll(cfg, cql, fetchImpl, { expand = EXPAND } = {}) {
  const pages = [];
  let start = 0;
  let total = null;
  for (;;) {
    const want = Math.min(PAGE_SIZE, cfg.max - pages.length);
    if (want <= 0) break;
    const q = new URLSearchParams({
      cql, start: String(start), limit: String(want), expand,
    });
    const data = await confGet(cfg, `/rest/api/content/search?${q}`, fetchImpl);
    const batch = data.results || [];
    pages.push(...batch);
    total = data.totalSize ?? pages.length;
    if (batch.length < want || pages.length >= total) break;
    start += batch.length;
  }
  return { pages, total: total ?? pages.length };
}

/**
 * Detect upstream changes without writing raw/. Reuses CQL scopes and auth.
 * @returns summary {new, changed, unchanged, removed_upstream, errors}
 */
export async function detect(kbRoot, { kbConfig, cql, maxResults, fetchImpl } = {}) {
  const cfg = resolveConfig(kbConfig, { cql, maxResults });
  const result = { new: [], changed: [], unchanged: [], removed_upstream: [], errors: [] };
  const local = loadLocalBySource(kbRoot, 'confluence');
  const upstream = new Map();

  for (const scope of cfg.cqlList) {
    let res;
    try {
      // detect only needs id + version.when + title — body.storage (the full
      // XHTML payload in EXPAND) would ride along for nothing.
      res = await searchAll(cfg, scope, fetchImpl, { expand: 'version' });
    } catch (err) {
      if (err.authFailed) throw err;
      result.errors.push({ cql: scope, error: err.message });
      continue;
    }
    for (const page of res.pages) {
      const id = String(page?.id || '');
      if (!id || !SAFE_SOURCE_ID.test(id)) continue;
      const version = normalizeConfluenceDate(page.version?.when);
      upstream.set(id, { id, upstream_id: id, version, title: page.title || '' });
    }
  }

  for (const [id, item] of upstream) {
    const cls = classify(id, item.version, local);
    if (cls === 'new') result.new.push(item);
    else if (cls === 'changed') result.changed.push({ ...item, path: local.get(id).path, local_version: local.get(id).version });
    else result.unchanged.push({ ...item, path: local.get(id).path });
  }

  for (const [id, localItem] of local) {
    if (!upstream.has(id)) {
      result.removed_upstream.push({ path: localItem.path, source_id: id, upstream_id: id, title: localItem.title });
    }
  }
  return result;
}

/**
 * Pull every configured CQL scope into raw/confluence/<page-id>.md.
 * A page matched by several scopes is written once (id-keyed dedupe).
 * @returns summary {created, updated, unchanged, errors, truncated, total}
 */
export async function run(kbRoot, { kbConfig, cql, maxResults, fetchImpl } = {}) {
  const cfg = resolveConfig(kbConfig, { cql, maxResults });
  const summary = { created: [], updated: [], unchanged: [], errors: [], truncated: [], total: 0 };

  // jira-filter macros resolve against the configured Jira (dynamic import:
  // confluence-only KBs stay decoupled from the jira connector)
  let jira = null;
  if (kbConfig?.connectors?.jira?.base_url) jira = await import('./jira.mjs');
  const jqlCache = new Map(); // one run = one JQL executed once, however many pages embed it
  const macroCounts = {};

  const byId = new Map();
  for (const scope of cfg.cqlList) {
    let res;
    try {
      res = await searchAll(cfg, scope, fetchImpl);
    } catch (err) {
      if (err.authFailed) throw err; // fail fast: every scope would fail identically
      // per-scope failure granularity matches per-page: record and continue
      summary.errors.push({ cql: scope, error: err.message });
      continue;
    }
    if (res.total > res.pages.length) {
      summary.truncated.push({ cql: scope, fetched: res.pages.length, total: res.total });
    }
    for (const page of res.pages) {
      const id = String(page?.id || '');
      if (id && !byId.has(id)) byId.set(id, page);
    }
  }
  summary.total = byId.size;

  for (const [id, page] of byId) {
    if (!SAFE_SOURCE_ID.test(id)) {
      summary.errors.push({ id, error: `non-compliant page id (contract §2): ${id}` });
      continue;
    }
    try {
      const out = {};
      let body = pageToMarkdown(page, cfg.baseUrl, out);
      if (out.pendingMacros?.length) {
        body = await resolveMacros(body, out.pendingMacros, {
          cfg, kbRoot, kbConfig, jira, jqlCache, counts: macroCounts, fetchImpl,
        });
      }
      const result = upsertRawDoc(kbRoot, {
        source: 'confluence',
        sourceId: id,
        fileName: `${id}.md`,
        sourceUrl: pageUrl(page, cfg.baseUrl),
        sourceVersion: normalizeConfluenceDate(page.version?.when),
        title: page.title || '',
        connector: CONNECTOR_ID,
        extra: {
          space: page.space?.key || '',
          version: String(page.version?.number ?? ''),
          labels: (page.metadata?.labels?.results || []).map((l) => l.name || '').join(', '),
          content_type: page.type || 'page',
        },
        contentHash: sha256(body),
        body,
      });
      const rel = result.relPath.replace(/\\/g, '/');
      summary[result.action === 'created' ? 'created' : result.action === 'updated' ? 'updated' : 'unchanged'].push(rel);
      if (result.action !== 'unchanged') {
        appendLog(kbRoot, 'acquire', `confluence:${result.action}`, rel, `id ${id}`);
      }
    } catch (err) {
      summary.errors.push({ id, error: err.message });
    }
  }
  if (Object.values(macroCounts).some((v) => v)) summary.macros = macroCounts;
  return summary;
}
