// Job-runner helpers for agent-service tasks (ADR-0012: formerly the Node llm/
// service). Builds job specs that spawn `<python> -m weft_agent` with JSON
// input/output files — the CLI contract is unchanged.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';
import { agentTaskSpawn } from './agentcli.mjs';

export function llmJobSpec(kbRoot, task, input = {}) {
  const workDir = path.join(kbRoot, '.kb', 'ui', 'jobs');
  fs.mkdirSync(workDir, { recursive: true });
  const inputFile = path.join(workDir, `${task}-in-${Date.now()}.json`);
  const outputFile = path.join(workDir, `${task}-out-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input, null, 2), 'utf8');

  const agent = agentTaskSpawn();
  const args = [
    ...agent.baseArgs,
    task,
    '--kb', kbRoot,
    '--input-file', inputFile,
    '--output-file', outputFile,
  ];

  return {
    type: `llm-${task}`,
    label: `llm ${task}`,
    async run(job) {
      try {
        await spawnJob(job, agent.command, args, { env: process.env, cwd: agent.cwd });
        const raw = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '{}';
        return JSON.parse(raw);
      } finally {
        // Best-effort cleanup of transient input/output files.
        try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
        try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
      }
    },
  };
}

export function llmStreamingJobSpec(kbRoot, task, input = {}) {
  const workDir = path.join(kbRoot, '.kb', 'ui', 'jobs');
  fs.mkdirSync(workDir, { recursive: true });
  const inputFile = path.join(workDir, `${task}-in-${Date.now()}.json`);
  const outputFile = path.join(workDir, `${task}-out-${Date.now()}.ndjson`);
  fs.writeFileSync(inputFile, JSON.stringify(input, null, 2), 'utf8');

  const agent = agentTaskSpawn();
  const args = [
    ...agent.baseArgs,
    task,
    '--kb', kbRoot,
    '--input-file', inputFile,
    '--output-file', outputFile,
  ];

  return {
    type: `llm-${task}`,
    label: `llm ${task}`,
    outputFile,
    async run(job) {
      try {
        await spawnJob(job, agent.command, args, { env: process.env, cwd: agent.cwd });
        return { outputFile };
      } finally {
        try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
      }
    },
  };
}
