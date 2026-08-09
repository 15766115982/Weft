// K evaluation service (block K): lightweight self-built judge — a single LLM
// chat call, pointwise 0-3 with a fixed rubric, zero Python in the UI layer.
// The judge registry mirrors executor.mjs (registerExecutor / startRun).
// Backend (ADR-0012): the Python agent service's `complete` task (the retired
// claude -p adapter was removed with the claude CLI dependency).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { agentTaskSpawn } from './agentcli.mjs';

const registry = new Map();

export function registerJudge(name, chatFn) {
  registry.set(name, chatFn);
}

export function judgeNames() {
  return [...registry.keys()];
}

// ---- agent-service chat adapter ----
// One `complete` task call: prompt via JSON input file, text from the output
// file. The judge never touches the filesystem itself — the task only talks to
// the model; its input is untrusted KB content, its output is display-only.
function agentChat(prompt, { kb, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!kb) return reject(new Error('judge agent backend requires kb'));
    const dir = path.join(kb, '.kb', 'ui', 'judge');
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(6).toString('hex');
    const inputFile = path.join(dir, `in-${id}.json`);
    const outputFile = path.join(dir, `out-${id}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ prompt }), 'utf8');

    const agent = agentTaskSpawn();
    const child = spawn(agent.command, [...agent.baseArgs, 'complete', '--kb', kb,
      '--input-file', inputFile, '--output-file', outputFile],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    const cleanup = () => {
      try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
      try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
    };
    let err = '';
    const timer = setTimeout(() => { child.kill(); cleanup(); reject(new Error('judge timeout')); }, timeoutMs);
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try { text = JSON.parse(fs.readFileSync(outputFile, 'utf8')).text || ''; } catch { /* missing/malformed */ }
      cleanup();
      if (code !== 0 && !text.trim()) reject(new Error(`judge exited ${code}: ${err.slice(-300)}`));
      else resolve(text.trim());
    });
  });
}

registerJudge('agent', agentChat);

// ---- the rubric (fixed, K2) ----
const RUBRIC = `You are grading search results for relevance to a query.
Rubric: 3 = directly answers the query; 2 = relevant and useful; 1 = weakly related; 0 = irrelevant.
Reply with ONLY a JSON array, one object per result, in the same order:
[{"id": <number>, "score": <0|1|2|3>, "reason": "<=15 words"}]`;

export function buildJudgePrompt(q, results) {
  const items = results.map((r, i) => ({
    id: i + 1,
    title: String(r.title || r.page || '').slice(0, 200),
    snippet: String(r.snippet || '').slice(0, 500),
  }));
  return `${RUBRIC}\n\nQuery: ${q}\n\nResults:\n${JSON.stringify(items, null, 2)}`;
}

// tolerate prose around the JSON array (judge models love prefacing)
export function parseVerdicts(text, count) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error(`judge returned no JSON array: ${String(text).slice(0, 160)}`);
  const arr = JSON.parse(m[0]);
  const byId = new Map(arr.map((v) => [Number(v.id), v]));
  const out = [];
  for (let i = 1; i <= count; i++) {
    const v = byId.get(i);
    out.push(v && Number.isInteger(v.score) && v.score >= 0 && v.score <= 3
      ? { score: v.score, reason: String(v.reason || '').slice(0, 120) }
      : { score: null, reason: 'judge 未给这条打分' });
  }
  return out;
}

export async function judge(name, q, results, { kb } = {}) {
  const chat = registry.get(name);
  if (!chat) throw new Error(`unknown judge backend: ${name} (registered: ${judgeNames().join(', ') || 'none'})`);
  const t0 = Date.now();
  const text = await chat(buildJudgePrompt(q, results), { kb });
  return { verdicts: parseVerdicts(text, results.length), backend: name, ms: Date.now() - t0 };
}
