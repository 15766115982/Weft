// views/search.js — B manual retrieval: live debounced search, filter chips
// (type:/source: without typing syntax), term highlighting, skeleton loading.
import { api, apiPost } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

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
  return `<div class="card">
    <h3><a href="#/page?path=${encodeURIComponent(c.page)}${anchor}">${highlight(c.title || c.page, terms)}</a>
      <span class="via ${c.via === 'link' ? 'link' : ''}">${esc(c.via)}</span></h3>
    ${c.heading ? `<div class="foot">§ ${esc(c.heading)}</div>` : ''}
    ${c.snippet ? `<div class="snippet">${highlight(cleanSnippet(c.snippet), terms)}</div>` : ''}
    <div class="foot">${esc(c.page)}${score}${slot}</div>
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
  view.append(bar, chips, out);
  input.focus();

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
