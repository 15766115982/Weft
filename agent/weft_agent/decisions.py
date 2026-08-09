"""Read-only decision-log access for LLM few-shot context (port of llm/lib/decisions.mjs)."""
import json
from pathlib import Path


def decisions_dir(kb_root: Path) -> Path:
    return kb_root / ".kb" / "govern" / "decisions"


def list_decisions(kb_root: Path) -> list[Path]:
    d = decisions_dir(kb_root)
    if not d.is_dir():
        return []
    return sorted(d.glob("*.json"))


def read_decision(kb_root: Path, decision_id: str) -> dict | None:
    p = decisions_dir(kb_root) / f"{decision_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def decisions_by_type(kb_root: Path, decision_type: str) -> list[dict]:
    out = []
    for p in list_decisions(kb_root):
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue  # skip malformed
        if rec.get("decision_type") == decision_type:
            out.append(rec)
    out.sort(key=lambda r: r.get("ts") or "")
    return out
