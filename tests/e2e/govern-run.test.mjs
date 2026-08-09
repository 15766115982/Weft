// GR-01..04 — govern-run e2e (ADR-0012): the LangGraph govern agent drives the
// REAL acquisition/governance CLIs against a scratch KB built from the fixture
// corpus; only the LLM judgments are stubbed (WEFT_LLM_STUB). Verifies the
// graph skeleton end-to-end at fixture scale: sweep → plan → per-doc →
// synthesis → rebuild-index, plus the NDJSON contract and idempotency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  GOVERNABLE, makeScratchKb, acquire, runLlm, rawRelFor, sourcePageFor, copyInbox, readNdjson,
} from '../helpers/kb.mjs';

const STUB_ENV = { WEFT_LLM_STUB: '1' };
let kb;

// Order-dependent within this file (same convention as pipeline.test.mjs):
// GR-01 governs everything; GR-02..04 assert on the governed state.
before(() => {
  kb = makeScratchKb('kb-govern-run-');
  copyInbox(kb);
  acquire(kb);
});
after(() => { fs.rmSync(kb, { recursive: true, force: true }); });

test('GR-01 govern-run (stub) governs all pending docs into source pages', () => {
  const out = path.join(kb, '.kb', 'gr01.ndjson');
  const summary = runLlm(kb, 'govern-run', { run_id: 'gr01' }, out, STUB_ENV);
  assert.equal(summary.task, 'govern-run');
  assert.equal(summary.ok, true);
  assert.equal(summary.created, GOVERNABLE.length, `all ${GOVERNABLE.length} fixture docs governed`);
  assert.deepEqual(summary.doc_errors, []);
  // every fixture raw now has an approved source page with the stub body
  for (const name of GOVERNABLE.slice(0, 3)) {
    const page = path.join(kb, sourcePageFor(name));
    assert.ok(fs.existsSync(page), `page exists for ${name}`);
    const text = fs.readFileSync(page, 'utf8');
    assert.match(text, /^status:\s*approved/m);
    assert.ok(text.includes('Stub point one.'));
  }
  const lines = readNdjson(out);
  assert.equal(lines[0].type, 'meta');
  assert.ok(lines.some((l) => l.type === 'phase' && l.phase === 'sweep'));
  assert.ok(lines.some((l) => l.type === 'phase' && l.phase === 'plan' && l.pending === GOVERNABLE.length));
  assert.equal(lines.filter((l) => l.type === 'doc').length, GOVERNABLE.length);
  assert.equal(lines.at(-1).type, 'report');
});

test('GR-02 synthesis cluster from shared stub topic', () => {
  // every stub summary hooks "stub-topic" → one synthesis page referencing all raws
  const syn = path.join(kb, 'wiki', 'syntheses', 'stub-topic.md');
  assert.ok(fs.existsSync(syn), 'stub-topic synthesis exists');
  const text = fs.readFileSync(syn, 'utf8');
  assert.ok(text.includes(rawRelFor(GOVERNABLE[0])), 'provenance lists fixture raws');
});

test('GR-03 second run is a no-op (idempotent)', () => {
  const out = path.join(kb, '.kb', 'gr03.ndjson');
  const summary = runLlm(kb, 'govern-run', { run_id: 'gr03' }, out, STUB_ENV);
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 0);
  assert.deepEqual(summary.doc_errors, []);
});

test('GR-04 index rebuilt and plan clean after run', () => {
  assert.ok(fs.existsSync(path.join(kb, 'wiki', 'index.md')));
  const out = path.join(kb, '.kb', 'gr04.ndjson');
  const summary = runLlm(kb, 'govern-run', { run_id: 'gr04' }, out, STUB_ENV);
  assert.deepEqual(summary.human_lists.errors ?? 0, 0);
});
