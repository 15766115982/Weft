"""draft-concept — draft a concept page from sources (port of llm/lib/tasks/draft-concept.mjs)."""
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    slug = input.get("slug") or "stub-concept"
    sources = input.get("sources") if isinstance(input.get("sources"), list) else []
    related = input.get("related") if isinstance(input.get("related"), list) else []
    res = run_json_prompt(kb_root, "draft-concept", {
        "slug": slug,
        "sources": "\n\n---\n\n".join(str(s) for s in sources),
        "related": "\n".join(f"- {r}" for r in related),
    })
    data = res["data"]
    return {
        "task": "draft-concept",
        "slug": data.get("slug") or slug,
        "title": data.get("title") or slug,
        "body": data.get("body") or "",
        "sources": data.get("sources") if isinstance(data.get("sources"), list) else sources,
    }
