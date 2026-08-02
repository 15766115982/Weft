// views/acquire.js — M7b acquisition console: E upload (dropzone → inbox →
// acquire), F source pull (jira/confluence param overrides), J5 auth check,
// J6 source freshness, J4 inbox management, I6 job center (live via SSE).
// All writes are queued server-side (S10); this view never blocks on them —
// it enqueues (202) and lets SSE 'ui:job' events refresh the job center.
import { api, apiPost, apiUpload } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';

const fmtBytes = (n) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
const fmtTime = (iso) => iso ? iso.slice(0, 16).replace('T', ' ') : '—';
// J6 滞后信号:相对时间 + 逾期阈值(>7 天琥珀)
const fmtAgo = (iso) => {
  if (!iso) return { text: '—', stale: false };
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  const text = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
  return { text, stale: days > 7 };
};
const fmtDur = (a, b) => {
  if (!a || !b) return '';
  const s = (new Date(b) - new Date(a)) / 1000;
  return s < 1 ? '<1s' : s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
};

export async function render(view) {
  const wrap = el('div', { class: 'acquire' });
  view.append(wrap);

  // Live refresh hooks: app.js dispatches these from the SSE stream.
  const onJob = () => loadJobs();
  const onChange = () => { loadInbox(); loadSources(); loadJobs(); };
  window.addEventListener('ui:job', onJob);
  window.addEventListener('ui:kb-change', onChange);
  // views are replaced on route change; window listeners would leak
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) {
      window.removeEventListener('ui:job', onJob);
      window.removeEventListener('ui:kb-change', onChange);
      obs.disconnect();
    }
  }).observe(document.getElementById('view'), { childList: true });

  // ============================== E: upload ==============================
  const drop = el('div', { class: 'dropzone', tabindex: '0' });
  html(drop, `${icon('upload', 22)}<div><b>拖文件到这里,或点击选择</b><br>
    <span class="dim">写入 inbox/ 暂存区并立即运行 acquire local → 落 raw/local/(单一入队作业)</span></div>`);
  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  const uploadNote = el('p', { class: 'dim', style: 'font-size:12.5px;margin:8px 0 0' });
  const uploadFiles = async (files) => {
    let okCount = 0;
    const failures = [];
    for (const f of files) {
      try {
        uploadNote.textContent = `入队中:${f.name}(${fmtBytes(f.size)})…(${okCount}/${files.length})`;
        await apiUpload(f);
        okCount++;
      } catch (err) { failures.push(`${f.name}: ${err.message}`); }
    }
    // P3: one aggregate line — per-file notes used to overwrite each other
    uploadNote.textContent = okCount
      ? `${okCount} 个文件已入队 — 作业进展见下方作业中心${files.length > 1 ? '(同名文件会覆盖暂存区旧件)' : ''}`
      : '';
    if (failures.length) uploadNote.textContent += `;失败:${failures.join('; ')}`;
  };
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileInput.click(); });
  fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));
  for (const ev of ['dragover', 'dragenter']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));

  // ============================== F: source pull ==============================
  const pullCard = (connector, title, hint, scopeFields) => {
    const card = el('div', { class: 'pull-card' });
    const head = el('div', { class: 'pull-head' });
    html(head, `${icon(connector === 'local' ? 'inbox' : 'database', 15)} <b>${esc(title)}</b>
      <span class="dim" style="font-size:12px">${esc(hint)}</span>`);
    card.append(head);
    const inputs = {};
    for (const f of scopeFields) {
      const lab = el('label', { class: 'pull-field' }, f.label);
      const inp = el('input', { placeholder: f.ph });
      lab.append(inp);
      card.append(lab);
      inputs[f.key] = inp;
    }
    const row = el('div', { class: 'pull-actions' });
    const go = el('button', { class: 'primary sm' });
    html(go, `${icon('play', 13)} 拉取`);
    const note = el('span', { class: 'dim', style: 'font-size:12px' });
    go.addEventListener('click', async () => {
      note.textContent = '已入队…';
      try {
        const body = { connector };
        if (inputs.jql?.value.trim()) body.jql = inputs.jql.value.trim();
        if (inputs.cql?.value.trim()) body.cql = inputs.cql.value.trim();
        if (inputs.max?.value.trim()) body.max = inputs.max.value.trim();
        const { job } = await apiPost('/api/pull', body);
        note.textContent = `作业 ${job.id} 已入队 — 完成后见作业中心与 raw/ 树`;
      } catch (err) { note.textContent = `失败:${err.message}`; }
    });
    row.append(go, note);
    if (connector !== 'local') {
      // J5: auth probe (acquire --check), read-only, result inline
      const chk = el('button', { class: 'sm' });
      html(chk, `${icon('shieldCheck', 13)} 认证检查`);
      chk.addEventListener('click', async () => {
        note.textContent = '检查中…';
        try {
          const r = await apiPost('/api/authcheck', { connector });
          const me = r.myself?.displayName || r.myself?.name || r.myself?.username;
          note.textContent = me ? `认证正常:${me}` : `返回:${JSON.stringify(r).slice(0, 120)}`;
        } catch (err) { note.textContent = `认证失败:${err.message}`; }
      });
      row.insertBefore(chk, note);
    }
    card.append(row);
    return card;
  };

  const pulls = el('div', { class: 'pull-grid' });
  pulls.append(
    pullCard('local', 'local · inbox 采集', '把 inbox/ 暂存文件落进 raw/local/', []),
    pullCard('jira', 'jira · JQL 拉取', '留空则用 kb.json 的 scope', [
      { key: 'jql', label: 'JQL 覆盖', ph: 'project = PAY AND updated >= -7d' },
      { key: 'max', label: 'max', ph: '50' },
    ]),
    pullCard('confluence', 'confluence · CQL 拉取', '留空则用 kb.json 的 scope', [
      { key: 'cql', label: 'CQL 覆盖', ph: 'space = "KB" AND type = page' },
      { key: 'max', label: 'max', ph: '50' },
    ]),
  );

  // ============================== J6: freshness ==============================
  const srcTable = el('div');
  async function loadSources() {
    const { sources } = await api('/api/sources').catch(() => ({ sources: [] }));
    srcTable.textContent = '';
    if (!sources.length) { srcTable.append(el('p', { class: 'dim' }, 'kb.json 还没有配置任何连接器。')); return; }
    for (const s of sources) {
      const row = el('div', { class: 'src-row' });
      const r = s.lastRun;
      const ago = r ? fmtAgo(r.ts) : null;
      const counts = r ? ['created', 'updated', 'unchanged', 'errors'].filter((k) => r[k]).map((k) => `${k} ${r[k]}`).join(' · ') : '';
      html(row, `<span class="via">${esc(s.connector)}</span>
        <span class="dim scope">${esc(s.scope || '(无 scope)')}</span>
        <span class="grow"></span>
        ${r ? `<span class="${ago.stale ? 'ago-stale' : 'mono'}">${esc(ago.text)}</span> <span class="dim">${esc(counts || '全部跳过')}</span>`
            : '<span class="dim">从未拉取</span>'}`);
      srcTable.append(row);
    }
  }

  // ============================== J4: inbox ==============================
  const inboxBox = el('div');
  async function loadInbox() {
    const { files } = await api('/api/inbox').catch(() => ({ files: [] }));
    inboxBox.textContent = '';
    if (!files.length) { inboxBox.append(el('p', { class: 'dim' }, '暂存区为空 — 拖文件到上方即可。')); return; }
    for (const f of files) {
      const row = el('div', { class: 'inbox-row' });
      html(row, `${icon('fileText', 13)} <span class="t">${esc(f.name)}</span>
        <span class="dim">${fmtBytes(f.size)} · ${esc(fmtTime(f.mtime))}</span>`);
      const del = el('button', { class: 'icon-btn danger', title: '从暂存区移除(物理删除,不可恢复)' });
      html(del, icon('trash2', 13));
      del.addEventListener('click', async () => {
        try { await apiPost('/api/inbox-delete', { name: f.name }); }
        catch (err) { alert(`移除失败:${err.message}`); }
      });
      row.append(del);
      inboxBox.append(row);
    }
  }

  // ============================== I6: job center ==============================
  const jobBox = el('div');
  const STATUS_CHIP = { queued: '排队中', running: '运行中', done: '完成', failed: '失败' };
  async function loadJobs() {
    const { jobs } = await api('/api/jobs').catch(() => ({ jobs: [] }));
    jobBox.textContent = '';
    if (!jobs.length) { jobBox.append(el('p', { class: 'dim' }, '还没有作业 — 上传或拉取会在这里留下记录。')); return; }
    for (const j of jobs.slice(0, 30)) {
      const det = el('details', { class: `job ${j.status}` });
      const sum = el('summary');
      html(sum, `<span class="chip ${esc(j.status)}">${STATUS_CHIP[j.status] || esc(j.status)}</span>
        <span class="t">${esc(j.label)}</span>
        <span class="grow"></span><span class="mono dim">${esc(fmtDur(j.startedAt, j.finishedAt))}</span>
        <span class="mono dim">${esc(fmtTime(j.createdAt))}</span>`);
      det.append(sum);
      const body = el('div', { class: 'job-body' });
      if (j.error) body.append(el('pre', { class: 'error' }, j.error));
      if (j.result) body.append(el('pre', {}, typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 2)));
      if (j.log && !j.result) body.append(el('pre', {}, j.log));
      det.append(body);
      jobBox.append(det);
    }
  }

  // ============================== assemble ==============================
  const sec = (titleHtml, ...nodes) => {
    const s = el('section', { class: 'acq-sec' });
    const h = el('h2');
    html(h, titleHtml);
    s.append(h, ...nodes);
    return s;
  };
  wrap.append(
    sec(`${icon('upload', 16)} 上传采集 <span class="dim">E</span>`, drop, fileInput, uploadNote),
    sec(`${icon('database', 16)} 源拉取控制台 <span class="dim">F · 认证检查 J5</span>`, pulls),
    sec(`${icon('clock', 16)} 来源新鲜度 <span class="dim">J6</span>`, srcTable),
    sec(`${icon('inbox', 16)} inbox 暂存区 <span class="dim">J4</span>`, inboxBox),
    sec(`${icon('activity', 16)} 作业中心 <span class="dim">I6 · 每个 KB 写操作串行执行(S10)</span>`, jobBox),
  );
  await Promise.all([loadSources(), loadInbox(), loadJobs()]);
}
