#!/usr/bin/env node
// UI portal server (ADR-0006): on-demand localhost human console. Red lines:
// launch on demand; no user system; whitelisted KB writes only (contract §1);
// per-startup token + Origin/Host checks on every write request (S8).
// Read-hot paths import service libs in-process; every KB-mutating operation
// goes through the per-KB serial write queue (S10, lib/jobs.mjs).
//
//   node serve.mjs [--kb <path>] [--port N]     (default port 8322, binds 127.0.0.1 only)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createAuth } from './lib/auth.mjs';
import { createKbRegistry } from './lib/kb.mjs';
import { resolveUnder, normalizeWikiRelRead, normalizeRawRel, walkMd } from './lib/paths.mjs';
import { listWikiPages, backlinks, rawRefs, health } from './lib/browse.mjs';
import { runSearch } from './lib/search.mjs';
import { flipStatus, normalizeWikiRel, parseFrontmatter } from './lib/review.mjs';
import { createJobCenter } from './lib/jobs.mjs';
import { createWatcher } from './lib/watch.mjs';
import { governJob, governRunJob } from './lib/govern.mjs';
import { plan } from '../governance/scripts/lib/govern.mjs';
import {
  UPLOAD_MAX, uploadJob, pullJob, inboxDeleteJob, rawDeleteJob, rawMoveJob,
  authCheck, sourceFreshness, listInbox,
} from './lib/acquire.mjs';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(UI_DIR, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createPortal({ kb: cliKb, port = 8322 } = {}) {
  const auth = createAuth();
  const registry = createKbRegistry({ cliKb });
  const jobs = createJobCenter();
  const watcher = createWatcher();
  // I4: granular agent-run chunks ride a bridge to the SSE 'run' channel —
  // the job event stream stays coarse (queued/running/done transitions).
  const runBridge = new EventEmitter();

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const readBody = (req) => new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) { rejectBody(Object.assign(new Error('request body too large (64KB max)'), { code: 413 })); req.destroy(); }
    });
    req.on('end', () => resolveBody(body));
    req.on('error', rejectBody);
  });

  // Raw-bytes reader for the upload route (E: no multipart; X-Filename header
  // carries the name). Separate cap from the JSON reader above.
  const readBytes = (req, max) => new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { rejectBody(Object.assign(new Error(`upload too large (${Math.round(max / 1024 / 1024)}MB max)`), { code: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    console.log(`${req.method} ${url.pathname}${url.search}`);
    try {
      // P2-2: every request (reads, SSE, static included) must carry a
      // loopback Host — CORS cannot stop DNS-rebinding reads.
      const badHost = auth.checkHost(req);
      if (badHost) return json(res, badHost.code, { error: badHost.error });
      // ---- reads (GET, no token — local single-user tool) ----
      if (req.method === 'GET' && url.pathname === '/api/kbs') {
        return json(res, 200, { kbs: registry.list() });
      }
      // J3+I6: SSE event stream — KB change events (fs.watch, debounced) and
      // job lifecycle events (queue transitions). Read-only; EventSource
      // cannot send headers, so no token — it carries no secrets.
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const kb = registry.resolve(url.searchParams.get('kb')).path;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const unwatch = watcher.subscribe(kb, (e) => send('change', e));
        const unjobs = jobs.subscribe((job) => { if (job.kb === kb) send('job', job); });
        const onRun = (d) => { if (d.kb === kb) send('run', d); };
        runBridge.on('chunk', onRun);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(keepalive); unwatch(); unjobs(); runBridge.off('chunk', onRun); });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
        const kb = registry.resolve(url.searchParams.get('kb')).path;

        if (url.pathname === '/api/tree') return json(res, 200, { pages: listWikiPages(kb) });
        if (url.pathname === '/api/queue') {
          return json(res, 200, { pages: listWikiPages(kb).filter((p) => p.status === 'candidate') });
        }
        if (url.pathname === '/api/health') return json(res, 200, health(kb));
        if (url.pathname === '/api/log') {
          // D2 governance timeline: parse log.md's uniform prefix
          // (## [ts] actor | action | target | note), newest first.
          const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 200);
          const logPath = path.join(kb, 'log.md');
          const entries = [];
          if (fs.existsSync(logPath)) {
            const re = /^## \[(.+?)\] (\S+) \| ([^|]+) \| ([^|]+)(?: \| (.*))?$/;
            for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
              const m = line.match(re);
              if (m) entries.push({ ts: m[1], actor: m[2], action: m[3].trim(), target: m[4].trim(), note: (m[5] || '').trim() });
            }
          }
          return json(res, 200, { entries: entries.reverse().slice(0, limit) });
        }
        if (url.pathname === '/api/page') {
          const rel = normalizeWikiRelRead(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, rel, 'wiki');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
          return json(res, 200, { path: rel, ...parseFrontmatter(fs.readFileSync(abs, 'utf8')) });
        }
        if (url.pathname === '/api/raw') {
          const rel = normalizeRawRel(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, rel, 'raw');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `raw doc does not exist: ${rel}` });
          return json(res, 200, { path: rel, ...parseFrontmatter(fs.readFileSync(abs, 'utf8')) });
        }
        if (url.pathname === '/api/rawlist') {
          // raw-layer browse (C9): every raw doc with its identity quintuple,
          // grouped by source system on the client.
          const docs = [];
          for (const abs of walkMd(path.join(kb, 'raw'))) {
            const rel = path.relative(kb, abs).replace(/\\/g, '/');
            const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
            docs.push({
              path: rel, source: fields.source, source_id: fields.source_id,
              title: fields.title || path.basename(rel, '.md'),
              source_version: fields.source_version, pulled_at: fields.pulled_at,
            });
          }
          return json(res, 200, { docs: docs.sort((a, b) => a.path.localeCompare(b.path)) });
        }
        if (url.pathname === '/api/backlinks') {
          const rel = normalizeWikiRelRead(url.searchParams.get('path') || '');
          return json(res, 200, { pages: backlinks(kb, rel) });
        }
        if (url.pathname === '/api/rawrefs') {
          // A5: which wiki pages trace to this raw doc (source_ref / sources[])
          const rel = normalizeRawRel(url.searchParams.get('path') || '');
          return json(res, 200, { pages: rawRefs(kb, rel) });
        }
        if (url.pathname === '/api/search') {
          const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
          return json(res, 200, runSearch(kb, url.searchParams.get('q') || '', { limit }));
        }
        // ---- M7b acquisition console reads ----
        if (url.pathname === '/api/jobs') return json(res, 200, { jobs: jobs.list(kb) });
        if (url.pathname === '/api/inbox') return json(res, 200, { files: listInbox(kb) });
        if (url.pathname === '/api/sources') return json(res, 200, { sources: sourceFreshness(kb) });
        // I5 plan-as-preview: the full six lists (paths + titles + reasons) —
        // health() serves counts to the dashboard; this serves the confirm page.
        if (url.pathname === '/api/plan') return json(res, 200, plan(kb));
        // The govern skill's canonical path — the default agent prompt points
        // at it so runs follow the real workflow EVEN when the skill is not
        // registered in the executor's environment (e2e finding 2026-08-02).
        if (url.pathname === '/api/govern-context') {
          return json(res, 200, {
            skillPath: path.resolve(UI_DIR, '..', 'governance', 'skills', 'govern', 'SKILL.md'),
          });
        }
        if (url.pathname === '/api/diff') {
          // Same as the thin viewer: read-only git show; graceful null baseline
          // when the KB is not a repository (version-management constraint, S4).
          const rel = normalizeWikiRel(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, rel, 'wiki');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
          let baseline = null;
          try {
            baseline = execFileSync('git', ['-C', kb, 'show', `HEAD:${rel}`],
              { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
          } catch { baseline = null; }
          const current = fs.readFileSync(abs, 'utf8');
          return json(res, 200, { baseline, current, changed: baseline !== null && baseline !== current });
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- writes (token + Origin/Host, S8; all KB mutations via the serial queue, S10) ----
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const refusal = auth.checkWrite(req);
        if (refusal) return json(res, refusal.code, { error: refusal.error });

        if (url.pathname === '/api/review') {
          const { path: p, action, kb: kbName } = JSON.parse(await readBody(req) || '{}');
          if (action !== 'approve' && action !== 'reject') {
            return json(res, 400, { error: `action must be approve|reject: ${action}` });
          }
          const kb = registry.resolve(kbName).path;
          const rel = normalizeWikiRel(p || '');
          const abs = resolveUnder(kb, rel, 'wiki');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
          const job = await jobs.waitFor(jobs.enqueue(kb, {
            type: 'review', label: `${action} ${rel}`,
            run: async () => flipStatus(abs, 'candidate', action === 'approve' ? 'approved' : 'rejected'),
          }));
          if (job.status === 'failed') throw new Error(job.error);
          return json(res, 200, { page: rel, status: job.result.to });
        }

        // E1: upload raw bytes → inbox/ → acquire local (one queued job).
        // X-Filename carries encodeURIComponent(name) so CJK names survive
        // latin1-only HTTP headers.
        if (url.pathname === '/api/upload') {
          const kb = registry.resolve(url.searchParams.get('kb')).path;
          const filename = decodeURIComponent(req.headers['x-filename'] || '');
          const bytes = await readBytes(req, UPLOAD_MAX);
          const spec = uploadJob(kb, { filename, bytes }); // factory validates → 400 on throw
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // F1: source pull (jira/confluence/local), scope overrides optional.
        if (url.pathname === '/api/pull') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = pullJob(kb, body);
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // J5/F4: auth probe — read-only, so off-queue (no KB mutation).
        if (url.pathname === '/api/authcheck') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          return json(res, 200, await authCheck(kb, body.connector));
        }

        // J4: remove a staged inbox file.
        if (url.pathname === '/api/inbox-delete') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = inboxDeleteJob(kb, { filename: body.name });
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // G1: delete raw (job snapshots first, G6; preview G5 is /api/rawrefs).
        if (url.pathname === '/api/raw-delete') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = rawDeleteJob(kb, { path: body.path });
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // G2: move raw (new identity; old doc becomes an orphan by design).
        if (url.pathname === '/api/raw-move') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = rawMoveJob(kb, { from: body.from, to: body.to });
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // I1: mechanical governance steps (sweep / rebuild-index / merge-topic).
        if (url.pathname === '/api/govern') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = governJob(kb, body);
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // I2/I4: agent-driven governance. Executor events stream to the SSE
        // 'run' channel live; the job record keeps the full transcript.
        if (url.pathname === '/api/govern-run') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = governRunJob(kb, body, (job, kind, chunk) =>
            runBridge.emit('chunk', { kb, jobId: job.id, kind, chunk }));
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        return json(res, 404, { error: 'not found' });
      }

      // ---- static (index.html gets the per-startup token injected) ----
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        // index.html carries a data-URI icon; silence the automatic request
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && (url.pathname === '/' || MIME[path.extname(url.pathname)])) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const abs = path.resolve(PUBLIC_DIR, name);
        if (!abs.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return json(res, 400, { error: 'bad static path' });
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: 'not found' });
        const ext = path.extname(abs);
        res.writeHead(200, { 'content-type': MIME[ext] });
        if (ext === '.html') {
          return res.end(fs.readFileSync(abs, 'utf8').replace('%%UI_TOKEN%%', auth.token));
        }
        return res.end(fs.readFileSync(abs));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) {
        const code = err.code === 404 || err.code === 413 ? err.code : /page status is/.test(err.message) ? 409 : 400;
        return json(res, code, { error: err.message });
      }
      res.end();
    }
  });
  return server;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = (i + 1 >= argv.length || argv[i + 1].startsWith('--')) ? true : argv[++i];
    } else args._.push(argv[i]);
  }
  return args;
}

// Direct launch only (importing this file from tests does not start a server)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const cliKb = args.kb || process.env.KB_PATH;
  if (!cliKb && !fs.existsSync(path.join(UI_DIR, 'kbs.json'))) {
    console.error(JSON.stringify({ error: 'no knowledge base: pass --kb <path>, set KB_PATH, or create ui/kbs.json' }));
    process.exit(64);
  }
  const port = Number(args.port) || 8322;
  createPortal({ kb: cliKb, port }).listen(port, '127.0.0.1', () => {
    console.log(`KB portal listening at http://127.0.0.1:${port}  (Ctrl+C to stop; review flips are logged by the next governance sweep)`);
    // single-operator assumption: two portals on the same KB = two in-memory
    // queues = the serial guarantee is gone. Say it where the operator looks.
    console.log('note: run at most ONE portal per knowledge base (the serial write queue is per-process)');
  });
}
