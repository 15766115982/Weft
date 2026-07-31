#!/usr/bin/env node
// Governance service CLI. Usage:
//   node govern.mjs plan --kb <path>
//   node govern.mjs apply-source --kb <path> --raw <raw-relative-path> [--tags a,b,c]   (summary body passed via stdin)
//   node govern.mjs apply-topic --kb <path> --slug <slug> --title "T" [--sources raw/a.md,raw/b.md]
//       [--aliases a,b] [--tags t1,t2] [--candidate] [--note "..."]                    (synthesis body passed via stdin)
//   node govern.mjs approve --kb <path> --page wiki/(sources|topics)/<name>.md
//   node govern.mjs reject  --kb <path> --page wiki/(sources|topics)/<name>.md
//   node govern.mjs archive --kb <path> --page wiki/(sources|topics)/<name>.md [--note "..."]
//   node govern.mjs sweep   --kb <path>
//   node govern.mjs merge-topic --kb <path> --from <slug> --to <slug> [--note "..."]
//   node govern.mjs rebuild-index --kb <path>
// stdout is always JSON (for Claude to parse).
import fs from 'node:fs';
import { plan, applySourcePage, applyTopicPage, rebuildIndex, approvePage, rejectPage, archivePage, sweep, mergeTopics } from './lib/govern.mjs';

// Boolean flags take no value: `--flag` / `--flag true` / `--flag false` are accepted;
// anything else is a caller mistake and must fail loudly instead of silently reading
// as false (e.g. `--candidate yes` silently producing an approved page).
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

try {
  const kbRoot = resolveKb(args.kb);
  let out;
  switch (cmd) {
    case 'plan':
      out = plan(kbRoot);
      break;
    case 'apply-source': {
      if (!args.raw) throw new Error('apply-source requires --raw <raw-relative-path>');
      const summary = fs.readFileSync(0, 'utf8'); // stdin
      // --tags omitted = keep existing tags; explicit --tags "" = clear
      const tags = args.tags === undefined ? undefined
        : String(args.tags).split(',').map(s => s.trim()).filter(Boolean);
      out = applySourcePage(kbRoot, args.raw, summary, { tags });
      break;
    }
    case 'rebuild-index':
      out = rebuildIndex(kbRoot);
      break;
    case 'apply-topic': {
      if (!args.slug) throw new Error('apply-topic requires --slug <slug>');
      const synthesis = fs.readFileSync(0, 'utf8'); // stdin
      // comma-list flags: omitted = keep existing; explicit "" = clear
      const list = (v) => v === undefined ? undefined
        : String(v).split(',').map(s => s.trim()).filter(Boolean);
      // --sources omitted on update = keep existing (union-merge keeps provenance)
      out = applyTopicPage(kbRoot, {
        slug: args.slug,
        title: args.title,
        sources: list(args.sources),
        aliases: list(args.aliases),
        tags: list(args.tags),
        candidate: args.candidate === undefined ? false : boolFlag(args.candidate, '--candidate'),
        note: typeof args.note === 'string' ? args.note : undefined,
      }, synthesis);
      break;
    }
    case 'approve':
    case 'reject': {
      if (!args.page) throw new Error(`${cmd} requires --page wiki/(sources|topics)/<name>.md`);
      const fn = cmd === 'approve' ? approvePage : rejectPage;
      out = fn(kbRoot, args.page, { via: 'session' });
      break;
    }
    case 'archive': {
      if (!args.page) throw new Error('archive requires --page wiki/(sources|topics)/<name>.md');
      out = archivePage(kbRoot, args.page, { note: typeof args.note === 'string' ? args.note : '' });
      break;
    }
    case 'sweep':
      out = sweep(kbRoot);
      break;
    case 'merge-topic': {
      if (!args.from || !args.to) throw new Error('merge-topic requires --from <slug> --to <slug>');
      out = mergeTopics(kbRoot, args.from, args.to, { note: typeof args.note === 'string' ? args.note : '' });
      break;
    }
    default:
      console.error('Usage: node govern.mjs <plan|apply-source|apply-topic|approve|reject|archive|sweep|merge-topic|rebuild-index> --kb <path> [options]');
      process.exitCode = 64;
      break;
  }
  if (out) console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
}
