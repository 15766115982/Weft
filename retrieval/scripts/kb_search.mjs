#!/usr/bin/env node
// Retrieval service CLI. Usage:
//   node kb_search.mjs search "<query>" [--kb <path>] [--within p1,p2] [--limit N]
//   node kb_search.mjs read <wiki-page-path>[#anchor] [--kb <path>]
//   node kb_search.mjs reindex [--kb <path>]     (manual trigger; search runs lazy reconciliation automatically first)
// Structured query: bare terms ANDed, "phrases", field filters type:/source:/tag: (constructed by Claude, ADR-0003)
import fs from 'node:fs';
import { ensureFresh } from './lib/store.mjs';
import { search } from './lib/query.mjs';
import { readSection } from './lib/chunk.mjs';
import { readWikiPage } from './lib/readpage.mjs';

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

const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;

try {
  const kbRoot = args.kb || process.env.KB_PATH;
  if (!kbRoot || !fs.existsSync(kbRoot)) throw new Error('no knowledge base specified: --kb <path> or KB_PATH');

  switch (cmd) {
    case 'reindex':
      console.log(JSON.stringify(ensureFresh(kbRoot), null, 2));
      break;
    case 'search': {
      const q = rest.join(' ');
      if (!q) throw new Error('search requires a query string');
      ensureFresh(kbRoot); // lazy reconciliation: always reconcile the index before querying
      const within = args.within ? String(args.within).split(',').map(s => s.trim()) : [];
      const limit = args.limit ? parseInt(args.limit, 10) : 50;
      if (!Number.isInteger(limit) || limit <= 0) throw new Error(`--limit must be a positive integer: ${args.limit}`);
      console.log(JSON.stringify(search(kbRoot, q, { within, limit }), null, 2));
      break;
    }
    case 'read': {
      const [page, anchor] = (rest[0] || '').split('#');
      const { body } = readWikiPage(kbRoot, page); // gates: inside wiki/ + not archive + approved
      try {
        console.log(readSection(body, anchor || undefined));
      } catch (e) {
        if (e.available) console.error(JSON.stringify({ error: e.message, available_anchors: e.available }));
        throw e;
      }
      break;
    }
    default:
      console.error('usage: node kb_search.mjs <search|read|reindex> ... (see header comment)');
      process.exitCode = 64;
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
}
