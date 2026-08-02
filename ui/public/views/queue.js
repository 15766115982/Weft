// views/queue.js — C review queue: sticky action bar with keyboard shortcuts
// (a approve / r reject / [ ] or j/k prev-next), optimistic UI, explicit 409.
// Hotkeys use the 'queue' SCOPE (P0-2): app.js resets to 'all' on every route
// mount, so these bindings die the moment the user leaves this view — no
// global leak, no silent writes from another page.
import { api, apiPost } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { renderMarkdown, setKnownPages } from '../lib/md.js';
import { lineDiff } from '../lib/diff.js';
import { icon } from '../lib/icons.js';

let queue = [];

function bindQueueHotkeys() {
  // unbind first: hotkeys-js stacks duplicate handlers for the same key+scope
  // (P2-2 — they would accumulate on every queue mount)
  for (const k of ['a', 'r', '[', ']', 'j', 'k']) hotkeys.unbind(k, 'queue');
  hotkeys.setScope('queue');
  hotkeys('a', 'queue', () => document.querySelector('.reviewbar .approve')?.click());
  hotkeys('r', 'queue', () => document.querySelector('.reviewbar .reject')?.click());
  hotkeys('[,j', 'queue', () => step(-1));
  hotkeys('],k', 'queue', () => step(1));
}

function step(dir) {
  const current = new URLSearchParams((location.hash.split('?')[1] || '')).get('path');
  const i = queue.findIndex((p) => p.path === current);
  const next = queue[i + dir] || (i === -1 ? queue[0] : null);
  if (next) location.hash = `#/queue?path=${encodeURIComponent(next.path)}`;
}

function diffHtml(ops) {
  return ops.map((o) => o.t === ' '
    ? esc(o.text) + '\n'
    : `<span class="${o.t === '+' ? 'add' : 'del'}">${esc((o.t === '+' ? '+ ' : '- ') + o.text)}</span>\n`).join('');
}

async function renderReview(container, rel, onDone) {
  container.textContent = '';
  const [page, diff] = await Promise.all([
    api('/api/page', { path: rel }),
    api('/api/diff', { path: rel }).catch(() => ({ baseline: null, current: '', changed: false })),
  ]);
  const f = page.fields;

  const reader = el('div', { class: 'reader' });
  const title = el('h1', { class: 'doc-title' });
  html(title, `${esc(f.title || rel)} <span class="badge candidate">candidate</span>`);
  reader.append(title);

  const meta = el('div', { class: 'archive-card' });
  html(meta, [`<b>${esc(rel)}</b>`, f.type ? `type <b>${esc(f.type)}</b>` : '',
    f.updated_at ? `updated <b>${esc(String(f.updated_at).slice(0, 10))}</b>` : ''].filter(Boolean).join(''));
  reader.append(meta);

  if (f.review_note) {
    const note = el('div', { class: 'stale-cta' });
    html(note, `${icon('circleAlert', 14)} <b>评审备注:</b>${esc(f.review_note)}`);
    reader.append(note);
  }

  const links = [];
  if (f.source_ref) links.push(`<a href="#/browse?raw=${encodeURIComponent(f.source_ref)}">raw 证据:${esc(f.source_ref)}</a>`);
  for (const s of f.sources || []) {
    links.push(`<a href="#/page?path=${encodeURIComponent('wiki/sources/' + s.replace(/^wiki\/sources\//, ''))}">来源:${esc(s)}</a>`);
  }
  if (links.length) {
    const ev = el('div', { class: 'archive-card' });
    html(ev, links.join(''));
    reader.append(ev);
  }

  if (diff.changed) {
    const box = el('details', { class: 'card' });
    const pre = el('div', { class: 'diff' });
    html(pre, diffHtml(lineDiff((diff.baseline || '').replace(/^---\n[\s\S]*?\n---\n/, ''), page.body)));
    box.append(el('summary', {}, '与上一版(HEAD)的差异'), pre);
    reader.append(box);
  }

  const body = el('div', { class: 'md card' });
  html(body, renderMarkdown(page.body));
  reader.append(body);

  const bar = el('div', { class: 'reviewbar' });
  const approve = el('button', { class: 'approve', title: '批准 (a)' }, '✓ 批准');
  const reject = el('button', { class: 'reject', title: '拒绝 (r)' }, '✗ 拒绝');
  const hint = el('span', { class: 'hint' });
  html(hint, '<kbd>a</kbd> 批准 · <kbd>r</kbd> 拒绝 · <kbd>j</kbd><kbd>k</kbd> 上/下一条');
  const note = el('span', { class: 'dim', style: 'font-size:12.5px' });
  bar.append(approve, reject, note, hint);
  reader.append(bar);
  container.append(reader);

  async function act(action) {
    approve.disabled = reject.disabled = true;
    note.textContent = '';
    try {
      await apiPost('/api/review', { path: rel, action });
      note.textContent = `已${action === 'approve' ? '批准' : '拒绝'} — log 由下次治理 sweep 回补`;
      window.dispatchEvent(new CustomEvent('ui:refresh-header')); // P2-1: counts/stale
      setTimeout(onDone, 600);
    } catch (err) {
      const conflict = el('div', { class: 'conflict' });
      conflict.append(el('span', {}, /409|page status is/.test(err.message)
        ? `冲突:这篇的状态刚被别处改动(${err.message})。`
        : err.message));
      const refresh = el('button', { style: 'margin-left:10px;padding:2px 10px;font-size:12px' }, '刷新队列');
      refresh.addEventListener('click', () => { location.hash = '#/queue'; onDone(); });
      conflict.append(refresh);
      bar.before(conflict);
      approve.disabled = reject.disabled = false;
    }
  }
  approve.addEventListener('click', () => act('approve'));
  reject.addEventListener('click', () => act('reject'));
}

export async function render(view, params) {
  // /api/queue is the queue's source of truth (P2-4 — no client-side filter
  // duplicating it); /api/tree only feeds the wikilink resolver
  const [treeData, queueData] = await Promise.all([api('/api/tree'), api('/api/queue')]);
  setKnownPages(treeData.pages);
  queue = queueData.pages;

  const wrap = el('div', { class: 'browse' });
  const list = el('nav', { class: 'tree', style: 'width:220px' });
  const head = el('div', { class: 'dim', style: 'padding:6px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em' },
    `评审队列 · ${queue.length}`);
  list.append(head);
  for (const p of queue) {
    const a = el('a', { href: `#/queue?path=${encodeURIComponent(p.path)}`,
      class: p.path === params.get('path') ? 'current' : '' });
    const t = el('span', { class: 't' }, p.title);
    a.append(t);
    list.append(a);
  }
  if (!queue.length) list.append(el('p', { class: 'dim', style: 'padding:4px' }, '队列已清空 🎉'));

  const spacer = el('div');
  const content = el('div');
  wrap.append(list, content, spacer);
  view.append(wrap);

  bindQueueHotkeys(); // 'queue' scope — dies on route change (app.js resets to 'all')

  const target = params.get('path') || queue[0]?.path;
  if (target) {
    await renderReview(content, target, () => { location.hash = '#/queue'; });
  } else {
    html(content, `<div class="empty-state"><div class="big">队列已清空 🎉</div>
      所有候选都处理完了。下次治理产生新候选时,这里会出现它们。</div>`);
  }
}
