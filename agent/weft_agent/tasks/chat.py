"""chat — page-level Q&A, streaming NDJSON (port of llm/lib/tasks/chat.mjs).
Every level retrieves (the product promise is "answers are KB-grounded"); they
differ in depth:
  quick         top-3 snippet grounding, single LLM call, fastest
  deep          top-5 snippet grounding, single LLM call
  deep-research multi-round search→read loop with full reasoning trace
Context assembly (C3): full wiki page bodies; for source pages the raw evidence
is followed via source_ref (agent reads of wiki/ + raw/ are in-contract).
"""
import re
from pathlib import Path

from ..research import search_smart
from ..runner import run_json_prompt, run_prompt
from ..stream import NdjsonWriter

LEVEL_LIMIT = {"quick": 3, "deep": 5, "deep-research": 8}
PAGE_BUDGET = 2500    # per wiki page body
RAW_BUDGET = 3500     # per source page's raw excerpt
TOTAL_BUDGET = 16000  # whole context

REFUSAL = "这座知识库里没有与该问题相关的内容。可以换个问法,或先采集/治理相关文档。"


def read_page_full(kb_root: Path, page_rel: str):
    abs_path = kb_root / page_rel
    if not abs_path.exists():
        return None
    text = abs_path.read_text(encoding="utf-8")
    fm_end = text.find("\n---", 3) if text.startswith("---") else -1
    fm = text[3:fm_end] if fm_end > 0 else ""
    body = (text[fm_end + 4:] if fm_end > 0 else text).strip()
    m = re.search(r'^source_ref:\s*"?([^"\n]+)"?', fm, flags=re.M)
    return {"body": body, "source_ref": m.group(1).strip() if m else None}


def read_raw_evidence(kb_root: Path, source_ref: str | None) -> str:
    if not source_ref or ".." in source_ref:
        return ""
    abs_path = kb_root / source_ref
    if not str(abs_path).startswith(str(kb_root / "raw")) or not abs_path.exists():
        return ""
    text = abs_path.read_text(encoding="utf-8")
    fm_end = text.find("\n---", 3) if text.startswith("---") else -1
    return (text[fm_end + 4:] if fm_end > 0 else text).strip()


def _cited(answer: str, hits: list[dict]) -> list[str]:
    out = []
    for h in hits:
        slug = h["page"].split("/")[-1][:-3] if h["page"].endswith(".md") else h["page"].split("/")[-1]
        title = h.get("title") or ""
        if (f"[[{title}]]" in answer or f"[[{slug}]]" in answer
                or (title and title in answer) or slug in answer):
            out.append(h["page"])
    return out


def run(kb_root, input=None, output_path=None):
    input = input or {}
    writer = NdjsonWriter(output_path)
    level = input.get("level") or "quick"
    question = input.get("question") or ""
    context = ""
    hits: list[dict] = []  # { page, title } — citation candidates

    writer.write({"type": "meta", "level": level, "kb": str(kb_root)})

    try:
        limit = LEVEL_LIMIT.get(level, LEVEL_LIMIT["quick"])
        writer.write({"type": "search", "query": question, "round": 1})
        # quick stays single-call cheap; deep / deep-research add a listwise
        # rerank over the fused pool (ADR-0010 R2)
        is_deep = level != "quick"
        result = search_smart(
            kb_root, question, limit=limit,
            rewrite=lambda q: run_json_prompt(kb_root, "query-rewrite", {"question": q}),
            rerank=(lambda q, c: run_json_prompt(kb_root, "rerank", {"question": q, "candidates": c})) if is_deep else None,
        )
        previews = result.get("preview") if isinstance(result.get("preview"), list) else []
        parts = []
        budget = TOTAL_BUDGET
        for hit in previews[:limit]:
            writer.write({"type": "read", "page": hit["page"], "round": 1})
            hits.append({"page": hit["page"], "title": hit.get("title") or ""})
            # C3: full page body; source pages also contribute their raw evidence
            full = read_page_full(kb_root, hit["page"])
            part = f"## {hit.get('title') or hit['page']}\n{((full or {}).get('body') or hit.get('snippet') or '')[:PAGE_BUDGET]}"
            if full and full.get("source_ref"):
                raw = read_raw_evidence(kb_root, full["source_ref"])
                if raw:
                    part += f"\n\n### 原始证据({full['source_ref']})\n{raw[:RAW_BUDGET]}"
                    writer.write({"type": "read", "page": full["source_ref"], "round": 1, "kind": "raw"})
            if len(part) > budget:
                part = part[:max(budget, 0)]
            if not part:
                break
            budget -= len(part)
            parts.append(part)
        context = "\n\n---\n\n".join(parts)
    except Exception as err:  # noqa: BLE001 — retrieval failure degrades to refusal path
        writer.write({"type": "error", "message": str(err)})

    answer = ""
    # R3 (CRAG-style quality gate): zero hits means no LLM call at all — a fixed,
    # honest refusal costs nothing and can never hallucinate.
    if not hits:
        writer.write({"type": "chunk", "text": REFUSAL})
        writer.write({"type": "done", "citations": []})
        writer.end()
        return {"level": level, "tokens_in": 0, "tokens_out": 0, "refused": True}

    try:
        res = run_prompt(kb_root, "chat", {"question": question, "context": context},
                         stream=True,
                         on_delta=lambda d: writer.write({"type": "chunk", "text": d}))
        answer = res["content"] or ""
    except Exception as err:  # noqa: BLE001
        writer.write({"type": "error", "message": str(err)})

    citations = _cited(answer, hits)

    # C1 (ADR-0011): faithfulness guard for deep levels — when the answer drifts
    # from the context (judge score < 0.8), regenerate once with a stricter
    # instruction. quick keeps its single call.
    if level != "quick" and answer and hits:
        try:
            data = run_json_prompt(kb_root, "judge-faithfulness",
                                   {"context": context[:6000], "answer": answer})["data"]
            if isinstance(data.get("score"), (int, float)) and data["score"] < 0.8:
                writer.write({"type": "regenerate", "reason": f"faithfulness {data['score']}"})
                retry = run_prompt(kb_root, "chat", {
                    "question": f"{question}\n\n(只使用上下文中明确支持的陈述回答;上下文没有就说明知识库未涵盖。)",
                    "context": context,
                }, stream=True, on_delta=lambda d: writer.write({"type": "chunk", "text": d}))
                answer = retry["content"] or answer
                citations = _cited(answer, hits)
        except Exception:  # noqa: BLE001 — guard failure keeps the first answer
            pass

    done = {"type": "done", "citations": citations}
    if not citations and answer and hits:
        done["uncited_reads"] = [h["page"] for h in hits]
    writer.write(done)
    writer.end()

    return {"level": level, "tokens_in": 0, "tokens_out": 0}
