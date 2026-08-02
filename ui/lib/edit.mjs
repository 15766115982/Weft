// M7d human wiki edits (contract §1 whitelist ⑤, rulings ⑨/⑩). Every save:
// snapshot first (git pathspec commit / G6 copy — ruling ⑨c), body replaced,
// frontmatter surgically updated (status → candidate unless already, plus
// review_note + updated_at; byte-preserving discipline from statusflip —
// never parse-and-reserialize), then a `portal | candidate:manual` log.md
// entry the governance sweep treats as pending-review (same caliber as
// `govern | candidate:*`). Provenance fields are never touched (ruling ⑩).
import fs from 'node:fs';
import path from 'node:path';
import { resolveUnder } from './paths.mjs';
import { normalizeWikiRel } from './review.mjs';
import { locateFrontmatter } from '../../governance/scripts/lib/statusflip.mjs';
import { snapshot } from './acquire.mjs';

// Replace one scalar field's value inside the frontmatter block, or append
// the field at the block end. Same line-surgery style as flipStatus.
function setField(block, eol, key, value) {
  const re = new RegExp(`(^|\\r?\\n)(${key}:[ \\t]*)([^\\r\\n]*)`);
  if (re.test(block)) return block.replace(re, (_m, nl, k) => `${nl}${k}${value}`);
  return `${block}${eol}${key}: ${value}`;
}

export function saveWikiEditJob(kb, { path: rel, body }) {
  rel = normalizeWikiRel(rel); // wiki/sources|topics only — index.md stays non-editable
  if (typeof body !== 'string' || !body.trim()) throw new Error('page body must be non-empty');
  // A pasted frontmatter block would silently corrupt the page's identity —
  // frontmatter is governance-owned; the editor edits the BODY only.
  if (/^---\r?\n/.test(body.trimStart())) {
    throw new Error('body must not start with a frontmatter block (---); provenance fields are read-only here');
  }
  return {
    type: 'wiki-edit',
    label: `edit ${rel}`,
    run: async (job) => {
      const abs = resolveUnder(kb, rel, 'wiki');
      if (!fs.existsSync(abs)) throw new Error(`page does not exist: ${rel}`);

      const snap = snapshot(kb, [rel], job);
      const text = fs.readFileSync(abs, 'utf8');
      const loc = locateFrontmatter(text);
      if (!loc) throw new Error(`page has no frontmatter: ${rel}`);

      const iso = new Date().toISOString();
      const eol = loc.block.includes('\r\n') ? '\r\n' : '\n';
      const statusMatch = loc.block.match(/(?:^|\r?\n)status:[ \t]*([^\r\n]*)/);
      const was = statusMatch ? statusMatch[1].trim() : '';
      const demoted = was !== 'candidate';

      let block = loc.block;
      if (demoted) block = setField(block, eol, 'status', 'candidate');
      block = setField(block, eol, 'review_note', `manual edit via portal @ ${iso}`);
      block = setField(block, eol, 'updated_at', iso);

      // head + new block + the newline+closing fence the locator left behind,
      // then the new body wholesale.
      const head = text.slice(0, loc.blockStart);
      const tailFrom = text.slice(loc.blockStart + loc.block.length);
      const fence = tailFrom.match(/^\r?\n---(?:\r?\n|$)/);
      const out = head + block + fence[0] + '\n' + body.trim() + '\n';
      fs.writeFileSync(abs, out, 'utf8');

      // Pending-review log entry (whitelist ⑤): sweep backfills the eventual
      // review flip from this line exactly as it does for govern candidates.
      fs.appendFileSync(path.join(kb, 'log.md'),
        `## [${iso}] portal | candidate:manual | ${rel} | manual edit via portal${demoted ? ' (demoted to candidate)' : ''}\n`, 'utf8');

      return { path: rel, demoted, snapshot: snap };
    },
  };
}
