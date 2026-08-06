// Shared scratch-KB fixture for the UI regression suites (plan §4) — used by
// the node:test API suites (test/authz.test.mjs) and the Playwright webServer
// config. Build under a temp dir; never commit to the fixture KB.
//
// Options:
//   config: false  → omit .kb/config/ (settings empty-state variant, S2)
//   detect: false  → omit .kb/acquire/upstream-detect.json (detect null-shape)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildFrontmatter } from '../../../governance/scripts/lib/frontmatter.mjs';

// 1x1 transparent PNG (raw-asset case)
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function buildFixtureKb({ config = true, detect = true, dir } = {}) {
  const kb = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fixture-'));
  const write = (rel, text) => {
    const abs = path.join(kb, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };

  write('kb.json', JSON.stringify({ version: 2 }));

  write('raw/jira/PROJ-1.md', buildFrontmatter({
    source: 'jira', source_id: 'PROJ-1', title: 'Payment Gateway Requirements',
    source_url: 'https://jira.example/browse/PROJ-1',
    source_version: '2026-08-01T00:00:00Z', pulled_at: '2026-08-01T00:00:00Z',
    content_hash: 'sha256:fixture1', connector: 'jira@1.0.0',
  }) + '\nThe payment gateway must support timeout retries with exponential backoff.\n');
  const assetDir = path.join(kb, 'raw', 'jira', 'PROJ-1.assets');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'diagram.png'), TINY_PNG);

  write('wiki/index.md', '# Index\n\n- [[jira-proj-1]]\n');
  write('wiki/sources/jira-proj-1.md', buildFrontmatter({
    type: 'source', status: 'approved', title: 'Payment Gateway Requirements',
    source_ref: 'raw/jira/PROJ-1.md', updated_at: '2026-08-01T00:00:00Z',
  }) + '\nSource summary of PROJ-1.\n');
  // contract §3.5: synthesis pages live in wiki/syntheses/ (not wiki/topics/)
  write('wiki/syntheses/alpha.md', buildFrontmatter({
    type: 'synthesis', status: 'candidate', title: 'Alpha Topic', review_note: 'fixture candidate',
    sources: ['raw/jira/PROJ-1.md'], updated_at: '2026-08-01T00:00:00Z',
  }) + '\nCandidate synthesis awaiting review.\n');

  write('GOVERNANCE.md', '# Governance Brief\n\nPrefer API documentation sources.\n');
  write('log.md', [
    '## [2026-08-01T00:00:00Z] govern | approved:source | wiki/sources/jira-proj-1.md | initial',
    '## [2026-08-01T01:00:00Z] govern | candidate:synthesis | wiki/syntheses/alpha.md | agent draft',
  ].join('\n') + '\n');

  if (config) {
    write('.kb/config/models.json', JSON.stringify({
      provider: 'openai',
      endpoint: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2-0711-preview',
      auth: { type: 'api_key', api_key: 'WEFT_LLM_API_KEY' },
      defaults: { temperature: 0.2, max_tokens: 4096 },
    }, null, 2));
    write('.kb/config/prompts/chat.md', '# Chat prompt\n\nAnswer with citations.\n');
    write('.kb/config/prompts/govern.md', '# Govern prompt\n\nFollow the contract.\n');
  }

  if (detect) {
    write('.kb/acquire/upstream-detect.json', JSON.stringify({
      ts: '2026-08-02T00:00:00Z', connector: 'jira',
      new: [{ source_id: 'PROJ-9', title: 'New upstream doc' }],
      changed: [], unchanged: [{ source_id: 'PROJ-1', title: 'Payment Gateway Requirements' }],
      removed_upstream: [], errors: [],
    }, null, 2));
  }

  write('.kb/govern/conflicts.json', JSON.stringify({
    generated_at: '2026-08-02T00:00:00Z', fingerprint: 'fixture-fingerprint',
    groups: [{
      category: 'similar', raws: ['raw/jira/PROJ-1.md', 'raw/jira/PROJ-1-copy.md'],
      dismissed: false, provenance: {},
    }],
  }, null, 2));

  // decision records: one JSON file per record under .kb/govern/decisions/
  write('.kb/govern/decisions/2026-08-01T00-00-00Z-d1.json', JSON.stringify({
    id: 'd1', timestamp: '2026-08-01T00:00:00Z', actor: 'human',
    action: 'approve', page: 'wiki/sources/jira-proj-1.md', reason: 'accurate summary',
  }, null, 2));
  write('.kb/govern/decisions/2026-08-01T01-00-00Z-d2.json', JSON.stringify({
    id: 'd2', timestamp: '2026-08-01T01:00:00Z', actor: 'human',
    action: 'reject', page: 'wiki/syntheses/beta.md', reason: 'duplicate of alpha',
  }, null, 2));

  return kb;
}

export function rmFixtureKb(kb) {
  fs.rmSync(kb, { recursive: true, force: true });
}

/** Write the deterministic LLM CLI stub (chat streaming cases) and return its path. */
export function writeLlmStub(dir, { fail = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, fail ? 'llm-stub-fail.mjs' : 'llm-stub.mjs');
  if (fail) {
    fs.writeFileSync(stub, `process.stderr.write('stub llm failure\\n');\nprocess.exit(1);\n`, 'utf8');
    return stub;
  }
  fs.writeFileSync(stub, `import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input-file');
const outputIdx = args.indexOf('--output-file');
const input = inputIdx >= 0 ? JSON.parse(fs.readFileSync(args[inputIdx + 1], 'utf8')) : {};
const output = outputIdx >= 0 ? args[outputIdx + 1] : path.join(os.tmpdir(), 'out.ndjson');
fs.mkdirSync(path.dirname(output), { recursive: true });
const level = input.level || 'quick';
const lines = [
  JSON.stringify({ type: 'meta', level }),
  ...(level === 'deep' || level === 'deep-research' ? [
    JSON.stringify({ type: 'search', query: input.question, round: 1 }),
    JSON.stringify({ type: 'read', page: 'wiki/sources/x.md', round: 1 }),
  ] : []),
  JSON.stringify({ type: 'chunk', text: 'hello ' }),
  JSON.stringify({ type: 'chunk', text: 'world' }),
  JSON.stringify({ type: 'done', citations: ['wiki/sources/x.md'] }),
];
fs.writeFileSync(output, lines.join('\\n') + '\\n', 'utf8');
console.log(JSON.stringify({ task: 'chat', output }));
`, 'utf8');
  return stub;
}
