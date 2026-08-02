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

const ROUTES = {
  dashboard: dashboardView, browse: browseView, page: browseView,
  search: searchView, queue: queueView,
};
let pageCache = { kb: null, pages: [] };
let currentRoute = 'dashboard';

// ---- shortcuts help overlay (P1-2) ----

const SHORTCUTS = [
  ['Ctrl K / ⌘ K', '命令面板(搜页面 / 动作)'],
  ['g d / g b / g s / g q', '前往 总览 / 浏览 / 检索 / 评审'],
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
document.getElementById('hdr-refresh').addEventListener('click', () => { refreshHeader(); mount(); });
// J3 transitional (review decision: full fs-watch deferred to M7b): write-refresh
// (above) + 30s health polling (visibility-aware) + manual refresh button
setInterval(() => { if (!document.hidden) refreshHeader(); }, 30_000);
await initHeader();
await refreshHeader();
if (!location.hash) location.hash = '#/dashboard';
await mount();
