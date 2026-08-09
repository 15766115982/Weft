// Shared helpers for the cross-service pipeline/eval tests: scratch-KB
// construction from the fixture corpus, deterministic mtimes (for date-filter
// tests), CLI runners, and hash8/page-path computation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO = path.dirname(TESTS_DIR);
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');
export const SCRIPTS = {
  acquire: path.join(REPO, 'acquisition', 'scripts', 'acquire.mjs'),
  govern: path.join(REPO, 'governance', 'scripts', 'govern.mjs'),
  viewer: path.join(REPO, 'governance', 'viewer', 'serve.mjs'),
  search: path.join(REPO, 'retrieval', 'scripts', 'kb_search.mjs'),
};

// ADR-0012: LLM tasks run in the Python agent/ service. Resolution mirrors
// ui/lib/agentcli.mjs: WEFT_AGENT_PYTHON > agent/.venv > python on PATH.
export function agentPython() {
  if (process.env.WEFT_AGENT_PYTHON) return process.env.WEFT_AGENT_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(REPO, 'agent', '.venv', 'Scripts', 'python.exe')
    : path.join(REPO, 'agent', '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return 'python';
}
export const AGENT_DIR = path.join(REPO, 'agent');

// Deterministic mtimes per inbox-relative path — the local connector uses
// mtime as source_version, and retrieval date filters compare it, so the
// fixture corpus needs stable, known dates.
export const MTIMES = {
  'payment-timeout-retry.md': '2026-07-10T08:00:00.000Z',
  'idempotency-design.md': '2026-07-20T08:00:00.000Z',
  'payment-compensation.md': '2026-07-22T08:00:00.000Z',
  'rate-limiting.md': '2026-07-25T08:00:00.000Z',
  'reconciliation.md': '2026-07-28T08:00:00.000Z',
  '订单超时关闭.md': '2026-07-15T08:00:00.000Z',
  '支付对账流程.md': '2026-07-29T08:00:00.000Z',
  'mixed-locale.md': '2026-07-30T08:00:00.000Z',
  'notes.txt': '2026-07-30T09:00:00.000Z',
  'empty.md': '2026-07-30T09:30:00.000Z',
  'deep/structured-doc.md': '2026-07-31T08:00:00.000Z',
};

// Governable docs (everything except the unsupported .docx), in a stable order.
export const GOVERNABLE = Object.keys(MTIMES);

export function hash8(relInboxPath) {
  return crypto.createHash('sha256').update(relInboxPath.replace(/\\/g, '/')).digest('hex').slice(0, 8);
}

export function rawRelFor(inboxRelPath) {
  const stem = path.basename(inboxRelPath, path.extname(inboxRelPath));
  const slug = stem.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
  return `raw/local/${hash8(inboxRelPath)}-${slug}.md`;
}

export function sourcePageFor(inboxRelPath) {
  return `wiki/sources/local-${hash8(inboxRelPath)}.md`;
}

export function runCli(script, args, { stdin, expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [script, ...args], { input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (expectFail) throw new Error(`expected failure but succeeded: ${path.basename(script)} ${args.join(' ')}\n${out}`);
    return JSON.parse(out);
  } catch (err) {
    if (expectFail && err.status) return { failed: true, stderr: String(err.stderr), code: err.status };
    throw err;
  }
}

export function runCliText(script, args, { stdin, expectFail = false } = {}) {
  try {
    const out = execFileSync('node', [script, ...args], { input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (expectFail) throw new Error(`expected failure but succeeded: ${path.basename(script)} ${args.join(' ')}\n${out}`);
    return out;
  } catch (err) {
    if (expectFail && err.status) return { failed: true, stderr: String(err.stderr), code: err.status };
    throw err;
  }
}

export function copyInbox(kbRoot) {
  const inbox = path.join(kbRoot, 'inbox');
  const copyDir = (src, dst, rel = '') => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name), r);
      else {
        fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
        const m = MTIMES[r];
        if (m) { const t = new Date(m); fs.utimesSync(path.join(dst, e.name), t, t); }
      }
    }
  };
  copyDir(path.join(FIXTURES, 'inbox'), inbox);
  return inbox;
}

export function makeScratchKb(prefix = 'kb-pipeline-') {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(kb, 'kb.json'), JSON.stringify({ version: 1, name: 'test-kb', connectors: { local: { inbox: 'inbox/' } } }, null, 2));
  fs.writeFileSync(path.join(kb, '.gitignore'), '.kb/\n');
  return kb;
}

export function acquire(kb, extraArgs = []) {
  return runCli(SCRIPTS.acquire, ['local', '--kb', kb, ...extraArgs]);
}

export function govern(kb, args, stdin) {
  return runCli(SCRIPTS.govern, [...args, '--kb', kb], { stdin });
}

// Run an LLM service task against the scratch KB. Streaming tasks require
// outputPath; non-streaming tasks may also write there. The env object is
// merged into process.env so callers can set WEFT_LLM_STUB=1.
export function runLlm(kb, task, input, outputPath, env = {}) {
  const inputFile = path.join(kb, '.kb', `llm-input-${task}.json`);
  fs.mkdirSync(path.dirname(inputFile), { recursive: true });
  fs.writeFileSync(inputFile, JSON.stringify(input), 'utf8');
  const args = [task, '--kb', kb, '--input-file', inputFile];
  if (outputPath) args.push('--output-file', outputPath);
  const out = execFileSync(agentPython(), ['-m', 'weft_agent', ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function summaryFor(inboxRelPath) {
  const stem = path.basename(inboxRelPath, path.extname(inboxRelPath));
  return fs.readFileSync(path.join(FIXTURES, 'summaries', `${stem}.md`), 'utf8');
}

const TAGS = {
  'payment-timeout-retry.md': 'retry,timeout,resilience',
  'idempotency-design.md': 'idempotency,safety',
  'payment-compensation.md': 'compensation,saga,safety',
  'rate-limiting.md': 'ratelimit,throughput',
  'reconciliation.md': 'reconciliation,settlement',
  '订单超时关闭.md': 'order,timeout',
  '支付对账流程.md': 'reconciliation,operations',
  'mixed-locale.md': 'incident,retry',
  'faq-retry.md': 'retry,faq',
  'incident-settlement-delay.md': 'incident,settlement,reconciliation',
  'notes.txt': 'operations,handover',
  'empty.md': 'placeholder',
  'deep/structured-doc.md': 'operations,runbook,retry',
};

// Govern every raw produced from the fixture inbox: apply-source with the
// pre-written summary for the doc's inbox_path. Returns the applied page paths.
export function applyAllSources(kb) {
  const p = govern(kb, ['plan']);
  const applied = [];
  for (const item of p.pending) {
    const rawAbs = path.join(kb, item.raw);
    const fm = fs.readFileSync(rawAbs, 'utf8');
    const inboxPath = fm.match(/inbox_path:\s*"?([^"\n]+)"?/)?.[1].trim();
    const tags = TAGS[inboxPath] ? ['--tags', TAGS[inboxPath]] : [];
    govern(kb, ['apply-source', '--raw', item.raw, ...tags], summaryFor(inboxPath));
    applied.push(item.page);
  }
  return applied;
}

// Directory snapshot (rel path → content hash) for write-permission checks.
export function snapshot(dir) {
  const map = {};
  const walk = (d, rel = '') => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else map[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex');
    }
  };
  walk(dir);
  return map;
}
