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

function confFetchRaw(cfg, pathAndQuery, fetchImpl) {
  return confFetchUrl(cfg, cfg.baseUrl + pathAndQuery, fetchImpl);
}

/** Server-provided links are context-path-relative; make them absolute. */
function absolutizeLink(cfg, link) {
  if (/^https?:\/\//i.test(link)) return link;
  return `${cfg.baseUrl}${link.startsWith('/') ? '' : '/'}${link}`;
}

/** Attachment download URL (real-env hardening 2026-08-04): the legacy
 *  /download/attachments/<id>/<name> servlet 404s on some Server/DC
 *  deployments (proxy rules, stored-name ≠ macro name). Resolve through the
 *  REST child/attachment API first — _links.download is the server's own
 *  canonical URL — with fallbacks: a same-extension listing match (the
 *  macro's name param doesn't always equal the stored filename), then the
 *  legacy servlet path. Returns { url, via } — via is value-free and feeds
 *  the --probe diagnostic. */
async function attachmentUrl(cfg, pageId, fileName, fetchImpl) {
  const legacy = { url: `${cfg.baseUrl}/download/attachments/${pageId}/${encodeURIComponent(fileName)}`, via: 'legacy' };
  try {
    const base = `/rest/api/content/${encodeURIComponent(String(pageId))}/child/attachment`;
    const exact = await confGet(cfg, `${base}?${new URLSearchParams({ filename: fileName, limit: '1' })}`, fetchImpl);
    const hit = (exact.results || [])[0];
    if (hit?._links?.download) return { url: absolutizeLink(cfg, hit._links.download), via: 'rest-exact' };
    const dot = fileName.lastIndexOf('.');
    const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
    const wantBase = (dot > 0 ? fileName.slice(0, dot) : fileName).toLowerCase();
    const list = await confGet(cfg, `${base}?${new URLSearchParams({ limit: '200' })}`, fetchImpl);
    const sameExt = (list.results || []).filter((a) => String(a.title || '').toLowerCase().endsWith(ext));
    const pick = sameExt.find((a) => String(a.title || '').toLowerCase().replace(/\.[^.]*$/, '') === wantBase)
      || (sameExt.length === 1 ? sameExt[0] : null);
    if (pick?._links?.download) return { url: absolutizeLink(cfg, pick._links.download), via: 'rest-list' };
  } catch { /* REST lookup itself failed → the legacy path gives the real error */ }
  return legacy;
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
  const dl = async (file) => confFetchUrl(cfg, (await attachmentUrl(cfg, m.pageId, file, fetchImpl)).url, fetchImpl);
  const text = await (await dl(`${base}.gliffy`)).text();
  const labels = parseGliffyLabels(text);
  // the PNG render is best-effort: a missing render must not kill the labels
  let assetRel = '';
  try {
    const buf = Buffer.from(await (await dl(`${base}.png`)).arrayBuffer());
    assetRel = writeAsset(kbRoot, m.pageId, `${safeFileName(base)}.png`, buf);
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
 *  page's first .gliffy attachment and report its structure — never values. */
export async function probeGliffy(kbConfig, pageId, { fetchImpl } = {}) {
  if (!pageId || !String(pageId).trim()) {
    throw new Error('confluence --probe requires a page id (pick any page containing a Gliffy diagram)');
  }
  const auth = resolveAuth(kbConfig);
  const page = await confGet(auth, `/rest/api/content/${encodeURIComponent(String(pageId))}?expand=body.storage`, fetchImpl);
  const xhtml = page?.body?.storage?.value || '';
  const root = parseStorage(xhtml);
  let name = '';
  const walk = (n) => {
    if (name) return;
    if (n.tag === 'ac:structured-macro' && n.attrs['ac:name'] === 'gliffy') name = macroParam(n, 'name');
    (n.children || []).forEach(walk);
  };
  walk(root);
  const base = name.replace(/\.(gliffy|png|svg|jpe?g)$/i, '');
  if (!base) return { probe: true, page: String(pageId), note: 'no-gliffy-macro' };
  try {
    const resolved = await attachmentUrl(auth, pageId, `${base}.gliffy`, fetchImpl);
    const text = await (await confFetchUrl(auth, resolved.url, fetchImpl)).text();
    let g;
    let jsonValid = true;
    try { g = JSON.parse(text); } catch { jsonValid = false; }
    const objects = g?.stage?.objects;
    let labelCount = 0;
    if (jsonValid && Array.isArray(objects)) {
      try { labelCount = parseGliffyLabels(text).length; } catch { /* counted as 0 */ }
    }
    return {
      probe: true,
      page: String(pageId),
      gliffy: {
        http: 200,
        via: resolved.via,
        jsonValid,
        hasStageObjects: Array.isArray(objects),
        objectCount: Array.isArray(objects) ? objects.length : null,
        labelCount,
      },
    };
  } catch (err) {
    return { probe: true, page: String(pageId), gliffy: { http: err.status || 0, error: 'download failed' } };
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
async function searchAll(cfg, cql, fetchImpl) {
  const pages = [];
  let start = 0;
  let total = null;
  for (;;) {
    const want = Math.min(PAGE_SIZE, cfg.max - pages.length);
    if (want <= 0) break;
    const q = new URLSearchParams({
      cql, start: String(start), limit: String(want), expand: EXPAND,
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
