"""Research-layer unit tests: fallback ladder, RRF, searchSmart rewrite/rerank."""
from weft_agent import research


def test_strip_stopwords():
    assert research.strip_stopwords("retry 策略是怎么设计的?") == "retry 策略"
    # Node parity: only phrases in STOP_PHRASES are stripped ("什么是" is NOT
    # one of them — "是什么" is); stray 的/了/吗 particles are.
    assert research.strip_stopwords("DSCR 是什么") == "DSCR"
    assert research.strip_stopwords("DSCR 的意义是什么") == "DSCR 意义"


def test_terms_cjk_bigrams_and_latin():
    ts = research.terms("retry 重试几次")
    assert "retry" in ts
    assert "重试" in ts and "试几" in ts and "几次" in ts


def test_rrf_merge():
    a = [{"page": "p1"}, {"page": "p2"}]
    b = [{"page": "p2"}, {"page": "p3"}]
    merged = research.rrf_merge([a, b], limit=10)
    assert merged[0]["page"] == "p2"  # present in both lanes → highest RRF score
    assert [h["page"] for h in merged] == ["p2", "p1", "p3"]


def _fake_search(responses):
    """responses: list of dicts returned on successive search_pages calls."""
    calls = []

    def fake(kb, query, limit=10):
        calls.append(query)
        return responses[min(len(calls) - 1, len(responses) - 1)]
    return fake, calls


def test_fallback_direct_hit(kb, monkeypatch):
    fake, calls = _fake_search([{"total": 3, "preview": [{"page": "p1"}]}])
    monkeypatch.setattr(research, "search_pages", fake)
    out = research.search_with_fallback(kb, "dscr")
    assert out["relaxed"] is False
    assert calls == ["dscr"]


def test_fallback_strips_stopwords(kb, monkeypatch):
    fake, calls = _fake_search([
        {"total": 0, "preview": []},
        {"total": 2, "preview": [{"page": "p1"}]},
    ])
    monkeypatch.setattr(research, "search_pages", fake)
    out = research.search_with_fallback(kb, "DSCR 是什么")
    assert out["relaxed"] is True
    assert out["relaxed_query"] == "DSCR"
    assert calls == ["DSCR 是什么", "DSCR"]


def test_fallback_term_lanes_rrf(kb, monkeypatch):
    def fake(kb, query, limit=10):
        if query == "retry budget":
            return {"total": 0, "preview": []}
        return {"total": 1, "preview": [{"page": f"page-of-{query}"}]}
    monkeypatch.setattr(research, "search_pages", fake)
    out = research.search_with_fallback(kb, "retry budget")
    assert out["relaxed"] is True
    assert set(out["relaxed_terms"]) == {"retry", "budget"}
    assert out["total"] == 2


def test_search_smart_direct_enough_hits(kb, monkeypatch):
    monkeypatch.setattr(research, "search_pages", _fake_search([{"total": 5, "preview": [{"page": "p"}]}])[0])
    out = research.search_smart(kb, "q", rewrite=lambda q: {"data": {"queries": ["x"]}})
    assert out["via"] == "direct"


def test_search_smart_rewrite_fuses_lanes(kb, monkeypatch):
    def fake(kb, query, limit=10):
        if query == "question":
            return {"total": 0, "preview": [{"page": "direct"}]}
        return {"total": 1, "preview": [{"page": f"via-{query}"}]}
    monkeypatch.setattr(research, "search_pages", fake)
    out = research.search_smart(kb, "question",
                                rewrite=lambda q: {"data": {"queries": ["v1", "v2"]}})
    assert out["via"] == "rewrite"
    assert out["variants"] == ["v1", "v2"]
    assert {h["page"] for h in out["preview"]} == {"direct", "via-v1", "via-v2"}


def test_search_smart_rewrite_failure_degrades(kb, monkeypatch):
    monkeypatch.setattr(research, "search_pages", _fake_search([{"total": 0, "preview": []}])[0])

    def boom(q):
        raise RuntimeError("no model")
    out = research.search_smart(kb, "q", rewrite=boom)
    assert out["via"] == "direct"


def test_search_smart_rerank_reorders(kb, monkeypatch):
    previews = [{"page": f"p{i}", "title": f"t{i}", "snippet": "s"} for i in range(5)]
    monkeypatch.setattr(research, "search_pages", _fake_search([{"total": 5, "preview": previews}])[0])
    out = research.search_smart(
        kb, "q", limit=2,
        rerank=lambda q, c: {"data": {"ranking": [3, 1]}},
    )
    assert out.get("reranked") is True
    assert [h["page"] for h in out["preview"]] == ["p3", "p1"]
    # Node parity: the final total fix-up only fires when preview is LONGER than
    # limit; after rerank preview == limit, so total keeps the pool count.
    assert out["total"] == 5
