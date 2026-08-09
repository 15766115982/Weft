"""NDJSON line writer for streaming tasks (chat, deep-research). Port of llm/lib/stream.mjs."""
import json
from pathlib import Path


class NdjsonWriter:
    def __init__(self, output_path: str | Path):
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        self._fh = p.open("w", encoding="utf-8")
        self._finished = False

    def write(self, obj: dict) -> None:
        if self._finished or self._fh.closed:
            return
        self._fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self._fh.flush()

    def end(self, obj: dict | None = None) -> None:
        if obj is not None:
            self.write(obj)
        self._finished = True
        self._fh.close()

    def close(self) -> None:
        self._finished = True
        self._fh.close()
