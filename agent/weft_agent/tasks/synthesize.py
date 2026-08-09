"""synthesize — draft a synthesis page from multiple sources
(port of llm/lib/tasks/synthesize.mjs).
"""
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    slug = input.get("slug") or "stub-synthesis"
    topic = input.get("topic") or ""
    sources = input.get("sources") if isinstance(input.get("sources"), list) else []
    res = run_json_prompt(kb_root, "synthesize", {
        "slug": slug,
        "topic": topic,
        "sources": "\n\n---\n\n".join(str(s) for s in sources),
    })
    data = res["data"]
    return {
        "task": "synthesize",
        "slug": data.get("slug") or slug,
        "title": data.get("title") or slug,
        "body": data.get("body") or "",
        "sources": data.get("sources") if isinstance(data.get("sources"), list) else sources,
    }
