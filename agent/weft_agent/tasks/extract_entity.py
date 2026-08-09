"""extract-entity — extract entities and typed relations from source text
(port of llm/lib/tasks/extract-entity.mjs).
"""
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    source_path = input.get("source_path") or ""
    res = run_json_prompt(kb_root, "extract-entity", {
        "source_path": source_path,
        "body": input.get("body") or "",
    })
    data = res["data"]
    return {
        "task": "extract-entity",
        "source_path": source_path,
        "entities": data.get("entities") if isinstance(data.get("entities"), list) else [],
        "relations": data.get("relations") if isinstance(data.get("relations"), list) else [],
    }
