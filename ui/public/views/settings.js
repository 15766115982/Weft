// views/settings.js — SPA settings (2026-08-08; replaces standalone
// views/settings.html). Left section rail + right panel, hash deep-linkable
// via #/settings?sec=<id>. All writes go through /api/settings/* with the
// portal token (lib/api.js apiPost).
import { api, apiPost, waitJob, getKb } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

const SECTIONS = [
  { id: 'llm', label: '模型', icon: 'layers', desc: 'LLM 接入、认证与生成参数' },
  { id: 'prompts', label: 'Prompts', icon: 'fileText', desc: '各任务的提示词模板' },
  { id: 'kb', label: '知识库', icon: 'database', desc: '已注册的 KB 与切换' },
  { id: 'appearance', label: '外观', icon: 'moon', desc: '亮色 / 暗色 / 跟随系统' },
  { id: 'about', label: '关于', icon: 'circleHelp', desc: '门户信息与快捷键' },
];

// Unsaved-LLM-form guard: switching sections remounts the view (hashchange),
// so warn before silently dropping edits.
let llmDirty = false;

export async function render(view, params) {
  llmDirty = false;
  const sec = SECTIONS.some((s) => s.id === params.get('sec')) ? params.get('sec') : 'llm';

  const shell = el('div', { class: 'settings-shell' });
  const nav = el('aside', { class: 'settings-nav' });
  const panel = el('div', { class: 'settings-panel' });
  shell.append(nav, panel);
  view.append(shell);

  const head = el('div', { class: 'settings-nav-head' });
  head.append(el('h1', {}, '设置'), el('p', { class: 'dim' }, '配置存于 KB 的 .kb/config/,secrets 只走环境变量。'));
  nav.append(head);

  for (const s of SECTIONS) {
    const item = el('a', { class: `settings-nav-item${s.id === sec ? ' on' : ''}`, href: `#/settings?sec=${s.id}` });
    html(item, `${icon(s.icon, 15)}<span class="t">${esc(s.label)}</span><span class="d">${esc(s.desc)}</span>`);
    item.addEventListener('click', (e) => {
      if (llmDirty && !confirm('模型配置有未保存的修改,离开将丢失。继续?')) e.preventDefault();
    });
    nav.append(item);
  }

  const data = await api('/api/settings').catch((err) => ({ __error: err.message }));
  if (data.__error) {
    panel.append(el('pre', { class: 'error' }, `加载设置失败:${data.__error}`));
    return;
  }

  if (sec === 'llm') renderLlm(panel, data);
  else if (sec === 'prompts') renderPrompts(panel, data);
  else if (sec === 'kb') await renderKb(panel);
  else if (sec === 'appearance') renderAppearance(panel);
  else await renderAbout(panel);
}

/* ============================== LLM ============================== */

function renderLlm(panel, data) {
  let original = null; // normalized baseline for dirty tracking

  const card = (title, note, ...nodes) => {
    const s = el('section', { class: 'set-card' });
    const h = el('h2', {}, title);
    s.append(h);
    if (note) { const p = el('p', { class: 'dim section-note' }); html(p, note); s.append(p); }
    s.append(...nodes);
    return s;
  };
  const field = (labelText, input, hintHtml, wrapId) => {
    const w = el('div', { class: 'field', ...(wrapId ? { id: wrapId } : {}) });
    const lb = el('label', {}, labelText);
    lb.htmlFor = input.id;
    w.append(lb, input);
    if (hintHtml) { const p = el('p', { class: 'hint' }); html(p, hintHtml); w.append(p); }
    return w;
  };
  const input = (id, type, placeholder = '') =>
    el('input', { id, type, placeholder, spellcheck: 'false' });

  // ---- provider cards ----
  const providerCards = el('div', { class: 'provider-cards' });
  for (const [p, name, desc] of [
    ['azure', 'Azure OpenAI', '企业部署。URL 形如 …/openai/deployments/<deployment>,支持 SPN(服务主体)或 api-key 两种认证。'],
    ['openai', 'OpenAI 兼容接口', 'Kimi / DeepSeek / vLLM 等任何 /chat/completions 端点。Bearer api_key 认证,请求带 model 字段。'],
  ]) {
    const c = el('label', { class: 'provider-card', 'data-provider': p });
    const radio = el('input', { type: 'radio', name: 'provider', value: p });
    const strong = el('strong', {}, name);
    const span = el('span', {});
    html(span, desc.replace('/chat/completions', '<code>/chat/completions</code>').replace('model', '<code>model</code>'));
    c.append(radio, strong, span);
    providerCards.append(c);
  }

  // ---- connection fields (same ids as the old page — PW-04 contract) ----
  const endpoint = input('f-endpoint', 'url', 'https://…');
  const deployment = input('f-deployment', 'text', 'gpt-5-4');
  const model = input('f-model', 'text', 'kimi-k2-0711-preview');
  const apiVersion = input('f-api-version', 'text', '2025-01-01-preview');
  const hintEndpoint = el('p', { class: 'hint', id: 'hint-endpoint' });
  const connCard = card('连接', null,
    (() => { const w = el('div', { class: 'field' }); const lb = el('label', {}, 'Endpoint'); lb.htmlFor = 'f-endpoint'; w.append(lb, endpoint, hintEndpoint); return w; })(),
    field('Deployment', deployment, 'Azure 里的部署名 — 拼进请求 URL,决定实际用哪个模型。', 'wrap-deployment'),
    field('Model', model, 'OpenAI 兼容接口的模型名 — 放进请求体的 <code>model</code> 字段。', 'wrap-model'),
    field('API Version(可选)', apiVersion, 'Azure REST API 版本,留空用默认 <code>2025-01-01-preview</code>。', 'wrap-api-version'),
  );

  // ---- auth ----
  const authType = el('select', { id: 'f-auth-type' });
  authType.append(
    el('option', { value: 'api_key' }, 'api_key — 一个密钥环境变量'),
    el('option', { value: 'spn' }, 'spn — Azure 服务主体(tenant + client + secret)'),
  );
  const apiKey = input('f-api-key', 'text', 'WEFT_LLM_API_KEY');
  const tenant = input('f-tenant', 'text');
  const clientId = input('f-client-id', 'text');
  const clientSecret = input('f-client-secret', 'text', 'WEFT_AZURE_CLIENT_SECRET');
  const envApiKey = el('span', { class: 'env-badge', id: 'env-api-key' });
  const envClientSecret = el('span', { class: 'env-badge', id: 'env-client-secret' });
  const hintApiKey = el('p', { class: 'hint', id: 'hint-api-key' });

  const keyField = el('div', { class: 'field', id: 'wrap-api-key' });
  const keyLabel = el('label', {}, 'API Key 环境变量名 ', envApiKey);
  keyLabel.htmlFor = 'f-api-key';
  keyField.append(keyLabel, apiKey, hintApiKey);
  const spnWrap = el('div', { id: 'wrap-spn' });
  const spnSecretLabel = el('label', {}, 'Client Secret 环境变量名 ', envClientSecret);
  spnSecretLabel.htmlFor = 'f-client-secret';
  const spnSecretField = el('div', { class: 'field' });
  spnSecretField.append(spnSecretLabel, clientSecret);
  spnWrap.append(field('Tenant ID', tenant), field('Client ID', clientId), spnSecretField);

  const authCard = card('认证', '密钥本身永远不进配置文件、不进 git — 这里只填<b>环境变量的名字</b>,运行时从 env 读值。',
    field('认证方式', authType), keyField, spnWrap);

  // ---- generation defaults ----
  const temperature = input('f-temperature', 'number');
  temperature.min = '0'; temperature.max = '2'; temperature.step = '0.1';
  const maxTokens = input('f-max-tokens', 'number');
  maxTokens.min = '256'; maxTokens.step = '256';
  const pair = el('div', { class: 'field-pair' });
  pair.append(
    field('Temperature', temperature, '0 = 稳定保守,2 = 发散。治理任务建议 0.1–0.3。'),
    field('Max Tokens', maxTokens, '单次回答的最大长度。深研/综合任务建议 ≥ 4096。'),
  );
  const genCard = card('生成参数', null, pair);

  // ---- tools + action log ----
  const logBox = el('pre', { class: 'action-log', hidden: '' });
  logBox.append(el('code'));
  const log = (text) => {
    logBox.hidden = false;
    logBox.querySelector('code').textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };
  const runTool = async (label, path, body = {}) => {
    log(`${label} …`);
    try {
      const { job } = await apiPost(path, body);
      const done = await waitJob(job.id);
      log(`✓ ${label} 完成:${JSON.stringify(done.result)}`);
    } catch (err) { log(`✗ ${label} 失败:${err.message}`); }
  };
  const btnCheck = el('button', { class: 'sm' }, '检查连通');
  btnCheck.addEventListener('click', () => runTool('llm check', '/api/settings/check'));
  const btnInit = el('button', { class: 'sm' }, '重置 models.json 模板');
  btnInit.addEventListener('click', async () => {
    await runTool('init-config', '/api/settings/init-config', { provider: provider(), force: true });
    await reload();
  });
  const toolGrid = el('div', { class: 'tool-grid' });
  toolGrid.append(
    (() => { const t = el('div', { class: 'tool' }); t.append(btnCheck, el('p', { class: 'hint' }, '用当前保存的配置跑一次真实最小补全,验证 endpoint 与密钥可用。')); return t; })(),
    (() => { const t = el('div', { class: 'tool' }); t.append(btnInit, el('p', { class: 'hint' }, '按当前 provider 重新播种模板 — 会先备份现有文件为 .bak。')); return t; })(),
  );
  const toolCard = card('工具', null, toolGrid, logBox);

  // ---- save bar ----
  const saveNote = el('span', { id: 'save-note' }, '有未保存的修改');
  const btnDiscard = el('button', { class: 'sm', id: 'btn-discard' }, '放弃');
  const btnSave = el('button', { class: 'primary sm', id: 'btn-save' }, '保存 models.json');
  const saveBar = el('div', { class: 'save-bar', id: 'save-bar', hidden: '' });
  saveBar.append(saveNote, btnDiscard, btnSave);

  panel.append(
    card('模型提供方', null, providerCards),
    connCard, authCard, genCard, toolCard, saveBar,
  );

  // ---- form state machine (ported from the standalone page) ----
  function provider() {
    return panel.querySelector('input[name="provider"]:checked')?.value || 'azure';
  }
  function readForm() {
    const p = provider();
    const config = { provider: p, endpoint: endpoint.value.trim(), defaults: {} };
    if (p === 'azure') {
      config.deployment = deployment.value.trim();
      if (apiVersion.value.trim()) config.api_version = apiVersion.value.trim();
    } else {
      config.model = model.value.trim();
    }
    const type = authType.value;
    config.auth = { type };
    if (type === 'api_key') config.auth.api_key = apiKey.value.trim();
    else {
      config.auth.tenant_id = tenant.value.trim();
      config.auth.client_id = clientId.value.trim();
      config.auth.client_secret = clientSecret.value.trim();
    }
    if (temperature.value !== '') config.defaults.temperature = Number(temperature.value);
    if (maxTokens.value !== '') config.defaults.max_tokens = Number(maxTokens.value);
    if (!Object.keys(config.defaults).length) delete config.defaults;
    return config;
  }
  function writeForm(config) {
    const c = config || { provider: 'azure', auth: { type: 'api_key' }, defaults: {} };
    const p = c.provider || 'azure';
    panel.querySelector(`input[name="provider"][value="${p}"]`).checked = true;
    endpoint.value = c.endpoint || '';
    deployment.value = c.deployment || '';
    model.value = c.model || '';
    apiVersion.value = c.api_version || '';
    authType.value = c.auth?.type || 'api_key';
    apiKey.value = c.auth?.api_key || '';
    tenant.value = c.auth?.tenant_id || '';
    clientId.value = c.auth?.client_id || '';
    clientSecret.value = c.auth?.client_secret || '';
    temperature.value = c.defaults?.temperature ?? '';
    maxTokens.value = c.defaults?.max_tokens ?? '';
    syncVisibility();
  }
  function syncVisibility() {
    const p = provider();
    panel.querySelector('#wrap-deployment').hidden = p !== 'azure';
    panel.querySelector('#wrap-api-version').hidden = p !== 'azure';
    panel.querySelector('#wrap-model').hidden = p !== 'openai';
    hintEndpoint.textContent = p === 'azure'
      ? 'Azure 资源根地址,如 https://your-resource.openai.azure.com — 部署名和 API 版本会自动拼上。'
      : '兼容接口的 base URL,如 https://api.kimi.com/coding/v1 — /chat/completions 会自动拼上。';
    html(hintApiKey, p === 'azure'
      ? '例:设为 <code>AZURE_OPENAI_API_KEY</code> 后,在系统里 <code>setx AZURE_OPENAI_API_KEY "…"</code> 并重启门户。'
      : '例:设为 <code>WEFT_LLM_API_KEY</code> 后,在系统里 <code>setx WEFT_LLM_API_KEY "sk-…"</code> 并重启门户。');
    const isKey = authType.value === 'api_key';
    keyField.hidden = !isKey;
    spnWrap.hidden = isKey;
    for (const c of panel.querySelectorAll('.provider-card')) {
      c.classList.toggle('on', c.dataset.provider === p);
    }
    markDirty();
  }
  const isDirty = () => original !== null && JSON.stringify(readForm()) !== JSON.stringify(original);
  function markDirty() {
    llmDirty = isDirty();
    saveBar.hidden = !llmDirty;
  }
  const badge = (badgeEl, name) => {
    if (!name) { badgeEl.textContent = ''; return; }
    const set = data.env?.[name];
    badgeEl.textContent = set ? '✓ 已设置' : '✗ 未设置';
    badgeEl.className = `env-badge ${set ? 'ok' : 'missing'}`;
  };
  async function reload() {
    const fresh = await api('/api/settings').catch(() => null);
    if (fresh?.config) { writeForm(fresh.config); original = readForm(); markDirty(); }
  }

  btnSave.addEventListener('click', async () => {
    btnSave.disabled = true;
    saveNote.textContent = '保存中…';
    try {
      await apiPost('/api/settings/config', { config: readForm() });
      original = readForm();
      markDirty();
      saveNote.textContent = '✓ 已保存(旧文件备份为 models.json.bak)';
      setTimeout(() => { if (!isDirty()) saveBar.hidden = true; }, 2200);
    } catch (err) {
      saveNote.textContent = `保存失败:${err.message}`;
    } finally { btnSave.disabled = false; }
  });
  btnDiscard.addEventListener('click', () => writeForm(original));
  for (const inp of panel.querySelectorAll('input, select')) {
    inp.addEventListener('input', () => { markDirty(); badge(envApiKey, apiKey.value.trim()); badge(envClientSecret, clientSecret.value.trim()); });
    inp.addEventListener('change', syncVisibility);
  }

  writeForm(data.config || undefined);
  // Baseline is the NORMALIZED form state, not the raw file — otherwise shape
  // normalization (dropped optional fields, key order) shows a phantom dirty bar.
  original = readForm();
  markDirty();
  badge(envApiKey, apiKey.value.trim());
  badge(envClientSecret, clientSecret.value.trim());
  if (!data.config) log('还没有 models.json — 填好表单点"保存 models.json"即创建,或用"重置 models.json 模板"播种。');
}

/* ============================== prompts ============================== */

function renderPrompts(panel, data) {
  const cardEl = el('section', { class: 'set-card' });
  const headRow = el('div', { class: 'prompt-head' });
  const h = el('h2', {}, 'Prompts');
  const btnSeed = el('button', { class: 'sm' }, '补全默认 prompts');
  headRow.append(h, btnSeed);
  const note = el('p', { class: 'dim section-note' });
  html(note, '每个 LLM 任务的提示词模板,<code>{{变量}}</code> 会被任务数据替换;改动对下一次任务生效。');
  const logBox = el('pre', { class: 'action-log', hidden: '' });
  logBox.append(el('code'));
  const log = (text) => {
    logBox.hidden = false;
    logBox.querySelector('code').textContent += `${new Date().toLocaleTimeString()} ${text}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };
  btnSeed.addEventListener('click', async () => {
    log('init-prompts …');
    try {
      const { job } = await apiPost('/api/settings/init-prompts', {});
      const done = await waitJob(job.id);
      log(`✓ 完成:${JSON.stringify(done.result)}`);
      location.reload();
    } catch (err) { log(`✗ 失败:${err.message}`); }
  });
  cardEl.append(headRow, note, logBox);

  const prompts = data.prompts || [];
  if (!prompts.length) {
    cardEl.append(el('p', { class: 'dim' }, '还没有 prompt 文件 — 点上方"补全默认 prompts"生成。'));
    panel.append(cardEl);
    return;
  }

  const split = el('div', { class: 'prompt-split' });
  const list = el('div', { class: 'prompt-index' });
  const stage = el('div', { class: 'prompt-stage' });
  split.append(list, stage);
  cardEl.append(split);
  panel.append(cardEl);

  let active = null;
  const open = async (p, item) => {
    if (active === p.file) return;
    active = p.file;
    for (const n of list.querySelectorAll('.prompt-index-item')) n.classList.toggle('on', n === item);
    stage.textContent = '';
    stage.append(el('p', { class: 'dim' }, '加载中…'));
    let body;
    try {
      ({ body } = await api('/api/settings/prompt', { file: p.file }));
    } catch (err) {
      stage.textContent = '';
      stage.append(el('p', { class: 'error' }, `加载失败:${err.message}`));
      return;
    }
    stage.textContent = '';
    const meta = el('div', { class: 'prompt-stage-meta' });
    html(meta, `<b>${esc(p.title)}</b> <span class="dim mono">${esc(p.file)} · ${p.size} B</span>`);
    const ta = el('textarea', { class: 'prompt-editor', rows: '16', spellcheck: 'false' });
    ta.value = body;
    const row = el('div', { class: 'prompt-actions' });
    const save = el('button', { class: 'primary sm' }, '保存');
    const saveNote = el('span', { class: 'dim save-note' });
    ta.addEventListener('input', () => { saveNote.textContent = '未保存'; });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await apiPost('/api/settings/prompt', { file: p.file, body: ta.value });
        saveNote.textContent = '✓ 已保存,下次任务生效';
      } catch (err) { saveNote.textContent = `保存失败:${err.message}`; }
      save.disabled = false;
      setTimeout(() => { saveNote.textContent = ''; }, 2500);
    });
    row.append(save, saveNote);
    stage.append(meta, ta, row);
  };

  for (const p of prompts) {
    const item = el('a', { class: 'prompt-index-item' });
    html(item, `<span class="t">${esc(p.title)}</span><span class="d mono">${esc(p.file)}</span>`);
    item.addEventListener('click', () => open(p, item));
    list.append(item);
  }
  // open the first prompt immediately — an empty stage reads as broken
  list.querySelector('.prompt-index-item')?.click();
}

/* ============================== KB ============================== */

async function renderKb(panel) {
  const { kbs } = await api('/api/kbs');
  const cardEl = el('section', { class: 'set-card' });
  cardEl.append(el('h2', {}, '知识库'));
  const note = el('p', { class: 'dim section-note' });
  html(note, 'KB 注册在门户的 <code>ui/kbs.json</code>(增删请编辑该文件后重启门户)。模型与 prompts 配置是<b>每个 KB 各自</b>的 .kb/config/。');
  cardEl.append(note);

  const grid = el('div', { class: 'kb-grid' });
  for (const k of kbs) {
    const current = k.name === getKb();
    const c = el('div', { class: `kb-card${current ? ' on' : ''}${k.exists ? '' : ' missing'}` });
    const top = el('div', { class: 'kb-card-top' });
    html(top, `${icon('database', 15)}<b>${esc(k.name)}</b>`);
    if (current) { const chip = el('span', { class: 'chip done' }, '当前'); top.append(chip); }
    if (!k.exists) { const chip = el('span', { class: 'chip failed' }, '目录缺失'); top.append(chip); }
    const pathEl = el('div', { class: 'mono dim kb-path' }, k.path);
    c.append(top, pathEl);
    if (!current && k.exists) {
      const btn = el('button', { class: 'sm' }, '切换到此 KB');
      btn.addEventListener('click', () => {
        const select = document.getElementById('kb-select');
        select.value = k.name;
        select.dispatchEvent(new Event('change'));
      });
      c.append(btn);
    }
    grid.append(c);
  }
  cardEl.append(grid);
  panel.append(cardEl);
}

/* ============================== appearance ============================== */

function renderAppearance(panel) {
  const cardEl = el('section', { class: 'set-card' });
  cardEl.append(el('h2', {}, '外观'));
  const saved = localStorage.getItem('ui.theme'); // null = follow system
  const current = saved || 'auto';
  const cards = el('div', { class: 'provider-cards theme-cards' });
  for (const [id, name, desc, ic] of [
    ['auto', '跟随系统', '随操作系统的亮色/暗色设置自动切换。', 'sun'],
    ['light', '亮色', '纸面底色 + 青瓷点缀,默认的档案编排主题。', 'sun'],
    ['dark', '暗色', '低亮度纸张,夜间阅读友好。', 'moon'],
  ]) {
    const c = el('label', { class: `provider-card theme-card${current === id ? ' on' : ''}`, 'data-theme-pref': id });
    html(c, `${icon(ic, 16)}<strong>${esc(name)}</strong><span>${esc(desc)}</span>`);
    c.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('ui:theme-pref', { detail: id }));
      for (const n of cards.querySelectorAll('.theme-card')) n.classList.toggle('on', n === c);
    });
    cards.append(c);
  }
  cardEl.append(cards);
  const note = el('p', { class: 'dim section-note' });
  html(note, '顶栏的月亮/太阳按钮仍然可以在亮色与暗色之间快速切换(等同手动选择,脱离"跟随系统")。');
  cardEl.append(note);
  panel.append(cardEl);
}

/* ============================== about ============================== */

async function renderAbout(panel) {
  const cardEl = el('section', { class: 'set-card' });
  cardEl.append(el('h2', {}, '关于'));
  const { kbs } = await api('/api/kbs').catch(() => ({ kbs: [] }));
  const kb = kbs.find((k) => k.name === getKb());
  const dl = el('dl', { class: 'about-list' });
  const row = (k, v) => { dl.append(el('dt', {}, k), el('dd', { class: 'mono' }, v)); };
  row('门户地址', location.origin);
  row('当前 KB', kb ? `${kb.name} — ${kb.path}` : getKb() || '(未选择)');
  row('写入安全', '每次启动一个写 token + loopback Host 校验;密钥只走环境变量');
  row('数据契约', 'schema/contract.md — 三个服务只通过 KB 目录协作');
  cardEl.append(dl);
  const btnShortcuts = el('button', { class: 'sm' }, '键盘快捷键');
  btnShortcuts.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ui:shortcuts')));
  const actions = el('div', { class: 'about-actions' });
  actions.append(btnShortcuts);
  cardEl.append(actions);
  panel.append(cardEl);
}
