// F1 governance run history (openwiki-inspired): every agent governance run
// appends a 'start' line when dequeued and a 'finish' line when the executor
// reports back, mirroring acquisition's .kb/acquire_runs.jsonl. The two-phase
// shape lets the READ side infer 'interrupted' (a start with no finish whose
// job is not currently active) exactly the way jobs.jsonl tombstones dead
// processes — no patching of the crash path needed.
//
// Caveat (documented blind spot): 'interrupted' is a read-side inference. Two
// portal processes on the same KB would read each other's running jobs as
// interrupted — the single-operator discipline (serve.mjs startup warning)
// already rules that out.
import fs from 'node:fs';
import path from 'node:path';

function runsFile(kb) {
  return path.join(kb, '.kb', 'govern_runs.jsonl');
}

// Best-effort append — history must never break the run itself (jobs.mjs
// persist() precedent).
export function appendGovernRun(kb, rec) {
  try {
    fs.mkdirSync(path.join(kb, '.kb'), { recursive: true });
    fs.appendFileSync(runsFile(kb), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* history is best-effort */ }
}

// Latest run's effective state. activeIds = job ids currently queued/running
// in this portal's job center (a start-only record for one of those is
// 'running', not 'interrupted').
export function governRunFreshness(kb, activeIds = new Set()) {
  const byId = new Map(); // jobId -> {start?, finish?} (file is small: 2 lines/run)
  let lines;
  try { lines = fs.readFileSync(runsFile(kb), 'utf8').split('\n'); } catch { return null; }
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; /* torn line */ }
    if (!rec.jobId) continue;
    const e = byId.get(rec.jobId) || {};
    if (rec.phase === 'start') e.start = rec;
    else if (rec.phase === 'finish') e.finish = rec;
    byId.set(rec.jobId, e);
  }
  let latest = null;
  for (const [jobId, e] of byId) {
    const ts = (e.finish || e.start).ts;
    if (latest && ts <= latest.ts) continue;
    let status;
    if (e.finish) status = e.finish.status;
    else status = activeIds.has(jobId) ? 'running' : 'interrupted';
    latest = { ts, jobId, status, ...(e.finish || {}), phase: undefined };
  }
  if (latest) { delete latest.phase; latest.startedAt = byId.get(latest.jobId)?.start?.ts || null; }
  return latest;
}
