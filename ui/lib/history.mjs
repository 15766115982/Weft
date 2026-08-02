// J7 page history (M7d; version-management constraint — never assume git).
// git KB: `git log --follow` for the page. Non-git: the G6 copy snapshots
// under .kb/ui/snapshots/ that mention the page, plus the "git init
// recommended" hint the constraint prescribes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function isGitRepo(kb) {
  try {
    execFileSync('git', ['-C', kb, 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch { return false; }
}

export function pageHistory(kbRoot, rel) {
  if (isGitRepo(kbRoot)) {
    let out = '';
    try {
      out = execFileSync('git', ['-C', kbRoot, 'log', '--follow', '--format=%h%x1f%aI%x1f%s%x1e', '--', rel],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    } catch { /* path never committed yet → empty history */ }
    const entries = [];
    for (const rec of out.split('\x1e')) {
      const [hash, ts, subject] = rec.trim().split('\x1f');
      if (hash) entries.push({ hash, ts, subject });
    }
    return { kind: 'git', entries };
  }

  const snapRoot = path.join(kbRoot, '.kb', 'ui', 'snapshots');
  const entries = [];
  if (fs.existsSync(snapRoot)) {
    for (const dir of fs.readdirSync(snapRoot)) {
      if (!fs.existsSync(path.join(snapRoot, dir, rel))) continue;
      const ms = Number(dir.split('-')[0]);
      entries.push({ ts: Number.isNaN(ms) ? dir : new Date(ms).toISOString(), subject: `编辑前快照 (${dir})` });
    }
  }
  entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return {
    kind: 'snapshots', entries,
    hint: '这个知识库未纳入版本管理 — 只有操作前快照。建议 git init 获得完整页面历史。',
  };
}
