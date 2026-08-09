"""search-smart — the full searchSmart path (ADR-0010) as a task.
Eval suites drive this directly (they used to import the Node llm/lib in-process).
input: {question, limit?, min_hits?, rewrite?: bool, rerank?: bool, rerank_pool?}
"""
from ..research import search_smart
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    question = input.get("question") or ""
    if not question.strip():
        raise ValueError("search-smart requires input.question")
    limit = input.get("limit") or 10
    result = search_smart(
        kb_root, question,
        limit=limit,
        min_hits=input.get("min_hits") or 2,
        rerank_pool=input.get("rerank_pool") or 20,
        rewrite=(lambda q: run_json_prompt(kb_root, "query-rewrite", {"question": q}))
        if input.get("rewrite") else None,
        rerank=(lambda q, c: run_json_prompt(kb_root, "rerank", {"question": q, "candidates": c}))
        if input.get("rerank") else None,
    )
    return {"task": "search-smart", "question": question, **result}
