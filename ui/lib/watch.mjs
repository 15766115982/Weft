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
  const perKb = new Map(); // kbRoot -> { watcher, clients: Map<fn, since>, timer, lastEvent }

  function subscribe(kb, onEvent) {
    let s = perKb.get(kb);
    if (!s) {
      s = { watcher: null, clients: new Map(), timer: null, lastEvent: 0 };
      try {
        s.watcher = fs.watch(kb, { recursive: true }, (_type, rel) => {
          if (!rel) return;
          const top = rel.replace(/\\/g, '/').split('/')[0];
          if (top === '.kb') return; // guard ①: derived artifacts are not "KB changed"
          s.lastEvent = Date.now();
          clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            // deliver only to clients attached BEFORE the change (review
            // 2026-08-04: long-lived internal subscribers — the health-cache
            // invalidator — keep the watcher alive across SSE attach, and a
            // pre-attach write must not flush into a freshly attached stream)
            for (const [cb, since] of s.clients) {
              if (since > s.lastEvent) continue;
              try { cb({ kind: 'change' }); } catch { /* client vanished mid-flush */ }
            }
          }, DEBOUNCE_MS); // guard ②
        });
        s.watcher.on('error', () => { /* watch is best-effort; health poll remains */ });
      } catch { /* fs.watch unsupported/failed — SSE clients just get job events */ }
      perKb.set(kb, s);
    }
    s.clients.set(onEvent, Date.now());
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
