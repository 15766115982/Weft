#!/usr/bin/env node
// Thin viewer server (ADR-0004): on-demand localhost review UI for the candidate
// state machine. Three red lines: (1) launch on demand, no resident service;
// (2) no user system / permissions / config UI; (3) dumb consumer — the ONLY
// write operation anywhere in this file is flipStatus (frontmatter status).
// Logging of review outcomes is the governance sweep's job, not the viewer's.
//
//   node serve.mjs --kb <path> [--port N]     (default port 8321, binds 127.0.0.1 only)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { flipStatus, normalizeWikiRel } from '../scripts/lib/statusflip.mjs';
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

// raw/ read gate (evidence pane): same discipline as the acquisition side —
// forward slashes, must stay under raw/, per-segment `..` rejection.
function normalizeRawRel(input) {
  const rel = String(input).replace(/\\/g, '/');
  if (!rel.startsWith('raw/') || rel.split('/').some((s) => s === '..') || !rel.endsWith('.md')) {
    throw new Error(`raw path must be a relative .md path under raw/: ${input}`);
  }
  return rel;
}

// Resolved-path prefix check under an expected root. One shared normalized
// product (lowercased on win32) feeds the comparison — never mix raw and
// normalized casings (the M3 wiki/ARCHIVE bypass was exactly that bug class).
function resolveUnder(kbRoot, rel, mustStartWith) {
  const abs = path.resolve(kbRoot, rel);
  const root = path.resolve(kbRoot, mustStartWith);
  const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (norm(abs) !== norm(root) && !norm(abs).startsWith(norm(root) + path.sep)) {
    throw new Error(`path escapes ${mustStartWith}: ${rel}`);
  }
  return abs;
}

export function createViewer(kbRoot) {
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  const listPages = () => {
    const pages = [];
    for (const sub of ['sources', 'topics']) {
      for (const abs of walk(path.join(kbRoot, 'wiki', sub))) {
        const rel = path.relative(kbRoot, abs).replace(/\\/g, '/');
        const { fields } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
        pages.push({ path: rel, type: fields.type, status: fields.status, title: fields.title, updated_at: fields.updated_at });
      }
    }
    return pages.sort((a, b) => a.path.localeCompare(b.path));
  };

  const readPage = (rel) => {
    const abs = resolveUnder(kbRoot, rel, 'wiki');
    if (!fs.existsSync(abs)) { const e = new Error(`page does not exist: ${rel}`); e.code = 404; throw e; }
    return parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    console.log(`${req.method} ${url.pathname}${url.search}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/pages') return json(res, 200, { pages: listPages() });
      if (req.method === 'GET' && url.pathname === '/api/queue') {
        return json(res, 200, { pages: listPages().filter((p) => p.status === 'candidate') });
      }
      if (req.method === 'GET' && url.pathname === '/api/page') {
        const rel = normalizeWikiRel(url.searchParams.get('path') || '');
        return json(res, 200, readPage(rel));
      }
      if (req.method === 'GET' && url.pathname === '/api/raw') {
        const rel = normalizeRawRel(url.searchParams.get('path') || '');
        const abs = resolveUnder(kbRoot, rel, 'raw');
        if (!fs.existsSync(abs)) return json(res, 404, { error: `raw doc does not exist: ${rel}` });
        return json(res, 200, parseFrontmatter(fs.readFileSync(abs, 'utf8')));
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        // Conflict-diff support (ADR-0004): the pre-overwrite version of a candidate
        // page lives in the KB's Git history. Read-only `git show`; when the KB is
        // not a repo / has no HEAD / the page is new, baseline is null and the
        // client simply hides the diff view.
        const rel = normalizeWikiRel(url.searchParams.get('path') || '');
        const { body } = readPage(rel);   // 404s for missing pages
        let baseline = null;
        try {
          baseline = execFileSync('git', ['-C', kbRoot, 'show', `HEAD:${rel}`],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
        } catch { baseline = null; }
        const current = fs.readFileSync(resolveUnder(kbRoot, rel, 'wiki'), 'utf8');
        return json(res, 200, { baseline, current, changed: baseline !== null && baseline !== current, body });
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        let body = '';
        let refused = false;
        req.on('data', (c) => {
          body += c;
          if (body.length > 64 * 1024 && !refused) {
            refused = true;
            json(res, 413, { error: 'request body too large (64KB max)' });
            req.destroy();
          }
        });
        req.on('end', () => {
          if (refused) return;
          try {
            const { path: p, action } = JSON.parse(body || '{}');
            if (action !== 'approve' && action !== 'reject') {
              return json(res, 400, { error: `action must be approve|reject: ${action}` });
            }
            const rel = normalizeWikiRel(p || '');
            const abs = resolveUnder(kbRoot, rel, 'wiki');
            if (!fs.existsSync(abs)) return json(res, 404, { error: `page does not exist: ${rel}` });
            const { to } = flipStatus(abs, 'candidate', action === 'approve' ? 'approved' : 'rejected');
            return json(res, 200, { page: rel, status: to });
          } catch (err) {
            const code = /page status is/.test(err.message) ? 409 : 400;
            return json(res, err.code === 404 ? 404 : code, { error: err.message });
          }
        });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || MIME[path.extname(url.pathname)])) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const abs = path.resolve(PUBLIC_DIR, name);
        if (!abs.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) return json(res, 400, { error: 'bad static path' });
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(abs));
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.code === 404 ? 404 : 400, { error: err.message });
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
  const kbRoot = args.kb || process.env.KB_PATH;
  if (!kbRoot || !fs.existsSync(kbRoot)) {
    console.error(JSON.stringify({ error: 'knowledge base not specified or does not exist: pass --kb <path> or set KB_PATH' }));
    process.exit(64);
  }
  const port = Number(args.port) || 8321;
  createViewer(path.resolve(kbRoot)).listen(port, '127.0.0.1', () => {
    console.log(`KB review viewer listening at http://127.0.0.1:${port}  (Ctrl+C to stop; status flips are logged by the next governance sweep)`);
  });
}
