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
import { sourceLinksHtml } from '../lib/sources.mjs';

let queue = [];
// Module scope on purpose (review 2026-08-04): j/k navigation changes the hash,
// which remounts the whole view — a render-local Set silently discarded the
// batch selection on every step. Entries are pruned against the fresh queue on
// each render (a page reviewed elsewhere must not stay selected).
const selected = new Set();

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
  if (Array.isArray(f.sources) && f.sources.length) {
    links.push(sourceLinksHtml(f.sources, page.sources_resolved, '来源:'));
  }
  if (links.length) {
    const ev = el('div', { class: 'archive-card' });
    html(ev, links.join(''));
    reader.append(ev);
  }

  if (diff.changed) {
    const box = el('details', { class: 'card' });
    const pre = el('div', { class: 'diff' });
    const ops = lineDiff((diff.baseline || '').replace(/^---\n[\s\S]*?\n---\n/, ''), page.body);
    if (ops) html(pre, diffHtml(ops));
    else pre.append(el('p', { class: 'dim', style: 'padding:8px' }, '文件过大,差异视图省略(与薄 viewer 同一上限);请直接对照正文。'));
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
  const [treeData, queueData, planData] = await Promise.all([
    api('/api/tree'), api('/api/queue'), api('/api/plan').catch(() => null),
  ]);
  setKnownPages(treeData.pages);
  queue = queueData.pages;
  for (const p of [...selected]) if (!queue.some((q) => q.path === p)) selected.delete(p);

  // F4 structure-findings banner: the queue is where users ACT on problems,
  // so dangling links / anomalies / errors surface here (live plan data, not
  // run history — this also covers partial changes from failed runs).
  if (planData) {
    const findings = [
      ...planData.dangling_links.map((d) => ({ text: `悬空链接 [[${d.link}]]`, page: d.page })),
      ...[...planData.anomalies, ...planData.errors].map((a) => ({
        text: `${a.title || a.raw || a.page} — ${a.reason || a.error || ''}`, page: a.page && String(a.page).startsWith('wiki/') ? a.page : null,
      })),
    ];
    if (findings.length) {
      const banner = el('div', { class: 'stale-cta', style: 'margin-bottom:10px' });
      html(banner, `${icon('circleAlert', 15)} <b>结构问题 ${findings.length} 项</b>(治理后校验/实时 plan):`);
      const ul = el('ul', { style: 'margin:6px 0 0;padding-left:18px' });
      for (const f of findings.slice(0, 8)) {
        const li = el('li', { style: 'font-size:12.5px' });
        html(li, f.page ? `<a href="#/page?path=${encodeURIComponent(f.page)}">${esc(f.text)}</a>` : esc(f.text));
        ul.append(li);
      }
      if (findings.length > 8) ul.append(el('li', { class: 'dim', style: 'font-size:12px' }, `…共 ${findings.length} 项,完整清单见治理控制台`));
      banner.append(ul);
      view.append(banner);
    }
  }

  const wrap = el('div', { class: 'browse' });
  const list = el('nav', { class: 'tree', style: 'width:260px' });
  const head = el('div', { class: 'dim', style: 'padding:6px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em' },
    `评审队列 · ${queue.length}`);
  list.append(head);

  // ---- C5 batch review (ruling 2026-08-03: checkboxes + select-all; approve
  // direct — recoverable via edit-demote; reject armed two-click + archive
  // consequence copy, merge-topic discipline) ----
  const batchBar = el('div', { class: 'batchbar', hidden: '' });
  const selNote = el('span', { class: 'dim', style: 'font-size:12px' });
  const approveBtn = el('button', { class: 'sm approve' });
  const rejectBtn = el('button', { class: 'sm reject' });
  const clearBtn = el('button', { class: 'sm' }, '清空');
  const resultNote = el('div', { style: 'font-size:12.5px;padding:2px 4px' });
  list.append(batchBar, resultNote);

  function syncBatchBar() {
    batchBar.hidden = selected.size === 0;
    selNote.textContent = `已选 ${selected.size} 篇`;
    html(approveBtn, `✓ 批量批准 (${selected.size})`);
    if (!rejectBtn.dataset.armed) html(rejectBtn, `✗ 批量拒绝 (${selected.size})`);
    for (const cb of list.querySelectorAll('input[data-sel]')) cb.checked = selected.has(cb.dataset.sel);
    allBox.checked = selected.size > 0 && selected.size === queue.length;
  }

  let rejectDisarm = 0;
  async function runBatch(action) {
    approveBtn.disabled = rejectBtn.disabled = true;
    const paths = [...selected];
    try {
      const { results } = await apiPost('/api/review-batch', { paths, action });
      const failed = results.filter((r) => !r.ok);
      const verb = action === 'approve' ? '批准' : '拒绝';
      resultNote.textContent = `批量${verb}:${results.length - failed.length} 成功` + (failed.length ? ` / ${failed.length} 失败` : '');
      for (const f of failed.slice(0, 3)) {
        resultNote.append(el('div', { class: 'dim', style: 'font-size:11.5px' }, `${f.path}: ${f.error}`));
      }
      window.dispatchEvent(new CustomEvent('ui:refresh-header'));
      setTimeout(() => window.dispatchEvent(new CustomEvent('ui:remount')), 1500);
    } catch (err) {
      resultNote.textContent = `批量${action === 'approve' ? '批准' : '拒绝'}失败:${err.message}`;
      approveBtn.disabled = rejectBtn.disabled = false;
    }
  }
  approveBtn.addEventListener('click', () => runBatch('approve'));
  rejectBtn.addEventListener('click', () => {
    if (!rejectBtn.dataset.armed) {
      rejectBtn.dataset.armed = '1';
      rejectBtn.textContent = `确认拒绝 ${selected.size} 篇?sweep 后归档,找回是手工活`;
      rejectBtn.classList.add('danger-solid');
      clearTimeout(rejectDisarm);
      rejectDisarm = setTimeout(() => { delete rejectBtn.dataset.armed; rejectBtn.classList.remove('danger-solid'); syncBatchBar(); }, 5000);
      return;
    }
    delete rejectBtn.dataset.armed;
    rejectBtn.classList.remove('danger-solid');
    runBatch('reject');
  });
  clearBtn.addEventListener('click', () => { selected.clear(); syncBatchBar(); });
  batchBar.append(selNote, approveBtn, rejectBtn, clearBtn);

  const allRow = el('label', { class: 'batch-all' });
  const allBox = el('input', { type: 'checkbox' });
  allBox.addEventListener('change', () => {
    selected.clear();
    if (allBox.checked) for (const p of queue) selected.add(p.path);
    syncBatchBar();
  });
  allRow.append(allBox, el('span', { style: 'font-size:12px' }, ' 全选'));
  list.append(allRow);

  for (const p of queue) {
    const row = el('div', { class: 'batch-row' });
    const cb = el('input', { type: 'checkbox', 'data-sel': p.path });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(p.path); else selected.delete(p.path);
      syncBatchBar();
    });
    const a = el('a', { href: `#/queue?path=${encodeURIComponent(p.path)}`,
      class: p.path === params.get('path') ? 'current' : '' });
    const t = el('span', { class: 't' }, p.title);
    a.append(t);
    row.append(cb, a);
    list.append(row);
  }
  if (!queue.length) list.append(el('p', { class: 'dim', style: 'padding:4px' }, '队列已清空 🎉'));
  syncBatchBar(); // restore checkbox/batchbar state after a j/k remount (selected is module-scoped)

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
