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
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createAuth } from './lib/auth.mjs';
import { settingsRoutes } from './routes/api-settings.mjs';
import { createKbRegistry } from './lib/kb.mjs';
import { resolveUnder, normalizeWikiRelRead, normalizeRawRel, normalizeKbFileName, walkMd, normalizeRawAssetRel, assetMime } from './lib/paths.mjs';
import { listWikiPages, rawRefs, health } from './lib/browse.mjs';
import { buildGraph, backlinks } from './lib/graph.mjs';
import { pageHistory } from './lib/history.mjs';
import { runSearch } from './lib/search.mjs';
import { flipStatus, normalizeWikiRel, parseFrontmatter } from './lib/review.mjs';
import { createJobCenter } from './lib/jobs.mjs';
import { createWatcher } from './lib/watch.mjs';
import { governJob, governRunJob } from './lib/govern.mjs';
import { governRunFreshness } from './lib/governruns.mjs';
import { saveWikiEditJob } from './lib/edit.mjs';
import { saveKbFileJob } from './lib/kbfile.mjs';
import { judge, judgeNames } from './lib/judge.mjs';
import { feedbackJob, readFeedback } from './lib/feedback.mjs';
import {
  plan, sourcePageRelPath, approvePage, rejectPage as governReject, archivePage as governArchive,
  addDismissal, readConflicts, readDecisions,
} from '../governance/scripts/lib/govern.mjs';
import {
  UPLOAD_MAX, uploadJob, pullJob, inboxDeleteJob, rawDeleteJob, rawMoveJob,
  authCheck, probeCheck, sourceFreshness, listInbox, detectJob,
} from './lib/acquire.mjs';

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(UI_DIR, 'public');
// LLM CLI path is resolved at portal creation time so tests can override it via
// the WEFT_LLM_CLI env var before calling createPortal().
function resolveLlmCli() { return process.env.WEFT_LLM_CLI || path.resolve(UI_DIR, '..', 'llm', 'llm.mjs'); }
// async git: a 5s blocking execFileSync inside the request handler would stall
// every other request on the event loop (review 2026-08-04)
const execFileP = promisify(execFile);

// Phase 4: stream an NDJSON file as it is written by the LLM service, forwarding
// each line as an SSE data event. Stops when the file reaches EOF or the child exits.
async function streamNdjson(filePath, res, child) {
  // Wait briefly for the writer to create the file.
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (res.writableEnded) break;
    res.write(`data: ${line}\n\n`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

  // /api/health is polled every 30s by every open client AND on every SSE
  // change event; health() walks the whole wiki and plan() scans raw+wiki
  // (review 2026-08-04). Cache per KB; invalidate on watcher events (debounced
  // fs.watch) and on job completion (portal-originated writes, so the post-
  // write header refresh never reads a stale cache).
  const healthCache = new Map(); // kb -> { value, unwatch }
  const invalidateHealth = (kb) => { const e = healthCache.get(kb); if (e) e.value = null; };
  function cachedHealth(kb) {
    let e = healthCache.get(kb);
    if (!e) {
      e = { value: null, unwatch: watcher.subscribe(kb, () => invalidateHealth(kb)) };
      healthCache.set(kb, e);
    }
    if (!e.value) e.value = health(kb);
    return e.value;
  }
  jobs.subscribe((job) => {
    if (job.status !== 'queued' && job.status !== 'running') invalidateHealth(job.kb);
  });

  const readBody = (req, max = 64 * 1024) => new Promise((resolveBody, rejectBody) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > max) { rejectBody(Object.assign(new Error(`request body too large (${Math.round(max / 1024)}KB max)`), { code: 413 })); req.destroy(); }
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

        // Settings reads.
        if (url.pathname === '/api/settings') {
          const settingsHandler = settingsRoutes({ jobs, registry });
          const handled = await settingsHandler(req, res, url, readBody, json);
          if (handled !== null) return handled;
        }

        if (url.pathname === '/api/tree') return json(res, 200, { pages: listWikiPages(kb) });
        if (url.pathname === '/api/queue') {
          return json(res, 200, { pages: listWikiPages(kb).filter((p) => p.status === 'candidate') });
        }
        if (url.pathname === '/api/health') {
          // F1: lastGovernRun rides health so dashboard/govern views get it in
          // the same poll; composed here (not inside lib/browse.mjs) to keep
          // lib-to-lib coupling flat.
          const active = new Set(jobs.list(kb)
            .filter((j) => j.type === 'govern-run' && (j.status === 'queued' || j.status === 'running'))
            .map((j) => j.id));
          return json(res, 200, { ...cachedHealth(kb), lastGovernRun: governRunFreshness(kb, active) });
        }
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
          const text = fs.readFileSync(abs, 'utf8');
          // hash: the M7d editor's optimistic-lock base (final-review P2)
          const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
          const parsed = parseFrontmatter(text);
          // topic sources are raw-path provenance; resolve each to its source
          // summary page so the UI can link to a page that exists instead of
          // gluing 'wiki/sources/' onto the raw path (intranet bug 1)
          let sources_resolved = null;
          if (Array.isArray(parsed.fields.sources) && parsed.fields.sources.length) {
            sources_resolved = parsed.fields.sources.map((raw) => {
              const rawRel = String(raw);
              if (!rawRel.startsWith('raw/')) return { raw: rawRel, page: null };
              try {
                const rawAbs = resolveUnder(kb, rawRel, 'raw');
                if (!fs.existsSync(rawAbs)) return { raw: rawRel, page: null };
                const rf = parseFrontmatter(fs.readFileSync(rawAbs, 'utf8')).fields;
                if (!rf.source || !rf.source_id) return { raw: rawRel, page: null };
                const cand = sourcePageRelPath(rf).replace(/\\/g, '/');
                return { raw: rawRel, page: fs.existsSync(path.join(kb, cand)) ? cand : null };
              } catch {
                return { raw: rawRel, page: null };
              }
            });
          }
          return json(res, 200, { path: rel, hash, ...parsed, sources_resolved });
        }
        // F3: KB-root whitelisted files (GOVERNANCE.md) — free-form Markdown,
        // no frontmatter parsing; hash is the editor's optimistic-lock base.
        if (url.pathname === '/api/kbfile') {
          const name = normalizeKbFileName(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, name, '.');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `file does not exist: ${name}` });
          const text = fs.readFileSync(abs, 'utf8');
          const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
          return json(res, 200, { path: name, hash, body: text });
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
        // A7 relationship graph: all wiki pages as nodes, wikilink edges from
        // the retrieval index (approved) + candidate scan (lib/graph.mjs).
        if (url.pathname === '/api/graph') return json(res, 200, buildGraph(kb));
        // J7 page history: git log --follow, or G6 snapshots + hint on
        // non-git KBs (version-management constraint).
        if (url.pathname === '/api/history') {
          const rel = normalizeWikiRelRead(url.searchParams.get('path') || '');
          return json(res, 200, pageHistory(kb, rel));
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
        // Phase 1: binary evidence sidecars (contract §1 amendment 2026-08-03)
        // — Gliffy PNGs referenced from raw docs. Read-only, whitelist-gated
        // (raw/<source>/<id>.assets/<file>, image extensions, no traversal).
        if (url.pathname === '/api/raw-asset') {
          const rel = normalizeRawAssetRel(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, rel, 'raw');
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            return json(res, 404, { error: `asset does not exist: ${rel}` });
          }
          res.writeHead(200, { 'content-type': assetMime(rel), 'cache-control': 'no-cache' });
          return fs.createReadStream(abs).pipe(res);
        }
        // I5 plan-as-preview: the full lists (paths + titles + reasons) —
        // health() serves counts to the dashboard; this serves the confirm page.
        if (url.pathname === '/api/plan') return json(res, 200, plan(kb));
        // P3-4: the conflicts side-channel the review queue's F4 banner and the
        // keep-both/archive-source adjudication buttons read.
        if (url.pathname === '/api/conflicts') {
          const state = readConflicts(kb);
          return json(res, 200, state || { generated_at: null, fingerprint: null, groups: [] });
        }
        // Decision log (ADR-0009): append-only records for every mutating governance action.
        if (url.pathname === '/api/decisions') {
          const filters = {
            action: url.searchParams.get('action') || undefined,
            page: url.searchParams.get('page') || undefined,
            actor: url.searchParams.get('actor') || undefined,
          };
          return json(res, 200, { decisions: readDecisions(kb, filters) });
        }
        // Phase 3: upstream detect report (read-only — .kb/acquire artifact).
        if (url.pathname === '/api/detect') {
          const reportPath = path.join(kb, '.kb', 'acquire', 'upstream-detect.json');
          if (!fs.existsSync(reportPath)) return json(res, 200, { connector: null, generated_at: null, detect: null });
          const stored = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          // The stored file is flat (new/changed/...); expose the same shape the
          // acquisition CLI prints: { connector, generated_at, detect: {...} }.
          const { ts, new: n, changed, unchanged, removed_upstream, errors } = stored;
          return json(res, 200, {
            connector: stored.connector,
            generated_at: ts,
            detect: { new: n, changed, unchanged, removed_upstream, error: errors },
          });
        }

        // J9: recent feedback votes (the 👎 panel in search)
        if (url.pathname === '/api/feedback') {
          return json(res, 200, { entries: readFeedback(kb, { vote: url.searchParams.get('vote') || undefined }) });
        }
        // The govern skill's canonical path — the default agent prompt points
        // at it so runs follow the real workflow EVEN when the skill is not
        // registered in the executor's environment (e2e finding 2026-08-02).
        if (url.pathname === '/api/govern-context') {
          // existsSync fallback (M7c review P3): a missing skill file must not
          // leave the default prompt pointing at a phantom path.
          const skillPath = path.resolve(UI_DIR, '..', 'governance', 'skills', 'govern', 'SKILL.md');
          // repoRoot (forward-slash): the default prompt prescribes the exact
          // script-invocation form the acceptEdits allow-list matches (S18 of
          // the P2-2 spike: backslash invocations are denied).
          const repoRoot = path.resolve(UI_DIR, '..').split(path.sep).join('/');
          return json(res, 200, { skillPath: fs.existsSync(skillPath) ? skillPath : null, repoRoot });
        }
        if (url.pathname === '/api/diff') {
          // Same as the thin viewer: read-only git show; graceful null baseline
          // when the KB is not a repository (version-management constraint, S4).
          const rel = normalizeWikiRel(url.searchParams.get('path') || '');
          const abs = resolveUnder(kb, rel, 'wiki');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
          let baseline = null;
          try {
            ({ stdout: baseline } = await execFileP('git', ['-C', kb, 'show', `HEAD:${rel}`],
              { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }));
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

        // Settings actions (llm check / init-prompts) enqueue jobs.
        if (url.pathname.startsWith('/api/settings/')) {
          const settingsHandler = settingsRoutes({ jobs, registry });
          const handled = await settingsHandler(req, res, url, readBody, json);
          if (handled !== null) return handled;
        }

        if (url.pathname === '/api/review') {
          const { path: p, action, kb: kbName, raws, reason } = JSON.parse(await readBody(req) || '{}');
          if (!['approve', 'reject', 'archive-source', 'dismiss-conflict'].includes(action)) {
            return json(res, 400, { error: `action must be approve|reject|archive-source|dismiss-conflict: ${action}` });
          }
          if (!reason || !String(reason).trim()) {
            return json(res, 400, { error: `human ${action} requires a reason` });
          }
          const kb = registry.resolve(kbName).path;
          const rel = normalizeWikiRel(p || '');
          const abs = resolveUnder(kb, rel, 'wiki');
          if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
          const job = await jobs.waitFor(jobs.enqueue(kb, {
            type: 'review', label: `${action} ${rel}`,
            run: () => {
              if (action === 'approve') return approvePage(kb, rel, { via: 'portal', actor: 'human', reason });
              // reject is reject-and-restore (plan 0001 §3.1.5): revert the page to its
              // most recent git-committed approved version and log synchronously, so the
              // sweep backfill cannot mis-record the rejection as an approval (P1-5).
              if (action === 'reject') return governReject(kb, rel, { via: 'portal', actor: 'human', reason });
              // archive the LOSER source page (approved only) — the raw gets tombstoned.
              if (action === 'archive-source') return governArchive(kb, rel, { actor: 'human', reason });
              // keep-both: persist the pair as parallel documents; never re-flagged.
              if (action === 'dismiss-conflict') {
                if (!Array.isArray(raws) || raws.length < 2) {
                  throw new Error('dismiss-conflict requires raws[] (at least two raw paths)');
                }
                return { action: 'dismiss-conflict', ...addDismissal(kb, raws, String(reason)) };
              }
              throw new Error(`unsupported review action: ${action}`);
            },
          }));
          if (job.status === 'failed') throw new Error(job.error);
          return json(res, 200, { page: rel, status: job.result.to ?? job.result.status, result: job.result });
        }

        // C5 batch review: one queued job, per-page decisions, per-page fault isolation.
        if (url.pathname === '/api/review-batch') {
          const { paths, action, kb: kbName, reason } = JSON.parse(await readBody(req) || '{}');
          if (action !== 'approve' && action !== 'reject') {
            return json(res, 400, { error: `action must be approve|reject: ${action}` });
          }
          if (!reason || !String(reason).trim()) {
            return json(res, 400, { error: `human batch ${action} requires a reason` });
          }
          if (!Array.isArray(paths) || !paths.length || paths.length > 200) {
            return json(res, 400, { error: `paths must be a non-empty array (≤200): ${JSON.stringify(paths)?.slice(0, 80)}` });
          }
          const kb = registry.resolve(kbName).path;
          const job = await jobs.waitFor(jobs.enqueue(kb, {
            type: 'review-batch', label: `${action} ×${paths.length}`,
            run: async () => {
              const results = [];
              for (const p of paths) {
                try {
                  const rel = normalizeWikiRel(p);
                  if (action === 'approve') {
                    approvePage(kb, rel, { via: 'portal', actor: 'human', reason });
                  } else {
                    governReject(kb, rel, { via: 'portal', actor: 'human', reason });
                  }
                  results.push({ path: rel, ok: true });
                } catch (err) {
                  results.push({ path: String(p), ok: false, error: err.message });
                }
              }
              return { action, results };
            },
          }));
          if (job.status === 'failed') throw new Error(job.error);
          return json(res, 200, job.result);
        }

        // K1 judge (block K): pointwise 0-3 rubric over the query's top
        // results. Read-only (no KB writes) → off-queue like authCheck. The
        // snippet payload is untrusted KB content — the judge backend runs
        // tool-less (judge.mjs), its output is display-only.
        if (url.pathname === '/api/judge') {
          const { q, results, backend = 'claude', kb: _kbName } = JSON.parse(await readBody(req) || '{}');
          if (!q || !String(q).trim()) return json(res, 400, { error: 'judge requires a query string' });
          if (!Array.isArray(results) || !results.length || results.length > 10) {
            return json(res, 400, { error: 'results must be a non-empty array (≤10)' });
          }
          if (!judgeNames().includes(backend)) {
            return json(res, 400, { error: `unknown judge backend: ${backend} (registered: ${judgeNames().join(', ')})` });
          }
          const out = await judge(backend, String(q), results.slice(0, 10));
          return json(res, 200, out);
        }

        // J9: record a 👍/👎 vote (tiny append, still inside the serial queue
        // — every KB-touching write is, S10).
        if (url.pathname === '/api/feedback') {
          const { q, page, vote, kb: kbName } = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(kbName).path;
          const job = await jobs.waitFor(jobs.enqueue(kb, feedbackJob(kb, { q, page, vote })));
          if (job.status === 'failed') throw new Error(job.error);
          return json(res, 200, { recorded: true });
        }

        // M7d H1/H2: human wiki edit (whitelist ⑤). Bigger body limit — pages
        // run to tens of thousands of chars (CJK ≈ 3 bytes each).
        if (url.pathname === '/api/edit') {
          const { path: p, body, base_hash, kb: kbName } = JSON.parse(await readBody(req, 512 * 1024) || '{}');
          const kb = registry.resolve(kbName).path;
          const spec = saveWikiEditJob(kb, { path: p, body, baseHash: base_hash }); // factory validates → 400
          const job = await jobs.waitFor(jobs.enqueue(kb, spec));
          if (job.status === 'failed') {
            const err = new Error(job.error);
            if (/^edit conflict:/.test(job.error)) err.code = 409; // optimistic lock (final-review P2)
            throw err;
          }
          return json(res, 200, { page: job.result.path, demoted: job.result.demoted });
        }

        // F3: KB-root whitelisted file edit (GOVERNANCE.md). Same optimistic-
        // lock 409 discipline as /api/edit.
        if (url.pathname === '/api/kbfile-edit') {
          const { path: p, body, base_hash, kb: kbName } = JSON.parse(await readBody(req, 512 * 1024) || '{}');
          const kb = registry.resolve(kbName).path;
          const spec = saveKbFileJob(kb, { path: p, body, baseHash: base_hash }); // factory validates → 400
          const job = await jobs.waitFor(jobs.enqueue(kb, spec));
          if (job.status === 'failed') {
            const err = new Error(job.error);
            if (/^edit conflict:/.test(job.error)) err.code = 409;
            throw err;
          }
          return json(res, 200, { path: job.result.path, created: job.result.created });
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

        // Phase 3: upstream detect (queued; writes .kb/acquire/upstream-detect.json).
        if (url.pathname === '/api/detect') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const spec = detectJob(kb, { connector: body.connector });
          return json(res, 202, { job: jobs.enqueue(kb, spec) });
        }

        // J5/F4: auth probe — read-only, so off-queue (no KB mutation).
        if (url.pathname === '/api/authcheck') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          return json(res, 200, await authCheck(kb, body.connector));
        }

        // Phase 1: shape probe (Zephyr ZAPI / Gliffy attachment structure).
        // Read-only, off-queue; output is value-free by design (types/keys/
        // counts only) — what renders here is safe to relay out of the intranet.
        if (url.pathname === '/api/probe') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          return json(res, 200, await probeCheck(kb, body.connector, body.pageId));
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

        // Phase 4: chat / deep-research streaming endpoint (LLM service).
        if (url.pathname === '/api/chat') {
          const refusal = auth.checkWrite(req);
          if (refusal) return json(res, refusal.code, { error: refusal.error });
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const question = String(body.question || '').trim();
          const level = ['quick', 'deep', 'deep-research'].includes(body.level) ? body.level : 'quick';
          if (!question) return json(res, 400, { error: 'question required' });

          const id = crypto.randomBytes(6).toString('hex');
          const inputFile = path.join(kb, '.kb', 'ui', `chat-${id}.in.json`);
          const outputFile = path.join(kb, '.kb', 'ui', `chat-${id}.out.ndjson`);
          fs.mkdirSync(path.dirname(inputFile), { recursive: true });
          fs.writeFileSync(inputFile, JSON.stringify({ question, level, opts: body.opts || {} }), 'utf8');

          const child = spawn(process.execPath, [resolveLlmCli(), 'chat', '--kb', kb, '--input-file', inputFile, '--output-file', outputFile], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          function cleanup() {
            try { fs.unlinkSync(inputFile); } catch {}
            try { fs.unlinkSync(outputFile); } catch {}
          }

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });

          let stderr = '';
          child.stderr.on('data', (c) => { stderr += c; });

          // Stream NDJSON lines as they are written; finish when the child exits.
          const streamDone = streamNdjson(outputFile, res, child).catch((err) => {
            if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
          });

          child.on('close', async (code) => {
            await streamDone;
            if (code !== 0 && !res.writableEnded) {
              res.write(`event: error\ndata: ${JSON.stringify({ message: stderr.slice(-2000) || `llm.mjs exited ${code}` })}\n\n`);
            }
            if (!res.writableEnded) {
              res.write('event: close\ndata: {}\n\n');
              res.end();
            }
            cleanup();
          });

          child.on('error', (err) => {
            if (!res.writableEnded) {
              res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
              res.write('event: close\ndata: {}\n\n');
              res.end();
            }
            cleanup();
          });

          req.on('close', () => { child.kill(); cleanup(); });
          return;
        }

        // Cancel a queued/running job (M7c review P3 — long agent runs
        // otherwise hold the serial queue hostage).
        if (url.pathname === '/api/job-cancel') {
          const body = JSON.parse(await readBody(req) || '{}');
          const kb = registry.resolve(body.kb).path;
          const r = jobs.cancel(kb, body.id);
          return json(res, r.code, r.error ? { error: r.error } : { job: r.job });
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
        // index.html carries the per-startup token → always revalidate (a
        // cached copy holds a DEAD token and every write would 403). Other
        // assets get Last-Modified revalidation (review 2026-08-04: no caching
        // headers at all meant a full refetch of every asset per launch).
        if (ext === '.html') {
          res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'no-cache' });
          return res.end(fs.readFileSync(abs, 'utf8').replace('%%UI_TOKEN%%', auth.token));
        }
        const mtime = fs.statSync(abs).mtime;
        if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= mtime) {
          res.writeHead(304);
          return res.end();
        }
        res.writeHead(200, { 'content-type': MIME[ext], 'last-modified': mtime.toUTCString() });
        return res.end(fs.readFileSync(abs));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) {
        // numeric 4xx codes set by libs (413 body cap, 409 edit conflict) pass through
        const code = (Number.isInteger(err.code) && err.code >= 400 && err.code < 500) ? err.code
          : /page status is/.test(err.message) ? 409 : 400;
        return json(res, code, { error: err.message });
      }
      res.end();
    }
  });
  // the internal health watcher holds fs.watch handles — release them on
  // shutdown or the process hangs past server.close() (test suites hit this)
  server.on('close', () => { for (const e of healthCache.values()) e.unwatch(); healthCache.clear(); });
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
