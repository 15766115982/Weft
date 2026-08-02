// M7c governance jobs (I1 mechanical steps + I2 agent runs). Same discipline
// as M7b: every KB-mutating helper runs INSIDE the per-KB serial queue;
// the governance CLI is spawned (process isolation), never imported for writes.
// plan() is read-only and imported in-process elsewhere (browse.mjs precedent).
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';
import { startRun, executorNames } from './executor.mjs';

const GOVERN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'governance', 'scripts', 'govern.mjs',
);

// I1: mechanical governance steps the UI may trigger. approve/reject already
// exist as the statusflip review (M7a); plan is read-only (I5 preview).
const MECHANICAL = new Set(['sweep', 'rebuild-index', 'merge-topic']);

export function governJob(kb, { action, from, to }) {
  if (!MECHANICAL.has(action)) throw new Error(`unknown mechanical step: ${action} (have: ${[...MECHANICAL].join(', ')})`);
  const args = [GOVERN, action, '--kb', kb];
  if (action === 'merge-topic') {
    if (!from || !to) throw new Error('merge-topic requires from + to slugs');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(from) || !/^[a-z0-9][a-z0-9-]*$/.test(to)) {
      throw new Error(`slugs must be lowercase-kebab: ${from} → ${to}`);
    }
    args.push('--from', String(from), '--to', String(to));
  }
  return {
    type: 'govern',
    label: `govern ${action}${from ? ` ${from} → ${to}` : ''}`,
    run: async (job) => tail((await spawnJob(job, process.execPath, args)).log),
  };
}

// ---- C layer (P2-2, ruling ⑧): post-run boundary check on git KBs ----
// acceptEdits confines the agent's file tools to the KB (executor.mjs ④);
// this layer DETECTS what got through anyway. Blind spot, documented: a path
// already dirty before the run can't be attributed, so only newly-dirty paths
// outside the governance write set are reported.
const GOVERN_WRITE_ROOTS = ['wiki/', 'log.md', '.kb/'];

function gitPorcelain(kb) {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: kb, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; } // not a git repo (or no git) → layer C inactive
}

// porcelain " XY path" / "XY old -> new" → set of changed paths
function porcelainPaths(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const p = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
    out.add(p);
  }
  return out;
}

export function boundaryViolations(before, after) {
  if (before === null || after === null) return [];
  const pre = porcelainPaths(before);
  const out = [];
  for (const p of porcelainPaths(after)) {
    if (pre.has(p)) continue;
    if (!GOVERN_WRITE_ROOTS.some((r) => p === r || p.startsWith(r))) out.push(p);
  }
  return out.sort();
}

// I2: agent-driven governance (the intellectual steps: summaries, topic
// synthesis). Streams executor events into job.log AND to onChunk (the SSE
// 'run' channel, I4). The run's verdict comes from the executor's parsed
// result event — never from an exit code (executor.mjs header).
export function governRunJob(kb, { prompt, executor = 'claude' }, onChunk) {
  if (!executorNames().includes(executor)) {
    throw new Error(`unknown executor: ${executor} (registered: ${executorNames().join(', ')})`);
  }
  return {
    type: 'govern-run',
    label: `agent 治理 (${executor})`,
    run: (job) => new Promise((resolve, reject) => {
      let run;
      const before = gitPorcelain(kb); // C layer baseline (null when not git)
      try {
        run = startRun(executor, { prompt, cwd: kb });
      } catch (err) { reject(err); return; }
      job.kill = run.kill; // jobs.cancel(kb, id) calls this for running jobs
      run.events.on('event', (e) => {
        const line = e.kind === 'init' ? `— ${e.text} —\n` : e.text;
        job.log = (job.log + line).slice(-64 * 1024);
        onChunk?.(job, e.kind, line);
      });
      run.events.on('done', ({ ok, text }) => {
        job.log = (job.log + (job.log.endsWith('\n') || !job.log ? '' : '\n')).slice(-64 * 1024);
        const violations = boundaryViolations(before, gitPorcelain(kb));
        if (violations.length) {
          const warn = `\n⚠ 边界检查:运行期间以下 KB 外/非治理写集路径发生变化 — ${violations.join(', ')}`;
          job.log = (job.log + warn).slice(-64 * 1024);
          onChunk?.(job, 'system', warn);
        }
        if (ok) resolve({ result: tail(text), ...(violations.length ? { boundaryViolations: violations } : {}) });
        else reject(new Error(tail(text, 2000)));
      });
    }),
  };
}

function tail(s, n = 4000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(-n) : s;
}
