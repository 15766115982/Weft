// views/graph.js — ADR-0007 dual view: a NAVIGATION TREE ("find things",
// node-scan driven, never parses index.md) and a SEMANTIC GRAPH ("understand
// relationships", force-directed canvas). The semantic view excludes index.md
// (view-layer only — buildGraph's contract is unchanged) and distinguishes
// authored edges (solid) from ADR-0007 derived provenance edges (dashed).
// Hand-rolled simulation (zero new vendor deps — intranet rule): uniform-grid
// repulsion keeps each tick ~O(n) at the ≤2k-node scale the requirements cap
// the KB at. Visual unity with the signature [[ reference chip ]]: hovered /
// focused nodes show it in the tooltip; topics are filled celadon, sources
// hollow, candidates dashed amber (status chip semantics).
import { api } from '../lib/api.js';
import { el, html, esc } from '../lib/render.js';
import { icon } from '../lib/icons.js';

const MAX_AUTO = 2000;      // requirements: ≤2k nodes client-side layout
const REST = 78;            // spring rest length (world px)
const REPULSION = 2600;     // charge strength
const CUTOFF = 160;         // repulsion range = grid cell size
const STATUS_LABEL = { candidate: '候选', approved: '已批准' };

export async function render(view, params) {
  const wrap = el('div', { class: 'graph' });
  view.append(wrap);

  // ---------- ADR-0007 tab bar: navigation tree / semantic graph ----------
  const tabs = el('div', { class: 'graph-tabs' });
  const tabTree = el('button', {}, '导航树');
  const tabGraph = el('button', { class: 'active' }, '语义图'); // graph pane is the default view — the active tab must match (2026-08-12)
  tabs.append(tabTree, tabGraph);
  wrap.append(tabs);

  const treePane = el('div', { class: 'graph-tree-pane', hidden: '' });
  const graphPane = el('div', { class: 'graph-canvas-pane' });
  wrap.append(treePane, graphPane);

  tabTree.addEventListener('click', () => {
    tabTree.classList.add('active'); tabGraph.classList.remove('active');
    treePane.hidden = false; graphPane.hidden = true;
  });
  tabGraph.addEventListener('click', () => {
    tabGraph.classList.add('active'); tabTree.classList.remove('active');
    treePane.hidden = true; graphPane.hidden = false;
    if (graphPane.hidden === false && !fitted) { fitView(); fitted = true; }
  });

  // ---------- navigation tree ----------
  // Node-scan driven (ADR-0007 Decision 2): the directory tree is the type
  // system. The four groups mirror contract.md §3 1:1 (ADR-0009 page types);
  // the candidate status badge needs the scan; coverage count comes from the
  // graph layer (derived page→source edge count).
  const treeFilter = el('input', { class: 'tree-filter', placeholder: '过滤导航树…' });
  const treeList = el('nav', { class: 'tree' });
  treePane.append(treeFilter, treeList);
  let treeNodes = [];

  function renderTree() {
    treeList.textContent = '';
    const q = treeFilter.value.trim().toLowerCase();
    const groups = [
      { label: '实体 Entities', nodes: treeNodes.filter((n) => n.path.startsWith('wiki/entities/')) },
      { label: '概念 Concepts', nodes: treeNodes.filter((n) => n.path.startsWith('wiki/concepts/')) },
      { label: '综合 Syntheses', nodes: treeNodes.filter((n) => n.path.startsWith('wiki/syntheses/')) },
      { label: '来源 Sources', nodes: treeNodes.filter((n) => n.path.startsWith('wiki/sources/')) },
    ];
    for (const g of groups) {
      let list = g.nodes;
      if (q) list = list.filter((n) => (n.title || '').toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
      if (!list.length) continue;
      const head = el('div', { class: 'dim', style: 'padding:8px 4px 2px;font-size:11px;text-transform:uppercase;letter-spacing:.08em' },
        `${g.label} · ${list.length}`);
      treeList.append(head);
      for (const n of list) {
        const a = el('a', { href: `#/page?path=${encodeURIComponent(n.path)}` });
        const t = el('span', { class: 't' }, n.title || n.path);
        a.append(t);
        if (n.status === 'candidate') a.append(el('span', { class: 'badge candidate' }, '候选'));
        if (n.coverage) a.append(el('span', { class: 'src' }, `${n.coverage} 覆盖`));
        treeList.append(a);
      }
    }
    if (!treeList.childElementCount) treeList.append(el('p', { class: 'dim', style: 'padding:8px 4px' }, '没有匹配的页面。'));
  }
  treeFilter.addEventListener('input', renderTree);

  // ---------- semantic graph toolbar ----------
  const focusInput = el('input', { class: 'graph-focus', placeholder: '定位页面…', list: 'graph-titles', title: '输入页面名,回车定位' });
  const candBtn = el('button', { class: 'graph-toggle on', title: '显示 / 隐藏候选页' }, '候选');
  const isoBtn = el('button', { class: 'graph-toggle on', title: '显示 / 隐藏没有连线的孤立页' }, '孤立点');
  const relayBtn = el('button', { class: 'icon-btn', title: '重新布局' });
  html(relayBtn, icon('history', 15));
  const stats = el('span', { class: 'dim graph-stats' });
  // edge-list provenance (final-review ③): edges mirror the retrieval index
  // and freeze until a page is re-indexed — say so before someone asks why a
  // fresh link is missing while dangling_links (live-scanned) disagrees.
  const lag = el('span', { class: 'dim', style: 'font-size:11px', title: '边取自检索索引,页面重建索引前是冻结的:指向新建页面的边会迟到,plan 的悬空链接(实时扫描)可能已经算它有效。治理台 rebuild-index 可强制重建。' }, '边可能滞后');
  const legend = el('span', { class: 'graph-legend dim' });
  html(legend, '<span class="lg-topic">●</span> 知识页(实体/概念/综合) <span class="lg-source">○</span> 来源页 <span class="lg-cand">◌</span> 候选 <span class="lg-deriv">┅</span> 溯源边');
  const bar = el('div', { class: 'graph-bar' }, focusInput, candBtn, isoBtn, relayBtn, legend, lag, stats);

  const stage = el('div', { class: 'graph-stage' });
  const canvas = el('canvas');
  const tip = el('div', { class: 'graph-tip', hidden: '' });
  stage.append(canvas, tip);
  graphPane.append(bar, stage);
  const ctx = canvas.getContext('2d');

  // ---------- state ----------
  let raw = { nodes: [], edges: [] };          // server payload
  let nodes = [], edges = [], byPath = new Map();
  let cam = { x: 0, y: 0, k: 1 };
  let alpha = 0, raf = 0, simRunning = false;
  let hover = null, dragNode = null, pan = null, pressAt = null;
  let focusedPath = params.get('focus') || null;
  let showCandidates = true, showIsolated = true;
  let fitted = false;

  const colors = () => {
    const s = getComputedStyle(document.documentElement);
    return {
      line: s.getPropertyValue('--line').trim() || '#dde3df',
      ink: s.getPropertyValue('--ink').trim(),
      dim: s.getPropertyValue('--ink-dim').trim(),
      celadon: s.getPropertyValue('--celadon').trim(),
      soft: s.getPropertyValue('--celadon-soft').trim(),
      paper: s.getPropertyValue('--paper-raise').trim() || '#ffffff',
    };
  };

  // ---------- simulation ----------
  function rebuild() {
    // ADR-0007: the SEMANTIC view excludes index.md — a view-layer decision;
    // buildGraph still returns it as a node (backlinks depends on its edges).
    let list = raw.nodes.filter((n) => !n.isIndex);
    if (!showCandidates) list = list.filter((n) => n.status !== 'candidate');
    const kept = new Set(list.map((n) => n.path));
    let es = raw.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
    const deg = new Map();
    for (const e of es) { deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1); }
    if (!showIsolated) list = list.filter((n) => deg.get(n.path) || n.path === focusedPath);
    const kept2 = new Set(list.map((n) => n.path));
    es = es.filter((e) => kept2.has(e.from) && kept2.has(e.to));

    const prev = new Map(nodes.map((n) => [n.path, n]));
    nodes = list.map((n, i) => {
      const old = prev.get(n.path);
      // golden-angle spiral start: deterministic spread, no hairball
      const a = i * 2.399963, r = 24 * Math.sqrt(i + 1);
      return {
        ...n, deg: deg.get(n.path) || 0,
        x: old ? old.x : r * Math.cos(a), y: old ? old.y : r * Math.sin(a),
        vx: 0, vy: 0,
      };
    });
    byPath = new Map(nodes.map((n) => [n.path, n]));
    edges = es.map((e) => ({ a: byPath.get(e.from), b: byPath.get(e.to), kind: e.kind })).filter((e) => e.a && e.b);
    hover = null; tip.hidden = true; // node objects are fresh — drop stale refs
    const cand = raw.nodes.filter((n) => n.status === 'candidate').length;
    stats.textContent = `${raw.nodes.length - (raw.nodes.some((n) => n.isIndex) ? 1 : 0)} 节点 · ${edges.length} 边` + (cand ? ` · ${cand} 候选` : '');
  }

  function tick(forcesOnly) {
    // repulsion via uniform grid (cell = CUTOFF): only 3×3 neighbor cells
    const grid = new Map();
    for (let i = 0; i < nodes.length; i++) {
      const key = `${Math.floor(nodes[i].x / CUTOFF)},${Math.floor(nodes[i].y / CUTOFF)}`;
      (grid.get(key) || grid.set(key, []).get(key)).push(i);
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], cx = Math.floor(n.x / CUTOFF), cy = Math.floor(n.y / CUTOFF);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j of grid.get(`${gx},${gy}`) || []) {
          if (j <= i) continue;
          const m = nodes[j];
          let dx = n.x - m.x, dy = n.y - m.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > CUTOFF * CUTOFF) continue;
          if (d2 < 0.01) { dx = 0.1; dy = 0.1; d2 = 0.02; }
          const d = Math.sqrt(d2), f = (REPULSION * alpha) / d2 / d;
          dx *= f; dy *= f;
          n.vx += dx; n.vy += dy; m.vx -= dx; m.vy -= dy;
        }
      }
    }
    for (const e of edges) { // springs
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - REST) / d) * 0.07 * alpha;
      e.a.vx += dx * f; e.a.vy += dy * f; e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const n of nodes) { // weak centering + integration
      n.vx -= n.x * 0.012 * alpha; n.vy -= n.y * 0.012 * alpha;
      if (n === dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.985;
    if (forcesOnly) return; // pre-warm: physics only, no paint, no scheduling
    draw();
    if (alpha > 0.004 || dragNode) raf = requestAnimationFrame(() => tick(false));
    else simRunning = false;
  }
  function reheat(a) {
    alpha = Math.max(alpha, a);
    if (!simRunning) { simRunning = true; cancelAnimationFrame(raf); tick(false); }
  }

  // ---------- drawing ----------
  function fitView() {
    if (!nodes.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const w = Math.max(x1 - x0, 80), h = Math.max(y1 - y0, 80);
    const cw = stage.clientWidth, ch = stage.clientHeight;
    cam.k = Math.max(0.15, Math.min(cw / (w + 120), ch / (h + 120), 1.4));
    cam.x = cw / 2 - ((x0 + x1) / 2) * cam.k;
    cam.y = ch / 2 - ((y0 + y1) / 2) * cam.k;
  }
  const toWorld = (mx, my) => ({ x: (mx - cam.x) / cam.k, y: (my - cam.y) / cam.k });
  const radius = (n) => Math.min(4 + 1.6 * Math.sqrt(n.deg), 12);

  function draw() {
    const c = colors();
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.k, cam.k);

    const focusSet = new Set();
    const hot = hover || byPath.get(focusedPath);
    if (hot) {
      focusSet.add(hot.path);
      for (const e of edges) {
        if (e.a === hot) focusSet.add(e.b.path);
        if (e.b === hot) focusSet.add(e.a.path);
      }
    }
    const dimAll = focusSet.size > 0;

    ctx.lineWidth = 1 / cam.k;
    for (const e of edges) {
      const on = !dimAll || (focusSet.has(e.a.path) && focusSet.has(e.b.path));
      // --line is a hairline at rest; edges need the dim-ink to stay visible
      ctx.strokeStyle = c.dim;
      ctx.globalAlpha = on ? (dimAll ? 0.85 : 0.4) : 0.06;
      // ADR-0007: authored solid, derived provenance dashed (explicit > implicit)
      ctx.setLineDash(e.kind === 'derived' ? [5 / cam.k, 4 / cam.k] : []);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of nodes) {
      const on = !dimAll || focusSet.has(n.path);
      ctx.globalAlpha = on ? 1 : 0.18;
      const r = radius(n);
      // ADR-0009: curated pages (entities/concepts/syntheses) are the filled
      // class; only wiki/sources/ renders as the outlined "source" class.
      const isSource = n.path.startsWith('wiki/sources/');
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.2832);
      if (n.status === 'candidate') {
        ctx.fillStyle = c.soft; ctx.fill();
        ctx.setLineDash([3 / cam.k, 3 / cam.k]); ctx.lineWidth = 1.4 / cam.k;
        ctx.strokeStyle = '#b45309'; ctx.stroke(); ctx.setLineDash([]);
      } else if (!isSource) {
        ctx.fillStyle = c.celadon; ctx.fill();
      } else {
        ctx.fillStyle = c.paper; ctx.fill();
        ctx.setLineDash([]); ctx.lineWidth = 1.4 / cam.k; ctx.strokeStyle = c.dim; ctx.stroke();
      }
    }
    // labels: everything when zoomed in; hubs + hot neighborhood otherwise.
    // paper-colored halo keeps text readable where edges cross underneath.
    ctx.globalAlpha = 1;
    ctx.font = `${11 / cam.k}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    for (const n of nodes) {
      const show = cam.k > 1.15 || n.deg >= 6 || focusSet.has(n.path);
      if (!show || (dimAll && !focusSet.has(n.path))) continue;
      const ty = n.y + radius(n) + 13 / cam.k;
      ctx.lineWidth = 3 / cam.k; ctx.strokeStyle = c.paper;
      ctx.strokeText(n.title, n.x, ty);
      ctx.fillStyle = focusSet.has(n.path) ? c.ink : c.dim;
      ctx.fillText(n.title, n.x, ty);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- interaction ----------
  function nodeAt(mx, my) {
    const p = toWorld(mx, my);
    let best = null, bestD = 1e9;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y) - radius(n);
      if (d < 4 / cam.k && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }
  function showTip(n, mx, my) {
    if (!n) { tip.hidden = true; return; }
    const KIND_LABEL = { 'wiki/sources/': '来源页', 'wiki/entities/': '实体页', 'wiki/concepts/': '概念页', 'wiki/syntheses/': '综合页' };
    const kindLabel = Object.entries(KIND_LABEL).find(([prefix]) => n.path.startsWith(prefix))?.[1] || '页面';
    const meta = [kindLabel,
      STATUS_LABEL[n.status] || n.status || '', `${n.deg} 连接`].filter(Boolean).join(' · ');
    html(tip, `<span class="br">[[</span>${esc(n.title)}<span class="br">]]</span><span class="dim">${esc(meta)}</span>`);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(mx + 14, stage.clientWidth - tw - 8) + 'px';
    tip.style.top = Math.min(my + 14, stage.clientHeight - th - 8) + 'px';
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pressAt = { x: e.offsetX, y: e.offsetY };
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n) { dragNode = n; reheat(0.2); }
    else pan = { sx: e.offsetX, sy: e.offsetY, cx: cam.x, cy: cam.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragNode) {
      const p = toWorld(e.offsetX, e.offsetY);
      dragNode.x = p.x; dragNode.y = p.y;
      reheat(0.12); draw();
      showTip(dragNode, e.offsetX, e.offsetY);
      return;
    }
    if (pan) {
      cam.x = pan.cx + (e.offsetX - pan.sx); cam.y = pan.cy + (e.offsetY - pan.sy);
      draw();
      return;
    }
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n !== hover) { hover = n; showTip(n, e.offsetX, e.offsetY); canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); }
    else if (n) showTip(n, e.offsetX, e.offsetY);
  });
  canvas.addEventListener('pointerup', (e) => {
    // click = press and release within a few px, whether it began on a node
    // (navigate) or on the background (clear the focus ring)
    const dist = pressAt ? Math.hypot(e.offsetX - pressAt.x, e.offsetY - pressAt.y) : 99;
    const wasDrag = dragNode;
    dragNode = null; pan = null; pressAt = null;
    if (dist < 6) {
      const n = nodeAt(e.offsetX, e.offsetY);
      if (n) { location.hash = `#/page?path=${encodeURIComponent(n.path)}`; return; }
      focusedPath = null; draw();
    }
    if (wasDrag) reheat(0.05);
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; draw(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k2 = Math.max(0.15, Math.min(5, cam.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const p = toWorld(e.offsetX, e.offsetY);
    cam.x = e.offsetX - p.x * k2; cam.y = e.offsetY - p.y * k2; cam.k = k2;
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { focusedPath = null; fitView(); draw(); });

  // ---------- toolbar wiring ----------
  function centerOn(path) {
    const n = byPath.get(path);
    if (!n) return false;
    focusedPath = path;
    cam.k = Math.max(cam.k, 1.2);
    cam.x = stage.clientWidth / 2 - n.x * cam.k;
    cam.y = stage.clientHeight / 2 - n.y * cam.k;
    reheat(0.05); draw();
    return true;
  }
  focusInput.addEventListener('change', () => {
    const q = focusInput.value.trim().toLowerCase();
    if (!q) return;
    const hit = nodes.find((n) => n.title.toLowerCase() === q)
      || nodes.find((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
    if (hit) { centerOn(hit.path); focusInput.value = hit.title; }
  });
  candBtn.addEventListener('click', () => { showCandidates = !showCandidates; candBtn.classList.toggle('on', showCandidates); rebuild(); reheat(0.6); });
  isoBtn.addEventListener('click', () => { showIsolated = !showIsolated; isoBtn.classList.toggle('on', showIsolated); rebuild(); reheat(0.6); });
  relayBtn.addEventListener('click', () => {
    for (const n of nodes) { const a = Math.random() * 6.2832, r = 40 + Math.random() * 120; n.x = r * Math.cos(a); n.y = r * Math.sin(a); n.vx = 0; n.vy = 0; }
    reheat(1);
  });

  // ---------- data ----------
  async function load() {
    raw = await api('/api/graph');
    treeNodes = raw.nodes;
    renderTree();
    rebuild();
    // datalist for the focus box (native autocomplete, zero extra code)
    let dl = document.getElementById('graph-titles');
    dl?.remove();
    dl = el('datalist', { id: 'graph-titles' });
    for (const n of raw.nodes) dl.append(el('option', { value: n.title }));
    bar.append(dl);

    if (raw.nodes.length > MAX_AUTO) {
      const cover = el('div', { class: 'graph-guard' });
      const btn = el('button', {}, '仍然渲染');
      cover.append(el('p', {}, `这个知识库有 ${raw.nodes.length} 个页面,超过客户端布局的建议上限(${MAX_AUTO})。渲染可能变慢。`), btn);
      stage.append(cover);
      btn.addEventListener('click', () => { cover.remove(); start(); });
      return;
    }
    start();
  }
  function start() {
    // pre-warm synchronously so the first paint is already organized
    alpha = 1;
    for (let i = 0; i < 180; i++) tick(true);
    alpha = 0.3;
    if (graphPane.hidden === false && !fitted) { fitView(); fitted = true; }
    if (focusedPath && byPath.has(focusedPath)) centerOn(focusedPath);
    reheat(0.3);
  }

  // ---------- lifecycle ----------
  let reloadTimer = 0;
  const onChange = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 500); };
  window.addEventListener('ui:kb-change', onChange);
  const ro = new ResizeObserver(() => draw());
  ro.observe(stage);
  // canvas doesn't follow CSS variables by itself — repaint on theme flip
  const themeObs = new MutationObserver(() => draw());
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) {
      cancelAnimationFrame(raf); simRunning = false;
      ro.disconnect(); themeObs.disconnect();
      window.removeEventListener('ui:kb-change', onChange);
      obs.disconnect();
    }
  }).observe(document.getElementById('view'), { childList: true });

  try {
    await load();
    if (!raw.nodes.length) {
      stage.append(el('div', { class: 'empty-hint' },
        el('p', {}, '还没有页面可连成图 — 先去采集页投入第一批文档,或到治理台让 agent 起草。')));
    }
  } catch (err) {
    stage.append(el('pre', { class: 'error' }, err.message));
  }
}
