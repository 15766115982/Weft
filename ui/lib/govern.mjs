// M7c governance jobs (I1 mechanical steps + I2 agent runs). Same discipline
// as M7b: every KB-mutating helper runs INSIDE the per-KB serial queue;
// the governance CLI is spawned (process isolation), never imported for writes.
// plan() is read-only and imported in-process elsewhere (browse.mjs precedent).
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';
import { tail } from './sys.mjs';
import { startRun, executorNames } from './executor.mjs';
import { appendGovernRun, resumableGovernRun } from './governruns.mjs';
// F4: read-only post-run validation (serve.mjs's in-process plan() precedent —
// the file header's "never imported for writes" discipline stays intact).
import { plan } from '../../governance/scripts/lib/govern.mjs';

// the run-done path is async — sync git there would stall the portal's event
// loop for every concurrent request (review-fix review 2026-08-04, N3)
const execFileP = promisify(execFile);

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

function gitHead(kb) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: kb, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; } // not a git repo
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

// One commit per governance run (CONTEXT.md:190 — the KB's git history is the
// audit/rollback backbone). The pathspec is ONLY the paths this run made dirty
// (after-porcelain minus before-porcelain, intersected with wiki/ + log.md):
// the user's own pre-existing uncommitted edits are never swept into a
// governance commit (review-fix review 2026-08-04, N3; shared blind spot with
// the C layer: a path dirty before AND changed by the run is unattributable
// and goes in). Fixed machine author keeps run commits greppable. Async — a
// sync git here would stall the portal's event loop.
// Returns true (committed) / false (the run changed nothing); THROWS on git
// failure — a rejected commit (hook, lock, config) must surface loudly, never
// read as "nothing happened". The caller skips this entirely on non-git KBs.
async function commitGovernRun(kb, jobId, before) {
  const { stdout: after } = await execFileP('git', ['-C', kb, 'status', '--porcelain'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const pre = porcelainPaths(before);
  const runPaths = [...porcelainPaths(after)]
    .filter((p) => !pre.has(p) && (p === 'log.md' || p.startsWith('wiki/')))
    .sort();
  if (!runPaths.length) return false;
  const GIT_ID = ['-c', 'user.name=kb-portal', '-c', 'user.email=kb-portal@localhost'];
  await execFileP('git', ['-C', kb, 'add', '--', ...runPaths]);
  await execFileP('git', ['-C', kb, ...GIT_ID, 'commit', '-m', `govern: agent run ${jobId}`, '--', ...runPaths]);
  return true;
}

// F2 content snapshot (openwiki-inspired): whole-tree hash of wiki/ so a run
// that changed nothing is marked no-op instead of looking productive. Cheap
// (wiki pages are tens of KB) against a minutes-long agent run.
export function wikiHash(kb) {
  const root = path.join(kb, 'wiki');
  if (!fs.existsSync(root)) return null;
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith('.md')) files.push(abs);
    }
  };
  walk(root);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    h.update(rel + '\0' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') + '\n');
  }
  return h.digest('hex');
}

// F3 user governance brief (openwiki INSTRUCTIONS.md-inspired): <kb>/GOVERNANCE.md
// is USER-OWNED — read and prepended to every agent prompt here on the server,
// so textarea edits or direct API calls cannot drop it. Hard-capped at 8KB
// (≈2700 CJK chars); the agent is told when truncation happened.
const BRIEF_MAX = 8 * 1024;
export function buildGovernPrompt(kb, userPrompt) {
  const briefPath = path.join(kb, 'GOVERNANCE.md');
  if (!fs.existsSync(briefPath)) return userPrompt;
  let brief = fs.readFileSync(briefPath, 'utf8');
  let truncated = '';
  if (Buffer.byteLength(brief, 'utf8') > BRIEF_MAX) {
    brief = Buffer.from(brief, 'utf8').subarray(0, BRIEF_MAX).toString('utf8');
    truncated = '\n(纲要过长,已截断至 8KB)';
  }
  return [
    '# 用户治理纲要(GOVERNANCE.md,服务端注入,优先级高于下方指令中的风格偏好)',
    brief + truncated,
    '',
    'GOVERNANCE.md 由用户所有,你(agent)不得创建、修改或删除它。',
    '',
    '# 本次任务',
    userPrompt,
  ].join('\n');
}

// I2: agent-driven governance (the intellectual steps: summaries, topic
// synthesis). Streams executor events into job.log AND to onChunk (the SSE
// 'run' channel, I4). The run's verdict comes from the executor's parsed
// result event — never from an exit code (executor.mjs header).
export function governRunJob(kb, { prompt, executor = 'langgraph', resume = false }, onChunk) {
  if (!executorNames().includes(executor)) {
    throw new Error(`unknown executor: ${executor} (registered: ${executorNames().join(', ')})`);
  }
  return {
    type: 'govern-run',
    label: `agent 治理 (${executor})${resume ? ' · 续跑' : ''}`,
    run: (job) => new Promise((resolve, reject) => {
      let run;
      const before = gitPorcelain(kb); // C layer baseline (null when not git)
      const hashBefore = wikiHash(kb); // F2 no-op baseline
      const headBefore = gitHead(kb);
      const startTs = new Date().toISOString();
      const finalPrompt = buildGovernPrompt(kb, prompt); // F3 brief injection
      // resume: pick up the latest interrupted/failed/cancelled run's
      // checkpoint thread; fresh run when none qualifies. The thread id rides
      // the start record so a failed RESUME run still points at the same
      // checkpoint thread (the resumable pointer follows the newer job).
      const resumeTarget = resume ? resumableGovernRun(kb, job.id) : null;
      if (resume && !resumeTarget) {
        job.log = '没有可续跑的未完成 run,按全新 run 启动\n';
      }
      const threadId = resumeTarget?.threadId || `portal-${job.id}`;
      // F1 history: start line first — a missing finish line is how the read
      // side infers 'interrupted' (governruns.mjs).
      appendGovernRun(kb, {
        ts: startTs, jobId: job.id, phase: 'start', executor, threadId,
        promptHash: crypto.createHash('sha256').update(finalPrompt).digest('hex').slice(0, 12),
      });
      try {
        run = startRun(executor, { prompt: finalPrompt, cwd: kb, resumeThreadId: resumeTarget ? threadId : null });
      } catch (err) { reject(err); return; }
      job.kill = run.kill; // jobs.cancel(kb, id) calls this for running jobs
      run.events.on('event', (e) => {
        const line = e.kind === 'init' ? `— ${e.text} —\n` : e.text;
        job.log = (job.log + line).slice(-64 * 1024);
        onChunk?.(job, e.kind, line);
      });
      run.events.on('done', async ({ ok, text }) => {
        try {
          job.log = (job.log + (job.log.endsWith('\n') || !job.log ? '' : '\n')).slice(-64 * 1024);
          const violations = boundaryViolations(before, gitPorcelain(kb));
          if (violations.length) {
            const warn = `\n⚠ 边界检查:运行期间以下 KB 外/非治理写集路径发生变化 — ${violations.join(', ')}`;
            job.log = (job.log + warn).slice(-64 * 1024);
            onChunk?.(job, 'system', warn);
          }
          // one commit per governance run (CONTEXT.md) — after the boundary
          // check (its porcelain must see the run's changes), before the
          // wikiHash/gitHead capture so the record reflects the commit.
          // headBefore null = non-git KB → silent skip (S4); a git FAILURE is
          // not silence — the run's changes sit uncommitted and the log says so.
          let committed = null; // true | false | 'failed' | null (non-git)
          if (ok && headBefore !== null) {
            try {
              committed = await commitGovernRun(kb, job.id, before);
              if (committed) {
                const note = `\n— 本次治理变更已提交 git(govern: agent run ${job.id})—`;
                job.log = (job.log + note).slice(-64 * 1024);
                onChunk?.(job, 'system', note);
              }
            } catch (err) {
              committed = 'failed';
              const warn = `\n⚠ 治理自动提交失败(改动仍在工作区,未丢失;请手工 git 提交):${String(err.message).split('\n')[0]}`;
              job.log = (job.log + warn).slice(-64 * 1024);
              onChunk?.(job, 'system', warn);
            }
          }
          const hashAfter = wikiHash(kb);
          const noop = ok && hashBefore !== null && hashBefore === hashAfter;
          if (noop) {
            const note = '\n— 本次治理无 wiki 变更 —';
            job.log = (job.log + note).slice(-64 * 1024);
            onChunk?.(job, 'system', note);
          }
          // F4 deterministic post-run validation (openwiki-inspired): the LLM
          // writes content; plain code checks structure. plan() is read-only
          // and cheap against a minutes-long run. Details are capped at 50 per
          // list — the full set is always available via /api/plan.
          let postPlan = null;
          if (ok) {
            try {
              const post = plan(kb);
              postPlan = {
                dangling_links: post.dangling_links.slice(0, 50),
                anomalies: post.anomalies.slice(0, 50),
                errors: post.errors.slice(0, 50),
                orphaned_pages: post.orphaned_pages.slice(0, 50),
                counts: {
                  dangling_links: post.dangling_links.length,
                  anomalies: post.anomalies.length,
                  errors: post.errors.length,
                  orphaned_pages: post.orphaned_pages.length,
                },
              };
            } catch { /* post-run validation is advisory, never fails the run */ }
          }
          // F1 history: finish line BEFORE resolve/reject so the record is on
          // disk before the job's done/failed event goes out.
          const finishTs = new Date().toISOString();
          appendGovernRun(kb, {
            ts: finishTs, jobId: job.id, phase: 'finish',
            status: job.cancelled ? 'cancelled' : ok ? 'complete' : 'failed',
            durationMs: Date.now() - Date.parse(startTs),
            gitHeadBefore: headBefore, gitHeadAfter: gitHead(kb),
            wikiHashBefore: hashBefore, wikiHashAfter: hashAfter, noop,
            boundaryViolations: violations.length,
            gitCommitted: committed,
            postPlanCounts: postPlan ? postPlan.counts : null,
          });
          // a resume run closes the old run's history: the checkpoint thread
          // now belongs to THIS job (its finish status governs resumability).
          // Same ts as this run's finish so freshness keeps the real run as
          // latest (the close is bookkeeping, not newer activity).
          if (resumeTarget) {
            appendGovernRun(kb, {
              ts: finishTs, jobId: resumeTarget.jobId, phase: 'finish',
              status: 'resumed', resumedBy: job.id,
            });
          }
          if (ok) resolve({
            result: tail(text),
            wikiHashBefore: hashBefore, wikiHashAfter: hashAfter, noop,
            ...(committed !== null ? { gitCommitted: committed } : {}),
            ...(postPlan ? { postPlan } : {}),
            ...(violations.length ? { boundaryViolations: violations } : {}),
          });
          else reject(new Error(tail(text, 2000)));
        } catch (err) { reject(err); } // async handler: never leave the job pending
      });
    }),
  };
}
