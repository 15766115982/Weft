// M7b write-operation runners (ADR-0006 whitelist ①② + F/J5/J6). Every
// KB-mutating helper here is designed to run INSIDE the per-KB serial queue
// (jobs.mjs) — never call them off-queue from an endpoint.
// Writes spawn the acquisition CLI (process isolation, ADR-0006 integration
// split); nothing in the acquisition service is imported in-process for writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';
import { normalizeInboxName, normalizeRawRel, resolveUnder } from './paths.mjs';
import { tail, isGitRepo } from './sys.mjs';

// async git: execFileSync inside the serial queue froze the whole portal event
// loop for the duration of the commit (2026-08-12 audit; same class as the
// 2026-08-04 review fix in serve.mjs). 10s timeout so a wedged git fails the
// job instead of hanging the queue.
const execFileP = promisify(execFile);
const GIT_TIMEOUT = { timeout: 10000 };

const ACQUIRE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'acquisition', 'scripts', 'acquire.mjs',
);

export const UPLOAD_MAX = 32 * 1024 * 1024; // 32MB raw-bytes cap (E: no multipart)

// Connector name lists, one place (review 2026-08-04: the three hardcoded
// ['jira','confluence'] / ['local','jira','confluence'] literals were a
// shotgun-surgery trap — a new connector had to find every list).
const REMOTE_CONNECTORS = ['jira', 'confluence']; // --check / --probe exist for these
const ALL_CONNECTORS = ['local', ...REMOTE_CONNECTORS];

// ---- job runners (on-queue only) ----

// E1: inbox upload + immediate local acquire. The upload bytes arrive with the
// request but the file is written HERE, inside the queue, so inbox writes are
// serialized with every other KB write.
export function uploadJob(kb, { filename, bytes }) {
  const name = normalizeInboxName(filename);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('upload body must be non-empty bytes');
  return {
    type: 'upload',
    label: `upload ${name} → acquire local`,
    run: async (job) => {
      const inbox = path.join(kb, 'inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, name), bytes);
      job.log = `inbox/${name} written (${bytes.length} bytes)\n`;
      const { log } = await spawnJob(job, process.execPath, [ACQUIRE, 'local', '--kb', kb]);
      return { inbox: `inbox/${name}`, acquire: tail(log) };
    },
  };
}

// F1: source pull with UI-supplied scope overrides (spawn the same CLI the
// skill uses; kb.json supplies defaults when a param is omitted).
export function pullJob(kb, { connector, jql, cql, max }) {
  if (!ALL_CONNECTORS.includes(connector)) {
    throw new Error(`unknown connector: ${connector}`);
  }
  const args = [ACQUIRE, connector, '--kb', kb];
  if (jql) args.push('--jql', String(jql));
  if (cql) args.push('--cql', String(cql));
  if (max) args.push('--max', String(Math.min(Math.max(1, Number(max) || 1), 500)));
  return {
    type: 'pull',
    label: `acquire ${connector}${jql ? ' (JQL override)' : ''}${cql ? ' (CQL override)' : ''}`,
    run: async (job) => tail((await spawnJob(job, process.execPath, args)).log),
  };
}

// J4: remove a staged (not yet acquired) inbox file.
export function inboxDeleteJob(kb, { filename }) {
  const name = normalizeInboxName(filename);
  return {
    type: 'inbox-delete',
    label: `remove inbox/${name}`,
    run: async () => {
      fs.unlinkSync(path.join(kb, 'inbox', name)); // ENOENT surfaces as a failed job — good
      return { removed: `inbox/${name}` };
    },
  };
}

// G1/G4: delete a raw doc. Snapshot FIRST (G6), then unlink. Impact preview
// (G5) is a read the frontend does via /api/rawrefs before enqueueing this.
export function rawDeleteJob(kb, { path: rel }) {
  rel = normalizeRawRel(rel);
  return {
    type: 'raw-delete',
    label: `delete ${rel}`,
    run: async (job) => {
      const abs = resolveUnder(kb, rel, 'raw');
      if (!fs.existsSync(abs)) throw new Error(`raw doc does not exist: ${rel}`);
      const snap = await snapshot(kb, [rel], job);
      fs.unlinkSync(abs);
      return { deleted: rel, snapshot: snap };
    },
  };
}

// G2: move a raw doc (move = new identity; the old document becomes an orphan
// by design, contract §1). Snapshot covers the source path before the rename.
export function rawMoveJob(kb, { from, to }) {
  from = normalizeRawRel(from);
  to = normalizeRawRel(to);
  if (from === to) throw new Error('move target equals source');
  return {
    type: 'raw-move',
    label: `move ${from} → ${to}`,
    run: async (job) => {
      const absFrom = resolveUnder(kb, from, 'raw');
      const absTo = resolveUnder(kb, to, 'raw');
      if (!fs.existsSync(absFrom)) throw new Error(`raw doc does not exist: ${from}`);
      if (fs.existsSync(absTo)) throw new Error(`move target already exists: ${to}`);
      const snap = await snapshot(kb, [from], job);
      fs.mkdirSync(path.dirname(absTo), { recursive: true });
      fs.renameSync(absFrom, absTo);
      return { from, to, snapshot: snap };
    },
  };
}

// G6 (version-management constraint): preserve a restorable point before a
// destructive op. git commit when the KB is a repository (pathspec-scoped so
// unrelated worktree changes are NOT swept in); file-copy snapshot under
// .kb/ui/snapshots/ otherwise (whitelist ④).
// Also reused by the M7d wiki-edit path (ruling ⑨c: original rests on
// git / G6 copy snapshots).
export async function snapshot(kb, rels, job) {
  if (isGitRepo(kb)) {
    // -c user.*: snapshot commits must not depend on the machine's git config,
    // and a fixed machine author makes automated snapshots greppable in git log.
    const GIT_ID = ['-c', 'user.name=kb-portal', '-c', 'user.email=kb-portal@localhost'];
    for (const rel of rels) {
      await execFileP('git', ['-C', kb, 'add', '--', rel], GIT_TIMEOUT);
      try {
        await execFileP('git', ['-C', kb, ...GIT_ID, 'commit', '-m', `ui: snapshot before ${job.type} (${job.id})`, '--', rel],
          GIT_TIMEOUT);
      } catch { /* already committed at HEAD — the restorable point exists */ }
    }
    return { kind: 'git', note: 'committed to HEAD (pathspec-scoped)' };
  }
  const dir = path.join(kb, '.kb', 'ui', 'snapshots', `${Date.now()}-${job.id}`);
  for (const rel of rels) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(kb, rel), dest);
  }
  return { kind: 'copy', path: path.relative(kb, dir).replace(/\\/g, '/') };
}

// ---- read-only helpers (off-queue) ----

// J5/F4: auth probe. Read-only — runs off-queue straight from the endpoint.
export function authCheck(kb, connector) {
  if (!REMOTE_CONNECTORS.includes(connector)) throw new Error(`--check exists for jira|confluence: ${connector}`);
  return new Promise((resolve, reject) => {
    const pseudo = { log: '' };
    spawnJob(pseudo, process.execPath, [ACQUIRE, connector, '--kb', kb, '--check'])
      .then(({ log }) => {
        try { resolve(JSON.parse(log)); }
        catch { resolve({ raw: tail(log) }); }
      })
      .catch(reject);
  });
}

// Phase 3: upstream change detection. Read-only against raw/ (writes only
// .kb/acquire/upstream-detect.json), but it may call upstream APIs so it runs
// as a queued job to keep the portal event loop unblocked.
export function detectJob(kb, { connector }) {
  if (!ALL_CONNECTORS.includes(connector)) {
    throw new Error(`unknown connector: ${connector}`);
  }
  return {
    type: 'detect',
    label: `detect ${connector}`,
    run: async (job) => {
      const { log } = await spawnJob(job, process.execPath, [ACQUIRE, 'detect', connector, '--kb', kb]);
      // The CLI prints a one-line JSON summary; keep the tail for diagnostics.
      return { report: tail(log), raw: log };
    },
  };
}

// Phase 1: shape probe (Zephyr ZAPI / Gliffy attachment). Same off-queue
// read-only pattern as authCheck; the CLI output is value-free by design, so
// what the UI shows is exactly what may be relayed out of the intranet.
export function probeCheck(kb, connector, pageId) {
  if (!REMOTE_CONNECTORS.includes(connector)) throw new Error(`--probe exists for jira|confluence: ${connector}`);
  const args = [ACQUIRE, connector, '--kb', kb, '--probe'];
  if (connector === 'confluence') args.push(String(pageId || ''));
  return new Promise((resolve, reject) => {
    const pseudo = { log: '' };
    spawnJob(pseudo, process.execPath, args)
      .then(({ log }) => {
        try { resolve(JSON.parse(log)); }
        catch { resolve({ raw: tail(log) }); }
      })
      .catch(reject);
  });
}

// J6: per-source freshness — kb.json connector config + the last record per
// connector from .kb/acquire_runs.jsonl (written by the acquisition CLI).
export function sourceFreshness(kb) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(kb, 'kb.json'), 'utf8')); } catch { /* kb.json optional */ }
  const last = new Map();
  try {
    for (const line of fs.readFileSync(path.join(kb, '.kb', 'acquire_runs.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.connector) last.set(rec.connector, rec);
      } catch { /* torn line */ }
    }
  } catch { /* no pulls recorded yet */ }
  const connectors = config.connectors || {};
  const ids = [...new Set([...Object.keys(connectors), ...last.keys()])].sort();
  return ids.map((id) => ({
    connector: id,
    configured: Boolean(connectors[id]),
    scope: connectors[id]?.jql || connectors[id]?.cql || connectors[id]?.spaces?.join(', ') || connectors[id]?.inbox || null,
    lastRun: last.get(id) || null,
  }));
}

// J4 read side: staged inbox files.
export function listInbox(kb) {
  const dir = path.join(kb, 'inbox');
  const files = [];
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const st = fs.statSync(path.join(dir, e.name));
      files.push({ name: e.name, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return files.sort((a, b) => b.mtime.localeCompare(a.mtime));
}
