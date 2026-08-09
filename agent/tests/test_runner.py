"""Runner + stub-mode tests. The WEFT_LLM_STUB canned outputs are a cross-service
contract (tests/e2e asserts on them) — pin them byte-for-byte."""
import json

import pytest

from weft_agent import runner


@pytest.fixture(autouse=True)
def stub_env(monkeypatch):
    monkeypatch.setenv("WEFT_LLM_STUB", "1")


def test_render():
    assert runner.render("a {{x}} b {{missing}}", {"x": 1}) == "a 1 b "


def test_extract_json_plain():
    assert runner.extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_fenced():
    assert runner.extract_json('```json\n{"a": 2}\n```') == {"a": 2}


def test_extract_json_prose_around():
    assert runner.extract_json('here you go: {"a": 3} hope that helps') == {"a": 3}


def test_extract_json_none():
    with pytest.raises(ValueError, match="no JSON"):
        runner.extract_json("no json here")


def test_stub_summarize_source(kb):
    res = runner.run_json_prompt(kb, "summarize-source", {"title": "T", "source": "local", "body": "b"})
    assert res["data"]["key_points"] == ["Stub point one.", "Stub point two."]
    assert res["data"]["title"] == "T"


def test_stub_govern_decide(kb):
    res = runner.run_json_prompt(kb, "govern-decide", {"decision_type": "approve", "context": "", "precedents": ""})
    assert res["data"]["decision"] == "candidate"


def test_stub_rerank_identity(kb):
    res = runner.run_json_prompt(kb, "rerank", {"question": "q", "candidates": "[0] a\n\n[1] b\n\n[2] c"})
    assert res["data"]["ranking"] == [0, 1, 2]


def test_stub_query_rewrite(kb):
    res = runner.run_json_prompt(kb, "query-rewrite", {"question": "how does retry work"})
    assert res["data"]["queries"] == ["how does retry work", "how does retry"]


def test_stub_chat_cites_first_context_page(kb):
    res = runner.run_prompt(kb, "chat", {"question": "q?", "context": "## Page One\nbody"})
    assert "[[Page One]]" in res["content"]


def test_stub_streaming_emits_full_content(kb):
    deltas = []
    res = runner.run_prompt(kb, "chat", {"question": "q", "context": ""}, stream=True,
                            on_delta=deltas.append)
    assert "".join(deltas) == res["content"]
    assert "Stub answer" in res["content"]


def test_load_model_config_validation(kb_no_config):
    with pytest.raises(RuntimeError, match="models.json not found"):
        runner.load_model_config(kb_no_config)
