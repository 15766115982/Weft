// Settings page controller.
const kb = new URLSearchParams(location.search).get('kb') || '';

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const url = `/api${path}${path.includes('?') ? '&' : '?'}kb=${encodeURIComponent(kb)}`;
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-ui-token': document.querySelector('meta[name="ui-token"]')?.content || '' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function log(text) {
  const el = $('#action-log code');
  el.textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
}

async function loadSettings() {
  const { ok, data } = await api('/settings');
  if (!ok) {
    $('#config-display code').textContent = `Failed to load settings: ${data.error || 'unknown'}`;
    return;
  }
  $('#config-display code').textContent = data.config ? JSON.stringify(data.config, null, 2) : 'No .kb/config/models.json found.';

  const envList = $('#env-list');
  envList.innerHTML = '';
  for (const [k, v] of Object.entries(data.env || {})) {
    const li = document.createElement('li');
    li.textContent = `${k}: ${v ? '✅ set' : '❌ not set'}`;
    envList.appendChild(li);
  }

  const promptsList = $('#prompts-list');
  promptsList.innerHTML = '';
  const prompts = data.prompts || [];
  if (!prompts.length) {
    promptsList.appendChild(el('li', { class: 'dim' }, 'No prompts found. Run “Init default prompts” to seed .kb/config/prompts/.'));
  } else {
    for (const p of prompts) {
      promptsList.appendChild(el('li', {}, `${p.title} (${p.file}, ${p.size} bytes)`));
    }
  }
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function runJob(path, body = {}) {
  log(`POST ${path} ...`);
  const { ok, data } = await api(path, { method: 'POST', body: JSON.stringify(body) });
  if (!ok) {
    log(`ERROR ${data.error || 'unknown'}`);
    return;
  }
  log(`queued job ${data.job.id} (${data.job.status})`);
  pollJob(data.job.id);
}

async function pollJob(id) {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`/api/jobs?kb=${encodeURIComponent(kb)}`, { credentials: 'same-origin' });
    const data = await res.json();
    const job = data.jobs.find((j) => j.id === id);
    if (!job) continue;
    if (job.status === 'done') {
      log(`job ${id} done: ${JSON.stringify(job.result)}`);
      return;
    }
    if (job.status === 'failed') {
      log(`job ${id} failed: ${job.error}`);
      return;
    }
  }
  log(`job ${id} polling timed out`);
}

$('#btn-check').addEventListener('click', () => runJob('/settings/check'));
$('#btn-init-prompts').addEventListener('click', () => runJob('/settings/init-prompts'));
$('#btn-init-force').addEventListener('click', () => runJob('/settings/init-prompts', { force: true }));

loadSettings();
