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

function promptReason(action, prefill = '') {
  return new Promise((resolve) => {
    const mask = el('div', { class: 'cmdk-mask' });
    const box = el('div', { class: 'cmdk', style: 'padding:18px 22px; max-width:480px' });
    const title = {
      approve: '批准理由', reject: '拒绝理由', 'archive-source': '归档理由', 'dismiss-conflict': '保留两者理由',
    }[action] || '决策理由';
    box.append(el('h3', { style: 'margin:0 0 10px' }, title));
    const ta = el('textarea', { class: 'wiki-editor', rows: '4', placeholder: '简短说明为何做出这个决策…' });
    ta.value = prefill;
    box.append(ta);
    const row = el('div', { style: 'display:flex;gap:10px;margin-top:14px;justify-content:flex-end' });
    const cancel = el('button', {}, '取消');
    const ok = el('button', { class: 'primary' }, '确认');
    const note = el('span', { class: 'dim', style: 'font-size:12.5px' });
    cancel.addEventListener('click', () => { close(); resolve(null); });
    ok.addEventListener('click', () => {
      const v = ta.value.trim();
      if (!v) { note.textContent = '需要填写理由'; return; }
      close(); resolve(v);
    });
    row.append(cancel, ok, note);
    box.append(row);
    mask.append(box);
    mask.addEventListener('click', (e) => { if (e.target === mask) { close(); resolve(null); } });
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); resolve(null); } }
    function close() { mask.remove(); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('keydown', onKey, true);
    document.body.append(mask);
    setTimeout(() => ta.focus(), 10);
  });
}

async function decisionsPanel(rel) {
  const box = el('div', { class: 'archive-card', style: 'margin-top:10px' });
  try {
    const { decisions } = await api('/api/decisions', { page: rel, limit: 10 });
    if (!decisions.length) {
      box.append(el('span', { class: 'dim' }, '暂无决策记录'));
      return box;
    }
    box.append(el('div', { style: 'font-size:12px;font-weight:600;margin-bottom:4px' }, '决策记录'));
    for (const d of decisions.slice(-5).reverse()) {
      const line = el('div', { class: 'dim', style: 'font-size:12px' });
      line.textContent = `[${d.timestamp ? String(d.timestamp).slice(0, 10) : ''}] ${d.actor} · ${d.action}${d.reason ? ': ' + d.reason : ''}`;
      box.append(line);
    }
  } catch {
    box.append(el('span', { class: 'dim' }, '决策记录加载失败'));
  }
  return box;
}

async function renderReview(container, rel, onDone, conflicts, suppressed) {
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

  // Conflict group this candidate's sources fall into (fail-closed candidate from
  // plan 0001 §3.1.4): render it as an adjudication call-to-action, not a footnote.
  const group = (conflicts?.groups || []).find((g) => !g.dismissed && Array.isArray(f.sources) && g.raws.some((r) => f.sources.includes(r))) || null;
  if (group) {
    const c = el('div', { class: 'stale-cta conflict' });
    html(c, `${icon('alertTriangle', 14)} <b>冲突组 ${esc(group.category)}</b>:${esc(group.raws.join('、'))}${group.score !== undefined ? `(相似度 ${group.score})` : ''} — 必须裁决:归档败方来源页 或 保留两者(dismiss)`);
    reader.append(c);
  }

  // A source this candidate references was loser-archived (P0-1 tombstone). The
  // archive only removes the source page from retrieval — it does NOT rewrite the
  // topic body, so the fused text may still carry the loser's content. Surface
  // the edit-before-approve reminder instead of letting the stale text pass silently.
  const archivedSrc = (f.sources || []).find((s) =>
    suppressed?.some((sup) => sup.raw === s && sup.detail === 'loser-archive'));
  if (archivedSrc) {
    const cta = el('div', { class: 'stale-cta archive-hint' });
    html(cta, `${icon('archiveRestore', 14)} <b>来源已归档:</b>${esc(archivedSrc)} 已被归档,主题正文可能仍含其内容。建议先 <b>✎ 编辑</b> 去除旧内容,再 <b>✓ 批准</b>。`);
    reader.append(cta);
  }

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

  // Per-source "archive the loser" buttons (plan 0001 §3.2) — the human decides
  // which source page is the losing side and removes it from retrieval. These
  // SELECT a loser (no default — 2026-08-05 ruling); the bar's 「归档来源」 button
  // executes the archive of the selected one.
  const resolvedSources = page.sources_resolved || [];
  let selectedLoser = null; // wiki/sources/... path armed for archive-source, or null
  const syncArchiveDisabled = () => {
    archiveBtn.disabled = !selectedLoser;
    archiveBtn.title = selectedLoser
      ? `归档 ${selectedLoser} — 移出检索并墓碑`
      : '先在下方的来源行点选一个来源(败方),再执行归档';
  };
  if (resolvedSources.some((s) => s.page)) {
    const arch = el('div', { class: 'archive-card', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' });
    html(arch, '<span class="dim" style="font-size:12px">归档来源(败方,点选后执行):</span>');
    for (const s of resolvedSources) {
      if (!s.page) continue;
      const b = el('button', { class: 'sm', title: `点选 ${s.page} 为败方(再点「归档来源」执行)` }, `🗄 ${s.page.split('/').pop()}`);
      b.addEventListener('click', () => {
        selectedLoser = selectedLoser === s.page ? null : s.page; // toggle
        for (const other of arch.querySelectorAll('button')) {
          other.classList.toggle('sel', other === b && !!selectedLoser);
        }
        note.textContent = selectedLoser
          ? `已选败方 ${selectedLoser.split('/').pop()} — 点「归档来源」执行`
          : '';
        syncArchiveDisabled();
      });
      arch.append(b);
    }
    reader.append(arch);
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

  // Five-state adjudication bar (plan 0001 §4): approve / reject-and-restore /
  // edit (deep-link to the existing M7d editor; save keeps the candidate, then
  // approve) / archive-source (disabled until a loser source is selected in the
  // sources row above — no default target, 2026-08-05) / keep-both (dismiss).
  const bar = el('div', { class: 'reviewbar' });
  const approve = el('button', { class: 'approve', title: '批准 (a)' }, '✓ 批准');
  const reject = el('button', { class: 'reject', title: '拒绝并恢复上一 approved 版 (r)' }, '✗ 拒绝并恢复');
  const edit = el('button', { class: 'edit', title: '人工编辑(保存即降级为候选,再批准)' }, '✎ 编辑');
  const archiveBtn = el('button', { class: 'archive', disabled: true, title: '先在下方的来源行点选一个来源(败方),再执行归档' }, '🗄 归档来源');
  const dismiss = el('button', { class: 'dismiss', title: '保留两者(平行文档,不再标记)' }, '◫ 保留两者');
  const hint = el('span', { class: 'hint' });
  html(hint, '<kbd>a</kbd> 批准 · <kbd>r</kbd> 拒绝 · <kbd>j</kbd><kbd>k</kbd> 上/下一条');
  const note = el('span', { class: 'dim note', style: 'font-size:12.5px' });
  bar.append(approve, reject, edit, archiveBtn, dismiss, note, hint);
  reader.append(bar);
  reader.append(await decisionsPanel(rel));
  syncArchiveDisabled(); // normalize initial title; stays disabled until a loser is selected
  container.append(reader);

  async function act(action, targetPath, reason) {
    if (!reason) return;
    approve.disabled = reject.disabled = edit.disabled = archiveBtn.disabled = dismiss.disabled = true;
    note.textContent = '';
    try {
      const r = await apiPost('/api/review', {
        path: targetPath || rel, action, raws: group?.raws, reason,
      });
      note.textContent = ({
        approve: '已批准',
        reject: '已拒绝' + (r.result?.restored ? '(并恢复上一 approved 版)' : '(无历史 approved 版 → 普通拒绝,下次 sweep 归档)'),
        'archive-source': `已归档来源 ${r.result?.page || targetPath || ''}`,
        'dismiss-conflict': `已保留两者 — ${(group?.raws || []).join('、')} 不再标记`,
      })[action];
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
      approve.disabled = reject.disabled = edit.disabled = dismiss.disabled = false;
      syncArchiveDisabled(); // archive stays gated on an explicit loser selection
    }
  }
  approve.addEventListener('click', async () => {
    const reason = await promptReason('approve');
    if (reason) act('approve', null, reason);
  });
  reject.addEventListener('click', async () => {
    const reason = await promptReason('reject');
    if (reason) act('reject', null, reason);
  });
  edit.addEventListener('click', () => { location.hash = `#/page?path=${encodeURIComponent(rel)}`; });
  archiveBtn.addEventListener('click', async () => {
    if (!selectedLoser) { note.textContent = '请先在来源行点选要归档的来源(败方)'; return; }
    const reason = await promptReason('archive-source', `归档败方 ${selectedLoser}`);
    if (reason) act('archive-source', selectedLoser, reason);
  });
  dismiss.addEventListener('click', async () => {
    if (!group) { note.textContent = '当前候选不在冲突组内,无需保留两者'; return; }
    const reason = await promptReason('dismiss-conflict', '平行文档,保留两者');
    if (reason) act('dismiss-conflict', null, reason);
  });
}

export async function render(view, params) {
  // /api/queue is the queue's source of truth (P2-4 — no client-side filter
  // duplicating it); /api/tree only feeds the wikilink resolver
  const [treeData, queueData, planData, conflictsData] = await Promise.all([
    api('/api/tree'), api('/api/queue'), api('/api/plan').catch(() => null), api('/api/conflicts').catch(() => null),
  ]);
  setKnownPages(treeData.pages);
  queue = queueData.pages;
  for (const p of [...selected]) if (!queue.some((q) => q.path === p)) selected.delete(p);

  // F4 structure-findings banner: the queue is where users ACT on problems,
  // so dangling links / anomalies / errors / conflict groups / suppressed
  // tombstones surface here (live plan data, not run history — this also covers
  // partial changes from failed runs).
  if (planData) {
    const findings = [
      ...planData.dangling_links.map((d) => ({ text: `悬空链接 [[${d.link}]]`, page: d.page })),
      ...[...planData.anomalies, ...planData.errors].map((a) => ({
        text: `${a.title || a.raw || a.page} — ${a.reason || a.error || ''}`, page: a.page && String(a.page).startsWith('wiki/') ? a.page : null,
      })),
      ...(planData.conflicts || []).filter((g) => !g.dismissed).map((g) => ({
        text: `${g.category} 冲突组:${g.raws.join('、')}`, page: null,
      })),
      ...(planData.suppressed || []).map((s) => ({
        text: `已抑制(墓碑) ${s.raw} — ${s.detail || s.reason || ''}`, page: null,
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
  async function runBatch(action, reason) {
    if (!reason) return;
    approveBtn.disabled = rejectBtn.disabled = true;
    const paths = [...selected];
    try {
      const { results } = await apiPost('/api/review-batch', { paths, action, reason });
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
  approveBtn.addEventListener('click', async () => {
    const reason = await promptReason('approve', `批量批准 ${selected.size} 篇`);
    if (reason) runBatch('approve', reason);
  });
  rejectBtn.addEventListener('click', async () => {
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
    const reason = await promptReason('reject', `批量拒绝 ${selected.size} 篇`);
    if (reason) runBatch('reject', reason);
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
  if (queue.length) list.append(allRow); // batch controls are meaningless on an empty queue

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
  syncBatchBar(); // restore checkbox/batchbar state after a j/k remount (selected is module-scoped)

  const spacer = el('div');
  const content = el('div');
  wrap.append(list, content, spacer);
  view.append(wrap);

  bindQueueHotkeys(); // 'queue' scope — dies on route change (app.js resets to 'all')

  const target = params.get('path') || queue[0]?.path;
  if (target) {
    await renderReview(content, target, () => { location.hash = '#/queue'; }, conflictsData, planData?.suppressed);
  } else {
    html(content, `<div class="empty-state"><div class="big">队列已清空 🎉</div>
      所有候选都处理完了。下次治理产生新候选时,这里会出现它们。</div>`);
  }
}
