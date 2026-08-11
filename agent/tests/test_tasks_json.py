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


MESSAGES = [
    {"role": "user", "text": "重试策略是什么?", "ts": "2026-08-11T10:00:00+08:00"},
    {"role": "assistant", "text": "指数退避,见 [[retry-policy]]。", "ts": "2026-08-11T10:00:05+08:00"},
]


def test_distill_chat(kb):
    out = run_task(kb, "distill-chat", {"messages": MESSAGES})
    assert out["task"] == "distill-chat"
    assert out["message_count"] == 2
    body = out["body"]
    assert body.startswith("# Stub 对话整理\n")
    # mechanical appendix: marker + one entry per message, in order
    assert "<!-- transcript-appendix -->" in body
    assert "### [T1] user · 2026-08-11T10:00:00+08:00" in body
    assert "### [T2] assistant · 2026-08-11T10:00:05+08:00" in body
    assert body.index("[T1]") < body.index("<!-- transcript-appendix -->")  # distilled cites first
    # CJK conversation → Chinese appendix heading
    assert "## 附录:对话转录" in body


def test_distill_chat_english_heading(kb):
    msgs = [{"role": "user", "text": "What is the retry policy?"}]
    out = run_task(kb, "distill-chat", {"messages": msgs})
    assert "## Transcript Appendix" in out["body"]
    assert "### [T1] user · unknown-time" in out["body"]  # missing ts degrades, not crashes


def test_distill_chat_rejects_empty(kb):
    proc = run_cli(kb, "distill-chat", input={"messages": []}, env={"WEFT_LLM_STUB": "1"})
    assert proc.returncode == 1
    assert "messages" in json.loads(proc.stderr)["error"]


def test_distill_chat_rejects_over_budget(kb):
    msgs = [{"role": "user", "text": "x" * 30001}]
    proc = run_cli(kb, "distill-chat", input={"messages": msgs}, env={"WEFT_LLM_STUB": "1"})
    assert proc.returncode == 1
    assert "对话过长" in json.loads(proc.stderr)["error"]


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
