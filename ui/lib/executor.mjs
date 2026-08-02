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
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

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
//  ② spawn 'claude.cmd' directly, no shell ('claude' ENOENTs on Windows);
//  ③ cwd must be a Windows path (Git-Bash /tmp paths ENOENT) — callers pass
//    path.resolve'd KB roots, which satisfies this naturally;
//  ④ permission posture: --dangerously-skip-permissions (user-ruled
//    2026-08-02; buffered by candidate review + full job logging);
//  ⑤ the prompt goes via STDIN, never as an argv slot (M7c e2e finding):
//    claude.cmd is a batch shim using %*, and cmd.exe treats a literal
//    newline in the command line as a command terminator — a multi-line
//    prompt produces ZERO output and no result event (single-line works).
function startClaudeRun({ prompt, cwd }) {
  if (!prompt || !String(prompt).trim()) throw new Error('executor run requires a non-empty prompt');
  const events = new EventEmitter();
  const child = spawn('claude.cmd', [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
  ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        else if (block.type === 'tool_use') emitText('assistant', `[tool: ${block.name}]`);
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
    const blocked = /write was blocked|permission to (write|edit)/i.test(text);
    const ok = result.is_error === false && result.subtype === 'success' && !blocked;
    events.emit('done', { ok, text: text || (ok ? '(completed without a summary)' : stderr.slice(-1000)) });
  });

  return { events, kill: () => child.kill() };
}

registerExecutor('claude', startClaudeRun);
