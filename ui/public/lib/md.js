// md.js — markdown rendering: marked + wikilink tokenizer extension.
// Wikilinks render as signature reference chips [[ x ]] (design-plan §1);
// unresolved targets become dashed dead chips. Heading ids + hover anchor
// buttons for section linking. Page set injected via setKnownPages.
import { esc } from './render.js';
import { getKb } from './api.js';

let knownByBase = new Map();

export function setKnownPages(pages) {
  knownByBase = new Map();
  for (const p of pages) {
    const base = p.path.replace(/^wiki\//, '').replace(/\.md$/, '');
    knownByBase.set(base.toLowerCase(), p.path);
    const short = base.split('/').pop().toLowerCase();
    if (!knownByBase.has(short)) knownByBase.set(short, p.path);
    // chat answers cite by page TITLE ([[Payment Gateway Timeout and Retry Policy]])
    // — index titles too or those wikilinks render as dead chips (2026-08-07)
    if (p.title) {
      const t = String(p.title).toLowerCase();
      if (!knownByBase.has(t)) knownByBase.set(t, p.path);
    }
  }
}

export function resolveWikilink(target) {
  const t = target.trim().replace(/\.md$/, '').toLowerCase();
  return knownByBase.get(t) || knownByBase.get(t.split('/').pop()) || null;
}

const wikilinkExt = {
  name: 'wikilink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return undefined;
    return {
      type: 'wikilink', raw: m[0],
      target: m[1].trim(), anchor: (m[2] || '').slice(1),
      display: (m[3] || '').trim(),
    };
  },
  renderer(token) {
    const rel = resolveWikilink(token.target);
    const label = token.display || token.target.split('/').pop();
    if (!rel) return `<span class="ref-dead" title="未解析的链接">[[${esc(token.target)}]]</span>`;
    const anchor = token.anchor ? `&anchor=${encodeURIComponent(token.anchor)}` : '';
    return `<a class="ref" data-preview="${esc(rel)}" href="#/page?path=${encodeURIComponent(rel)}${anchor}"><span class="br">[[</span>${esc(label)}<span class="br">]]</span></a>`;
  },
};

export function slugify(text) {
  return String(text || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

// duplicate heading texts would render duplicate ids — dedupe per document (P3)
let usedIds = new Set();

const renderer = {
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const plain = text.replace(/<[^>]+>/g, '');
    let id = slugify(plain) || 'section';
    for (let n = 2; usedIds.has(id); n++) id = `${slugify(plain)}-${n}`;
    usedIds.add(id);
    const anchor = depth === 2 || depth === 3
      ? `<button class="anchor" data-anchor="${esc(id)}" title="复制小节链接">#</button>` : '';
    return `<h${depth} id="${esc(id)}" data-depth="${depth}">${text}${anchor}</h${depth}>\n`;
  },
  // KB-root-relative sidecar assets (phase 1: ![gliffy: x](raw/confluence/<id>.assets/x.png))
  // route through the portal's gated asset endpoint; everything else untouched.
  image({ href, title, text }) {
    let src = href || '';
    if (/^raw\/[^/]+\/[^/]+\.assets\//.test(src)) {
      const qs = new URLSearchParams({ path: src });
      const kb = getKb();
      if (kb) qs.set('kb', kb);
      src = `/api/raw-asset?${qs}`;
    }
    const t = title ? ` title="${esc(title)}"` : '';
    return `<img src="${esc(src)}" alt="${esc(text || '')}"${t} loading="lazy">`;
  },
};

marked.use({ extensions: [wikilinkExt], renderer });

export function renderMarkdown(text) {
  usedIds = new Set(); // per-document reset
  return marked.parse(text || '', { async: false });
}

export function anchorToId(anchor) {
  return slugify(anchor);
}
