// Agent-service spawn resolution (ADR-0012): the LLM tasks live in the Python
// `agent/` package. Everything spawns `<python> -m weft_agent`; the CLI
// contract is unchanged.
//
// Python resolution order:
//   1. WEFT_AGENT_PYTHON env var (explicit override)
//   2. the service venv: agent/.venv (Scripts/python.exe on win32, bin/python otherwise)
//   3. "python" on PATH
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AGENT_DIR = path.resolve(__dirname, '..', '..', 'agent');

export function agentPython() {
  if (process.env.WEFT_AGENT_PYTHON) return process.env.WEFT_AGENT_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(AGENT_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(AGENT_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return 'python';
}

// [python, '-m', 'weft_agent'] — spread first into spawn args.
export function agentSpawnSpec() {
  return { command: agentPython(), baseArgs: ['-m', 'weft_agent'], cwd: AGENT_DIR };
}

// Test hook: WEFT_AGENT_STUB points at a node stub script that emulates the
// agent CLI (ui/test/fixtures/kb.mjs writeLlmStub). When set, spawns
// `node <stub>` instead of python — same argv shape after the base args.
export function agentTaskSpawn() {
  if (process.env.WEFT_AGENT_STUB) {
    return { command: process.execPath, baseArgs: [process.env.WEFT_AGENT_STUB], cwd: undefined };
  }
  return agentSpawnSpec();
}

// One-shot task I/O plumbing: scratch input/output files under .kb/ui/, the
// argv tail, and a cleanup fn. Shared by judge (complete) and the langgraph
// executor (govern-run) so the temp-file dance lives in exactly one place.
export function agentTaskIO(kb, tag, input) {
  const dir = path.join(kb, '.kb', 'ui');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const inputFile = path.join(dir, `${tag}-${id}.in.json`);
  const outputFile = path.join(dir, `${tag}-${id}.out.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input), 'utf8');
  const cleanup = () => {
    try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  };
  return { inputFile, outputFile, cleanup };
}
