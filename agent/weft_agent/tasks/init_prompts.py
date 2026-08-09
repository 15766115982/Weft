"""init-prompts — seed .kb/config/prompts/ from templates/prompts/
(port of llm/lib/tasks/init-prompts.mjs).
"""
from ..prompts import init_prompts, resolve_prompt


def run(kb_root, input=None, output_path=None):
    result = init_prompts(kb_root, force=bool((input or {}).get("force") is True))
    resolve_prompt.cache_clear()
    return {
        "ok": True,
        "src": result["src"],
        "dst": result["dst"],
        "prompts": result["results"],
    }
