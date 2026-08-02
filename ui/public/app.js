// app.js — frame: hash router, header (KB switcher / theme / stale), statusbar,
// Ctrl+K palette, global hotkeys. Kernel discipline (P2-1): wiring only;
// DOM construction in views/ via lib/render.js. Kernel budget: <600 lines.
import { api, setKb, getKb } from './lib/api.js';
import { el, html } from './lib/render.js';
import { icon } from './lib/icons.js';
import { openPalette } from './lib/palette.js';
import { render as dashboardView } from './views/dashboard.js';
import { render as browseView } from './views/browse.js';
import { render as searchView } from './views/search.js';
import { render as queueView } from './views/queue.js';
import { render as acquireView } from './views/acquire.js';

const ROUTES = {
  dashboard: dashboardView, browse: browseView, page: browseView,
  search: searchView, queue: queueView, acquire: acquireView,
};
let pageCache = { kb: null, pages: [] };
let currentRoute = 'dashboard';

// ---- shortcuts help overlay (P1-2) ----

const SHORTCUTS = [
  ['Ctrl K / ⌘ K', '命令面板(搜页面 / 动作)'],
  ['g d / g b / g s / g q / g a', '前往 总览 / 浏览 / 检索 / 评审 / 采集'],
  ['g t', '切换暗色 / 亮色'],
  ['/', '聚焦搜索框(检索页)/ 命令面板(其他页)'],
  ['j k 或 [ ]', '评审队列:上 / 下一条'],
  ['a / r', '评审队列:批准 / 拒绝'],
  ['Esc', '关闭浮层 / 清空树过滤'],
  ['?', '本帮助'],
];

function showShortcuts() {
  const mask = el('div', { class: 'cmdk-mask' });
  const box = el('div', { class: 'cmdk', style: 'padding:18px 22px; max-width:460px' });
  box.append(el('h3', { style: 'margin:0 0 10px' }, '键盘快捷键'));
  const table = el('div');
  for (const [key, desc] of SHORTCUTS) {
    const row = el('div', { style: 'display:flex;gap:14px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13px' });
    const k = el('span', { style: 'flex:none;min-width:150px' });
    html(k, key.split(' / ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' '));
    row.append(k, el('span', { class: 'dim' }, desc));
    table.append(row);
  }
  box.append(table, el('p', { class: 'dim', style: 'font-size:12px;margin:10px 0 0' }, 'Esc 关闭'));
  mask.append(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  function close() { mask.remove(); document.removeEventListener('keydown', onKey, true); }
  document.addEventListener('keydown', onKey, true);
  document.body.append(mask);
}

function parseHash() {
  const raw = location.hash.slice(2) || 'dashboard';
  const [route, qs] = raw.split('?');
  return { route: ROUTES[route] ? route : 'dashboard', params: new URLSearchParams(qs || '') };
}

async function mount() {
  const { route, params } = parseHash();
  hotkeys.setScope('all'); // route change kills any view-scoped bindings (P0-2)
  currentRoute = route;
  const loader = document.getElementById('route-loader');
  loader.classList.add('on');
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.dataset.route === (route === 'page' ? 'browse' : route));
  }
  const view = document.getElementById('view');
  view.textContent = '';
  try {
    await ROUTES[route](view, params);
  } catch (err) {
    view.append(el('pre', { class: 'error' }, err.message));
  } finally {
    loader.classList.remove('on');
  }
  tippy('[title]', { delay: [300, 0], placement: 'bottom' });
}

// ---- header / statusbar ----

async function initHeader() {
  html(document.getElementById('brand-icon'), icon('library', 19));
  for (const s of document.querySelectorAll('[data-ic]')) html(s, icon(s.dataset.ic, 15));
  html(document.getElementById('stale-banner'), `${icon('circleAlert', 14)} 待治理`);

  const { kbs } = await api('/api/kbs');
  const select = document.getElementById('kb-select');
  for (const k of kbs) {
    const opt = el('option', { value: k.name }, k.name + (k.exists ? '' : ' (缺失)'));
    if (!k.exists) opt.disabled = true;
    select.append(opt);
  }
  const saved = localStorage.getItem('ui.kb');
  const initial = kbs.find((k) => k.name === saved && k.exists) || kbs.find((k) => k.exists);
  if (initial) {
    select.value = initial.name;
    setKb(initial.name);
    document.getElementById('sb-kb').textContent = initial.path;
  }
  select.addEventListener('change', () => {
    setKb(select.value);
    localStorage.setItem('ui.kb', select.value);
    document.getElementById('sb-kb').textContent = kbs.find((k) => k.name === select.value)?.path || '';
    pageCache = { kb: null, pages: [] };
    refreshHeader();
    mount();
  });

  const savedTheme = localStorage.getItem('ui.theme');
  const dark = savedTheme ? savedTheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.getElementById('cmdk-btn').addEventListener('click', showPalette);
  document.getElementById('sb-help').addEventListener('click', (e) => { e.preventDefault(); showShortcuts(); });
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('ui.theme', dark ? 'dark' : 'light');
  html(document.getElementById('theme-toggle'), icon(dark ? 'sun' : 'moon', 16));
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme !== 'dark'); }

async function refreshHeader() {
  try {
    const h = await api('/api/health');
    document.getElementById('stale-banner').hidden = !h.stale;
    const qc = document.getElementById('queue-count');
    qc.hidden = h.plan.review_queue === 0;
    qc.textContent = h.plan.review_queue;
    document.getElementById('sb-pages').textContent =
      `${h.pages.total} pages · ${h.pages.byStatus.approved || 0} approved · ${h.plan.review_queue} 待审`;
  } catch { /* header degrades silently; the view surfaces errors */ }
}

// ---- command palette ----

async function paletteItems() {
  if (pageCache.kb !== getKb()) {
    pageCache = { kb: getKb(), pages: (await api('/api/tree')).pages };
  }
  const actions = [
    { icon: 'layoutDashboard', label: '前往:总览', hint: 'g d', go: '#/dashboard' },
    { icon: 'library', label: '前往:浏览', hint: 'g b', go: '#/browse' },
    { icon: 'search', label: '前往:检索', hint: 'g s', go: '#/search' },
    { icon: 'listChecks', label: '前往:评审队列', hint: 'g q', go: '#/queue' },
    { icon: 'inbox', label: '前往:采集控制台', hint: 'g a', go: '#/acquire' },
    { icon: 'keyboard', label: '键盘快捷键', hint: '?', action: showShortcuts },
    { icon: 'moon', label: '切换暗色 / 亮色', hint: 'g t', action: toggleTheme },
  ];
  const pages = pageCache.pages.map((p) => ({
    icon: p.status === 'candidate' ? 'circleAlert' : 'fileText',
    label: p.title, hint: p.path.replace('wiki/', ''),
    go: `#/page?path=${encodeURIComponent(p.path)}`,
  }));
  return [...actions, ...pages];
}

function showPalette() {
  openPalette({
    getItems: paletteItems,
    onPick: (item) => { if (item.action) item.action(); else if (item.go) location.hash = item.go; },
  });
}

// ---- global hotkeys (I2) ----

hotkeys('ctrl+k,command+k', (e) => { e.preventDefault(); showPalette(); });
hotkeys('g d', () => { location.hash = '#/dashboard'; });
hotkeys('g b', () => { location.hash = '#/browse'; });
hotkeys('g s', () => { location.hash = '#/search'; });
hotkeys('g q', () => { location.hash = '#/queue'; });
hotkeys('g a', () => { location.hash = '#/acquire'; });
hotkeys('g t', toggleTheme);
hotkeys('g k', () => document.getElementById('kb-select')?.focus()); // P2-3
hotkeys('shift+/', (e) => { e.preventDefault(); showShortcuts(); }); // "?" (P1-2)
hotkeys('/', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  // P2: on the search view, '/' focuses the search box (site convention);
  // elsewhere it opens the palette.
  if (currentRoute === 'search') document.querySelector('.searchbar input')?.focus();
  else showPalette();
});

window.addEventListener('hashchange', mount);
window.addEventListener('ui:refresh-header', refreshHeader); // P2-1: views signal writes
window.addEventListener('ui:remount', mount); // M7b: views ask for a full re-render after queued writes
document.getElementById('hdr-refresh').addEventListener('click', () => { refreshHeader(); mount(); });

// J3 (M7b): SSE event stream replaces polling as the primary freshness signal.
// 'change' → KB files changed on disk (fs.watch, .kb/ excluded, debounced);
// 'job' → queue lifecycle. Views opt in via window events; the header always
// refreshes. The 30s poll below stays as the SSE-down fallback.
// I6 job indicator (M7b review P3): queued/running count in the header, red
// dot for a recent failure — makes the job center visible from every view.
const activeJobs = new Set();
let recentFail = false;
function syncJobIndicator() {
  const btn = document.getElementById('job-indicator');
  const active = activeJobs.size > 0;
  btn.hidden = !active && !recentFail;
  btn.classList.toggle('failed', !active && recentFail);
  html(btn, active ? `${icon('activity', 14)} ${activeJobs.size}` : icon('circleAlert', 14));
  btn.title = active ? `${activeJobs.size} 个作业运行中 — 点击去作业中心` : '有作业失败 — 点击去作业中心';
}
function trackJob(job) {
  if (job.status === 'queued' || job.status === 'running') { activeJobs.add(job.id); recentFail = false; }
  else { activeJobs.delete(job.id); if (job.status === 'failed') recentFail = true; }
  syncJobIndicator();
}

let events;
function connectEvents() {
  events?.close();
  const qs = getKb() ? `?kb=${encodeURIComponent(getKb())}` : '';
  events = new EventSource('/api/events' + qs);
  events.addEventListener('change', () => {
    refreshHeader();
    window.dispatchEvent(new CustomEvent('ui:kb-change'));
  });
  events.addEventListener('job', (e) => {
    trackJob(JSON.parse(e.data));
    refreshHeader();
    window.dispatchEvent(new CustomEvent('ui:job', { detail: JSON.parse(e.data) }));
  });
}
document.getElementById('job-indicator').addEventListener('click', () => {
  recentFail = false;
  syncJobIndicator();
  location.hash = '#/acquire';
});
setInterval(() => { if (!document.hidden) refreshHeader(); }, 30_000);
await initHeader();
// seed the indicator from persisted history (jobs finished while we were away)
api('/api/jobs').then(({ jobs }) => {
  for (const j of jobs) if (j.status === 'queued' || j.status === 'running') activeJobs.add(j.id);
  if (jobs.some((j) => j.status === 'failed' && Date.now() - new Date(j.finishedAt) < 3600_000)) recentFail = true;
  syncJobIndicator();
}).catch(() => {});
connectEvents();
// KB switch re-targets the stream (the watcher is per-KB server-side)
document.getElementById('kb-select').addEventListener('change', connectEvents);
await refreshHeader();
if (!location.hash) location.hash = '#/dashboard';
await mount();
