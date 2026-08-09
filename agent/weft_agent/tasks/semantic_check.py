"""semantic-check — does new content contradict existing approved content?
(port of llm/lib/tasks/semantic-check.mjs).
"""
from ..runner import run_json_prompt

VALID_SEVERITY = {"none", "low", "medium", "high"}


def run(kb_root, input=None, output_path=None):
    input = input or {}
    proposed = input.get("proposed") or ""
    existing_pages = input.get("existing_pages") if isinstance(input.get("existing_pages"), list) else []
    existing = "\n\n---\n\n".join(f"## {p.get('path')}\n{p.get('body') or ''}" for p in existing_pages)
    res = run_json_prompt(kb_root, "semantic-check", {"proposed": proposed, "existing": existing})
    data = res["data"]
    severity = data.get("severity")
    return {
        "task": "semantic-check",
        "conflict": bool(data.get("conflict")),
        "severity": severity if severity in VALID_SEVERITY else "none",
        "reasoning": data.get("reasoning") or "",
        "contradicting_pages": data.get("contradicting_pages") if isinstance(data.get("contradicting_pages"), list) else [],
        "existing_pages": input.get("existing_pages") or [],
    }
