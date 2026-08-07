// views/upstream.js — Phase 3 upstream change detection: compare raw/ to the
// current upstream state without writing raw, then optionally pull.
import { api, apiPost, waitJob } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

const CONNECTORS = [
  { id: 'local', label: 'local', hint: 'inbox 文件 vs raw/local/' },
  { id: 'jira', label: 'jira', hint: 'JQL scope vs raw/jira/' },
  { id: 'confluence', label: 'confluence', hint: 'CQL scope vs raw/confluence/' },
];
const BUCKETS = [
  { key: 'new', label: '新增', cls: 'done' },
  { key: 'changed', label: '已变更', cls: 'running' },
  { key: 'removed_upstream', label: '上游已删除', cls: 'failed' },
  { key: 'error', label: '异常', cls: 'failed' },
  { key: 'unchanged', label: '未变化', cls: '' },
];

export async function render(view) {
  const wrap = el('div', { class: 'acquire upstream' });
  view.append(wrap);

  const cleanup = [];
  const on = (ev, fn) => { window.addEventListener(ev, fn); cleanup.push(() => window.removeEventListener(ev, fn)); };
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) { cleanup.forEach((f) => f()); obs.disconnect(); }
  }).observe(document.getElementById('view'), { childList: true });

  const status = el('p', { class: 'dim' }, '选择来源并运行 detect,查看当前 raw/ 与上游的差异。');
  const reportBox = el('div');
  const activeBox = el('div', { class: 'dim', style: 'font-size:12px;margin:8px 0' });

  async function loadReport() {
    try {
      const data = await api('/api/detect');
      renderReports(data.reports || []);
    } catch (err) {
      status.textContent = `读取 detect 报告失败:${err.message}`;
    }
  }

  function renderReports(reports) {
    reportBox.textContent = '';
    if (!reports.length) {
      reportBox.append(el('p', { class: 'dim' }, '还没有 detect 报告 — 点击下方按钮运行一次。'));
      return;
    }
    const order = CONNECTORS.map((c) => c.id);
    reports.sort((a, b) => order.indexOf(a.connector) - order.indexOf(b.connector));
    for (const r of reports) reportBox.append(renderReport(r));
  }

  function renderReport(data) {
    const box = el('div', { style: 'margin-bottom:16px' });
    const head = el('p', { class: 'dim', style: 'font-size:12px;margin:0 0 8px' });
    head.textContent = `报告来源:${esc(data.connector)} · 生成于 ${data.generated_at ? data.generated_at.slice(0, 19).replace('T', ' ') : '—'}`;
    box.append(head);

    const grid = el('div', { class: 'pull-grid' });
    for (const b of BUCKETS) {
      const items = data.detect[b.key] || [];
      const card = el('div', { class: 'pull-card' });
      const title = el('div', { class: 'pull-head' });
      html(title, `${b.cls ? `<span class="chip ${b.cls}">${items.length}</span>` : `<span class="chip">${items.length}</span>`} <b>${esc(b.label)}</b>`);
      card.append(title);
      const list = el('div', { style: 'max-height:220px;overflow:auto;font-size:12.5px' });
      if (!items.length) list.append(el('p', { class: 'dim' }, '无'));
      else {
        for (const it of items) {
          const row = el('div', { style: 'padding:3px 0;border-bottom:1px dashed var(--line)' });
          const id = it.id || it.source_id || '(unknown)';
          const extra = it.title ? ` — ${esc(it.title)}` : '';
          row.append(el('span', { class: 'mono' }, esc(id)), el('span', { class: 'dim' }, extra));
          if (it.upstream_version && it.local_version) {
            row.append(el('span', { class: 'dim', style: 'display:block' }, `${esc(it.local_version)} → ${esc(it.upstream_version)}`));
          }
          if (it.error) row.append(el('span', { class: 'dim', style: 'display:block;color:var(--del)' }, esc(it.error)));
          list.append(row);
        }
      }
      card.append(list);
      grid.append(card);
    }
    box.append(grid);

    const pullRow = el('div', { class: 'pull-actions', style: 'margin-top:10px' });
    const pullBtn = el('button', { class: 'primary' });
    html(pullBtn, `${icon('download', 14)} 拉取 ${esc(data.connector)} 全部`);
    const pullNote = el('span', { class: 'dim', style: 'font-size:12px' });
    pullBtn.addEventListener('click', async () => {
      pullNote.textContent = '已入队…';
      try {
        const { job } = await apiPost('/api/pull', { connector: data.connector });
        pullNote.textContent = `拉取作业 ${job.id} 已入队 — 完成后见采集页作业中心`;
      } catch (err) { pullNote.textContent = `失败:${err.message}`; }
    });
    pullRow.append(pullBtn, pullNote);
    box.append(pullRow);
    return box;
  }

  function connectorCard(c) {
    const card = el('div', { class: 'pull-card' });
    const head = el('div', { class: 'pull-head' });
    html(head, `${icon(c.id === 'local' ? 'inbox' : 'database', 15)} <b>${esc(c.label)}</b> <span class="dim" style="font-size:12px">${esc(c.hint)}</span>`);
    card.append(head);
    const row = el('div', { class: 'pull-actions' });
    const btn = el('button', { class: 'primary sm' });
    html(btn, `${icon('search', 13)} 检测`);
    const note = el('span', { class: 'dim', style: 'font-size:12px' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      note.textContent = '已入队 detect 作业…';
      activeBox.textContent = `${esc(c.label)} detect 运行中…`;
      try {
        const { job } = await apiPost('/api/detect', { connector: c.id });
        note.textContent = `作业 ${job.id} 运行中…`;
        await waitJob(job.id, { timeout: 120000 });
        note.textContent = '完成,刷新报告…';
        activeBox.textContent = '';
        await loadReport(); // the CLI wrote the report — re-read the merged state
      } catch (err) {
        note.textContent = `失败:${err.message}`;
        activeBox.textContent = '';
      } finally {
        btn.disabled = false;
      }
    });
    row.append(btn, note);
    card.append(row);
    return card;
  }

  const cards = el('div', { class: 'pull-grid' });
  for (const c of CONNECTORS) cards.append(connectorCard(c));

  const sec = (titleHtml, ...nodes) => {
    const s = el('section', { class: 'acq-sec' });
    const h = el('h2');
    html(h, titleHtml);
    s.append(h, ...nodes);
    return s;
  };
  wrap.append(
    sec(`${icon('search', 16)} 上游检测 <span class="dim">detect · 只读,不写 raw/</span>`, status, cards, activeBox),
    sec(`${icon('activity', 16)} 检测报告`, reportBox),
  );
  await loadReport();
}
