#!/usr/bin/env node
// LLM service CLI entry. Usage:
//   node llm.mjs <task> --kb <path> --input-file <json> --output-file <path>
// KB location: --kb > KB_PATH env var. stdout prints a JSON summary for non-streaming tasks;
// streaming tasks (chat, deep-research) write NDJSON lines to --output-file.
// Boolean flags take no value: `--flag` / `--flag true` / `--flag false` only.
import fs from 'node:fs';
import path from 'node:path';
import { resolveKbRoot } from './lib/config.mjs';

const TASKS = [
  'check',
  'init-prompts',
  'init-config',
  'summarize-source',
  'classify-page',
  'extract-entity',
  'draft-concept',
  'synthesize',
  'govern-decide',
  'semantic-check',
  'chat',
  'deep-research',
];

const STREAMING_TASKS = new Set(['chat', 'deep-research']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = (i + 1 >= argv.length || argv[i + 1].startsWith('--')) ? true : argv[++i];
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function boolFlag(v, name) {
  if (v === true || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`${name} is a boolean flag and takes no value (got ${JSON.stringify(v)})`);
}

function usage() {
  console.error('usage: node llm.mjs <task> --kb <path> [options]');
  console.error('tasks: ' + TASKS.join(', '));
  console.error('options:');
  console.error('  --input-file <json>    task input payload');
  console.error('  --output-file <path>   task output (required for streaming tasks)');
  console.error('  --kb <path>            KB root (or KB_PATH env var)');
  process.exitCode = 64;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [task] = args._;

  if (!task || !TASKS.includes(task)) {
    usage();
    return;
  }

  let kbRoot;
  try {
    kbRoot = resolveKbRoot(args.kb);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exitCode = 64;
    return;
  }

  const inputPath = args['input-file'];
  const outputPath = args['output-file'];
  const input = inputPath ? JSON.parse(fs.readFileSync(inputPath, 'utf8')) : {};

  if (STREAMING_TASKS.has(task) && !outputPath) {
    console.error(JSON.stringify({ error: `task ${task} requires --output-file for NDJSON stream` }));
    process.exitCode = 64;
    return;
  }

  // Load task module lazily so stub tasks can be added independently.
  const { run } = await import(`./lib/tasks/${task}.mjs`);
  const result = await run({ kbRoot, input, outputPath });

  if (STREAMING_TASKS.has(task)) {
    // Streaming tasks write NDJSON to outputPath and return a summary.
    console.log(JSON.stringify({ task, kb: kbRoot, output: outputPath, ...result }, null, 2));
  } else {
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
    }
    console.log(JSON.stringify({ task, kb: kbRoot, output: outputPath || null, ...result }, null, 2));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
});
