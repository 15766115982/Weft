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
import { upsertRawDoc, sha256 } from '../lib/rawdoc.mjs';
import { appendLog } from '../lib/log.mjs';

export const CONNECTOR_ID = 'confluence@1.0.0';

const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPAND = 'body.storage,version,space,metadata.labels,ancestors';
// contract §2: source/source_id are spliced into wiki paths, so they are
// whitelisted; a non-compliant page id is skipped with an error, never escaped
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Confluence emits ISO offsets (with or without colon); normalize to Z.
 *  Unparseable values pass through unchanged (kept visible, not invented). */
export function normalizeConfluenceDate(s) {
  if (!s) return '';
  const fixed = String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString();
}

// ---------------------------------------------------------------------------
// storage XHTML -> markdown (minimal, hand-rolled: zero new dependencies)
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'img', 'hr', 'col', 'input', 'link', 'meta']);

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must run last
}

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
    const quoted = inner.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    return `\n\n> **${label}:**\n${quoted}\n\n`;
  }
  if (name === 'toc') return ''; // navigation chrome, not content
  if (name === 'status') {
    const title = (findChild(node, 'ac:parameter', 'ac:name', 'title')?.children || [])
      .map((c) => c.text || '').join('').trim();
    return `[status: ${title}]`;
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
      return `\n\n${'#'.repeat(Number(tag[1]))} ${renderInline(children, ctx)}\n\n`;
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
      return `\n\n${inner.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n`;
    }
    case 'ul': case 'ol': {
      const items = children.filter((c) => c.tag === 'li');
      const lines = items.map((li, i) => {
        const marker = tag === 'ol' ? `${i + 1}. ` : '- ';
        const inner = renderNodes(li.children, { ...ctx, depth: ctx.depth + 1 }).trim();
        const indent = '  '.repeat(ctx.depth);
        const body = inner.split('\n').map((l, k) => (k === 0 ? l : `${indent}  ${l}`)).join('\n');
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

/** Storage-format XHTML -> markdown (minimal fidelity, declared). */
export function storageToMarkdown(xhtml, baseUrl = '') {
  const root = parseStorage(String(xhtml || ''));
  const md = renderNodes(root.children, { depth: 0, baseUrl });
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
 *  text keeps its source language — raw/ is the evidence layer). */
export function pageToMarkdown(page, baseUrl) {
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

  const body = storageToMarkdown(page.body?.storage?.value || '', baseUrl);
  return head.join('\n') + (body || '(empty page)') + '\n';
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
  return { baseUrl: String(c.base_url).replace(/\/+$/, ''), pat, patEnv, confConf: c };
}

function resolveConfig(kbConfig, { cql, maxResults } = {}) {
  const auth = resolveAuth(kbConfig);
  const c = auth.confConf;
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
      const body = pageToMarkdown(page, cfg.baseUrl);
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
  return summary;
}
