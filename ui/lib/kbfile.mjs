// F3 KB-root file editing (GOVERNANCE.md — the user-owned governance brief).
// Same save discipline as saveWikiEditJob (edit.mjs): optimistic baseHash lock
// → 409, G6 snapshot before write, log.md audit line. Differences: no
// frontmatter surgery (the file is free-form Markdown) and no candidate
// demotion (it is not a wiki page — it steers the agent, it is never curated).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveUnder, normalizeKbFileName } from './paths.mjs';
import { snapshot } from './acquire.mjs';

export function saveKbFileJob(kb, { path: name, body, baseHash }) {
  name = normalizeKbFileName(name);
  if (typeof body !== 'string' || !body.trim()) throw new Error('file body must be non-empty');
  return {
    type: 'kbfile-edit',
    label: `edit ${name}`,
    run: async (job) => {
      const abs = resolveUnder(kb, name, '.');
      const existed = fs.existsSync(abs);

      // Optimistic lock, same 409 discipline as the wiki editor. On first
      // creation (no file yet) a baseHash is meaningless — skip the compare.
      if (existed && baseHash) {
        const cur = crypto.createHash('sha256').update(fs.readFileSync(abs, 'utf8'), 'utf8').digest('hex');
        if (cur !== baseHash) {
          throw new Error(`edit conflict: ${name} changed since the editor was opened — reload the latest version or force-overwrite`);
        }
      }

      // snapshot() tracks existing files (git pathspec commit / copy); a
      // not-yet-existing file has nothing to snapshot.
      const snap = existed ? snapshot(kb, [name], job) : null;

      fs.writeFileSync(abs, body.trim() + '\n', 'utf8');

      const iso = new Date().toISOString();
      fs.appendFileSync(path.join(kb, 'log.md'),
        `## [${iso}] portal | file:edit | ${name} | manual edit via portal${existed ? '' : ' (created)'}\n`, 'utf8');

      return { path: name, created: !existed, snapshot: snap };
    },
  };
}
