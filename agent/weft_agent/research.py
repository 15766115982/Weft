"""Internal retrieval loop used by chat and deep-research (port of llm/lib/research.mjs).
The agent service must not import retrieval code directly (service decoupling);
it spawns `kb_search.mjs` (plain node CLI) through the CLI contract.
"""
import re
from pathlib import Path

from .nodecli import run_node_cli
from .textutil import REPO_ROOT

KB_SEARCH = REPO_ROOT / "retrieval" / "scripts" / "kb_search.mjs"


def run_kb_search(kb_root: Path, args: list[str]) -> dict:
    return run_node_cli(KB_SEARCH, args, kb_root)


def search_pages(kb_root: Path, query: str, limit: int = 10) -> dict:
    return run_kb_search(kb_root, ["search", query, "--limit", str(limit)])


# Conversational questions ("retry 策略是怎么设计的?") defeat the index's
# cross-leg AND: question stopwords become CJK trigrams no page contains.
# Fallback ladder, cheapest first:
#   1. full query
#   2. query with question stopwords/punctuation stripped
#   3. each remaining term searched separately, merged by hit frequency
STOP_PHRASES = [
    "是怎么设计的", "是什么意思", "是什么", "为什么", "怎么", "怎样", "如何",
    "哪些", "哪个", "请问", "一下", "有没有", "是不是", "能不能", "可以",
    "的", "了", "吗", "呢", "吧", "啊", "呀", "嘛", "么",
]

_STRIP_PUNCT = re.compile(r"[?,!。?,!;:;:·…—\-()()【】\"'‘’]")


def strip_stopwords(query: str) -> str:
    q = f" {query} "
    for s in STOP_PHRASES:
        q = q.replace(s, " ")
    return " ".join(_STRIP_PUNCT.sub(" ", q).split())


def terms(query: str) -> list[str]:
    out: list[str] = []
    for tok in query.split():
        if re.fullmatch(r"[-0-9a-zA-Z_.]+", tok):
            if len(tok) >= 2:
                out.append(tok)
            continue
        # CJK run: 2-char terms hit the LIKE leg; slide bigrams so a long
        # stopword-stripped run still yields searchable anchors.
        if len(tok) == 2:
            out.append(tok)
            continue
        for i in range(len(tok) - 1):
            out.append(tok[i:i + 2])
    return list(dict.fromkeys(out))


def rrf_merge(lists: list[list[dict]], limit: int = 10, k: int = 60) -> list[dict]:
    """Reciprocal Rank Fusion over multiple ranked lists (ADR-0010)."""
    scores: dict[str, dict] = {}  # page -> {hit, score}
    for lst in lists:
        for rank, hit in enumerate(lst or []):
            e = scores.setdefault(hit["page"], {"hit": hit, "score": 0.0})
            e["score"] += 1 / (k + rank + 1)
    return [e["hit"] for e in sorted(scores.values(), key=lambda e: -e["score"])[:limit]]


def search_with_fallback(kb_root: Path, query: str, limit: int = 10) -> dict:
    first = search_pages(kb_root, query, limit=limit)
    if (first.get("total") or 0) > 0:
        return {**first, "relaxed": False}

    stripped = strip_stopwords(query)
    if stripped and stripped != query.strip():
        second = search_pages(kb_root, stripped, limit=limit)
        if (second.get("total") or 0) > 0:
            return {**second, "relaxed": True, "relaxed_query": stripped}

    ts = terms(stripped or query)
    if not ts:
        return first
    lanes = [(search_pages(kb_root, t, limit=limit).get("preview") or []) for t in ts]
    merged = rrf_merge(lanes, limit)
    if not merged:
        return first
    return {"query": query, "total": len(merged), "preview": merged, "relaxed": True, "relaxed_terms": ts}


def search_smart(kb_root: Path, question: str, *, limit: int = 10, min_hits: int = 2,
                 rewrite=None, rerank=None, rerank_pool: int = 20) -> dict:
    """searchSmart (ADR-0010 R1): fallback first; when hits are scarce, one LLM call
    rewrites the question into 2-3 keyword queries, each is searched, and every lane
    is fused with RRF. R2: optional listwise LLM rerank over the fused pool.
    Degrades gracefully when no model config exists or the rewrite fails.
    """
    pool = rerank_pool if rerank else limit
    direct = search_with_fallback(kb_root, question, limit=pool)
    if (direct.get("total") or 0) >= min_hits:
        result = {**direct, "via": "fallback" if direct.get("relaxed") else "direct"}
    else:
        variants: list[str] = []
        if rewrite:
            try:
                data = rewrite(question)["data"]
                variants = [q.strip() for q in (data.get("queries") or [])
                            if q.strip() and q.strip() != question][:3]
            except Exception:  # noqa: BLE001 — rewrite failure degrades to direct
                variants = []
        if not variants:
            result = {**direct, "via": "fallback" if direct.get("relaxed") else "direct"}
        else:
            lanes = [direct.get("preview") or []]
            for v in variants:
                lanes.append(search_with_fallback(kb_root, v, limit=pool).get("preview") or [])
            merged = rrf_merge(lanes, pool)
            result = ({"query": question, "total": len(merged), "preview": merged,
                       "relaxed": True, "via": "rewrite", "variants": variants}
                      if merged else {**direct, "via": "rewrite-empty"})

    # R2: optional listwise LLM rerank over the fused pool → final top-k.
    if rerank and len(result.get("preview") or []) > limit:
        pool_hits = result["preview"][:rerank_pool]
        try:
            candidates = "\n\n".join(
                f"[{i}] {h.get('title') or h.get('page')}\n{(h.get('snippet') or '')[:400]}"
                for i, h in enumerate(pool_hits)
            )
            data = rerank(question, candidates)["data"]
            order = [i for i in (data.get("ranking") or [])
                     if isinstance(i, int) and 0 <= i < len(pool_hits)]
            if order:
                seen = set(order)
                reranked = [pool_hits[i] for i in order] + [h for i, h in enumerate(pool_hits) if i not in seen]
                result = {**result, "preview": reranked[:limit], "reranked": True}
        except Exception:  # noqa: BLE001 — rerank failure keeps the fused order
            pass
    if len(result.get("preview") or []) > limit:
        result = {**result, "preview": result["preview"][:limit], "total": limit}
    return result


def read_page(kb_root: Path, page_path: str) -> dict:
    return run_kb_search(kb_root, ["read", page_path])


def run_research_loop(kb_root: Path, question: str, on_event, opts: dict | None = None) -> dict:
    """Multi-round research loop. Rounds are capped; each round searches, reads top
    pages, and appends findings. on_event receives dicts the caller writes to NDJSON.
    """
    opts = opts or {}
    max_rounds = opts.get("maxRounds") or 3
    hits_per_round = opts.get("hitsPerRound") or 5
    read_top = opts.get("readTop") or 3
    seen: set[str] = set()
    citations: list[str] = []
    findings: list[dict] = []

    on_event({"type": "meta", "task": "deep-research", "kb": str(kb_root), "maxRounds": max_rounds})

    for rnd in range(1, max_rounds + 1):
        on_event({"type": "search", "query": question, "round": rnd})
        search_result = search_pages(kb_root, question, limit=hits_per_round)
        hits = search_result.get("preview") if isinstance(search_result.get("preview"), list) else []
        if not hits:
            break

        to_read = [h for h in hits[:read_top] if h["page"] not in seen]
        if not to_read:
            break

        for hit in to_read:
            seen.add(hit["page"])
            on_event({"type": "read", "page": hit["page"], "round": rnd})
            try:
                body = read_page(kb_root, hit["page"])
                findings.append({"path": hit["page"], "title": hit.get("title") or hit["page"],
                                 "snippet": hit.get("snippet") or "", "body": body})
                if hit["page"] not in citations:
                    citations.append(hit["page"])
            except Exception as err:  # noqa: BLE001 — per-page failure degrades in place
                on_event({"type": "error", "page": hit["page"], "round": rnd, "error": str(err)})

    context = "\n\n---\n\n".join(f"## {f['title']} ({f['path']})\n{f['body']}" for f in findings)
    return {"rounds": max_rounds, "findings": findings, "context": context, "citations": citations}
