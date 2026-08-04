// K evaluation service (block K, direction already ruled in requirements):
// lightweight self-built judge — Node calls the LLM directly, pointwise 0-3
// with a fixed rubric, zero Python. The judge registry mirrors executor.mjs
// (registerExecutor / startRun): together they are the "LLM backend registry"
// the M7c reviewer asked to unify (executor = name → startRun; judge =
// name → chat → text). First adapter: claude -p headless (the only LLM source
// verified reachable today — copilot-proxy / Azure SPN endpoints are still
// "待验证" in requirements; they plug in here by the same one-call register).
//
// Promptfoo CI golden-set regression (K2): deliberately NOT vendored — heavy
// npm dependency, intranet rule. The existing tests/eval gate (Hit@5=1.000)
// stays the CI regression; judge calibration runs are manual (K4 note).
import { spawnClaude } from './claudecli.mjs';

const registry = new Map();

export function registerJudge(name, chatFn) {
  registry.set(name, chatFn);
}

export function judgeNames() {
  return [...registry.keys()];
}

// ---- claude -p chat adapter ----
// Plain text out (no stream-json needed — one final answer). Prompt via stdin
// (the M7c %*-shim finding). Tools disabled outright: the judge must never
// touch the filesystem — its input is untrusted KB content.
function claudeChat(prompt, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnClaude([
      '-p',
      '--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('judge timeout')); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) reject(new Error(`judge exited ${code}: ${err.slice(-300)}`));
      else resolve(out.trim());
    });
  });
}

registerJudge('claude', claudeChat);

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

export async function judge(name, q, results) {
  const chat = registry.get(name);
  if (!chat) throw new Error(`unknown judge backend: ${name} (registered: ${judgeNames().join(', ') || 'none'})`);
  const t0 = Date.now();
  const text = await chat(buildJudgePrompt(q, results));
  return { verdicts: parseVerdicts(text, results.length), backend: name, ms: Date.now() - t0 };
}
