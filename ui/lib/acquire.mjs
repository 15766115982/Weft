// M7b write-operation runners (ADR-0006 whitelist ①② + F/J5/J6). Every
// KB-mutating helper here is designed to run INSIDE the per-KB serial queue
// (jobs.mjs) — never call them off-queue from an endpoint.
// Writes spawn the acquisition CLI (process isolation, ADR-0006 integration
// split); nothing in the acquisition service is imported in-process for writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnJob } from './jobs.mjs';
import { normalizeInboxName, normalizeRawRel, resolveUnder } from './paths.mjs';

const ACQUIRE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'acquisition', 'scripts', 'acquire.mjs',
);

export const UPLOAD_MAX = 32 * 1024 * 1024; // 32MB raw-bytes cap (E: no multipart)

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
  if (!['local', 'jira', 'confluence'].includes(connector)) {
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
      const snap = snapshot(kb, [rel], job);
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
      const snap = snapshot(kb, [from], job);
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
export function snapshot(kb, rels, job) {
  if (isGitRepo(kb)) {
    // -c user.*: snapshot commits must not depend on the machine's git config,
    // and a fixed machine author makes automated snapshots greppable in git log.
    const GIT_ID = ['-c', 'user.name=kb-portal', '-c', 'user.email=kb-portal@localhost'];
    for (const rel of rels) {
      execFileSync('git', ['-C', kb, 'add', '--', rel], { stdio: 'ignore' });
      try {
        execFileSync('git', ['-C', kb, ...GIT_ID, 'commit', '-m', `ui: snapshot before ${job.type} (${job.id})`, '--', rel],
          { stdio: ['ignore', 'ignore', 'ignore'] });
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

function isGitRepo(kb) {
  try {
    execFileSync('git', ['-C', kb, 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch { return false; }
}

// ---- read-only helpers (off-queue) ----

// J5/F4: auth probe. Read-only — runs off-queue straight from the endpoint.
export function authCheck(kb, connector) {
  if (!['jira', 'confluence'].includes(connector)) throw new Error(`--check exists for jira|confluence: ${connector}`);
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

function tail(log, n = 4000) {
  return log.length > n ? log.slice(-n) : log;
}
