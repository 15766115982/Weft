// read-gate regression (H2/M3): approved gate, archive refusal, path-prefix
// bypass, case handling
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readWikiPage } from '../lib/readpage.mjs';
import { buildFrontmatter } from '../lib/frontmatter.mjs';

let kb;
function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body, 'utf8');
}

before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-read-'));
  writePage('wiki/sources/local-ok.md',
    { type: 'source', status: 'approved', title: 'OK', source_ref: 'raw/local/ok.md' },
    '## Body\n\napproved content.');
  writePage('wiki/topics/cand.md',
    { type: 'topic', status: 'candidate', title: 'Cand', sources: ['raw/local/ok.md'] },
    '## Body\n\nCANDIDATE-SECRET.');
  writePage('wiki/archive/old.md',
    { type: 'source', status: 'approved', title: 'Old', source_ref: 'raw/local/old.md' },
    '## Body\n\nARCHIVED-SECRET.');
  writePage('wiki/index.md', { title: 'Index' }, '## Topics\n\n- none');
  fs.mkdirSync(path.join(kb, 'wiki-evil'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'wiki-evil', 'secret.md'), 'EVIL-SECRET', 'utf8');
});

after(() => fs.rmSync(kb, { recursive: true, force: true }));

test('approved page reads fine (with/without .md, backslashes)', () => {
  assert.match(readWikiPage(kb, 'wiki/sources/local-ok.md').body, /approved content/);
  assert.match(readWikiPage(kb, 'wiki/sources/local-ok').body, /approved content/);
  assert.match(readWikiPage(kb, 'wiki\\sources\\local-ok.md').body, /approved content/);
});

test('H2: candidate page is refused', () => {
  assert.throws(() => readWikiPage(kb, 'wiki/topics/cand.md'), /status: candidate/);
});

test('H2: archived page is refused even when status is approved', () => {
  assert.throws(() => readWikiPage(kb, 'wiki/archive/old.md'), /archived page/);
});

test('archive gate is case-insensitive on Windows (path.relative preserves input case)', () => {
  if (process.platform !== 'win32') {
    // case-sensitive filesystem: path does not exist, still refused (different error)
    assert.throws(() => readWikiPage(kb, 'wiki/ARCHIVE/old.md'));
    return;
  }
  assert.throws(() => readWikiPage(kb, 'wiki/ARCHIVE/old.md'), /archived page/);
  assert.throws(() => readWikiPage(kb, 'wiki/Archive/old.md'), /archived page/);
});

test('wiki/INDEX.md case variant is whitelisted on Windows', () => {
  if (process.platform !== 'win32') return; // on a case-sensitive FS this path simply does not exist
  assert.match(readWikiPage(kb, 'wiki/INDEX.md').body, /Topics/);
});

test('index.md (no status field) is readable', () => {
  assert.match(readWikiPage(kb, 'wiki/index.md').body, /Topics/);
});

test('.MD uppercase suffix resolves', () => {
  fs.copyFileSync(path.join(kb, 'wiki', 'sources', 'local-ok.md'), path.join(kb, 'wiki', 'sources', 'local-up.MD'));
  assert.match(readWikiPage(kb, 'wiki/sources/local-up.MD').body, /approved content/);
  assert.match(readWikiPage(kb, 'wiki/sources/local-up').body, /approved content/);
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-up.MD'));
});

test('fail-closed: BOM-mangled candidate page is refused (whitelist)', () => {
  const abs = path.join(kb, 'wiki', 'topics', 'bom-cand.md');
  const BOM = String.fromCharCode(0xFEFF);
  fs.writeFileSync(abs, BOM + buildFrontmatter({ type: 'topic', status: 'candidate', title: 'B', sources: ['raw/local/ok.md'] }) + '\n## Body\n\nBOM-SECRET.', 'utf8');
  // even if the parser does not yet tolerate BOM, the whitelist exempts only
  // index.md; parse failure = refusal
  assert.throws(() => readWikiPage(kb, 'wiki/topics/bom-cand.md'), /not approved/);
  fs.unlinkSync(abs);
});

test('fail-closed: malformed frontmatter (status:candidate, no space) is refused', () => {
  const abs = path.join(kb, 'wiki', 'topics', 'bad-cand.md');
  fs.writeFileSync(abs, '---\ntype: topic\nstatus:candidate\ntitle: Bad\n---\n## Body\n\nMALFORMED-SECRET.', 'utf8');
  assert.throws(() => readWikiPage(kb, 'wiki/topics/bad-cand.md'), /not approved/);
  fs.unlinkSync(abs);
});

test('M3: sibling prefix (wiki-evil/) cannot bypass the wiki/ boundary', () => {
  assert.throws(() => readWikiPage(kb, 'wiki-evil/secret.md'), /not under wiki\//);
});

test('traversal outside wiki/ is refused', () => {
  assert.throws(() => readWikiPage(kb, 'wiki/../raw/local/ok.md'), /not under wiki\//);
  assert.throws(() => readWikiPage(kb, '../kb.json'), /not under wiki\//);
});
