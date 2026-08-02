// J3 change detection (fs.watch) feeding the SSE /api/events stream.
// One lazy watcher per KB, refcounted by connected SSE clients.
// Two storm guards, both learned from the requirements review:
//  ① exclude .kb/ — the portal's own derived writes (jobs.jsonl, search
//    state, snapshots) must not retrigger the UI that made them;
//  ② 400ms debounce — a single acquire run touches many files at once and
//    should surface as ONE refresh, not thirty.
import fs from 'node:fs';
import path from 'node:path';

const DEBOUNCE_MS = 400;

export function createWatcher() {
  const perKb = new Map(); // kbRoot -> { watcher, clients: Set<fn>, timer }

  function subscribe(kb, onEvent) {
    let s = perKb.get(kb);
    if (!s) {
      s = { watcher: null, clients: new Set(), timer: null };
      try {
        s.watcher = fs.watch(kb, { recursive: true }, (_type, rel) => {
          if (!rel) return;
          const top = rel.replace(/\\/g, '/').split('/')[0];
          if (top === '.kb') return; // guard ①: derived artifacts are not "KB changed"
          clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            for (const cb of s.clients) {
              try { cb({ kind: 'change' }); } catch { /* client vanished mid-flush */ }
            }
          }, DEBOUNCE_MS); // guard ②
        });
        s.watcher.on('error', () => { /* watch is best-effort; health poll remains */ });
      } catch { /* fs.watch unsupported/failed — SSE clients just get job events */ }
      perKb.set(kb, s);
    }
    s.clients.add(onEvent);
    return () => {
      s.clients.delete(onEvent);
      if (s.clients.size === 0) {
        clearTimeout(s.timer);
        s.watcher?.close();
        perKb.delete(kb);
      }
    };
  }

  return { subscribe, watched: () => [...perKb.keys()] };
}
