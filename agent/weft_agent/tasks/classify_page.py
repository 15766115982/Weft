"""classify-page — classify a page into source/entity/concept/synthesis
(port of llm/lib/tasks/classify-page.mjs).
"""
from ..runner import run_json_prompt

VALID = {"source", "entity", "concept", "synthesis"}


def run(kb_root, input=None, output_path=None):
    input = input or {}
    page_path = input.get("page_path") or ""
    res = run_json_prompt(kb_root, "classify-page", {
        "page_path": page_path,
        "title": input.get("title") or "",
        "body": input.get("body") or "",
    })
    data = res["data"]
    raw = str(data.get("classification") or "").lower()
    confidence = data.get("confidence")
    return {
        "task": "classify-page",
        "page_path": page_path,
        "classification": raw if raw in VALID else "source",
        "confidence": max(0.0, min(1.0, confidence)) if isinstance(confidence, (int, float)) else 0,
        "reasoning": data.get("reasoning") or "",
    }
