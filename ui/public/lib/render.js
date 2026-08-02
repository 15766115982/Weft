// render.js — the ONLY innerHTML exit in the frontend (review P1-5, red line:
// a repo-wide grep for innerHTML must hit only this file). Everything rendered
// from markdown or API data passes DOMPurify here. Wikilinks only ever become
// <a href="#/..."> — the sanitizer config keeps hash routing intact.

const CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  ADD_ATTR: ['target'],
};

export function html(el, rawHtml) {
  el.innerHTML = DOMPurify.sanitize(rawHtml, CONFIG);
  return el;
}

// Text escaping for spots that interpolate plain strings into templates.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// DOM builder for structure that does not need HTML strings.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
