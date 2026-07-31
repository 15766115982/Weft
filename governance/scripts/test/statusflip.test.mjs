// statusflip: byte-preserving status flip + wiki write-path gate (ADR-0004).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { flipStatus, readStatus, normalizeWikiRel } from '../lib/statusflip.mjs';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flip-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('flip preserves every byte except the status value (BOM + CRLF + comments)', () => {
  const p = path.join(dir, 'crlf.md');
  const original = '﻿---\r\n' +
    'type: topic\r\n' +
    'status: candidate\r\n' +
    'title: "Keep, me: intact"\r\n' +
    '# a comment line\r\n' +
    'sources:\r\n' +
    '  - raw/local/a.md\r\n' +
    '---\r\n' +
    '\r\n' +
    'Body with status: mentioned inline must not change.\r\n';
  fs.writeFileSync(p, original, 'utf8');
  flipStatus(p, 'candidate', 'approved');
  const expected = original.replace('status: candidate\r\n', 'status: approved\r\n');
  assert.equal(fs.readFileSync(p, 'utf8'), expected, 'only the one status line may change');
});

test('flip on LF-only file keeps LF', () => {
  const p = path.join(dir, 'lf.md');
  fs.writeFileSync(p, '---\ntype: topic\nstatus: candidate\n---\n\nbody\n', 'utf8');
  flipStatus(p, 'candidate', 'rejected');
  assert.equal(fs.readFileSync(p, 'utf8'), '---\ntype: topic\nstatus: rejected\n---\n\nbody\n');
});

test('status mismatch fails loudly (optimistic concurrency)', () => {
  const p = path.join(dir, 'mm.md');
  fs.writeFileSync(p, '---\nstatus: approved\n---\n', 'utf8');
  assert.throws(() => flipStatus(p, 'candidate', 'approved'), /page status is "approved", expected "candidate"/);
  assert.equal(readStatus(p), 'approved', 'failed flip must not modify the file');
});

test('missing frontmatter and missing status line', () => {
  const p = path.join(dir, 'nofm.md');
  fs.writeFileSync(p, 'no frontmatter here\n', 'utf8');
  assert.throws(() => flipStatus(p, 'candidate', 'approved'), /page has no frontmatter/);
  const q = path.join(dir, 'nostat.md');
  fs.writeFileSync(q, '---\ntitle: x\n---\n', 'utf8');
  assert.throws(() => flipStatus(q, 'candidate', 'approved'), /page status is "missing", expected "candidate"/);
});

test('normalizeWikiRel: backslashes normalized, traversal and non-page paths refused', () => {
  assert.equal(normalizeWikiRel('wiki\\topics\\x.md'), 'wiki/topics/x.md');
  assert.equal(normalizeWikiRel('wiki/sources/a-b.md'), 'wiki/sources/a-b.md');
  for (const bad of ['../log.md', 'wiki/../log.md', 'raw/local/a.md', 'wiki/index.md',
    'wiki/archive/old.md', 'wiki/topics/', 'wiki/topics/nested/x.md', 'log.md', '']) {
    assert.throws(() => normalizeWikiRel(bad), /page path must be wiki\/sources\|topics\/<name>\.md/, `should refuse: ${bad}`);
  }
});
