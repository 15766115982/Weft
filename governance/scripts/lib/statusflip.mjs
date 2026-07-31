// Byte-preserving single-field frontmatter status flip — the ONLY write primitive
// the thin viewer is allowed to use (ADR-0004 red line 3), also used by the
// governance service's review/archive commands. String surgery on the frontmatter
// block only: never parse-and-reserialize, so BOM, CRLF, key order and comments
// survive a flip byte-for-byte.
import fs from 'node:fs';

// Locate the frontmatter block without a BOM escape literal: charCodeAt keeps the
// BOM check explicit. Returns { blockStart, block } where block is the text
// between the opening and closing --- lines, or null when absent.
function locateFrontmatter(text) {
  const start = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const open = text.slice(start).match(/^---\r?\n/);
  if (!open) return null;
  const blockStart = start + open[0].length;
  const rest = text.slice(blockStart);
  const close = rest.match(/^(.*?)\r?\n---(?:\r?\n|$)/s);
  if (!close) return null;
  return { blockStart, block: close[1] };
}

// flipStatus(absPath, expectedFrom, to): rewrite exactly the `status:` line's
// value inside the frontmatter block. The expected-from check is optimistic
// concurrency: a concurrent flip loses loudly, never silently double-applies.
export function flipStatus(absPath, expectedFrom, to) {
  const text = fs.readFileSync(absPath, 'utf8');
  const loc = locateFrontmatter(text);
  if (!loc) throw new Error(`page has no frontmatter: ${absPath}`);
  const sm = loc.block.match(/(?:^|\r?\n)(status:[ \t]*)([^\r\n]*)/);
  const actual = sm ? sm[2].trim() : 'missing';
  if (actual !== expectedFrom) {
    throw new Error(`page status is "${actual}", expected "${expectedFrom}": ${absPath}`);
  }
  const replaced = sm[0].slice(0, sm[0].length - sm[2].length) + to;
  const out = text.slice(0, loc.blockStart + sm.index) + replaced + text.slice(loc.blockStart + sm.index + sm[0].length);
  fs.writeFileSync(absPath, out, 'utf8');
  return { from: expectedFrom, to };
}

// Read the current status value without modifying anything (viewer pre-checks,
// sweep detection). Returns the trimmed value, or null when absent/unparseable.
export function readStatus(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  const loc = locateFrontmatter(text);
  if (!loc) return null;
  const sm = loc.block.match(/(?:^|\r?\n)(status:[ \t]*)([^\r\n]*)/);
  return sm ? sm[2].trim() : null;
}

// normalizeWikiRel(relInput): the single gate for every wiki write path.
// Backslash-tolerant, segment-wise `..` rejection, and restricted to
// wiki/sources|topics/<name>.md — wiki/index.md and wiki/archive/ are excluded
// from ALL write paths by construction.
export function normalizeWikiRel(relInput) {
  const fail = () => { throw new Error(`page path must be wiki/sources|topics/<name>.md: ${relInput}`); };
  if (typeof relInput !== 'string' || !relInput.trim()) fail();
  const rel = relInput.replace(/\\/g, '/');
  if (rel.split('/').some((s) => s === '..')) fail();
  if (!/^wiki\/(sources|topics)\/[^/]+\.md$/.test(rel)) fail();
  return rel;
}
