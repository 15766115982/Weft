// Job-runner helpers for LLM service tasks.
// Builds job specs that spawn node <repo>/llm/llm.mjs with JSON input/output files.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLM_CLI = path.resolve(__dirname, '..', '..', 'llm', 'llm.mjs');

export function llmJobSpec(kbRoot, task, input = {}) {
  const workDir = path.join(kbRoot, '.kb', 'ui', 'jobs');
  fs.mkdirSync(workDir, { recursive: true });
  const inputFile = path.join(workDir, `${task}-in-${Date.now()}.json`);
  const outputFile = path.join(workDir, `${task}-out-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input, null, 2), 'utf8');

  const args = [
    LLM_CLI,
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
        await spawnJob(job, process.execPath, args, { env: process.env });
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

  const args = [
    LLM_CLI,
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
        await spawnJob(job, process.execPath, args, { env: process.env });
        return { outputFile };
      } finally {
        try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
      }
    },
  };
}
