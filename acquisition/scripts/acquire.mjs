#!/usr/bin/env node
// Acquisition service CLI entry. Usage:
//   node acquire.mjs local [--kb <path>] [--inbox <path>]
// KB location: --kb > KB_PATH env var. stdout prints a JSON summary (for Claude to parse).
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
      const { run, check } = await import('./connectors/jira.mjs');
      if (args.check !== undefined && boolFlag(args.check, '--check')) {
        summary = { myself: await check(config) };
      } else {
        summary = await run(kbRoot, { kbConfig: config, jql: args.jql, maxResults: args.max });
      }
      break;
    }
    case 'confluence':
      summary = { errors: [{ error: `connector ${connector} not yet implemented (see CONTEXT.md milestone M6)` }] };
      process.exitCode = 2;
      break;
    default:
      console.error('usage: node acquire.mjs <local|jira|confluence> [--kb <path>] [options]');
      console.error('  local: [--inbox <path>] [--prune]  --prune removes orphaned docs (default report-only)');
      console.error('  jira:  [--jql "<JQL>"] [--max <n>] [--check]  scope from kb.json connectors.jira.jql; PAT via env var');
      process.exitCode = 64;
      return;
  }
  console.log(JSON.stringify({ connector, kb: kbRoot, ...summary }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
});
