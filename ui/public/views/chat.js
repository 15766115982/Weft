// views/chat.js — Phase 4: page-level Q&A with quick / deep / deep-research.
// Streaming NDJSON from the LLM service is pushed as SSE and rendered live.
import { api, apiPost, waitJob, getKb } from '../lib/api.js';
import { html, esc, el } from '../lib/render.js';
import { icon } from '../lib/icons.js';
import { renderMarkdown, setKnownPages } from '../lib/md.js';

const LEVELS = [
  { key: 'quick', label: '快速', hint: '轻量检索(top 3)后回答,最快' },
  { key: 'deep', label: '深度', hint: '检索 top 5 页后回答' },
  { key: 'deep-research', label: '深研', hint: '多轮检索 + 推理' },
];

const store = {
  read(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } },
  // keep the NEWEST 100: slice(0, 100) kept the oldest and silently dropped
  // every new message once the cap was hit (2026-08-12 audit)
  write(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr.slice(-100))); }
    catch { /* quota exceeded — history is a convenience, never block send */ }
  },
};
const historyKey = () => `ui.chat-history.${getKb() || 'default'}`;

export async function render(view, params) {
  // resolve [[wikilinks]] in answers (title/slug → page path)
  api('/api/tree').then(({ pages }) => setKnownPages(pages)).catch(() => {});
  const wrap = el('div', { class: 'chat' });
  view.append(wrap);

  let level = 'quick';
  let streaming = false;
  let abort = null;

  // P5: search page can link here with ?q=...
  const prefilled = params.get('q') || '';

  // ---- header ----
  const header = el('div', { class: 'chat-header' });
  const levelGroup = el('div', { class: 'level-group' });
  const levelButtons = {};
  for (const lv of LEVELS) {
    const btn = el('button', { class: `level-btn${lv.key === level ? ' on' : ''}`, title: lv.hint }, lv.label);
    btn.addEventListener('click', () => setLevel(lv.key));
    levelButtons[lv.key] = btn;
    levelGroup.append(btn);
  }
  const clearBtn = el('button', { class: 'sm', title: '清空当前 KB 的聊天记录' }, '清空');
  clearBtn.addEventListener('click', () => { messages = []; saveHistory(); renderMessages(); });
  // ADR-0013: one-click distillation of the whole conversation → raw/chat/.
  const distillBtn = el('button', { class: 'sm', title: '把当前对话蒸馏成结构化文档,沉淀到「用户对话整理」(raw/chat/)' }, '一键整理');
  distillBtn.addEventListener('click', distill);
  const distillNote = el('div', { class: 'chat-distill-note', hidden: '' });
  header.append(el('h2', {}, '问答'), levelGroup, clearBtn, distillBtn);

  function setLevel(v) {
    level = v;
    for (const [k, b] of Object.entries(levelButtons)) b.classList.toggle('on', k === v);
  }

  // ---- messages ----
  const msgBox = el('div', { class: 'chat-messages' });
  let messages = store.read(historyKey());
  const thinkingBox = el('div', { class: 'chat-thinking', hidden: '' });

  // ---- input ----
  const inputRow = el('div', { class: 'chat-input-row' });
  const input = el('textarea', { rows: 1, placeholder: '输入问题…(Shift+Enter 换行,Enter 发送)' });
  const sendBtn = el('button', { class: 'primary' });
  html(sendBtn, `${icon('cornerDownLeft', 14)} 发送`);
  inputRow.append(input, sendBtn);

  wrap.append(header, distillNote, msgBox, thinkingBox, inputRow);

  if (prefilled) {
    input.value = prefilled;
    input.rows = Math.min(5, Math.max(1, Math.ceil(input.scrollHeight / 22)));
  }

  function renderMessages() {
    msgBox.textContent = '';
    clearBtn.hidden = messages.length === 0;
    distillBtn.hidden = messages.length === 0;
    if (!messages.length) distillNote.hidden = true;
    if (!messages.length) {
      msgBox.append(welcomeCard());
      return;
    }
    for (const m of messages) msgBox.append(renderMessage(m));
    msgBox.append(thinkingBox);
    scrollBottom();
  }

  // First-run empty state: what this chat is for, what the levels mean, and
  // clickable example questions instead of a blank white void.
  function welcomeCard() {
    const card = el('div', { class: 'chat-welcome' });
    card.append(el('h3', {}, '基于这座知识库提问'));
    card.append(el('p', { class: 'dim' },
      '回答只来自已批准的 wiki 页面并附引用。三种深度都会先检索:快速 = top 3 轻量检索,最快;深度 = top 5 页;深研 = 多轮检索 + 推理,带完整检索轨迹。'));
    const examples = el('div', { class: 'chat-examples' });
    for (const q of ['这个系统的重试策略是什么?', '支付超时后会发生什么?', '帮我梳理熔断和重试的关系']) {
      const b = el('button', { class: 'sm' }, q);
      b.addEventListener('click', () => { input.value = q; input.focus(); });
      examples.append(b);
    }
    card.append(examples);
    return card;
  }

  function renderMessage(m) {
    const row = el('div', { class: `chat-msg ${m.role}` });
    const bubble = el('div', { class: 'bubble' });
    if (m.role === 'user') {
      bubble.textContent = m.text;
    } else {
      if (m.level) bubble.append(el('span', { class: 'chat-level-tag' }, LEVELS.find((l) => l.key === m.level)?.label || m.level));
      if (m.steps?.length) {
        const details = el('details', { class: 'chat-steps' });
        details.append(el('summary', {}, `推理步骤 (${m.steps.length})`));
        const list = el('div');
        for (const s of m.steps) {
          const line = el('div', { class: 'step' });
          if (s.type === 'search') line.textContent = `🔍 检索: ${s.query}`;
          else if (s.type === 'read' && s.kind === 'raw') html(line, `📄 原始证据: <a href="#/browse?raw=${encodeURIComponent(s.page)}">${esc(s.page)}</a>`);
          else if (s.type === 'read') html(line, `📄 阅读: <a href="#/page?path=${encodeURIComponent(s.page)}">${esc(s.page)}</a>`);
          else if (s.type === 'error') line.textContent = `⚠ ${s.message}`;
          else line.textContent = `${s.type}: ${JSON.stringify(s)}`;
          list.append(line);
        }
        details.append(list);
        bubble.append(details);
      }
      const body = el('div', { class: 'md' });
      // shared renderer: [[wikilinks]] in answers become clickable ref chips
      html(body, renderMarkdown(m.text || '(无回答)'));
      bubble.append(body);
      if (m.citations?.length) {
        const cites = el('div', { class: 'chat-citations' });
        cites.append(el('span', { class: 'dim' }, '引用:'));
        for (const c of m.citations) {
          const a = el('a', { href: `#/page?path=${encodeURIComponent(c)}` }, c.replace(/^wiki\//, ''));
          cites.append(a);
        }
        bubble.append(cites);
      }
    }
    row.append(bubble);
    return row;
  }

  function scrollBottom() { msgBox.scrollTop = msgBox.scrollHeight; }

  function saveHistory() { store.write(historyKey(), messages); }

  // ADR-0013: distill the whole conversation into raw/chat/ via the queued job
  // (agent distill task → portal pre-check → acquisition chat connector).
  async function distill() {
    if (!messages.length || streaming) return;
    distillBtn.disabled = true;
    distillNote.hidden = false;
    distillNote.textContent = '整理中:蒸馏对话 → 校验引用 → 落盘 raw/chat/ …(含 LLM 调用,可能需要几十秒)';
    try {
      const payload = messages.map((m) => ({ role: m.role, text: m.text, ts: m.ts }));
      const { job } = await apiPost('/api/distill-chat', { messages: payload });
      const done = await waitJob(job.id, { timeout: 300000 });
      const r = done.result || {};
      const actionText = r.action === 'updated' ? '已更新' : r.action === 'unchanged' ? '内容未变' : '已沉淀';
      distillNote.textContent = '';
      const link = el('a', { href: `#/browse?raw=${encodeURIComponent(r.path)}` }, ` ${r.title || r.path} `);
      distillNote.append(`✅ ${actionText}至「用户对话整理」(raw/chat/):`, link, '— 下次治理运行后进入 wiki 并可检索。');
    } catch (err) {
      distillNote.textContent = `❌ 整理失败:${err.message}`;
    } finally {
      distillBtn.disabled = false;
    }
  }

  async function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    messages.push({ role: 'user', text, ts: new Date().toISOString() });
    saveHistory();
    renderMessages();
    input.value = '';
    input.rows = 1;
    await ask(text);
  }

  async function ask(question) {
    streaming = true;
    sendBtn.disabled = true;
    thinkingBox.hidden = false;
    thinkingBox.textContent = level === 'quick' ? '思考中…' : '检索并整理中…';
    scrollBottom();

    const assistantMsg = { role: 'assistant', text: '', level, steps: [], citations: [], ts: new Date().toISOString() };
    messages.push(assistantMsg);
    // Keep a reference to the live bubble so we can stream into it.
    let liveBubble = null;

    try {
      const controller = new AbortController();
      abort = controller;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ui-token': document.querySelector('meta[name="ui-token"]')?.content || '' },
        body: JSON.stringify({ question, level, kb: getKb() }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await readSse(res.body, (obj) => {
        if (obj.type === 'meta') {
          if (obj.level) assistantMsg.level = obj.level;
        } else if (obj.type === 'chunk') {
          assistantMsg.text += obj.text;
        } else if (obj.type === 'error' && obj.streamError) {
          // Server-side stream failure (SSE 'event: error' frame): surface the
          // same note the fetch-level catch path would, not '(无回答)' (P15).
          assistantMsg.text += `\n\n*(流式输出失败: ${obj.message})*`;
        } else if (obj.type === 'search' || obj.type === 'read' || obj.type === 'error') {
          assistantMsg.steps.push(obj);
          // In-band LLM failures (bad endpoint, bad key) arrive as {type:'error'}
          // frames — surface them in the bubble, not only in the steps drawer,
          // or the user sees a bare '(无回答)' with no explanation.
          if (obj.type === 'error') assistantMsg.error = obj.message;
        } else if (obj.type === 'done') {
          if (Array.isArray(obj.citations)) assistantMsg.citations = obj.citations;
        }
        if (obj.type === 'error' && !assistantMsg.text) {
          assistantMsg.text = `*(请求失败: ${obj.message})*`;
        }
        updateLiveBubble(assistantMsg);
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        assistantMsg.text += `\n\n*(流式输出失败: ${err.message})*`;
        updateLiveBubble(assistantMsg);
      }
    } finally {
      streaming = false;
      sendBtn.disabled = false;
      thinkingBox.hidden = true;
      abort = null;
      saveHistory();
      if (liveBubble) liveBubble.classList.remove('streaming');
      input.focus();
    }

    function updateLiveBubble(m) {
      if (!liveBubble) {
        liveBubble = renderMessage(m);
        liveBubble.classList.add('streaming');
        msgBox.append(liveBubble);
      } else {
        const fresh = renderMessage(m);
        fresh.classList.add('streaming');
        liveBubble.replaceWith(fresh);
        liveBubble = fresh;
      }
      scrollBottom();
    }
  }

  async function readSse(body, onObj) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Track the preceding 'event:' line: the server reports LLM child failures
    // as 'event: error' frames whose data payload is {message} with no 'type'
    // field — without this they fell through the NDJSON type switch (P15).
    let pendingEvent = null;
    const handleLine = (line) => {
      if (line.startsWith('event:')) { pendingEvent = line.slice(6).trim(); return; }
      if (!line.startsWith('data:')) { if (!line.trim()) pendingEvent = null; return; }
      const payload = line.slice(5).trim();
      if (!payload) { pendingEvent = null; return; }
      try {
        const obj = JSON.parse(payload);
        if (pendingEvent === 'error' && obj.type !== 'error') {
          obj.type = 'error';
          obj.streamError = true;
        }
        onObj(obj);
      } catch { /* ignore malformed line */ }
      pendingEvent = null;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) handleLine(line);
      }
      // trailing line
      if (buf) handleLine(buf);
    } finally {
      reader.releaseLock?.();
    }
  }

  // ---- input handlers ----
  input.addEventListener('keydown', (e) => {
    // Ignore IME composition Enter; Shift+Enter inserts a newline.
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  });
  input.addEventListener('input', () => {
    input.rows = Math.min(5, Math.max(1, Math.ceil(input.scrollHeight / 22)));
  });
  sendBtn.addEventListener('click', send);

  renderMessages();
  input.focus();

  // cleanup on navigation: abort an in-flight stream
  new MutationObserver((_, obs) => {
    if (!document.contains(wrap)) { abort?.abort(); obs.disconnect(); }
  }).observe(document.getElementById('view'), { childList: true });
}
