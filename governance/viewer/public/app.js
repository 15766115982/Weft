/* KB Review Viewer — no-build vanilla JS. Dumb consumer (ADR-0004): renders pages,
   lists the candidate queue, offers approve/reject buttons whose only effect is a
   frontmatter status flip via POST /api/review. All DOM is built via textContent /
   createElement — raw Markdown is never injected as HTML. */
'use strict';

const app = document.getElementById('app');

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

async function api(path, opts = {}) {
  // writes carry the per-startup token injected into index.html (S8)
  if ((opts.method || 'GET') !== 'GET') {
    opts.headers = { ...(opts.headers || {}),
      'x-viewer-token': document.querySelector('meta[name="viewer-token"]')?.content || '' };
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- inline markdown: bold / italic / code / links / wikilinks ---------- */

// Known page paths, refreshed on every route render — wikilink resolution below
// (review 2026-08-04: a bare-slug link used to be guessed as wiki/topics/<slug>,
// which 404'd for every source page).
let knownPaths = [];

function wikiHref(target) {
  const t = target.replace(/\.md$/, '');
  // same caliber as retrieval's resolveLinks: full relative form first, then
  // first suffix match in sorted order; unknown targets keep the old guess
  const hit = knownPaths.find((p) => p === `wiki/${t}.md`)
    || knownPaths.find((p) => p.replace(/\.md$/, '').endsWith(`/${t}`));
  const rel = hit ? hit.replace(/\.md$/, '') : (t.includes('/') ? `wiki/${t}` : `wiki/topics/${t}`);
  return `#/page/${rel}.md`;
}

function appendInline(parent, text) {
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const a = el('a', m[2] || m[1]);
      a.href = wikiHref(m[1].trim());
      parent.appendChild(a);
    } else if (m[3] !== undefined) {
      const a = el('a', m[3]);
      a.href = m[4];
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
    } else if (m[5] !== undefined) {
      parent.appendChild(el('strong', m[5]));
    } else if (m[6] !== undefined) {
      parent.appendChild(el('em', m[6]));
    } else if (m[7] !== undefined) {
      parent.appendChild(el('code', m[7]));
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/* ---------- block markdown renderer (headings / lists / fences / paragraphs) ---------- */

function renderMarkdown(container, md) {
  const lines = md.split('\n');
  let i = 0;
  let list = null;
  const closeList = () => { list = null; };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      closeList();
      const marker = fence[1];
      const isClose = (l) => {
        const t = l.trim();
        return t.length >= marker.length && t.split('').every((c) => c === marker[0]);
      };
      const buf = [];
      i++;
      while (i < lines.length && !isClose(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence (or run off the end)
      const pre = el('pre');
      pre.appendChild(el('code', buf.join('\n')));
      container.appendChild(pre);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const h = el('h' + heading[1].length);
      appendInline(h, heading[2]);
      container.appendChild(h);
      i++;
      continue;
    }
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) {
      const ordered = /^\s*\d+\./.test(line);
      if (!list || list.ordered !== ordered) {
        list = { node: el(ordered ? 'ol' : 'ul'), ordered };
        container.appendChild(list.node);
      }
      const li = el('li');
      appendInline(li, item[1]);
      list.node.appendChild(li);
      i++;
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|~~~|\s*(?:[-*]|\d+\.)\s)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const p = el('p');
    appendInline(p, buf.join(' '));
    container.appendChild(p);
  }
}

/* ---------- line diff (LCS) for the conflict-diff view ---------- */

function diffLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 4_000_000) return null;   // too large — caller shows a notice instead
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { rows.push([' ', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(['-', A[i]]); i++; }
    else { rows.push(['+', B[j]]); j++; }
  }
  while (i < n) rows.push(['-', A[i++]]);
  while (j < m) rows.push(['+', B[j++]]);
  return rows;
}

function renderDiff(container, baseline, current) {
  const rows = diffLines(baseline, current);
  if (!rows) { container.appendChild(el('p', 'Files too large to diff in the viewer.')); return; }
  const pre = el('pre', null, 'diff');
  for (const [sign, text] of rows) {
    if (sign === ' ' && rows.length > 40) continue;   // long files: changed lines only
    const line = el('span', `${sign} ${text}`, sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx');
    pre.appendChild(line);
    pre.appendChild(document.createTextNode('\n'));
  }
  container.appendChild(pre);
}

/* ---------- views ---------- */

function badge(status) {
  return el('span', status || 'missing', 'badge ' + (status || 'missing'));
}

function pageLink(p, text) {
  const a = el('a', text || p.title || p.path);
  a.href = '#/page/' + p.path;
  return a;
}

async function renderTable(target, pages, emptyText) {
  target.replaceChildren();
  if (!pages.length) { target.appendChild(el('p', emptyText, 'empty')); return; }
  const table = el('table');
  const head = el('tr');
  for (const h of ['Page', 'Type', 'Status', 'Updated']) head.appendChild(el('th', h));
  table.appendChild(head);
  for (const p of pages) {
    const tr = el('tr');
    const td = el('td');
    td.appendChild(pageLink(p));
    tr.appendChild(td);
    tr.appendChild(el('td', p.type || ''));
    const st = el('td');
    st.appendChild(badge(p.status));
    tr.appendChild(st);
    tr.appendChild(el('td', (p.updated_at || '').slice(0, 10)));
    table.appendChild(tr);
  }
  target.appendChild(table);
}

async function viewQueue(target) {
  const { pages } = await api('/api/queue');
  document.getElementById('queue-count').textContent = pages.length ? `(${pages.length})` : '';
  target.appendChild(el('h2', 'Review queue'));
  await renderTable(target, pages, 'Queue is empty — nothing awaiting review.');
}

async function viewBrowse(target) {
  const { pages } = await api('/api/pages');
  target.appendChild(el('h2', 'All wiki pages'));
  await renderTable(target, pages, 'No pages yet.');
}

function fmPanel(target, fields) {
  const panel = el('div', null, 'fm-panel');
  const dl = el('dl');
  const skip = new Set(['title']);
  for (const [k, v] of Object.entries(fields)) {
    if (skip.has(k) || v === undefined || v === null || v === '') continue;
    // review_note is meaningful only while candidate; after approval it is inert
    // residue (flips touch only the status line) — don't show it as live metadata
    if (k === 'review_note' && fields.status !== 'candidate') continue;
    dl.appendChild(el('dt', k + ':'));
    dl.appendChild(el('dd', Array.isArray(v) ? v.join(', ') : String(v)));
  }
  panel.appendChild(dl);
  target.appendChild(panel);
}

async function viewPage(target, rel) {
  const data = await api('/api/page?path=' + encodeURIComponent(rel));
  target.appendChild(el('h2', data.fields.title || rel));
  const statusLine = el('p');
  statusLine.appendChild(badge(data.fields.status));
  target.appendChild(statusLine);

  // Candidate reason (contract §3.3 review_note): the single most important piece
  // of review context — why this page is a candidate at all.
  if (data.fields.status === 'candidate' && data.fields.review_note) {
    target.appendChild(el('div', `Candidate reason: ${data.fields.review_note}`, 'notice candidate-reason'));
  }
  fmPanel(target, data.fields);

  if (data.fields.status === 'candidate') {
    const actions = el('div', null, 'actions');
    const approve = el('button', 'Approve', 'approve');
    const reject = el('button', 'Reject', 'reject');
    const doReview = async (action) => {
      approve.disabled = reject.disabled = true;
      try {
        const r = await api('/api/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: rel, action }),
        });
        const note = el('div', `${action === 'approve' ? 'Approved' : 'Rejected'} — status is now "${r.status}". Logged by the next governance sweep.`, 'notice ok');
        const back = el('a', 'Back to review queue');
        back.href = '#/queue';
        note.appendChild(document.createTextNode(' '));
        note.appendChild(back);
        actions.replaceChildren(note);
        statusLine.replaceChildren(badge(r.status));
      } catch (err) {
        actions.appendChild(el('div', err.status === 409
          ? 'Already reviewed elsewhere — refresh the page to see the current status.'
          : `Error: ${err.message}`, 'notice err'));
        approve.disabled = reject.disabled = false;
      }
    };
    approve.addEventListener('click', () => doReview('approve'));
    reject.addEventListener('click', () => doReview('reject'));
    actions.appendChild(approve);
    actions.appendChild(reject);
    target.appendChild(actions);
  }

  const article = el('article', null, 'body');
  renderMarkdown(article, data.body || '');
  target.appendChild(article);

  // Conflict diff (ADR-0004): for candidates, diff the working copy against the
  // Git baseline — this is how "what changed" is visible when a candidate
  // overwrites an approved page. Hidden when the KB has no git history.
  if (data.fields.status === 'candidate') {
    const det = el('details', null, 'evidence');
    det.appendChild(el('summary', 'Diff vs Git baseline'));
    det.addEventListener('toggle', async () => {
      if (!det.open || det.dataset.loaded) return;
      det.dataset.loaded = '1';
      try {
        const d = await api('/api/diff?path=' + encodeURIComponent(rel));
        if (!d.baseline) det.appendChild(el('p', 'No Git baseline (new page or KB has no git history).'));
        else if (!d.changed) det.appendChild(el('p', 'No changes vs Git baseline.'));
        else renderDiff(det, d.baseline, d.current);
      } catch (err) {
        det.appendChild(el('p', `Could not load diff: ${err.message}`));
      }
    });
    target.appendChild(det);
  }

  // Source evidence: source pages have source_ref; topic pages carry a sources
  // array — every entry is clickable and loads the raw document on demand.
  const evidenceRefs = data.fields.source_ref ? [data.fields.source_ref]
    : Array.isArray(data.fields.sources) ? data.fields.sources : [];
  for (const ref of evidenceRefs) {
    const det = el('details', null, 'evidence');
    det.appendChild(el('summary', `Source evidence — ${ref}`));
    det.addEventListener('toggle', async () => {
      if (!det.open || det.dataset.loaded) return;
      det.dataset.loaded = '1';
      try {
        const raw = await api('/api/raw?path=' + encodeURIComponent(ref));
        const pre = el('pre');
        pre.appendChild(el('code', raw.body || ''));
        det.appendChild(pre);
      } catch (err) {
        det.appendChild(el('p', `Could not load source: ${err.message}`));
      }
    });
    target.appendChild(det);
  }
}

/* ---------- router ---------- */

async function route() {
  app.replaceChildren();
  const hash = location.hash || '#/queue';
  try {
    // keep the wikilink resolver's page list fresh (cheap: one metadata list)
    api('/api/pages').then(({ pages }) => { knownPaths = pages.map((p) => p.path).sort(); })
      .catch(() => { /* resolver falls back to the old guess */ });
    if (hash.startsWith('#/page/')) {
      await viewPage(app, decodeURIComponent(hash.slice('#/page/'.length)));
    } else if (hash === '#/browse') {
      await viewBrowse(app);
    } else {
      await viewQueue(app);
    }
  } catch (err) {
    app.appendChild(el('div', `Error: ${err.message}`, 'notice err'));
  }
}

window.addEventListener('hashchange', route);
route();
