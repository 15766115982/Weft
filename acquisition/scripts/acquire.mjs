#!/usr/bin/env node
// Acquisition service CLI entry. Usage:
//   node acquire.mjs local [--kb <path>] [--inbox <path>]
// KB location: --kb > KB_PATH env var. stdout prints a JSON summary (for Claude to parse).
// Every pull appends one JSON line to <kb>/.kb/acquire_runs.jsonl (contract §1) —
// the only record of an all-skipped incremental pull, and the UI portal's source
// for "last pull time".
import fs from 'node:fs';
import path from 'node:path';
import { resolveKbRoot, loadKbConfig, ensureKbSkeleton } from './lib/kb.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      // boolean flag: no value follows or next arg is another flag
      args[key] = (i + 1 >= argv.length || argv[i + 1].startsWith('--')) ? true : argv[++i];
    } else args._.push(argv[i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const [connector] = args._;

// Boolean flags take no value: `--flag` / `--flag true` / `--flag false` are accepted;
// anything else fails loudly instead of silently reading as false (e.g. `--prune yes`
// silently degrading to report-only would be a destructive-action surprise).
function boolFlag(v, name) {
  if (v === true || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${name} is a boolean flag and takes no value (got ${JSON.stringify(v)})`);
}

async function main() {
  const kbRoot = resolveKbRoot(args.kb);
  ensureKbSkeleton(kbRoot);
  const config = loadKbConfig(kbRoot);

  let summary;
  switch (connector) {
    case 'local': {
      const { run } = await import('./connectors/local.mjs');
      const inboxConf = config.connectors?.local?.inbox || 'inbox/';
      const inbox = path.resolve(kbRoot, args.inbox || inboxConf);
      summary = run(kbRoot, { inbox, prune: args.prune === undefined ? false : boolFlag(args.prune, '--prune') });
      break;
    }
    case 'jira': {
      const { run, check, probeZephyr } = await import('./connectors/jira.mjs');
      if (args.check !== undefined && boolFlag(args.check, '--check')) {
        summary = { myself: await check(config) };
      } else if (args.probe !== undefined && boolFlag(args.probe, '--probe')) {
        // shape probe: ZAPI response structure, no values — safe to relay out
        summary = await probeZephyr(config);
      } else {
        summary = await run(kbRoot, { kbConfig: config, jql: args.jql, maxResults: args.max });
      }
      break;
    }
    case 'confluence': {
      const { run, check, probeGliffy } = await import('./connectors/confluence.mjs');
      if (args.check !== undefined && boolFlag(args.check, '--check')) {
        summary = { myself: await check(config) };
      } else if (args.probe !== undefined) {
        // --probe <pageId>: first gliffy attachment's structure, no values
        const pageId = args.probe === true ? '' : args.probe;
        summary = await probeGliffy(config, pageId);
      } else {
        summary = await run(kbRoot, { kbConfig: config, cql: args.cql, maxResults: args.max });
      }
      break;
    }
    default:
      console.error('usage: node acquire.mjs <local|jira|confluence> [--kb <path>] [options]');
      console.error('  local: [--inbox <path>] [--prune]  --prune removes orphaned docs (default report-only)');
      console.error('  jira:  [--jql "<JQL>"] [--max <n>] [--check] [--probe]  scope from kb.json connectors.jira.jql; PAT via env var');
      console.error('  confluence: [--cql "<CQL>"] [--max <n>] [--check] [--probe <pageId>]  scope from kb.json connectors.confluence.spaces/.cql; PAT via env var');
      process.exitCode = 64;
      return;
  }
  console.log(JSON.stringify({ connector, kb: kbRoot, ...summary }, null, 2));
  recordRun(kbRoot, connector, summary);
}

// Append one compact JSON line per pull to <kb>/.kb/acquire_runs.jsonl
// (contract §1; array fields are recorded as counts only). --check calls are
// auth probes, not pulls, and are not recorded. Best-effort: history must
// never break the pull itself.
function recordRun(kbRoot, connector, summary) {
  if (!summary || summary.myself || summary.probe) return; // --check / --probe shapes
  const rec = { ts: new Date().toISOString(), connector };
  for (const k of ['created', 'updated', 'unchanged', 'unsupported', 'orphaned', 'pruned', 'errors', 'truncated']) {
    if (Array.isArray(summary[k])) rec[k] = summary[k].length;
  }
  if (typeof summary.total === 'number') rec.total = summary.total;
  // phase-1 passthroughs (explicit whitelist, not generic): zephyr status and
  // macro-resolution counts surface in the portal's /api/sources freshness
  if (typeof summary.zephyr === 'string') rec.zephyr = summary.zephyr;
  if (typeof summary.zephyr_hint === 'string') rec.zephyr_hint = summary.zephyr_hint;
  if (summary.macros && typeof summary.macros === 'object') rec.macros = summary.macros;
  try {
    const dir = path.join(kbRoot, '.kb');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'acquire_runs.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* derived history; rebuildable from operational use */ }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
});
