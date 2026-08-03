// views/search.js — B manual retrieval: live debounced search, filter chips
// (type:/source: without typing syntax), term highlighting, skeleton loading.
import { api, apiPost, getKb } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

// B5 query history + saved queries: localStorage, KB-scoped (local single-user
// tool — no server round-trip for a convenience list).
const store = {
  read(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } },
  write(key, arr) { localStorage.setItem(key, JSON.stringify(arr.slice(0, 30))); },
};
const histKey = () => `ui.search-history.${getKb() || 'default'}`;
const savedKey = () => `ui.search-saved.${getKb() || 'default'}`;

function highlight(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t || t.length < 2) continue;
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  }
  return out;
}

// snippets come straight from FTS chunks — strip raw markdown tokens (P1-3)
function cleanSnippet(s) {
  return String(s || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, '$2')
    .trim();
}

function cardHtml(c, terms, idx = -1) {
  const anchor = c.anchor ? `&anchor=${encodeURIComponent(c.anchor)}` : '';
  const score = c.score >= 0.001
    ? ` · <span title="BM25 启发式打分(命中词数与位置的近似),仅供排序参考">score ${c.score}</span>` : '';
  // idx ≥ 0: a judge badge slot for the async K1 verdict
  const slot = idx >= 0 ? ' <span class="judge-slot"></span>' : '';
  // J9 vote buttons (event delegation on the results container)
  const votes = ` <span class="vote-btn" data-vote="up" data-page="${esc(c.page)}" title="这个结果有用">${icon('thumbsUp', 13)}</span>`
    + ` <span class="vote-btn" data-vote="down" data-page="${esc(c.page)}" title="这个结果没用 — 查询会沉淀为评测黄金集候选(J9)">${icon('thumbsDown', 13)}</span>`;
  return `<div class="card">
    <h3><a href="#/page?path=${encodeURIComponent(c.page)}${anchor}">${highlight(c.title || c.page, terms)}</a>
      <span class="via ${c.via === 'link' ? 'link' : ''}">${esc(c.via)}</span></h3>
    ${c.heading ? `<div class="foot">§ ${esc(c.heading)}</div>` : ''}
    ${c.snippet ? `<div class="snippet">${highlight(cleanSnippet(c.snippet), terms)}</div>` : ''}
    <div class="foot">${esc(c.page)}${score}${slot}${votes}</div>
  </div>`;
}

export async function render(view, params) {
  // filter chips: type + source systems present in this KB (from frontmatter
  // source_ref via /api/tree — not a path regex, P2)
  const tree = (await api('/api/tree')).pages;
  const sourceNames = [...new Set(tree.map((p) => p.source).filter(Boolean))];

  const bar = el('form', { class: 'searchbar' });
  const input = el('input', {
    placeholder: '查询… (即时搜索;支持 "短语" after:/before: 等)',
    value: params.get('q') || '',
  });
  bar.append(input);
  const chips = el('div', { class: 'chips' });
  const chipDefs = [
    ...['topic', 'source'].map((t) => ({ label: `type:${t}`, q: `type:${t}` })),
    ...sourceNames.map((s) => ({ label: `来源 ${s}`, q: `source:${s}` })),
  ];
  const active = new Set();
  for (const def of chipDefs) {
    const c = el('span', { class: 'chip' }, def.label);
    c.addEventListener('click', () => {
      if (active.has(def.q)) { active.delete(def.q); c.classList.remove('on'); }
      else { active.add(def.q); c.classList.add('on'); }
      run();
    });
    chips.append(c);
  }
  const out = el('div');
  // B5 history panel: ★ saved + recent queries, one click re-runs
  const histPanel = el('div', { class: 'hist-panel' });
  // J9 👎 panel: queries the user down-voted — the golden-set candidate pool
  const downPanel = el('details', { class: 'down-panel', hidden: '' });
  view.append(bar, chips, histPanel, downPanel, out);
  input.focus();

  function renderHistPanel() {
    const saved = store.read(savedKey());
    const recent = store.read(histKey()).filter((q) => !saved.includes(q)).slice(0, 8);
    histPanel.textContent = '';
    if (!saved.length && !recent.length) return;
    const mk = (q, isSaved) => {
      const item = el('span', { class: `hist-item${isSaved ? ' saved' : ''}` });
      const a = el('a', { href: '#' }, q);
      a.addEventListener('click', (e) => { e.preventDefault(); input.value = q; run(); });
      const star = el('span', { class: 'hist-star', title: isSaved ? '移出保存' : '保存这个查询' }, isSaved ? '★' : '☆');
      star.addEventListener('click', () => {
        const cur = store.read(savedKey());
        store.write(savedKey(), isSaved ? cur.filter((x) => x !== q) : [q, ...cur]);
        renderHistPanel();
      });
      item.append(a, star);
      return item;
    };
    for (const q of saved) histPanel.append(mk(q, true));
    for (const q of recent) histPanel.append(mk(q, false));
  }
  renderHistPanel();

  function recordQuery(q) {
    const cur = store.read(histKey()).filter((x) => x !== q);
    store.write(histKey(), [q, ...cur]);
    renderHistPanel();
  }

  async function loadDownPanel() {
    const { entries } = await api('/api/feedback', { vote: 'down' }).catch(() => ({ entries: [] }));
    const queries = [...new Set(entries.map((e) => e.q))].slice(0, 10);
    downPanel.hidden = queries.length === 0;
    downPanel.textContent = '';
    downPanel.append(el('summary', {}, `差评查询 (${queries.length})— 评测黄金集候选池`));
    const box = el('div', { style: 'padding:6px 4px' });
    for (const q of queries) {
      const a = el('a', { href: '#', style: 'display:inline-block;margin:2px 8px 2px 0;font-size:12.5px' }, q);
      a.addEventListener('click', (e) => { e.preventDefault(); input.value = q; run(); });
      box.append(a);
    }
    downPanel.append(box);
  }
  loadDownPanel();

  // J9 vote delegation (survives re-renders: listener lives on `out`)
  out.addEventListener('click', async (e) => {
    const btn = e.target.closest('.vote-btn');
    if (!btn) return;
    const q = fullQuery();
    if (!q) return;
    const siblings = btn.parentElement.querySelectorAll('.vote-btn');
    siblings.forEach((s) => s.classList.add('voted-off'));
    btn.classList.remove('voted-off');
    btn.classList.add('voted');
    try {
      await apiPost('/api/feedback', { q, page: btn.dataset.page, vote: btn.dataset.vote });
      if (btn.dataset.vote === 'down') loadDownPanel();
    } catch (err) {
      btn.classList.remove('voted');
      siblings.forEach((s) => s.classList.remove('voted-off'));
      btn.title = `记录失败:${err.message}`;
    }
  });

  let timer = null, seq = 0;
  function fullQuery() {
    return [input.value.trim(), ...active].filter(Boolean).join(' ');
  }

  async function run() {
    const q = fullQuery();
    if (!q) { out.textContent = ''; return; }
    const my = ++seq;
    out.textContent = '';
    out.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
    try {
      const r = await api('/api/search', { q });
      if (my !== seq) return; // a newer query finished first
      const terms = [...(r.routed?.latin || []), ...(r.routed?.cjk || []), ...(r.routed?.like || [])];
      out.textContent = '';
      const head = el('div', { class: 'routed' });
      const legs = ['latin', 'cjk', 'like'].filter((k) => r.routed?.[k]?.length)
        .map((k) => `${k}: ${r.routed[k].join(', ')}`).join(' ｜ ');
      head.textContent = `${r.total} 条候选${legs ? ` · 检索腿 → ${legs}` : ''}`;
      const list = el('div');
      html(list, r.preview.map((c, i) => cardHtml(c, terms, i)).join('') ||
        `<div class="empty-state"><div class="big">没有命中</div>试试去掉过滤器、换更短的词,或确认治理已经跑过(检索只覆盖 approved 页面)。</div>`);
      out.append(head, list);
      if (r.candidates.length > r.preview.length) {
        const more = el('details');
        const rest = el('div');
        html(rest, r.candidates.slice(r.preview.length).map((c) => cardHtml(c, terms)).join(''));
        more.append(el('summary', {}, `完整候选空间(其余 ${r.candidates.length - r.preview.length} 条)`), rest);
        out.append(more);
      }
      history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`);
      recordQuery(q); // B5
      judgeTop(r, q, my, head, out); // K1: async verdict badge, search already rendered
    } catch (err) {
      if (my !== seq) return;
      out.textContent = '';
      out.append(el('pre', { class: 'error' }, err.message));
    }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  bar.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); run(); });
  if (params.get('q')) run();

  // K1 async judge badge: the search renders immediately; the judge grades
  // the top-5 in the background and the badge lands when done. One backend
  // call for all five (not five serial calls). Same seq guard as the search.
  async function judgeTop(r, q, my, head, outBox) {
    const top = r.preview.slice(0, 5);
    const slots = outBox.querySelectorAll('.judge-slot');
    if (!top.length || !slots.length) return;
    slots.forEach((s, i) => { if (i < top.length) html(s, '<span class="judge-chip pending" title="LLM judge 评测中…">…</span>'); });
    try {
      const v = await apiPost('/api/judge', {
        q,
        results: top.map((c) => ({ page: c.page, title: c.title, snippet: cleanSnippet(c.snippet) })),
      });
      if (my !== seq) return;
      v.verdicts.forEach((verd, i) => {
        const slot = slots[i];
        if (!slot) return;
        slot.textContent = '';
        if (verd.score === null) { slot.append(el('span', { class: 'judge-chip na', title: verd.reason }, '—')); return; }
        slot.append(el('span', {
          class: `judge-chip s${verd.score}`,
          title: `${verd.reason} — judge:${v.backend} · ${(v.ms / 1000).toFixed(1)}s`,
        }, String(verd.score)));
      });
      head.textContent += ` · judge:${v.backend} ${(v.ms / 1000).toFixed(1)}s`;
    } catch (err) {
      if (my !== seq) return;
      slots.forEach((s) => { s.textContent = ''; s.append(el('span', { class: 'judge-chip na', title: `评测失败:${err.message}` }, '×')); });
    }
  }
}
