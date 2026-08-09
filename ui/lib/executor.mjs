// Agent executor abstraction (I2/I3, ADR-0006; S7 spike-verified 2026-08-02).
// Interface: startRun(spec) → { events: EventEmitter, kill() }. Any framework
// backend that can drive the service skills (or equivalent capability) plugs
// in by registering here — the first implementation is headless Claude.
//
// Event contract:
//   'event' { kind: 'init'|'assistant'|'result'|'stderr', text } — progressive
//   'done'  { ok, text } — final; ok is parsed from the result event, NEVER
//           from the exit code (S7 spike: a blocked write still exits 0 with
//           is_error false — exit code is not an error signal).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClaude } from './claudecli.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoFwd = () => REPO_ROOT.split(path.sep).join('/');

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

// ---- headless Claude (first implementation) ----
// Spike facts honored here:
//  ① event model = --output-format stream-json --verbose JSONL subset
//    (init / assistant / result), genuinely progressive;
//  ② spawn goes through cmd.exe on win32 (claudecli.mjs) — direct .cmd spawn
//    EINVALs on security-patched Node (real-env finding 2026-08-04,
//    superseding the spike's "spawn claude.cmd directly" conclusion);
//  ③ cwd must be a Windows path (Git-Bash /tmp paths ENOENT) — callers pass
//    path.resolve'd KB roots, which satisfies this naturally;
//  ④ permission posture (P2-2, user-ruled A 为主 2026-08-02; six-round spike
//    in docs/webui/spike-p2-2.zh-CN.md): **--permission-mode acceptEdits +
//    generated settings allow-list**, replacing --dangerously-skip-permissions
//    (ruling ④ revised — path-scoped rules are DEAD under skip-permissions;
//    acceptEdits has the cwd boundary built in: writes outside cwd need
//    approval → headless auto-deny, inside auto-accept). allow-list:
//    Bash(node <repo>/:*) so governance scripts run (node -e is denied),
//    read-only git prefixes, Read(<repo>/**) so the agent can read SKILL.md.
//    Residual: repo scripts with hostile args (they write into the KB by
//    contract) — layers B (prompt) and C (post-run git diff) stand behind.
//  ⑤ the prompt goes via STDIN, never as an argv slot (M7c e2e finding):
//    claude.cmd is a batch shim using %*, and cmd.exe treats a literal
//    newline in the command line as a command terminator — a multi-line
//    prompt produces ZERO output and no result event (single-line works).

// The per-deployment settings file lives under the KB's derived-artifact dir
// (write whitelist ④). Regenerated every run — cheap and always in sync.
export function buildAgentSettings(kbRoot) {
  const dir = path.join(kbRoot, '.kb', 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'agent-settings.json');
  // F3: GOVERNANCE.md is user-owned — deny the agent's file tools on it
  // (acceptEdits auto-accepts writes inside cwd, so this needs a hard rule).
  // Forward slashes, same as repoFwd — spike round 8's matching lesson.
  const kbFwd = kbRoot.split(path.sep).join('/');
  fs.writeFileSync(p, JSON.stringify({ permissions: {
    allow: [
      // /** glob, NOT the :* prefix form — spike round 8: Bash(prefix/:*) only
      // matches the bare command; arguments break the match. The /** glob
      // covers any repo script with any args. node -e stays denied.
      `Bash(node ${repoFwd()}/**)`,
      'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)',
      `Read(${repoFwd()}/**)`,
    ],
    deny: [
      `Edit(${kbFwd}/GOVERNANCE.md)`,
      `Write(${kbFwd}/GOVERNANCE.md)`,
    ],
  } }, null, 2), 'utf8');
  return p;
}

export function buildClaudeArgs(kbRoot) {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--settings', buildAgentSettings(kbRoot),
  ];
}

function startClaudeRun({ prompt, cwd }) {
  if (!prompt || !String(prompt).trim()) throw new Error('executor run requires a non-empty prompt');
  const events = new EventEmitter();
  const child = spawnClaude(buildClaudeArgs(cwd), { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.on('error', () => {}); // EPIPE if the process dies before reading
  child.stdin.write(String(prompt));
  child.stdin.end();

  let buf = '';
  let stderr = '';
  let result = null; // the stream-json 'result' event, when it arrives
  const emitText = (kind, text) => { if (text) events.emit('event', { kind, text }); };

  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // non-JSONL noise → ignore
    if (ev.type === 'system' && ev.subtype === 'init') {
      emitText('init', `session ${ev.session_id || ''} (${ev.model || 'claude'})`);
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text') emitText('assistant', block.text);
        else if (block.type === 'tool_use') {
          // I4 density (M7c review): "[Write: wiki/topics/x.md]" tells the
          // watcher WHAT the agent is doing, "[tool: Write]" does not.
          const target = block.input?.file_path || block.input?.path
            || (block.input?.command ? String(block.input.command).slice(0, 60) : null);
          emitText('assistant', target ? `[${block.name}: ${target}]` : `[tool: ${block.name}]`);
        }
      }
    } else if (ev.type === 'result') {
      result = ev;
    }
  };

  child.stdout.on('data', (c) => {
    buf += c;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) handle(line);
  });
  child.stderr.on('data', (c) => {
    stderr += c;
    if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
  });
  child.on('error', (err) => events.emit('done', { ok: false, text: `spawn failed: ${err.message}` }));
  child.on('close', (code) => {
    if (buf.trim()) handle(buf); // flush a trailing line without \n
    // ③ exit code is NOT the verdict. Parse the result event:
    // is_error/subtype first; the blocked-write text pattern second (spike ③).
    if (!result) {
      events.emit('done', { ok: false, text: `no result event (exit ${code})${stderr ? ': ' + stderr.slice(-1000) : ''}` });
      return;
    }
    const text = result.result || '';
    // Denial phrasings seen across postures: skip-permissions-era blocks, and
    // acceptEdits auto-denials ("requires approval", "hasn't been granted").
    const blocked = /write was blocked|permission to (write|edit)|requires approval|not been granted|permission not granted/i.test(text);
    const ok = result.is_error === false && result.subtype === 'success' && !blocked;
    events.emit('done', { ok, text: text || (ok ? '(completed without a summary)' : stderr.slice(-1000)) });
  });

  return { events, kill: () => child.kill() };
}

registerExecutor('claude', startClaudeRun);

// ---- LangGraph govern agent (ADR-0012) ----
// Spawns the Python agent service's `govern-run` task and tails its NDJSON
// output file, mapping frames onto the executor event contract. All governance
// writes happen inside the graph's govern.mjs subprocess calls — the portal's
// C-layer git boundary check still applies on top.
import { agentTaskSpawn } from './agentcli.mjs';
import crypto from 'node:crypto';

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

function startLanggraphRun({ prompt, cwd }) {
  const events = new EventEmitter();
  const dir = path.join(cwd, '.kb', 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const inputFile = path.join(dir, `govern-run-${id}.in.json`);
  const outputFile = path.join(dir, `govern-run-${id}.out.ndjson`);
  fs.writeFileSync(inputFile, JSON.stringify({ brief: String(prompt || ''), run_id: `portal-${id}` }), 'utf8');

  const agent = agentTaskSpawn();
  const child = spawn(agent.command, [...agent.baseArgs, 'govern-run', '--kb', cwd,
    '--input-file', inputFile, '--output-file', outputFile],
    { cwd: agent.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => {
    stderr += c;
    if (stderr.length > 32 * 1024) stderr = stderr.slice(-32 * 1024);
  });

  // tail the NDJSON output file as the graph writes it
  let offset = 0;
  let carry = '';
  const tailFile = () => {
    let text;
    try {
      const fd = fs.openSync(outputFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= offset) { fs.closeSync(fd); return; }
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      text = buf.toString('utf8');
    } catch { return; } // file not created yet
    const lines = (carry + text).split('\n');
    carry = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const mapped = formatGovernFrame(ev);
      if (mapped && mapped.text) events.emit('event', mapped);
    }
  };
  const timer = setInterval(tailFile, 300);

  const cleanup = () => {
    clearInterval(timer);
    try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
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
