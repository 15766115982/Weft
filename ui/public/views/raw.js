// views/raw.js — Phase 3 minimal raw/ browser: list every raw doc by source
// system, show identity tuple, link to raw page viewer, and flag orphans.
import { api } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

export async function render(view) {
  const wrap = el('div', { class: 'acquire raw' });
  view.append(wrap);

  const cleanup = [];
  const on = (ev, fn) => { window.addEventListener(ev, fn); cleanup.push(() => window.removeEventListener(ev, fn)); };
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) { cleanup.forEach((f) => f()); obs.disconnect(); }
  }).observe(document.getElementById('view'), { childList: true });

  const listBox = el('div');
  const detail = el('div', { class: 'plan-list', style: 'margin-top:12px' });

  async function load() {
    const [{ docs }] = await Promise.all([
      api('/api/rawlist').catch(() => ({ docs: [] })),
    ]);
    listBox.textContent = '';
    if (!docs.length) {
      listBox.append(el('p', { class: 'dim' }, 'raw/ 目录为空 — 去采集页上传或拉取。'));
      return;
    }
    // group by source
    const bySource = new Map();
    for (const d of docs) {
      if (!bySource.has(d.source)) bySource.set(d.source, []);
      bySource.get(d.source).push(d);
    }

    for (const [source, items] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sec = el('details', { open: true });
      const sum = el('summary');
      html(sum, `${icon('database', 14)} <b>${esc(source)}</b> <span class="dim">${items.length}</span>`);
      sec.append(sum);
      for (const d of items) {
        const row = el('div', { class: 'plan-item', style: 'cursor:pointer' });
        html(row, `<span class="mono">${esc(d.source_id)}</span>
          <span class="t">${esc(d.title)}</span>
          <span class="grow"></span>
          <span class="dim mono" style="font-size:11px">${esc(d.source_version || '').slice(0, 19)}</span>`);
        row.addEventListener('click', () => showDetail(d.path));
        sec.append(row);
      }
      listBox.append(sec);
    }
  }

  async function showDetail(rawPath) {
    detail.textContent = '加载中…';
    try {
      const data = await api('/api/raw', { path: rawPath });
      detail.textContent = '';
      const head = el('h3');
      html(head, `${icon('fileText', 14)} ${esc(data.fields?.title || rawPath)}`);
      const meta = el('pre', { style: 'font-size:12px' });
      meta.textContent = JSON.stringify({
        path: rawPath,
        source: data.fields?.source,
        source_id: data.fields?.source_id,
        source_url: data.fields?.source_url,
        source_version: data.fields?.source_version,
        pulled_at: data.fields?.pulled_at,
      }, null, 2);
      const body = el('article', { class: 'markdown-body' });
      html(body, marked.parse(data.body || ''));
      const refs = await api('/api/rawrefs', { path: rawPath }).catch(() => ({ pages: [] }));
      const refLine = el('p', { class: 'dim', style: 'font-size:12px' });
      refLine.textContent = refs.pages.length
        ? `${refs.pages.length} 个 wiki 页面引用此 raw`
        : '没有 wiki 页面引用此 raw(孤儿)';
      detail.append(head, meta, refLine, body);
    } catch (err) {
      detail.textContent = `加载失败:${err.message}`;
    }
  }

  const sec = (titleHtml, ...nodes) => {
    const s = el('section', { class: 'acq-sec' });
    const h = el('h2');
    html(h, titleHtml);
    s.append(h, ...nodes);
    return s;
  };
  wrap.append(
    sec(`${icon('folderGit-2', 16)} raw/ 来源管理 <span class="dim">read-only · 删除/移动请去采集控制台</span>`, listBox),
    sec(`${icon('fileText', 16)} raw 详情`, detail),
  );
  await load();
  on('ui:kb-change', load);
}
