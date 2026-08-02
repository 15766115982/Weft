// api.js — the ONLY request exit for views (P1 discipline). Automatically
// appends the current ?kb= and, for writes, the per-startup token (S8).
const TOKEN = document.querySelector('meta[name="ui-token"]')?.content || '';
let currentKb = '';

export function setKb(name) { currentKb = name || ''; }
export function getKb() { return currentKb; }

function withKb(params) {
  const p = new URLSearchParams(params || {});
  if (currentKb && !p.has('kb')) p.set('kb', currentKb);
  return p;
}

async function unwrap(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function api(path, params) {
  const qs = withKb(params).toString();
  return unwrap(await fetch(path + (qs ? `?${qs}` : '')));
}

export async function apiPost(path, body) {
  return unwrap(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ui-token': TOKEN },
    body: JSON.stringify({ ...body, kb: currentKb }),
  }));
}
