// Agent-service spawn resolution (ADR-0012): the LLM tasks now live in the
// Python `agent/` package. Everything that used to spawn `node llm/llm.mjs`
// spawns `<python> -m weft_agent` instead; the CLI contract is unchanged.
//
// Python resolution order:
//   1. WEFT_AGENT_PYTHON env var (explicit override)
//   2. the service venv: agent/.venv (Scripts/python.exe on win32, bin/python otherwise)
//   3. "python" on PATH
import fs from 'node:fs';
import path from 'node:path';
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

// Test hook: WEFT_LLM_CLI points at a node stub script that emulates the agent
// CLI (ui/test/fixtures/kb.mjs writeLlmStub). When set, spawns `node <stub>`
// instead of python — same argv shape after the base args.
export function agentTaskSpawn() {
  if (process.env.WEFT_LLM_CLI) {
    return { command: process.execPath, baseArgs: [process.env.WEFT_LLM_CLI], cwd: undefined };
  }
  return agentSpawnSpec();
}
