"""JSON-file checkpointer for govern runs (ADR-0012).

Why not SqliteSaver: langgraph-checkpoint-sqlite 3.x requires sqlite-vec, which
ships no win32 32-bit wheel (this dev machine) and adds a native dependency the
intranet interceptor may flag. A govern run's checkpoint state is tiny (a queue
of raw paths + per-doc results), so a JSON snapshot after each put is plenty —
and it keeps the agent service pure-wheel, no native deps.

Implementation: subclass InMemorySaver and persist its three stores
(storage / writes / blobs) after every mutation, bytes base64-encoded.
"""
import base64
import json
import threading
import time
from pathlib import Path

from langgraph.checkpoint.memory import InMemorySaver


def _enc_typed(t):
    return [t[0], base64.b64encode(t[1]).decode("ascii")]


def _dec_typed(t):
    return (t[0], base64.b64decode(t[1]))


class JsonFileSaver(InMemorySaver):
    def __init__(self, path, **kw):
        super().__init__(**kw)
        self.path = Path(path)
        self._lock = threading.Lock()  # langgraph writes from pool threads
        self._load()

    # ---- persistence ----
    def _compact(self):
        """Latest-checkpoint-only view for serialization. Resume reads the latest
        checkpoint (+ its pending writes + referenced blobs); older versions are
        dead weight — without this every put rewrites the run's full history
        (quadratic at ~150 docs) and dead threads pile up across runs."""
        storage: dict = {}
        keep_blobs: set = set()
        keep_writes: set = set()
        for tid, by_ns in self.storage.items():
            for ns, by_id in by_ns.items():
                if not by_id:
                    continue
                latest_id = next(reversed(by_id))  # insertion order == put order
                storage.setdefault(tid, {})[ns] = {latest_id: by_id[latest_id]}
                checkpoint = self.serde.loads_typed(by_id[latest_id][0])
                for channel, version in (checkpoint.get("channel_versions") or {}).items():
                    keep_blobs.add((tid, ns, channel, version))
        writes = {}
        for key, by_task in self.writes.items():
            full = (self.storage.get(key[0]) or {}).get(key[1]) or {}
            if key[2] in (next(reversed(full), None),) or key[2] not in full:
                writes[key] = by_task  # latest checkpoint's writes, or in-flight
        blobs = {k: v for k, v in self.blobs.items() if k in keep_blobs}
        return storage, writes, blobs

    def _dump(self):
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            storage, writes, blobs = self._compact()
            data = {
                "storage": {
                    tid: {ns: {cid: [_enc_typed(v[0]), _enc_typed(v[1]), v[2]]
                               for cid, v in by_id.items()}
                          for ns, by_id in by_ns.items()}
                    for tid, by_ns in storage.items()
                },
                "writes": [
                    [list(key), [list(wkey), w[0], w[1], _enc_typed(w[2]), w[3]]]
                    for key, by_task in writes.items()
                    for wkey, w in by_task.items()
                ],
                "blobs": [
                    [list(key), _enc_typed(value)] for key, value in blobs.items()
                ],
            }
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            # Windows: AV/search indexing can briefly hold the fresh .tmp (or the
            # target) — retry the swap a few times before giving up.
            for attempt in range(5):
                try:
                    tmp.replace(self.path)  # atomic-ish: no half-written checkpoints
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.05 * (attempt + 1))

    def _load(self):
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        for tid, by_ns in data.get("storage", {}).items():
            for ns, by_id in by_ns.items():
                for cid, v in by_id.items():
                    self.storage[tid][ns][cid] = (_dec_typed(v[0]), _dec_typed(v[1]), v[2])
        for key, entry in data.get("writes", []):
            wkey, w = entry[0], entry[1:]
            self.writes[tuple(key)][(wkey[0], wkey[1])] = (w[0], w[1], _dec_typed(w[2]), w[3])
        for key, value in data.get("blobs", []):
            self.blobs[tuple(key)] = _dec_typed(value)

    # ---- mutation hooks ----
    def put(self, config, checkpoint, metadata, new_versions):
        out = super().put(config, checkpoint, metadata, new_versions)
        self._dump()
        return out

    def put_writes(self, config, writes, task_id, task_path=""):
        out = super().put_writes(config, writes, task_id, task_path)
        self._dump()
        return out

    def delete_thread(self, thread_id):
        super().delete_thread(thread_id)
        self._dump()


def checkpoint_saver(kb_root):
    """Run checkpoints at .kb/agent/checkpoints.json (derived artifact dir)."""
    d = Path(kb_root) / ".kb" / "agent"
    d.mkdir(parents=True, exist_ok=True)
    return JsonFileSaver(d / "checkpoints.json")
