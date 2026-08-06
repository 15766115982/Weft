#!/usr/bin/env node
// Governance service CLI. Usage:
//   node govern.mjs plan --kb <path>
//   node govern.mjs apply-source --kb <path> --raw <raw-relative-path> [--tags a,b,c] [--force]
//       (summary body via --body-file <path>, or stdin when omitted)
//       --force revives a tombstoned raw (writes the page and clears the tombstone)
//   node govern.mjs apply-entity --kb <path> --slug <slug> --title "T" [--sources raw/a.md,raw/b.md]
//   node govern.mjs apply-concept --kb <path> --slug <slug> --title "T" [--sources raw/a.md,raw/b.md]
//   node govern.mjs apply-synthesis --kb <path> --slug <slug> --title "T" [--sources raw/a.md,raw/b.md]
//       [--aliases a,b] [--tags t1,t2] [--candidate] [--note "..."]
//       (synthesis body via --body-file <path>, or stdin when omitted)
//   node govern.mjs approve --kb <path> --page wiki/(sources|entities|concepts|syntheses)/<name>.md --reason "..."
//   node govern.mjs reject  --kb <path> --page wiki/(sources|entities|concepts|syntheses)/<name>.md --reason "..."
//   node govern.mjs archive --kb <path> --page wiki/(sources|entities|concepts|syntheses)/<name>.md --reason "..." [--note "..."]
//   node govern.mjs dismiss-conflict --kb <path> --pair raw/a.md,raw/b.md --reason "..."
//   node govern.mjs sweep   --kb <path>
//   node govern.mjs merge-page --kb <path> --type entity|concept|synthesis --from <slug> --to <slug> --reason "..."
//   node govern.mjs merge-topic --kb <path> --from <slug> --to <slug> --reason "..."  (legacy alias for synthesis)
//   node govern.mjs rebuild-index --kb <path>
//   node govern.mjs decisions --kb <path> [--action <a>] [--page <p>] [--actor <a>]
// stdout is always JSON (for Claude to parse).
import fs from 'node:fs';
import path from 'node:path';
import {
  plan, applySourcePage, applyEntityPage, applyConceptPage, applySynthesisPage,
  applyTopicPage, rebuildIndex, approvePage, rejectPage, archivePage, sweep,
  mergePages, mergeTopics, addDismissal,
} from './lib/govern.mjs';
import { decisionContext, readDecisions } from './lib/decisions.mjs';

function boolFlag(v, name) {
  if (v === true || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${name} is a boolean flag and takes no value (got ${JSON.stringify(v)})`);
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

function resolveKb(flag) {
  const root = flag || process.env.KB_PATH;
  if (!root) throw new Error('knowledge base not specified: pass --kb <path> or set KB_PATH');
  if (!fs.existsSync(root)) throw new Error(`knowledge base directory does not exist: ${root}`);
  return root;
}

const args = parseArgs(process.argv.slice(2));
const [cmd] = args._;

function readBody(args) {
  const f = args['body-file'];
  if (f === true) throw new Error('--body-file requires a path value');
  if (f !== undefined) {
    const abs = path.resolve(String(f));
    if (!fs.existsSync(abs)) throw new Error(`--body-file does not exist: ${f}`);
    return fs.readFileSync(abs, 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function list(v) {
  return v === undefined ? undefined
    : String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function applyOpts() {
  return {
    slug: args.slug,
    title: args.title,
    sources: list(args.sources),
    aliases: list(args.aliases),
    tags: list(args.tags),
    candidate: args.candidate === undefined ? false : boolFlag(args.candidate, '--candidate'),
    note: typeof args.note === 'string' ? args.note : undefined,
    ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
  };
}

try {
  const kbRoot = resolveKb(args.kb);
  let out;
  switch (cmd) {
    case 'plan':
      out = plan(kbRoot);
      break;
    case 'apply-source': {
      if (!args.raw) throw new Error('apply-source requires --raw <raw-relative-path>');
      const summary = readBody(args);
      const tags = args.tags === undefined ? undefined
        : String(args.tags).split(',').map(s => s.trim()).filter(Boolean);
      out = applySourcePage(kbRoot, args.raw, summary, {
        tags,
        force: args.force === undefined ? false : boolFlag(args.force, '--force'),
        ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
      });
      break;
    }
    case 'apply-entity':
      out = applyEntityPage(kbRoot, applyOpts(), readBody(args));
      break;
    case 'apply-concept':
      out = applyConceptPage(kbRoot, applyOpts(), readBody(args));
      break;
    case 'apply-synthesis':
      out = applySynthesisPage(kbRoot, applyOpts(), readBody(args));
      break;
    case 'apply-topic':
      // Legacy alias retained during the v2 transition.
      out = applyTopicPage(kbRoot, applyOpts(), readBody(args));
      break;
    case 'rebuild-index':
      out = rebuildIndex(kbRoot);
      break;
    case 'approve':
    case 'reject': {
      if (!args.page) throw new Error(`${cmd} requires --page wiki/(sources|entities|concepts|syntheses)/<name>.md`);
      const fn = cmd === 'approve' ? approvePage : rejectPage;
      out = fn(kbRoot, args.page, {
        via: 'session',
        ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });
      break;
    }
    case 'archive': {
      if (!args.page) throw new Error('archive requires --page wiki/(sources|entities|concepts|syntheses)/<name>.md');
      out = archivePage(kbRoot, args.page, {
        note: typeof args.note === 'string' ? args.note : '',
        ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });
      break;
    }
    case 'dismiss-conflict': {
      if (!args.pair || !args.reason) throw new Error('dismiss-conflict requires --pair raw/a.md,raw/b.md --reason "..."');
      const raws = String(args.pair).split(',').map(s => s.trim()).filter(Boolean);
      if (raws.length < 2) throw new Error('dismiss-conflict --pair requires at least two raw paths');
      out = { action: 'dismiss-conflict', ...addDismissal(kbRoot, raws, String(args.reason)) };
      break;
    }
    case 'sweep':
      out = sweep(kbRoot);
      break;
    case 'merge-page': {
      if (!args.from || !args.to || !args.type) throw new Error('merge-page requires --type entity|concept|synthesis --from <slug> --to <slug>');
      out = mergePages(kbRoot, args.type, args.from, args.to, {
        note: typeof args.note === 'string' ? args.note : '',
        ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });
      break;
    }
    case 'merge-topic': {
      if (!args.from || !args.to) throw new Error('merge-topic requires --from <slug> --to <slug>');
      out = mergeTopics(kbRoot, args.from, args.to, {
        note: typeof args.note === 'string' ? args.note : '',
        ...decisionContext({ actor: args.actor, model_version: args['model-version'], precedents: args.precedents }),
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });
      break;
    }
    case 'decisions':
      out = readDecisions(kbRoot, {
        action: typeof args.action === 'string' ? args.action : undefined,
        page: typeof args.page === 'string' ? args.page : undefined,
        actor: typeof args.actor === 'string' ? args.actor : undefined,
      });
      break;
    default:
      console.error('Usage: node govern.mjs <plan|apply-source|apply-entity|apply-concept|apply-synthesis|apply-topic|approve|reject|archive|dismiss-conflict|sweep|merge-page|merge-topic|rebuild-index|decisions> --kb <path> [options]');
      process.exitCode = 64;
      break;
  }
  if (out) console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
}
