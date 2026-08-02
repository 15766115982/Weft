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

// E1 upload: raw bytes, no multipart; the filename rides in X-Filename
// (encodeURIComponent — CJK names survive latin1-only headers).
export async function apiUpload(file) {
  const qs = withKb().toString();
  return unwrap(await fetch('/api/upload' + (qs ? `?${qs}` : ''), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-ui-token': TOKEN, 'x-filename': encodeURIComponent(file.name) },
    body: file,
  }));
}

// Poll a queued job to completion (M7b ops are 202 + job record). Rejects
// with the job's error so callers can surface it in place.
export async function waitJob(id, { timeout = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const { jobs } = await api('/api/jobs');
    const job = jobs.find((j) => j.id === id);
    if (job && job.status === 'done') return job;
    if (job && job.status === 'failed') throw new Error(job.error || 'job failed');
    if (Date.now() - t0 > timeout) throw new Error('作业仍在队列中执行,进展见采集页作业中心');
    await new Promise((r) => setTimeout(r, 300));
  }
}
