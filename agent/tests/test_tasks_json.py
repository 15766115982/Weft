"""Non-streaming task tests via the real CLI in WEFT_LLM_STUB mode."""
import json

from conftest import run_cli


def run_task(kb, task, input):
    proc = run_cli(kb, task, input=input, env={"WEFT_LLM_STUB": "1"})
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_summarize_source(kb):
    out = run_task(kb, "summarize-source", {"title": "DSCR", "source": "local", "body": "..."})
    assert out["task"] == "summarize-source"
    assert out["title"] == "DSCR"
    assert out["key_points"] == ["Stub point one.", "Stub point two."]


def test_classify_page_defaults_source(kb):
    out = run_task(kb, "classify-page", {"page_path": "wiki/sources/x.md", "title": "X", "body": "b"})
    assert out["classification"] == "source"
    assert out["confidence"] == 0.9


def test_extract_entity(kb):
    out = run_task(kb, "extract-entity", {"source_path": "raw/local/a.md", "body": "b"})
    assert out["entities"][0]["slug"] == "stub-entity"
    assert out["relations"][0]["type"] == "part-of"


def test_draft_concept(kb):
    out = run_task(kb, "draft-concept", {"slug": "my-concept", "sources": ["s1", "s2"], "related": ["r1"]})
    assert out["slug"] == "my-concept"
    assert "stub concept page" in out["body"]


def test_synthesize(kb):
    out = run_task(kb, "synthesize", {"slug": "syn", "topic": "retry", "sources": ["s1"]})
    assert out["slug"] == "syn"
    # Node parity: the stub receives the JOINED sources string, so its canned
    # `sources` is [] — and [] is a valid array, so the task returns it as-is.
    assert out["sources"] == []


def test_govern_decide_no_precedents(kb):
    out = run_task(kb, "govern-decide", {"decision_type": "approve", "context": "ctx"})
    assert out["decision"] == "candidate"
    assert out["referenced_decisions"] == []


def test_govern_decide_reads_precedents(kb):
    d = kb / ".kb" / "govern" / "decisions"
    d.mkdir(parents=True)
    (d / "d1.json").write_text(json.dumps({
        "id": "d1", "decision_type": "approve", "decision": "approved",
        "reason": "looked safe", "ts": "2026-01-01T00:00:00Z",
    }), encoding="utf-8")
    out = run_task(kb, "govern-decide", {"decision_type": "approve", "context": "ctx"})
    assert out["decision"] == "candidate"  # stub always candidates; precedents feed the prompt only


def test_semantic_check(kb):
    out = run_task(kb, "semantic-check", {"proposed": "p", "existing_pages": [{"path": "wiki/x.md", "body": "b"}]})
    assert out["conflict"] is False
    assert out["severity"] == "none"
    assert out["existing_pages"] == [{"path": "wiki/x.md", "body": "b"}]


def test_output_file_written(kb, tmp_path):
    out_file = tmp_path / "out" / "result.json"
    proc = run_cli(kb, "summarize-source", input={"title": "T", "body": "b"},
                   output_path=out_file, env={"WEFT_LLM_STUB": "1"})
    assert proc.returncode == 0, proc.stderr
    written = json.loads(out_file.read_text(encoding="utf-8"))
    assert written["task"] == "summarize-source"
    summary = json.loads(proc.stdout)
    assert summary["output"] == str(out_file)


def test_prompt_task_generic_template(kb):
    out = run_task(kb, "prompt", {"prompt_name": "govern-decide",
                                  "vars": {"decision_type": "approve", "context": "x", "precedents": ""}})
    assert out["data"]["decision"] == "candidate"
    assert out["prompt_name"] == "govern-decide"


def test_search_smart_task(kb, monkeypatch):
    import weft_agent.tasks.search_smart as sm_task
    monkeypatch.setattr(sm_task, "search_smart",
                        lambda *a, **kw: {"total": 1, "preview": [{"page": "wiki/sources/x.md"}], "via": "direct"})
    out = sm_task.run(kb_root=kb, input={"question": "q", "limit": 5})
    assert out["task"] == "search-smart"
    assert out["total"] == 1 and out["via"] == "direct"
