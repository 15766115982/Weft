// views/dashboard.js — D portal homepage: dossier summary strip (natural
// language), stat cards with icons, stale CTA (D5), governance timeline (D2).
import { api } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

const STAT = (ic, num, label) => `<div class="stat">
  <div class="stat-top"><span class="ic">${icon(ic, 14)}</span><span class="label">${esc(label)}</span></div>
  <div class="num">${esc(num)}</div></div>`;

export async function render(view) {
  const [h, log] = await Promise.all([
    api('/api/health'),
    api('/api/log', { limit: 12 }).catch(() => ({ entries: [] })),
  ]);

  // J8 first-use / empty-KB guidance: an action invitation, not a wall of
  // zeros (design-plan §2.7 — empty states invite the next step).
  if (h.pages.total === 0) {
    const guide = el('div', { class: 'welcome-card' });
    html(guide, `<div class="big">这座知识库还是空的</div>
      <p>三步让它运转起来:</p>
      <ol>
        <li><a href="#/acquire"><b>采集</b></a> — 拖入第一批文档,或配置 Jira / Confluence 源拉取;</li>
        <li><a href="#/govern"><b>治理</b></a> — 预览计划后发起 agent 运行:读取文档,起草摘要页与主题页,全部留候选;</li>
        <li><a href="#/queue"><b>评审</b></a> — 批准后页面进入检索,知识库开始可问。</li>
      </ol>`);
    view.append(guide);
    return;
  }

  // dossier: one natural-language paragraph instead of a wall of numbers
  const bits = [`共 <b>${h.pages.total}</b> 篇页面`];
  bits.push(`<b>${h.pages.byStatus.approved || 0}</b> 篇已批准(可检索)`);
  if (h.pages.byStatus.candidate) bits.push(`<b>${h.pages.byStatus.candidate}</b> 篇候选待评审`);
  if (h.plan.pending) bits.push(`<b>${h.plan.pending}</b> 篇 raw 待治理`);
  const last = log.entries.find((e) => e.actor === 'govern' || e.actor === 'review' || e.actor === 'acquire');
  const dossier = el('div', { class: 'dossier' });
  html(dossier, `这座知识库${bits.join(',')}${last ? `;最近一次动作是 <b>${esc(last.actor)}:${esc(last.action)}</b>(${esc(last.ts.slice(0, 10))})` : ''}。`);
  view.append(dossier);

  if (h.stale) {
    const ctaBits = [];
    if (h.plan.pending) ctaBits.push(`${h.plan.pending} 篇 raw 待治理`);
    if (h.plan.review_queue) ctaBits.push(`${h.plan.review_queue} 篇候选待评审`);
    if (h.plan.anomalies) ctaBits.push(`${h.plan.anomalies} 个异常`);
    const cta = el('div', { class: 'stale-cta' });
    html(cta, `${icon('circleAlert', 15)} <b>知识库不是最新:</b>${esc(ctaBits.join(','))}。
      去 <a href="#/govern">治理控制台</a> 预览计划并发起 agent 治理,或处理 <a href="#/queue">评审队列</a>。`);
    view.append(cta);
  }

  const cards = el('div', { class: 'cards' });
  html(cards, [
    STAT('library', h.pages.total, 'wiki 页面总数'),
    STAT('check', h.pages.byStatus.approved || 0, '已批准(可检索)'),
    STAT('circleAlert', h.pages.byStatus.candidate || 0, '候选(待评审)'),
    STAT('fileText', h.pages.byType.source || 0, '来源摘要页'),
    STAT('layers', h.pages.byType.topic || 0, '主题综合页'),
    STAT('fileX', h.plan.orphaned_pages, '孤儿页'),
    STAT('link2', h.plan.dangling_links, '悬空链接'),
    STAT('activity', h.plan.errors, '治理错误'),
  ].join(''));
  view.append(cards);

  // D1 done right: distribution by source SYSTEM (jira/confluence/local),
  // not by page type — "这座库的粮食从哪来"
  const bySource = (await api('/api/tree')).pages
    .filter((p) => p.source)
    .reduce((m, p) => { m[p.source] = (m[p.source] || 0) + 1; return m; }, {});
  if (Object.keys(bySource).length) {
    const bar = el('div', { class: 'dossier', style: 'margin-top:14px' });
    html(bar, `来源分布:${Object.entries(bySource)
      .map(([s, n]) => `<span class="via">${esc(s)}</span> <b>${n}</b> 页`).join(' · ')}`);
    view.append(bar);
  }

  if (log.entries.length) {
    const tl = el('div', { class: 'timeline' });
    tl.append(el('h3', {}, '最近动态'));
    let day = '';
    for (const e of log.entries) {
      const d = e.ts.slice(0, 10);
      if (d !== day) {
        day = d;
        const dh = el('div', { class: 'day' }, d);
        tl.append(dh);
      }
      const row = el('div', { class: 'row' });
      // demo journey: the target is clickable when it's a wiki page
      const targetHtml = e.target.startsWith('wiki/')
        ? `<a href="#/page?path=${encodeURIComponent(e.target)}">${esc(e.target)}</a>` : esc(e.target);
      html(row, `<span class="ts">${esc(e.ts.slice(11, 16))}</span>
        <span class="actor">${esc(e.actor)}</span>
        <span>${esc(e.action)} · ${targetHtml}${e.note ? ` · ${esc(e.note)}` : ''}</span>`);
      tl.append(row);
    }
    view.append(tl);
  }
}
