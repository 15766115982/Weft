// Per-KB serial write queue + job center (S10, ADR-0006; I6 foundation).
// The system's single-operator assumption is enforced here at the tool layer:
// every whitelisted KB write from the portal (upload-acquire, source pull,
// raw delete/move) is a job, and jobs for the same KB run strictly one at a
// time, in submission order. Read-only endpoints never touch this queue.
//
// Persistence: each job is one JSON line appended to <kb>/.kb/ui/jobs.jsonl
// (whitelisted write ④). On startup, jobs left 'queued'/'running' by a dead
// process are tombstoned to 'failed' (interrupted) — the queue state itself
// lives only in memory, the file is the audit/history trail for the job center.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as defaultSpawn } from 'node:child_process';

const KEEP = 200; // in-memory history bound per KB (job center display)
const LOG_TAIL = 64 * 1024; // per-job captured output bound

export function createJobCenter() {
  const queues = new Map(); // kbRoot -> { tail: Promise, jobs: Job[] }
  const settled = new Map(); // job.id -> Promise resolving when the job finishes
  const listeners = new Set();

  const stateFor = (kb) => {
    let s = queues.get(kb);
    if (!s) {
      s = { tail: Promise.resolve(), jobs: loadHistory(kb) };
      queues.set(kb, s);
    }
    return s;
  };

  const emit = (job) => {
    for (const cb of listeners) {
      try { cb(job); } catch { /* a dead SSE client must not break the queue */ }
    }
  };

  // spec: { type, label, run(job) -> result object | throws }
  // run() executes inside the per-KB serial chain; it must be the ONLY writer.
  function enqueue(kb, spec) {
    const s = stateFor(kb);
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      kb, type: spec.type, label: spec.label || spec.type,
      status: 'queued', createdAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, error: null, result: null, log: '',
    };
    s.jobs.push(job);
    if (s.jobs.length > KEEP) s.jobs.splice(0, s.jobs.length - KEEP);
    persist(kb, job);
    emit(job);

    s.tail = s.tail.then(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      persist(kb, job); emit(job);
      try {
        job.result = (await spec.run(job)) ?? null;
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
      }
      job.finishedAt = new Date().toISOString();
      persist(kb, job); emit(job);
    });
    // A failed job must not poison the chain — the next queued job still runs.
    s.tail = s.tail.catch(() => {});
    settled.set(job.id, s.tail);
    return job;
  }

  return {
    enqueue,
    // Await a job's completion and return its final record (never rejects —
    // the outcome is in job.status/job.error). Lets endpoints keep a
    // synchronous request/response shape while writes stay serialized.
    waitFor: async (job) => { await settled.get(job.id); return job; },
    list: (kb) => [...stateFor(kb).jobs].reverse(), // newest first
    get: (kb, id) => stateFor(kb).jobs.find((j) => j.id === id) || null,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

function jobsFile(kb) {
  return path.join(kb, '.kb', 'ui', 'jobs.jsonl');
}

function persist(kb, job) {
  // Status transitions rewrite the line: append the full record each time and
  // let readers take the LAST line per id (append-only, no in-place rewrite).
  try {
    fs.mkdirSync(path.dirname(jobsFile(kb)), { recursive: true });
    fs.appendFileSync(jobsFile(kb), JSON.stringify(job) + '\n', 'utf8');
  } catch { /* history is best-effort; the in-memory queue is authoritative */ }
}

function loadHistory(kb) {
  const byId = new Map();
  try {
    for (const line of fs.readFileSync(jobsFile(kb), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        // interrupted by a dead process: tombstone on load
        if (j.status === 'queued' || j.status === 'running') {
          j.status = 'failed';
          j.error = j.error || 'interrupted: portal stopped while the job was pending';
          j.finishedAt = j.finishedAt || new Date().toISOString();
        }
        byId.set(j.id, j);
      } catch { /* skip a torn last line from a crashed append */ }
    }
  } catch { /* no history yet */ }
  return [...byId.values()].slice(-KEEP);
}

// Shared helper for spawn-based job runners (acquire CLI, future executors):
// capture combined output with a bound, resolve with tail; exit≠0 → throw.
export function spawnJob(job, command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = (opts.spawn || defaultSpawn)(command, args, {
      cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (c) => {
      out += c;
      if (out.length > LOG_TAIL) out = out.slice(-LOG_TAIL);
      job.log = out;
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ log: out });
      else reject(new Error(`${path.basename(command)} exited ${code}: ${out.slice(-2000)}`));
    });
  });
}
