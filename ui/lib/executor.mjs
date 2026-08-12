// Agent executor abstraction (I2/I3, ADR-0006; ADR-0012: the claude CLI
// executor was removed with the intranet's claude dependency — the LangGraph
// govern agent is now the only built-in executor).
// Interface: startRun(spec) → { events: EventEmitter, kill() }. Any framework
// backend that can drive the service CLIs plugs in by registering here.
//
// Event contract:
//   'event' { kind: 'init'|'assistant'|'result'|'stderr', text } — progressive
//   'done'  { ok, text } — final; ok comes from the run's own result signal
//           (the agent task's stdout summary) gated on a clean exit.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const registry = new Map();

export function registerExecutor(name, startRun) {
  registry.set(name, startRun);
}

export function executorNames() {
  return [...registry.keys()];
}

export function startRun(name, spec) {
  const start = registry.get(name);
  if (!start) throw new Error(`unknown executor: ${name} (registered: ${executorNames().join(', ') || 'none'})`);
  return start(spec);
}

// ---- LangGraph govern agent (ADR-0012) ----
// Spawns the Python agent service's `govern-run` task and tails its NDJSON
// output file, mapping frames onto the executor event contract. All governance
// writes happen inside the graph's govern.mjs subprocess calls — the portal's
// C-layer git boundary check still applies on top.
import { agentTaskIO, agentTaskSpawn } from './agentcli.mjs';

function formatGovernFrame(ev) {
  switch (ev.type) {
    case 'meta': return { kind: 'init', text: `govern-run ${ev.run_id || ''} (langgraph agent)` };
    case 'phase': {
      if (ev.phase === 'plan') return { kind: 'assistant', text: `\n== plan:${ev.pending} 篇待治理 ==` };
      const counts = ev.result ? ` ${JSON.stringify(ev.result).slice(0, 200)}` : '';
      return { kind: 'assistant', text: `\n== ${ev.phase} ==${counts}` };
    }
    case 'human-list':
      return ev.count ? { kind: 'assistant', text: `⚠ ${ev.name}: ${ev.count} 项待人工处理(治理不自动裁决)` } : null;
    case 'doc': return { kind: 'assistant', text: `✓ ${ev.raw} → ${ev.page} (${ev.action})` };
    case 'doc-error': return { kind: 'assistant', text: `✗ ${ev.raw}: ${ev.error}` };
    case 'synthesis':
      return { kind: 'assistant', text: `◆ synthesis ${ev.slug} → ${ev.page}${ev.candidate ? '(candidate 待人审)' : ''}` };
    case 'synthesis-error': return { kind: 'assistant', text: `✗ synthesis ${ev.slug}: ${ev.error}` };
    case 'synthesis-skipped': return { kind: 'assistant', text: `· 跳过主题:${(ev.slugs || []).join(', ')}(${ev.reason})` };
    case 'report': {
      const h = ev.human_lists || {};
      const humanTotal = Object.entries(h).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(' ');
      return {
        kind: 'assistant',
        text: `\n— 治理完成:新建 ${ev.created} · 更新 ${ev.updated} · 去重 ${ev.deduped} · 合成 ${ev.syntheses}(candidate ${ev.syntheses_candidate})· 文档错误 ${(ev.doc_errors || []).length}`
          + (humanTotal ? `\n— 待人工:${humanTotal} —` : ' —'),
      };
    }
    default: return null;
  }
}

function startLanggraphRun({ prompt, cwd, resumeThreadId = null }) {
  const events = new EventEmitter();
  const id = crypto.randomBytes(6).toString('hex');
  // resumeThreadId reuses the interrupted run's checkpoint thread (the agent's
  // run_id IS the LangGraph thread_id); otherwise a fresh thread per run
  const io = agentTaskIO(cwd, 'govern-run', {
    brief: String(prompt || ''),
    run_id: resumeThreadId || `portal-${id}`,
    ...(resumeThreadId ? { resume: true } : {}),
  });
  const outputFile = io.outputFile.replace(/\.json$/, '.ndjson');

  const agent = agentTaskSpawn();
  const child = spawn(agent.command, [...agent.baseArgs, 'govern-run', '--kb', cwd,
    '--input-file', io.inputFile, '--output-file', outputFile],
    { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c;
    // bounded like stderr (2026-08-12 audit): the final summary JSON is ~1KB,
    // so a 64KB tail never hurts the success path
    if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
  });
  child.stderr.on('data', (c) => {
    stderr += c;
    if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
  });

  // tail the NDJSON output file as the graph writes it. Split the raw bytes
  // on \n (0x0A never appears inside a UTF-8 multibyte sequence) and decode
  // only complete lines — decoding each poll's delta would garble CJK split
  // across the 300ms boundary.
  let offset = 0;
  let carry = Buffer.alloc(0);
  const tailFile = () => {
    let buf;
    try {
      const fd = fs.openSync(outputFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= offset) { fs.closeSync(fd); return; }
      buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
    } catch { return; } // file not created yet
    const data = Buffer.concat([carry, buf]);
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 0x0a) continue;
      const line = data.toString('utf8', start, i).trim();
      start = i + 1;
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const mapped = formatGovernFrame(ev);
      if (mapped && mapped.text) events.emit('event', mapped);
    }
    carry = data.subarray(start);
  };
  const timer = setInterval(tailFile, 300);

  const cleanup = () => {
    clearInterval(timer);
    io.cleanup();
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  };
  child.on('error', (err) => { cleanup(); events.emit('done', { ok: false, text: `spawn failed: ${err.message}` }); });
  child.on('close', (code) => {
    tailFile(); // flush remaining frames
    let summary = null;
    try { summary = JSON.parse(stdout); } catch { /* non-JSON stdout */ }
    cleanup();
    if (code === 0 && summary && summary.ok !== false) {
      events.emit('done', { ok: true, text: `govern-run 完成:${JSON.stringify(summary).slice(0, 500)}` });
    } else {
      events.emit('done', { ok: false, text: `govern-run 失败(exit ${code}):${(stderr || stdout).slice(-1000)}` });
    }
  });

  return { events, kill: () => child.kill() };
}

registerExecutor('langgraph', startLanggraphRun);
