// lib/palette.js — Ctrl+K command palette (signature interaction, I1).
// Fuzzy-filters pages + actions; full keyboard operation (↑↓ Enter Esc).
// Built with render.js primitives only — the single-exit sanitization rule holds.
import { el, html, esc } from './render.js';
import { icon } from './icons.js';

function fuzzy(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  let qi = 0, score = 0;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) { qi++; score += ti === 0 || text[ti - 1] === ' ' || text[ti - 1] === '/' ? 3 : 1; }
  }
  return qi === q.length ? score : -1;
}

export function openPalette({ getItems, onPick }) {
  const mask = el('div', { class: 'cmdk-mask' });
  const box = el('div', { class: 'cmdk' });
  const input = el('input', { placeholder: '输入以过滤页面 / 动作… (↑↓ 选择,Enter 打开,Esc 关闭)' });
  const list = el('div', { class: 'list' });
  box.append(input, list);
  mask.append(box);
  document.body.append(mask);
  input.focus();

  let items = [], filtered = [], sel = 0;

  function row(item, i) {
    const r = el('div', { class: 'row' + (i === sel ? ' sel' : '') });
    html(r, `<span>${icon(item.icon || 'fileText', 15)}</span>`);
    r.append(el('span', {}, item.label));
    if (item.hint) r.append(el('span', { class: 'foot' }, item.hint));
    r.addEventListener('click', () => pick(item));
    // P3: mousemove only swaps the sel class — no full 12-row DOM rebuild
    r.addEventListener('mousemove', () => {
      if (sel === i) return;
      sel = i;
      list.querySelectorAll('.row').forEach((n, j) => n.classList.toggle('sel', j === sel));
    });
    return r;
  }
  function draw() {
    list.textContent = '';
    if (!filtered.length) { list.append(el('div', { class: 'empty' }, '没有匹配 — 换个词试试')); return; }
    filtered.slice(0, 12).forEach((item, i) => list.append(row(item, i)));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  async function refresh() {
    const q = input.value.trim();
    if (!items.length) items = await getItems();
    filtered = !q ? items.slice(0, 12)
      : items.map((it) => [fuzzy(q, it.label + ' ' + (it.hint || '')), it])
          .filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, it]) => it);
    sel = 0;
    draw();
  }
  function close() { mask.remove(); document.removeEventListener('keydown', onKey, true); }
  function pick(item) { close(); onPick(item); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, Math.min(filtered.length, 12) - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[sel]; if (it) pick(it); }
  }
  input.addEventListener('input', refresh);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey, true);
  refresh();
}
