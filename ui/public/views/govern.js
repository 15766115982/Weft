// views/govern.js — M7c governance console: I5 plan-as-preview (confirm page
// before any agent run), I1 mechanical steps (sweep / rebuild-index /
// merge-topic), I2/I4 agent run launcher with a live transcript (SSE 'run').
// Everything mutating goes through the serial queue; this view never blocks.
import { api, apiPost } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

export async function render(view) {
  const wrap = el('div', { class: 'acquire govern' });
  view.append(wrap);

  const cleanup = [];
  const on = (ev, fn) => {
    window.addEventListener(ev, fn);
    cleanup.push(() => window.removeEventListener(ev, fn));
  };
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) { cleanup.forEach((f) => f()); obs.disconnect(); }
  }).observe(document.getElementById('view'), { childList: true });

  // ============================== I5: plan-as-preview ==============================
  const planBox = el('div');
  const ctaRow = el('div', { class: 'govern-cta' });
  let lastPlan = null;

  const REASON = { new: '新文档', stale: '已更新', 'hash-changed-version-unchanged': '哈希异动' };
  function listSection(title, items, renderItem, emptyText) {
    const box = el('div', { class: 'plan-list' });
    box.append(el('h3', {}, `${title} (${items.length})`));
    if (!items.length) box.append(el('p', { class: 'dim' }, emptyText));
    else for (const it of items.slice(0, 50)) box.append(renderItem(it));
    if (items.length > 50) box.append(el('p', { class: 'dim' }, `…共 ${items.length} 条,余下在 CLI plan 输出中`));
    return box;
  }

  async function loadPlan() {
    const [plan, h] = await Promise.all([api('/api/plan'), api('/api/health').catch(() => null)]);
    lastPlan = plan;
    planBox.textContent = '';
    // F1: last agent-governance run summary (from .kb/govern_runs.jsonl)
    if (h && h.lastGovernRun) {
      const r = h.lastGovernRun;
      const LABEL = { complete: '✓ 完成', failed: '✗ 失败', cancelled: '■ 已取消', interrupted: '⚠ 中断(需重跑)', running: '… 进行中' };
      const line = el('p', { class: 'dim', style: 'font-size:11.5px;margin:0 0 4px' });
      line.textContent = `上次 agent 治理:${LABEL[r.status] || r.status} · ${r.ts.slice(0, 16).replace('T', ' ')}`
        + `${r.durationMs != null ? ` · 耗时 ${Math.round(r.durationMs / 1000)}s` : ''}${r.noop ? ' · 无变更' : ''}`;
      planBox.append(line);
    }
    // I5 freshness (M7c review): the preview is a confirm page — say how old it is
    const stamp = el('p', { class: 'dim', style: 'font-size:11.5px;margin:0 0 4px;text-align:right' },
      `计划清单刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}(KB 有变更时自动刷新)`);
    planBox.append(stamp);
    const item = (primary, secondaryHtml) => {
      const row = el('div', { class: 'plan-item' });
      html(row, `<span class="t">${esc(primary)}</span>${secondaryHtml || ''}`);
      return row;
    };
    planBox.append(
      listSection('待治理 raw', lastPlan.pending, (p) =>
        item(p.title || p.raw, `<span class="chip ${p.reason === 'new' ? 'done' : 'running'}">${REASON[p.reason] || esc(p.reason)}</span><span class="dim mono">${esc(p.raw)}</span>`),
        '没有待治理的 raw — 知识库是最新的。'),
      listSection('评审队列', lastPlan.review_queue, (p) =>
        item(p.title || p.page, `<a href="#/page?path=${encodeURIComponent(p.page)}">去评审</a>`),
        '队列为空。'),
      listSection('孤儿页', lastPlan.orphaned_pages, (p) =>
        item(p.title || p.page, `<span class="dim mono">缺 ${esc(p.missing_raw)}</span>`),
        '没有孤儿页。'),
      listSection('异常', [...lastPlan.anomalies, ...lastPlan.errors], (p) =>
        item(p.title || p.raw || p.page, `<span class="chip failed">${esc(p.reason || p.error || '')}</span>`),
        '没有异常。'),
    );
    renderCta();
  }

  function renderCta() {
    ctaRow.textContent = '';
    const n = lastPlan.pending.length;
    const q = lastPlan.review_queue.length;
    const summary = el('p', { class: 'dim', style: 'margin:0' });
    summary.textContent = n || q
      ? `将要发生:${n} 篇 raw 生成/更新来源摘要,主题综合由 agent 评估;${q} 篇候选等人工评审(agent 不会替你批准)。`
      : '计划清单全空 — 没有需要治理的内容。';
    const go = el('button', { class: 'primary' });
    html(go, `${icon('sparkles', 14)} 发起 agent 治理`);
    go.disabled = n === 0 && q === 0;
    go.title = go.disabled ? '计划为空,无需治理' : '以当前计划清单为上下文启动 headless agent';
    go.addEventListener('click', () => startRunPanel());
    ctaRow.append(summary, go);
  }

  // ============================== I2/I4: agent run + live transcript ==============================
  const runPanel = el('div', { class: 'run-panel', hidden: '' });
  let currentRunId = null;

  let skillPath = null, repoRoot = null;
  api('/api/govern-context').then((c) => { skillPath = c.skillPath; repoRoot = c.repoRoot; }).catch(() => {});

  function defaultPrompt() {
    const lines = lastPlan.pending.slice(0, 30).map((p) => `- ${p.raw} (${p.reason})`);
    return [
      // skillPath first: registration-independent (e2e finding — a headless
      // executor may not have kb-govern registered, but the file is canonical)
      skillPath
        ? `First read the skill instructions at ${skillPath} and follow them exactly.`
        : 'Use the kb-govern skill on this knowledge base (cwd IS the KB root).',
      'Process the current plan for this knowledge base (cwd IS the KB root):',
      'write English source-summary pages for each pending raw via apply-source,',
      'then evaluate topic synthesis (apply-topic) where cross-source themes exist.',
      // real-env finding 2026-08-04: the allow-list matches bare node commands
      // ONLY — pipes/heredocs/stdin are auto-denied, so the body must go
      // through a scratch file the agent writes with its file tools.
      'Page bodies go via --body-file: WRITE each summary/synthesis to a scratch file inside the KB',
      '(e.g. .kb/bodies/<page>.md) with your file tools, then run apply-source/apply-topic with',
      '--body-file <that path>. Never use pipes, heredocs or stdin redirection — they are auto-denied.',
      'Leave every page as candidate — a human reviews and approves. Do not approve or merge anything.',
      // B layer (P2-2 ruling ⑧): the prompt states the confinement out loud;
      // the acceptEdits boundary + allow-list enforce it underneath.
      'Permission confinement is active: create or edit files ONLY inside this KB (your cwd) — writes outside it are denied.',
      repoRoot ? `Run service scripts exactly as: node ${repoRoot}/<service>/scripts/<name>.mjs (forward slashes; other command forms are denied).` : '',
      lines.length ? `\nPending raws (from plan):\n${lines.join('\n')}` : '',
      '\nWhen done, output one short paragraph summarizing what you created or changed.',
    ].join('\n');
  }

  function startRunPanel() {
    runPanel.hidden = false;
    const ta = runPanel.querySelector('textarea');
    ta.value = defaultPrompt();
    runPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function buildRunPanel() {
    const head = el('h2');
    html(head, `${icon('sparkles', 16)} agent 治理运行 <span class="dim">I2 · 执行器:headless claude(acceptEdits + 仓库限定 · P2-2 加固)· 全程串行入队</span>`);
    const helper = el('p', { class: 'dim', style: 'font-size:12px;margin:0 0 6px' },
      '下面是给 agent 的完整指令(已含计划快照与"全部留 candidate"约束),通常不用改。');
    const ta = el('textarea', { rows: '10', class: 'run-prompt' });
    const row = el('div', { class: 'pull-actions' });
    const go = el('button', { class: 'primary sm' });
    html(go, `${icon('play', 13)} 启动运行`);
    const note = el('span', { class: 'dim', style: 'font-size:12px' });
    const transcript = el('pre', { class: 'run-transcript', hidden: '' });
    go.addEventListener('click', async () => {
      if (!ta.value.trim()) { note.textContent = '提示词为空'; return; }
      go.disabled = true;
      transcript.hidden = false;
      transcript.textContent = '';
      runPanel.querySelector('.findings-card')?.remove(); // F4: clear last run's card
      try {
        const { job } = await apiPost('/api/govern-run', { prompt: ta.value });
        currentRunId = job.id;
        note.textContent = `作业 ${job.id} 已入队 — 流式输出如下(全部写操作与其他作业串行)`;
      } catch (err) {
        note.textContent = `启动失败:${err.message}`;
        go.disabled = false;
      }
    });
    on('ui:run', (e) => {
      const d = e.detail;
      if (!currentRunId || d.jobId !== currentRunId) return;
      // P3: bound the DOM growth the way the server bounds job.log (64KB)
      transcript.textContent = (transcript.textContent + d.chunk).slice(-64 * 1024);
      transcript.scrollTop = transcript.scrollHeight;
    });
    on('ui:job', (e) => {
      const j = e.detail;
      if (!currentRunId || j.id !== currentRunId) return;
      if (j.status === 'done') {
        html(note, `运行完成 — <a href="#/queue">去评审队列</a> 批准候选页,wiki 变化见浏览页`);
        go.disabled = false;
        renderFindings(j.result);
        loadPlan(); // P3: close the loop — pending should read zero now
      }
      if (j.status === 'failed') { note.textContent = `运行失败:${j.error || ''}`; go.disabled = false; }
      if (j.status === 'cancelled') { note.textContent = '运行已取消'; go.disabled = false; }
    });
    runPanel.append(head, helper, ta, row, transcript);
    row.append(go, note);
  }

  // F4 findings card: deterministic post-run plan() attached to the job
  // result by the server (govern.mjs). Structure problems get surfaced here
  // right after the run — and dangling links are actionable (jump to the
  // page that contains the bad link).
  function renderFindings(result) {
    runPanel.querySelector('.findings-card')?.remove();
    if (!result || !result.postPlan) return;
    const pp = result.postPlan;
    const card = el('div', { class: 'plan-list findings-card', style: 'margin-top:10px' });
    const titleBits = [];
    if (result.noop) titleBits.push('本次治理无 wiki 变更');
    const counts = Object.entries(pp.counts).filter(([, n]) => n > 0);
    titleBits.push(counts.length
      ? counts.map(([k, n]) => `${{ dangling_links: '悬空链接', anomalies: '异常', errors: '错误', orphaned_pages: '孤儿页' }[k]} ${n}`).join(' · ')
      : '结构校验通过');
    card.append(el('h3', {}, `治理后校验 — ${titleBits.join(' · ')}`));
    const row = (primary, secondaryHtml) => {
      const r = el('div', { class: 'plan-item' });
      html(r, `<span class="t">${esc(primary)}</span>${secondaryHtml || ''}`);
      return r;
    };
    for (const d of pp.dangling_links) {
      card.append(row(`[[${d.link}]]`, ` <a href="#/page?path=${encodeURIComponent(d.page)}">${esc(d.page)}</a>`));
    }
    for (const a of [...pp.anomalies, ...pp.errors]) {
      card.append(row(a.title || a.raw || a.page, ` <span class="chip failed">${esc(a.reason || a.error || '')}</span>`));
    }
    for (const o of pp.orphaned_pages) {
      card.append(row(o.title || o.page, ` <span class="dim mono">缺 ${esc(o.missing_raw)}</span>`));
    }
    runPanel.append(card);
  }
  buildRunPanel();

  // ============================== I1: mechanical steps ==============================
  const mechNote = el('span', { class: 'dim', style: 'font-size:12px' });
  async function runMech(body, label) {
    mechNote.textContent = `${label} 已入队…`;
    try {
      const { job } = await apiPost('/api/govern', body);
      mechNote.textContent = `${label} → 作业 ${job.id},结果见采集页作业中心`;
    } catch (err) { mechNote.textContent = `${label} 失败:${err.message}`; }
  }
  const mech = el('div', { class: 'pull-grid' });
  const sweepCard = el('div', { class: 'pull-card' });
  html(sweepCard, `<div class="pull-head">${icon('history', 15)} <b>sweep</b><span class="dim" style="font-size:12px">日志回填 + rejected 归档(幂等)</span></div>`);
  const sweepBtn = el('button', { class: 'primary sm' });
  html(sweepBtn, `${icon('play', 13)} 运行 sweep`);
  sweepBtn.addEventListener('click', () => runMech({ action: 'sweep' }, 'sweep'));
  sweepCard.append(sweepBtn);

  const reindexCard = el('div', { class: 'pull-card' });
  html(reindexCard, `<div class="pull-head">${icon('search', 15)} <b>rebuild-index</b><span class="dim" style="font-size:12px">重建检索索引(FTS5 全量)</span></div>`);
  const reindexBtn = el('button', { class: 'primary sm' });
  html(reindexBtn, `${icon('play', 13)} 重建索引`);
  reindexBtn.addEventListener('click', () => runMech({ action: 'rebuild-index' }, 'rebuild-index'));
  reindexCard.append(reindexBtn);

  const mergeCard = el('div', { class: 'pull-card' });
  html(mergeCard, `<div class="pull-head">${icon('layers', 15)} <b>merge-topic</b><span class="dim" style="font-size:12px">合并两个主题页(回链改写+溯源并集)</span></div>`);
  const fromIn = el('input', { placeholder: 'from slug' });
  const toIn = el('input', { placeholder: 'to slug' });
  const mergeBtn = el('button', { class: 'primary sm' });
  html(mergeBtn, `${icon('play', 13)} 合并`);
  // M7c review P3: merge is as irreversible as raw delete — same confirmation
  // discipline, as a two-click arm (no modal duplication).
  let armed = false;
  mergeBtn.addEventListener('click', () => {
    if (!fromIn.value.trim() || !toIn.value.trim()) { mechNote.textContent = 'merge-topic 需要 from/to 两个 slug'; return; }
    if (!armed) {
      armed = true;
      mergeBtn.textContent = `确认合并 ${fromIn.value.trim()} → ${toIn.value.trim()}?(回链改写不可逆)`;
      mergeBtn.classList.add('danger-solid');
      setTimeout(() => { armed = false; html(mergeBtn, `${icon('play', 13)} 合并`); mergeBtn.classList.remove('danger-solid'); }, 5000);
      return;
    }
    armed = false;
    runMech({ action: 'merge-topic', from: fromIn.value.trim(), to: toIn.value.trim() }, 'merge-topic');
  });
  const mergeRow = el('div', { class: 'pull-actions' });
  mergeRow.append(fromIn, toIn, mergeBtn);
  mergeCard.append(mergeRow);
  mech.append(sweepCard, reindexCard, mergeCard);

  // ============================== F3: GOVERNANCE.md brief editor ==============================
  // The user-owned governance brief. Server-side injected into every agent
  // prompt (buildGovernPrompt) — editing here steers the next run. Same
  // optimistic-lock 409 discipline as the wiki page editor (browse.js).
  // (sec() is defined in the assemble section below; briefSec is built there.)
  const DEFAULT_TEMPLATE = [
    '# 治理纲要',
    '',
    '## 治理范围',
    '(哪些来源/主题优先治理,哪些可以暂缓)',
    '',
    '## 优先级',
    '(例:API 文档与故障排查优先,会议记录从简)',
    '',
    '## 页面粒度偏好',
    '(例:主题页宁少勿多,相近主题合并;来源页保持 1:1)',
    '',
    '## 语言约定',
    '(wiki 页面语言、标题风格的偏好)',
  ].join('\n');

  const briefBox = el('div');
  let briefHash = null;
  const briefTa = el('textarea', { rows: '10', class: 'run-prompt', spellcheck: 'false' });
  const briefNote = el('span', { class: 'dim', style: 'font-size:12px' });
  const briefSave = el('button', { class: 'primary sm' }, '保存纲要');
  const briefTpl = el('button', { class: 'sm' }, '插入模板');
  const briefRow = el('div', { class: 'pull-actions' });
  briefRow.append(briefSave, briefTpl, briefNote);

  async function loadBrief() {
    try {
      const f = await api('/api/kbfile', { path: 'GOVERNANCE.md' });
      briefHash = f.hash;
      briefTa.value = f.body;
      briefNote.textContent = `已加载(${f.body.length} 字符)`;
    } catch {
      briefHash = null; // 404 → not created yet
      briefTa.value = '';
      briefTa.placeholder = '还没有治理纲要 — 点「插入模板」起草,或直接从空白写起。';
      briefNote.textContent = 'GOVERNANCE.md 尚未创建,保存即创建。';
    }
  }

  briefTpl.addEventListener('click', () => {
    briefTa.value = DEFAULT_TEMPLATE;
    briefNote.textContent = '模板已填入(未保存)——按你的库改一改再保存。';
  });

  async function saveBrief(baseHash) {
    briefSave.disabled = true;
    briefNote.textContent = '保存中…';
    try {
      await apiPost('/api/kbfile-edit', { path: 'GOVERNANCE.md', body: briefTa.value, base_hash: baseHash });
      const fresh = await api('/api/kbfile', { path: 'GOVERNANCE.md' });
      briefHash = fresh.hash;
      briefNote.textContent = '已保存 — 下次 agent 治理运行生效。';
    } catch (err) {
      if (/^edit conflict:/.test(err.message)) { showBriefConflict(); return; }
      briefNote.textContent = `保存失败:${err.message}`;
    } finally {
      briefSave.disabled = false;
    }
  }

  function showBriefConflict() {
    const card = el('div', { class: 'conflict-card' });
    card.append(el('p', {}, '保存被拒绝:纲要在编辑期间被外部改动过。你的编辑还在文本框里。'));
    const reload = el('button', { class: 'sm danger' }, '放弃我的修改,查看最新');
    const force = el('button', { class: 'sm' }, '以我为准,强制覆盖');
    const cNote = el('span', { class: 'dim', style: 'font-size:12.5px' });
    reload.addEventListener('click', async () => { card.remove(); await loadBrief(); });
    force.addEventListener('click', async () => {
      cNote.textContent = '取最新版本号…';
      const fresh = await api('/api/kbfile', { path: 'GOVERNANCE.md' }); // re-base, one locked retry
      card.remove();
      await saveBrief(fresh.hash);
    });
    const btnRow = el('div', { style: 'display:flex;gap:10px;align-items:center' });
    btnRow.append(reload, force, cNote);
    card.append(btnRow);
    briefRow.after(card);
  }

  briefSave.addEventListener('click', () => saveBrief(briefHash));
  loadBrief();

  // ============================== assemble ==============================
  const sec = (titleHtml, ...nodes) => {
    const s = el('section', { class: 'acq-sec' });
    const h = el('h2');
    html(h, titleHtml);
    s.append(h, ...nodes);
    return s;
  };
  const briefSec = sec(`${icon('fileText', 16)} 治理纲要 <span class="dim">GOVERNANCE.md · 用户所有 · 每次 agent 运行时由服务端注入提示词前部,agent 无权修改此文件</span>`,
    el('p', { class: 'dim', style: 'font-size:12px;margin:0 0 6px' },
      '写给治理 agent 的常驻指令:范围、优先级、页面粒度、语言约定。与下方单次提示词的关系 = 宪法与本期任务。'),
    briefTa, briefRow);
  wrap.append(
    sec(`${icon('listChecks', 16)} 治理预览(plan-as-preview)<span class="dim">I5 · plan 是只读纯脚本,这里看到的就是将要发生的</span>`, planBox, ctaRow),
    briefSec,
    runPanel,
    sec(`${icon('activity', 16)} 机械步骤 <span class="dim">I1 · approve/reject 在评审队列页</span>`, mech, el('p', { style: 'margin:8px 0 0' }, mechNote)),
  );
  await loadPlan();
  on('ui:kb-change', loadPlan);
}
