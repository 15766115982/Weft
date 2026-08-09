"""summarize-source — structured summary of a raw source document
(port of llm/lib/tasks/summarize-source.mjs).
"""
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    title = input.get("title") or "untitled"
    source = input.get("source") or "unknown"
    body = input.get("body") or ""
    res = run_json_prompt(kb_root, "summarize-source", {"title": title, "source": source, "body": body})
    data = res["data"]
    return {
        "task": "summarize-source",
        "title": data.get("title") or title,
        "summary": data.get("summary") or "",
        "key_points": data.get("key_points") if isinstance(data.get("key_points"), list) else [],
    }
