// app.js — frame: hash router, header (KB switcher / theme / stale), statusbar,
// Ctrl+K palette, global hotkeys. Kernel discipline (P2-1): wiring only;
// DOM construction in views/ via lib/render.js. Kernel budget: <600 lines.
import { api, setKb, getKb } from './lib/api.js';
import { el, html, esc } from './lib/render.js';
import { icon } from './lib/icons.js';
import { openPalette } from './lib/palette.js';
import { render as dashboardView } from './views/dashboard.js';
import { render as browseView } from './views/browse.js';
import { render as searchView } from './views/search.js';
import { render as queueView } from './views/queue.js';
import { render as acquireView } from './views/acquire.js';
import { render as governView } from './views/govern.js';
import { render as graphView } from './views/graph.js';
import { render as upstreamView } from './views/upstream.js';
import { render as rawView } from './views/raw.js';

import { render as chatView } from './views/chat.js';

const ROUTES = {
  dashboard: dashboardView, browse: browseView, page: browseView,
  search: searchView, queue: queueView, inbox: queueView, acquire: acquireView, govern: governView,
  graph: graphView, upstream: upstreamView, raw: rawView, chat: chatView,
};
let pageCache = { kb: null, pages: [] };
let currentRoute = 'dashboard';

// ---- shortcuts help overlay (P1-2) ----

const SHORTCUTS = [
  ['Ctrl K / ⌘ K', '命令面板(搜页面 / 动作)'],
  ['g d / g b / g r / g s / g c', '前往 总览 / 浏览 / 图谱 / 检索 / 问答'],
  ['g q / g a / g u / g w / g g', '前往 评审 / 采集 / 上游 / 来源 / 治理 (operator)'],
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

// Route-switch race guard (review 2026-08-04): each mount renders into its own
// staging div. A slow view that resolves after a newer mount has cleared #view
// keeps appending into its detached stage — invisible, and the views' own
// MutationObserver cleanup fires on detachment. The sequence number guards the
// loader and error paint.
let mountSeq = 0;
async function mount() {
  const seq = ++mountSeq;
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
  const stage = el('div');
  view.append(stage);
  try {
    await ROUTES[route](stage, params);
    if (seq !== mountSeq) return; // superseded by a newer navigation mid-flight
  } catch (err) {
    if (seq !== mountSeq) return;
    stage.append(el('pre', { class: 'error' }, err.message));
  } finally {
    if (seq === mountSeq) loader.classList.remove('on');
  }
  tippy('[title]', { delay: [300, 0], placement: 'bottom' });
}

// ---- header / statusbar ----

async function initHeader() {
  html(document.getElementById('brand-icon'), icon('library', 19));
  for (const s of document.querySelectorAll('[data-ic]')) html(s, icon(s.dataset.ic, 15));
  html(document.getElementById('stale-banner'), `${icon('circleAlert', 14)} 待治理`);

  const { kbs } = await api('/api/kbs');
  // D5 (M7c review P2-1): the stale banner is a call-to-action, not a label —
  // click lands on the govern console where the plan preview explains it.
  const stale = document.getElementById('stale-banner');
  stale.style.cursor = 'pointer';
  stale.addEventListener('click', () => { location.hash = '#/govern'; });
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
    { icon: 'network', label: '前往:图谱', hint: 'g r', go: '#/graph' },
    { icon: 'search', label: '前往:检索', hint: 'g s', go: '#/search' },
    { icon: 'messageCircle', label: '前往:问答', hint: 'g c', go: '#/chat' },
    { icon: 'listChecks', label: '前往:评审队列', hint: 'g q', go: '#/queue' },
    { icon: 'inbox', label: '前往:采集控制台', hint: 'g a', go: '#/acquire' },
    { icon: 'search', label: '前往:上游检测', hint: 'g u', go: '#/upstream' },
    { icon: 'folderGit-2', label: '前往:来源管理', hint: 'g w', go: '#/raw' },
    { icon: 'sparkles', label: '前往:治理控制台', hint: 'g g', go: '#/govern' },
  ];
  const utilityActions = [
    { icon: 'keyboard', label: '键盘快捷键', hint: '?', action: showShortcuts },
    { icon: 'moon', label: '切换暗色 / 亮色', hint: 'g t', action: toggleTheme },
  ];
  const pages = pageCache.pages.map((p) => ({
    icon: p.status === 'candidate' ? 'circleAlert' : 'fileText',
    label: p.title, hint: p.path.replace('wiki/', ''),
    go: `#/page?path=${encodeURIComponent(p.path)}`,
  }));
  // Candidates first — they are the actionable pages, and the 12-row cap would
  // otherwise push them below the fold (Playwright P9).
  pages.sort((a, b) => (b.icon === 'circleAlert') - (a.icon === 'circleAlert'));
  // Pages rank above the two utility actions: the palette caps at 12 rows and
  // operators have 10 nav actions, so utility actions last would otherwise push
  // every page out of the unfiltered list (Playwright P9). Shortcuts/theme
  // remain reachable via filter.
  return [...actions, ...pages, ...utilityActions];
}

function showPalette() {
  openPalette({
    getItems: paletteItems,
    onPick: (item) => { if (item.action) item.action(); else if (item.go) location.hash = item.go; },
  });
}

// ---- global hotkeys (I2) ----

hotkeys('ctrl+k,command+k', (e) => { e.preventDefault(); showPalette(); });
hotkeys('shift+/', (e) => { e.preventDefault(); showShortcuts(); }); // "?" (P1-2)

// 'g x' two-key sequences (Gmail-style). hotkeys-js has no sequence support —
// it strips the space and folds every 'g x' combo onto keycode 71, so a single
// 'g' fired all eleven bindings at once (Playwright P10). This layer records
// the leading 'g' and dispatches the second key within a 1s window.
const G_SEQUENCES = {
  d: () => { location.hash = '#/dashboard'; },
  b: () => { location.hash = '#/browse'; },
  r: () => { location.hash = '#/graph'; },
  s: () => { location.hash = '#/search'; },
  c: () => { location.hash = '#/chat'; },
  q: () => { location.hash = '#/queue'; },
  a: () => { location.hash = '#/acquire'; },
  u: () => { location.hash = '#/upstream'; },
  w: () => { location.hash = '#/raw'; },
  g: () => { location.hash = '#/govern'; },
  t: toggleTheme,
  k: () => document.getElementById('kb-select')?.focus(), // P2-3
};
const G_WINDOW_MS = 1000;
let gPendingAt = 0;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) { gPendingAt = 0; return; }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) {
    gPendingAt = 0;
    return;
  }
  const key = e.key.toLowerCase();
  // 'g g' is itself a sequence (govern): a second 'g' within the window
  // dispatches instead of re-arming.
  if (key === 'g' && gPendingAt && Date.now() - gPendingAt <= G_WINDOW_MS) {
    gPendingAt = 0;
    e.preventDefault();
    G_SEQUENCES.g();
    return;
  }
  if (key === 'g') { gPendingAt = Date.now(); return; } // arms the sequence
  if (gPendingAt && Date.now() - gPendingAt <= G_WINDOW_MS) {
    const action = G_SEQUENCES[key];
    gPendingAt = 0;
    if (action) { e.preventDefault(); action(); }
    return;
  }
  gPendingAt = 0;
});
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
  events.addEventListener('run', (e) => {
    window.dispatchEvent(new CustomEvent('ui:run', { detail: JSON.parse(e.data) }));
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
