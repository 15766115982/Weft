// views/browse.js — A browsing: resizable/segmented tree + icon rail (P1-1/6/7/8),
// centered reader (archive card), tabbed context panel (info · backlinks · TOC).
// Filter input is OUTSIDE the re-render scope (P0-1: focus survives typing).
import { api, apiPost, waitJob } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { setKnownPages, renderMarkdown, anchorToId } from '../lib/md.js';
import { icon } from '../lib/icons.js';

const badge = (s) => s && s !== 'approved' ? `<span class="badge ${esc(s)}">${esc(s)}</span>` : '';

// ============================== tree framework ==============================

const store = {
  get: (k, d) => { const v = localStorage.getItem('ui.' + k); return v === null ? d : v; },
  set: (k, v) => localStorage.setItem('ui.' + k, v),
};

function groupDetails(name, label, count, itemsHtml, folds, filter) {
  const det = el('details', { class: 'grp' });
  if (folds[name] !== false || filter) det.open = true;
  det.addEventListener('toggle', () => {
    // P3: filtering force-opens groups — don't let that overwrite the memory
    if (filter) return;
    folds[name] = det.open;
    store.set('folds', JSON.stringify(folds));
  });
  const sum = el('summary');
  html(sum, `${icon('chevronRight', 11)} ${icon(label === 'raw' ? 'database' : label === 'topics' ? 'layers' : 'fileText', 12)}
    <span>${label.toUpperCase()}</span><span class="count">${count}</span>`);
  det.append(sum);
  const body = el('div', { class: 'grp-body' });
  html(body, itemsHtml);
  det.append(body);
  return det;
}

function wikiGroups(pages, current, filter) {
  const q = (filter || '').toLowerCase();
  const groups = { sources: [], topics: [] };
  for (const p of pages) {
    if (q && !p.title.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) continue;
    (p.path.startsWith('wiki/topics/') ? groups.topics : groups.sources).push(p);
  }
  const folds = JSON.parse(store.get('folds', '{}'));
  const frag = el('div');
  for (const [name, list] of Object.entries(groups)) {
    const items = list.map((p) =>
      `<a class="${p.path === current ? 'current' : ''}" href="#/page?path=${encodeURIComponent(p.path)}" title="${esc(p.path)}"><span class="t">${esc(p.title)}</span>${badge(p.status) || ''}</a>`
    ).join('') || '<p class="dim pad">无</p>';
    frag.append(groupDetails(name, name, list.length, items, folds, filter));
  }
  return frag;
}

function rawGroups(rawDocs, current, filter) {
  const q = (filter || '').toLowerCase();
  const list = rawDocs.filter((d) => !q || d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q));
  const folds = JSON.parse(store.get('folds', '{}'));
  const items = list.map((d) =>
    `<a class="${d.path === current ? 'current' : ''}" href="#/browse?raw=${encodeURIComponent(d.path)}"
      title="${esc(d.path)}" data-meta="version ${esc(d.source_version || '?')} · pulled ${esc(String(d.pulled_at || '').slice(0, 10))}"><span class="t">${esc(d.title)}</span><span class="src">${esc(d.source || '')}</span></a>`
  ).join('') || '<p class="dim pad">raw/ 为空 — 先 acquire</p>';
  const frag = el('div');
  frag.append(groupDetails('raw', 'raw', list.length, items, folds, filter));
  return frag;
}

function buildTreeFrame(wrap, { onSegment, onRefresh }) {
  const tree = el('nav', { class: 'tree' });
  tree.style.width = store.get('treeWidth', '248') + 'px';

  // segmented control [ wiki | raw ]
  const seg = el('div', { class: 'seg' });
  const segWiki = el('button', { 'data-seg': 'wiki' }, 'wiki 页面');
  const segRaw = el('button', { 'data-seg': 'raw' }, 'raw 原文');
  seg.append(segWiki, segRaw);

  const input = el('input', { class: 'tree-filter', placeholder: '过滤… (Esc 清空)' });
  input.addEventListener('input', () => onRefresh(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; onRefresh(''); e.stopPropagation(); }
  });

  const groups = el('div', { class: 'tree-groups' });

  // drag resizer (180–400px, persisted)
  const resizer = el('div', { class: 'tree-resizer', title: '拖拽调整宽度' });
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = tree.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.min(400, Math.max(180, startW + ev.clientX - startX));
      tree.style.width = w + 'px';
    };
    const up = () => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
      store.set('treeWidth', String(Math.round(tree.getBoundingClientRect().width)));
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });

  tree.append(seg, input, groups, resizer);
  return { tree, segBtns: { wiki: segWiki, raw: segRaw }, groups, input };
}

// ============================== context panel ==============================

function ctxTabs(panel, tabs) {
  const bar = el('div', { class: 'tabs' });
  const body = el('div');
  panel.append(bar, body);
  const activate = (name) => {
    for (const b of bar.children) b.classList.toggle('active', b.dataset.tab === name);
    body.textContent = '';
    body.append(tabs[name]);
  };
  for (const name of Object.keys(tabs)) {
    const b = el('button', { 'data-tab': name }, name);
    b.addEventListener('click', () => activate(name));
    bar.append(b);
  }
  activate(Object.keys(tabs)[0]);
}

function infoTab(fields) {
  const box = el('dl');
  const add = (k, vHtml) => { if (vHtml) { box.append(el('dt', {}, k)); const dd = el('dd'); html(dd, vHtml); box.append(dd); } };
  add('status', badge(fields.status) || `<span class="badge approved">approved</span>`);
  add('type', esc(fields.type || ''));
  add('updated_at', `<span class="mono">${esc(fields.updated_at || '')}</span>`);
  if (fields.source_ref) add('raw 证据', `<a href="#/browse?raw=${encodeURIComponent(fields.source_ref)}">${esc(fields.source_ref)}</a>`);
  if (fields.source_url) add('source_url', `<a href="${esc(fields.source_url)}" target="_blank" rel="noreferrer">${esc(fields.source_url)}</a>`);
  if (Array.isArray(fields.sources) && fields.sources.length) {
    add('sources', fields.sources.map((s) =>
      `<a href="#/page?path=${encodeURIComponent('wiki/sources/' + s.replace(/^wiki\/sources\//, ''))}">${esc(s)}</a>`).join('<br>'));
  }
  if (Array.isArray(fields.tags) && fields.tags.length) add('tags', esc(fields.tags.join(', ')));
  return box;
}

function backlinksTab(backlinks, rel) {
  const box = el('div');
  if (!backlinks.length) box.append(el('p', { class: 'dim' }, '没有页面引用这篇 — 它是知识图的一个端点。'));
  for (const b of backlinks) {
    box.append(el('a', { href: `#/page?path=${encodeURIComponent(b.path)}`, style: 'display:block;padding:2px 0' }, b.title));
  }
  // A7: jump into the graph centered on this page
  box.append(el('a', { href: `#/graph?focus=${encodeURIComponent(rel)}`, class: 'dim', style: 'display:block;margin-top:10px;font-size:12px' }, '在图谱中查看 →'));
  return box;
}

function tocTab(main) {
  const box = el('div', { class: 'toc' });
  const heads = [...main.querySelectorAll('h2, h3')];
  if (!heads.length) { box.append(el('p', { class: 'dim' }, '这篇没有小节。')); return box; }
  const links = heads.map((h) => {
    const a = el('a', { href: '#', class: h.tagName === 'H3' ? 'h3' : '' }, h.textContent.replace(/#$/, ''));
    a.addEventListener('click', (e) => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    box.append(a);
    return [h, a];
  });
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        for (const [, a] of links) a.classList.remove('on');
        const found = links.find(([h]) => h === e.target);
        if (found) found[1].classList.add('on');
      }
    }
  }, { rootMargin: '-10% 0px -80% 0px' });
  heads.forEach((h) => spy.observe(h));
  return box;
}

// ============================== reader chrome ==============================

function archiveCard(fields, rel) {
  const card = el('div', { class: 'archive-card' });
  const bits = [
    `<b>${esc(rel)}</b>`,
    fields.type ? `type <b>${esc(fields.type)}</b>` : '',
    fields.updated_at ? `updated <b>${esc(String(fields.updated_at).slice(0, 10))}</b>` : '',
    fields.review_note ? `note <b>${esc(fields.review_note)}</b>` : '',
  ];
  html(card, bits.filter(Boolean).join(''));
  if (fields.status && fields.status !== 'approved') html(card, badge(fields.status));
  return card;
}

function wireAnchors(main, rel) {
  for (const btn of main.querySelectorAll('button.anchor')) {
    btn.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}#/page?path=${encodeURIComponent(rel)}&anchor=${btn.dataset.anchor}`;
      navigator.clipboard?.writeText(url);
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '#'; }, 900);
    });
  }
}

function wirePreviews(main) {
  tippy(main.querySelectorAll('a.ref[data-preview]'), {
    delay: [300, 0], placement: 'right', interactive: true, maxWidth: 360,
    onShow(instance) {
      const rel = instance.reference.dataset.preview;
      if (instance._loaded) return;
      instance.setContent('');
      html(instance.popper.querySelector('.tippy-content'), '<div class="preview-card dim">加载中…</div>');
      api('/api/page', { path: rel }).then((page) => {
        const excerpt = (page.body || '').replace(/[#*`>\[\]]/g, '').trim().slice(0, 140);
        html(instance.popper.querySelector('.tippy-content'),
          `<div class="preview-card"><b>${esc(page.fields.title || rel)}</b><br>${esc(excerpt)}…</div>`);
        instance._loaded = true;
      }).catch(() => {
        html(instance.popper.querySelector('.tippy-content'), '<div class="preview-card dim">预览不可用</div>');
      });
    },
  });
}

// ---- G: raw delete / move (impact preview G5 = the rawrefs list already loaded) ----

function rawOpsModal({ title, bodyNodes, confirmLabel, onConfirm, navigate }) {
  const mask = el('div', { class: 'cmdk-mask' });
  const box = el('div', { class: 'cmdk', style: 'padding:18px 22px; max-width:520px' });
  box.append(el('h3', { style: 'margin:0 0 10px' }, title), ...bodyNodes);
  const row = el('div', { style: 'display:flex;gap:10px;margin-top:14px;justify-content:flex-end' });
  const cancel = el('button', {}, '取消');
  const ok = el('button', { class: 'primary danger-solid' }, confirmLabel);
  const note = el('p', { class: 'dim', style: 'font-size:12.5px;margin:10px 0 0' });
  cancel.addEventListener('click', close);
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    note.textContent = '作业已入队,执行中…(同 KB 写操作串行)';
    try {
      const { job } = await onConfirm();
      const done = await waitJob(job.id);
      close();
      window.dispatchEvent(new CustomEvent('ui:refresh-header'));
      // P2-1: the page the op was launched from is stale by definition after a
      // delete/move — navigate to a valid landing instead of remounting on it.
      if (navigate) location.hash = typeof navigate === 'function' ? navigate() : navigate;
      else window.dispatchEvent(new CustomEvent('ui:remount'));
      return done;
    } catch (err) {
      note.textContent = `失败:${err.message}`;
      ok.disabled = false;
    }
  });
  row.append(cancel, ok);
  box.append(row, note);
  mask.append(box);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  function close() { mask.remove(); document.removeEventListener('keydown', onKey, true); }
  document.addEventListener('keydown', onKey, true);
  document.body.append(mask);
}

function impactPreview(refs) {
  const box = el('div', { class: 'impact' });
  if (!refs.pages.length) {
    box.append(el('p', { class: 'dim' }, '没有 wiki 页溯源到这篇 raw — 删除不影响任何已治理内容。'));
    return box;
  }
  box.append(el('p', {}, `以下 ${refs.pages.length} 篇 wiki 页溯源到它 — 删除后它们的 source_ref 将失效,治理会发现孤儿,由人裁决:`));
  for (const p of refs.pages) {
    const a = el('a', { href: `#/page?path=${encodeURIComponent(p.path)}`, style: 'display:block;padding:2px 0' }, p.title);
    if (p.status && p.status !== 'approved') html(a, badge(p.status));
    box.append(a);
  }
  return box;
}

// ============================== page renderers ==============================

async function renderPage(content, rel, anchor) {
  const [page, back] = await Promise.all([
    api('/api/page', { path: rel }),
    api('/api/backlinks', { path: rel }).catch(() => ({ pages: [] })),
  ]);
  const reader = el('div', { class: 'reader' });
  reader.append(el('h1', { class: 'doc-title' }, page.fields.title || rel));
  reader.append(archiveCard(page.fields, rel));
  const main = el('div', { class: 'md' });
  html(main, renderMarkdown(page.body));
  wireAnchors(main, rel);
  wirePreviews(main);
  reader.append(main);

  const ctx = el('aside', { class: 'ctx' });
  ctxTabs(ctx, {
    信息: infoTab(page.fields),
    反链: backlinksTab(back.pages, rel),
    大纲: tocTab(main),
  });

  // A5: source pages get a side-by-side wiki⇄raw comparison mode
  if (page.fields.source_ref) {
    const btn = el('button', { class: 'icon-btn compare-btn', 'data-tt': '并排对照 wiki ⇄ raw' });
    html(btn, icon('bookOpen', 15) + '<span style="font-size:12px;margin-left:4px">对照</span>');
    tippy(btn, { content: btn.dataset.tt, delay: 0 });
    btn.addEventListener('click', () => renderSplit(content, rel, page, back.pages));
    reader.querySelector('.archive-card').append(btn);
  }

  content.append(reader, ctx);
  if (anchor) main.querySelector(`#${CSS.escape(anchorToId(anchor))}`)?.scrollIntoView({ block: 'start' });
}

// A5 split view: wiki left, raw right, exit returns to the normal reader.
async function renderSplit(content, rel, page, backlinksPages) {
  content.textContent = '';
  const rawRel = page.fields.source_ref;
  const raw = await api('/api/raw', { path: rawRel });

  const split = el('div', { class: 'split' });
  const left = el('div', { class: 'reader pane' });
  left.append(el('h1', { class: 'doc-title' }, page.fields.title || rel));
  const lmain = el('div', { class: 'md' });
  html(lmain, renderMarkdown(page.body));
  wireAnchors(lmain, rel);
  wirePreviews(lmain);
  left.append(lmain);

  const right = el('div', { class: 'reader pane' });
  const rhead = el('h1', { class: 'doc-title raw-title' });
  html(rhead, `${icon('database', 18)} raw 原文`);
  right.append(rhead);
  right.append(archiveCard(raw.fields, rawRel));
  const rmain = el('div', { class: 'md' });
  html(rmain, renderMarkdown(raw.body));
  right.append(rmain);

  split.append(left, right);

  const ctx = el('aside', { class: 'ctx' });
  const exit = el('button', { class: 'icon-btn', 'data-tt': '退出对照' });
  html(exit, icon('x', 15) + '<span style="font-size:12px;margin-left:4px">退出对照</span>');
  exit.addEventListener('click', () => {
    content.textContent = '';
    renderPage(content, rel);
  });
  const note = el('p', { class: 'dim', style: 'font-size:12px;margin-top:10px' },
    '左:治理后的 wiki 摘要。右:acquire 落地的 raw 原文。对照检查摘要是否忠实。');
  ctx.append(exit, note);
  ctxTabs(ctx, { 信息: infoTab(page.fields), 反链: backlinksTab(backlinksPages, rel), 大纲: tocTab(lmain) });

  content.append(split, ctx);
}

async function renderRaw(content, rel) {
  const [doc, refs] = await Promise.all([
    api('/api/raw', { path: rel }),
    api('/api/rawrefs', { path: rel }).catch(() => ({ pages: [] })),
  ]);
  const reader = el('div', { class: 'reader' });
  const back = el('p');
  html(back, `<a href="#/browse">← 返回浏览</a>`);
  reader.append(back, el('h1', { class: 'doc-title' }, `raw 证据:${rel.split('/').pop()}`));
  reader.append(archiveCard(doc.fields, rel));
  const main = el('div', { class: 'md' });
  html(main, renderMarkdown(doc.body));
  reader.append(main);

  const ctx = el('aside', { class: 'ctx' });
  const f = doc.fields;
  const dl = el('dl');
  const add = (k, v) => { if (v) { dl.append(el('dt', {}, k)); dl.append(el('dd', {}, String(v))); } };
  add('source', f.source); add('source_id', f.source_id);
  add('source_version', f.source_version); add('pulled_at', f.pulled_at);
  ctx.append(dl);
  // A5 reverse: wiki pages tracing to this raw doc
  const refBox = el('div', { style: 'margin-top:14px' });
  refBox.append(el('dt', {}, '引用它的 wiki 页'));
  if (!refs.pages.length) refBox.append(el('p', { class: 'dim', style: 'font-size:12.5px' }, '还没有 wiki 页溯源到它(可能尚未治理)'));
  for (const p of refs.pages) {
    const a = el('a', { href: `#/page?path=${encodeURIComponent(p.path)}`, style: 'display:block;padding:2px 0' });
    a.append(p.title);
    if (p.status && p.status !== 'approved') html(a, badge(p.status));
    refBox.append(a);
  }
  ctx.append(refBox);

  // G: raw 管理操作(删除 G1 / 移动 G2;影响预览 G5;快照由服务端作业先留,G6)
  const ops = el('div', { class: 'raw-ops' });
  const moveBtn = el('button', { class: 'sm' });
  html(moveBtn, `${icon('folderInput', 13)} 移动`);
  const delBtn = el('button', { class: 'sm danger' });
  html(delBtn, `${icon('trash2', 13)} 删除`);
  moveBtn.addEventListener('click', () => {
    const input = el('input', { value: rel, style: 'width:100%;font-family:var(--font-mono);font-size:12.5px' });
    rawOpsModal({
      title: '移动 raw 文档(= 新身份)',
      bodyNodes: [
        el('p', { class: 'dim', style: 'font-size:13px' }, '移动后旧路径成为孤儿(契约语义),溯源到旧路径的 wiki 页需治理裁决。目标必须仍在 raw/ 下。'),
        impactPreview(refs),
        el('label', { style: 'display:block;font-size:12.5px;margin-top:8px' }, '目标路径', input),
      ],
      confirmLabel: '移动',
      onConfirm: () => apiPost('/api/raw-move', { from: rel, to: input.value.trim() }),
      navigate: () => `#/browse?raw=${encodeURIComponent(input.value.trim())}`, // land on the moved doc
    });
  });
  delBtn.addEventListener('click', () => {
    rawOpsModal({
      title: `删除 ${rel.split('/').pop()}`,
      bodyNodes: [
        impactPreview(refs),
        el('p', { class: 'dim', style: 'font-size:12.5px' }, '删除前服务端会先留可回滚快照(git 提交或 .kb/ui/snapshots/ 副本)。raw 内容不可修改,但可删除后重新采集。'),
      ],
      confirmLabel: '确认删除',
      onConfirm: () => apiPost('/api/raw-delete', { path: rel }),
      navigate: '#/browse', // the deleted doc's page is a guaranteed 404
    });
  });
  ops.append(moveBtn, delBtn);
  ctx.append(ops);
  content.append(reader, ctx);
}

// ============================== view entry ==============================

export async function render(view, params) {
  const [treeData, rawlist] = await Promise.all([api('/api/tree'), api('/api/rawlist')]);
  const pages = treeData.pages;
  const rawDocs = rawlist.docs;
  setKnownPages(pages);

  const rawPath = params.get('raw');
  const explicit = params.get('path');
  let segment = store.get('treeSeg', rawPath ? 'raw' : 'wiki');
  let collapsed = store.get('treeCollapsed', '0') === '1';

  const wrap = el('div', { class: 'browse' });
  const rail = el('div', { class: 'rail-nav' });

  const frame = buildTreeFrame(wrap, {
    onSegment: (seg) => { segment = seg; store.set('treeSeg', seg); refreshTree(); syncChrome(); },
    onRefresh: () => refreshTree(),
  });

  function refreshTree() {
    frame.groups.textContent = '';
    frame.groups.append(segment === 'raw'
      ? rawGroups(rawDocs, rawPath, frame.input.value)
      : wikiGroups(pages, explicit, frame.input.value));
  }

  // rail: expand toggle + wiki + raw entries (reachable even when collapsed)
  const toggle = el('button', { class: 'icon-btn', 'data-tt': '' });
  const wikiBtn = el('button', { class: 'icon-btn', 'data-tt': 'wiki 页面' });
  const rawBtn = el('button', { class: 'icon-btn', 'data-tt': 'raw 原文' });
  html(wikiBtn, icon('library', 16));
  html(rawBtn, icon('database', 16));

  function syncChrome() {
    wrap.classList.toggle('collapsed', collapsed);
    frame.tree.classList.toggle('hidden', collapsed);
    html(toggle, icon(collapsed ? 'chevronRight' : 'panelLeftClose', 16));
    toggle.dataset.tt = collapsed ? '展开页面树' : '收合页面树';
    wikiBtn.classList.toggle('on', !collapsed && segment === 'wiki');
    rawBtn.classList.toggle('on', !collapsed && segment === 'raw');
    frame.segBtns.wiki.classList.toggle('on', segment === 'wiki');
    frame.segBtns.raw.classList.toggle('on', segment === 'raw');
    // tippy for rail icons: instant (discoverability, P1-8)
    tippy([toggle, wikiBtn, rawBtn], { content: (ref) => ref.dataset.tt, delay: 0, placement: 'right' });
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    store.set('treeCollapsed', collapsed ? '1' : '0');
    syncChrome();
  });
  const goto = (seg) => () => {
    segment = seg;
    store.set('treeSeg', seg);
    if (collapsed) { collapsed = false; store.set('treeCollapsed', '0'); }
    refreshTree();
    syncChrome();
  };
  wikiBtn.addEventListener('click', goto('wiki'));
  rawBtn.addEventListener('click', goto('raw'));
  frame.segBtns.wiki.addEventListener('click', goto('wiki'));
  frame.segBtns.raw.addEventListener('click', goto('raw'));

  rail.append(toggle, wikiBtn, rawBtn);
  refreshTree();
  syncChrome();

  const content = el('div', { style: 'display:contents' });
  wrap.append(rail, frame.tree, content);
  view.append(wrap);

  if (rawPath) return renderRaw(content, rawPath);
  try {
    await renderPage(content, explicit || 'wiki/index.md', params.get('anchor'));
  } catch (err) {
    if (!explicit && pages.length) return renderPage(content, pages[0].path);
    if (!explicit) {
      html(content, `<div class="empty-state"><div class="big">这个知识库还是空的</div>
        投入第一批文档,或在 Claude 会话中运行 acquire + govern,这里就会生长出内容。</div>`);
    } else throw err;
  }
}
