// Settings page controller: editable models.json form + prompt inline editor.
const kb = new URLSearchParams(location.search).get('kb') || '';
const TOKEN = document.querySelector('meta[name="ui-token"]')?.content || '';

const $ = (sel) => document.querySelector(sel);

async function api(path, opts = {}) {
  const url = `/api${path}${path.includes('?') ? '&' : '?'}kb=${encodeURIComponent(kb)}`;
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', 'x-ui-token': TOKEN },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- form state ----

let original = null; // last-loaded config, for dirty tracking + discard

const F = {
  endpoint: $('#f-endpoint'), deployment: $('#f-deployment'), model: $('#f-model'),
  apiVersion: $('#f-api-version'), authType: $('#f-auth-type'), apiKey: $('#f-api-key'),
  tenant: $('#f-tenant'), clientId: $('#f-client-id'), clientSecret: $('#f-client-secret'),
  temperature: $('#f-temperature'), maxTokens: $('#f-max-tokens'),
};

function provider() {
  return document.querySelector('input[name="provider"]:checked')?.value || 'azure';
}

function readForm() {
  const p = provider();
  const config = {
    provider: p,
    endpoint: F.endpoint.value.trim(),
    defaults: {},
  };
  if (p === 'azure') {
    config.deployment = F.deployment.value.trim();
    if (F.apiVersion.value.trim()) config.api_version = F.apiVersion.value.trim();
  } else {
    config.model = F.model.value.trim();
  }
  const type = F.authType.value;
  config.auth = { type };
  if (type === 'api_key') {
    config.auth.api_key = F.apiKey.value.trim();
  } else {
    config.auth.tenant_id = F.tenant.value.trim();
    config.auth.client_id = F.clientId.value.trim();
    config.auth.client_secret = F.clientSecret.value.trim();
  }
  if (F.temperature.value !== '') config.defaults.temperature = Number(F.temperature.value);
  if (F.maxTokens.value !== '') config.defaults.max_tokens = Number(F.maxTokens.value);
  if (!Object.keys(config.defaults).length) delete config.defaults;
  return config;
}

function writeForm(config) {
  const c = config || { provider: 'azure', auth: { type: 'api_key' }, defaults: {} };
  const p = c.provider || 'azure';
  document.querySelector(`input[name="provider"][value="${p}"]`).checked = true;
  F.endpoint.value = c.endpoint || '';
  F.deployment.value = c.deployment || '';
  F.model.value = c.model || '';
  F.apiVersion.value = c.api_version || '';
  F.authType.value = c.auth?.type || 'api_key';
  F.apiKey.value = c.auth?.api_key || '';
  F.tenant.value = c.auth?.tenant_id || '';
  F.clientId.value = c.auth?.client_id || '';
  F.clientSecret.value = c.auth?.client_secret || '';
  F.temperature.value = c.defaults?.temperature ?? '';
  F.maxTokens.value = c.defaults?.max_tokens ?? '';
  syncVisibility();
}

// Show only the fields the current provider/auth choices need.
function syncVisibility() {
  const p = provider();
  $('#wrap-deployment').hidden = p !== 'azure';
  $('#wrap-api-version').hidden = p !== 'azure';
  $('#wrap-model').hidden = p !== 'openai';
  $('#hint-endpoint').textContent = p === 'azure'
    ? 'Azure 资源根地址,如 https://your-resource.openai.azure.com — 部署名和 API 版本会自动拼上。'
    : '兼容接口的 base URL,如 https://api.moonshot.cn/v1 — /chat/completions 会自动拼上。';
  $('#hint-api-key').innerHTML = p === 'azure'
    ? '例:设为 <code>AZURE_OPENAI_API_KEY</code> 后,在系统里 <code>setx AZURE_OPENAI_API_KEY "…"</code> 并重启门户。'
    : '例:设为 <code>WEFT_LLM_API_KEY</code> 后,在系统里 <code>setx WEFT_LLM_API_KEY "sk-…"</code> 并重启门户。';
  const isKey = F.authType.value === 'api_key';
  $('#wrap-api-key').hidden = !isKey;
  $('#wrap-spn').hidden = isKey;
  for (const card of document.querySelectorAll('.provider-card')) {
    card.classList.toggle('on', card.dataset.provider === p);
  }
  markDirty();
}

function isDirty() {
  return original !== null && JSON.stringify(readForm()) !== JSON.stringify(original);
}

function markDirty() {
  $('#save-bar').hidden = !isDirty();
}

function envBadge(id, name, env) {
  const el = $(id);
  if (!name) { el.textContent = ''; return; }
  const set = env?.[name];
  el.textContent = set ? '✓ 已设置' : '✗ 未设置';
  el.className = `env-badge ${set ? 'ok' : 'missing'}`;
}

async function loadSettings() {
  const { ok, data } = await api('/settings');
  if (!ok) {
    log(`加载失败: ${data.error || 'unknown'}`);
    return;
  }
  original = data.config;
  writeForm(data.config || undefined);
  // Baseline is the NORMALIZED form state, not the raw file — otherwise shape
  // normalization (dropped optional fields, key order) shows a phantom dirty
  // bar before the user touches anything.
  original = readForm();
  if (!data.config) {
    log('还没有 models.json — 填好表单点"保存 models.json"即创建,或到"工具"里重置模板。');
  }
  renderPrompts(data.prompts || []);
  // env badges track the currently-typed var names
  const updateBadges = () => {
    envBadge('#env-api-key', F.apiKey.value.trim(), data.env);
    envBadge('#env-client-secret', F.clientSecret.value.trim(), data.env);
  };
  F.apiKey.addEventListener('input', updateBadges);
  F.clientSecret.addEventListener('input', updateBadges);
  updateBadges();
  markDirty();
}

// ---- save / discard ----

$('#btn-save').addEventListener('click', async () => {
  const btn = $('#btn-save');
  btn.disabled = true;
  $('#save-note').textContent = '保存中…';
  const { ok, data } = await api('/settings/config', {
    method: 'POST', body: JSON.stringify({ config: readForm() }),
  });
  btn.disabled = false;
  if (!ok) {
    $('#save-note').textContent = `保存失败: ${data.error || 'unknown'}`;
    return;
  }
  original = readForm();
  markDirty();
  $('#save-note').textContent = '✓ 已保存(旧文件备份为 models.json.bak)';
  setTimeout(() => { if (!isDirty()) $('#save-bar').hidden = true; }, 2200);
});

$('#btn-discard').addEventListener('click', () => writeForm(original));

for (const input of document.querySelectorAll('.settings input, .settings select')) {
  input.addEventListener('input', markDirty);
  input.addEventListener('change', syncVisibility);
}

// ---- prompts: accordion inline editor ----

function renderPrompts(prompts) {
  const list = $('#prompts-list');
  list.textContent = '';
  if (!prompts.length) {
    list.append(el('p', { class: 'dim' }, '还没有 prompt 文件 — 点下方"补全默认 prompts"生成。'));
    return;
  }
  for (const p of prompts) {
    const det = document.createElement('details');
    det.className = 'prompt-item';
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="t">${esc(p.title)}</span><span class="dim">${esc(p.file)} · ${p.size} B</span>`;
    det.append(sum);
    const body = el('div', { class: 'prompt-body' });
    det.append(body);
    det.addEventListener('toggle', async () => {
      if (!det.open || det.dataset.loaded) return;
      det.dataset.loaded = '1';
      const { ok, data } = await api(`/settings/prompt?file=${encodeURIComponent(p.file)}`);
      if (!ok) { body.append(el('p', { class: 'dim' }, `加载失败: ${data.error}`)); return; }
      const ta = el('textarea', { class: 'prompt-editor', rows: '10', spellcheck: 'false' });
      ta.value = data.body;
      const row = el('div', { class: 'prompt-actions' });
      const save = el('button', { class: 'primary sm' }, '保存');
      const note = el('span', { class: 'dim save-note' });
      save.addEventListener('click', async () => {
        save.disabled = true;
        const r = await api('/settings/prompt', {
          method: 'POST', body: JSON.stringify({ file: p.file, body: ta.value }),
        });
        save.disabled = false;
        note.textContent = r.ok ? '✓ 已保存,下次任务生效' : `保存失败: ${r.data.error}`;
        setTimeout(() => { note.textContent = ''; }, 2500);
      });
      row.append(save, note);
      body.append(ta, row);
    });
    list.append(det);
  }
}

// ---- tools ----

function log(text) {
  const box = $('#action-log');
  box.hidden = false;
  box.querySelector('code').textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
  box.scrollTop = box.scrollHeight;
}

async function runJob(path, body = {}) {
  log(`POST ${path} …`);
  const { ok, data } = await api(path, { method: 'POST', body: JSON.stringify(body) });
  if (!ok) { log(`ERROR ${data.error || 'unknown'}`); return; }
  log(`queued job ${data.job.id} (${data.job.status})`);
  pollJob(data.job.id);
}

async function pollJob(id) {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await api('/jobs');
    const job = (data.jobs || []).find((j) => j.id === id);
    if (!job) continue;
    if (job.status === 'done') { log(`job ${id} done: ${JSON.stringify(job.result)}`); return; }
    if (job.status === 'failed') { log(`job ${id} failed: ${job.error}`); return; }
  }
  log(`job ${id} polling timed out`);
}

$('#btn-check').addEventListener('click', () => runJob('/settings/check'));
$('#btn-init-prompts').addEventListener('click', () => runJob('/settings/init-prompts'));
$('#btn-init-config').addEventListener('click', () => runJob('/settings/init-config', { provider: provider(), force: true }));

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

loadSettings();
