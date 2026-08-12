"""chat / deep-research streaming task tests — retrieval mocked, LLM stubbed."""
import json

from conftest import run_cli


def read_ndjson(path):
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def make_wiki_page(kb, rel, title, body, source_ref=None):
    p = kb / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    fm = f"---\ntitle: {title}\n" + (f'source_ref: "{source_ref}"\n' if source_ref else "") + "---\n\n"
    p.write_text(fm + body + "\n", encoding="utf-8")


def test_chat_zero_hits_refuses_without_llm(kb, tmp_path):
    out = tmp_path / "chat.ndjson"
    proc = run_cli(kb, "chat", input={"question": "nothing matches", "level": "quick"},
                   output_path=out, env={"WEFT_LLM_STUB": "1"})
    # retrieval CLI will fail (no index) OR return zero hits — both land on refusal
    assert proc.returncode == 0, proc.stderr
    summary = json.loads(proc.stdout)
    assert summary["task"] == "chat"
    lines = read_ndjson(out)
    assert lines[0]["type"] == "meta"
    if summary.get("refused"):
        assert any(l["type"] == "chunk" and "没有与该问题相关" in l["text"] for l in lines)
        assert lines[-1]["type"] == "done" and lines[-1]["citations"] == []


def test_chat_streams_and_cites(kb, tmp_path, monkeypatch):
    make_wiki_page(kb, "wiki/sources/dscr.md", "DSCR", "DSCR = EBITDA / debt service.")
    out = tmp_path / "chat.ndjson"

    fake_result = {"total": 1, "preview": [{"page": "wiki/sources/dscr.md", "title": "DSCR", "snippet": "s"}]}
    import weft_agent.tasks.chat as chat_task
    monkeypatch.setattr(chat_task, "search_smart", lambda *a, **kw: fake_result)
    monkeypatch.setenv("WEFT_LLM_STUB", "1")

    # in-process run (monkeypatch doesn't cross subprocess boundaries)
    chat_task.run(kb_root=kb, input={"question": "what is DSCR", "level": "quick"}, output_path=out)

    lines = read_ndjson(out)
    assert lines[0] == {"type": "meta", "level": "quick", "kb": str(kb)}
    assert any(l["type"] == "read" and l["page"] == "wiki/sources/dscr.md" for l in lines)
    assert any(l["type"] == "chunk" for l in lines)
    done = lines[-1]
    assert done["type"] == "done"
    # stub answer cites the first context heading "## DSCR" via [[DSCR]]
    assert done["citations"] == ["wiki/sources/dscr.md"]


def test_chat_source_page_includes_raw_evidence(kb, tmp_path, monkeypatch):
    make_wiki_page(kb, "wiki/sources/dscr.md", "DSCR", "summary body",
                   source_ref="raw/local/dscr.md")
    raw = kb / "raw" / "local" / "dscr.md"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text("---\ntitle: raw\n---\n\nraw evidence body\n", encoding="utf-8")
    out = tmp_path / "chat.ndjson"

    import weft_agent.tasks.chat as chat_task
    monkeypatch.setattr(chat_task, "search_smart", lambda *a, **kw: {
        "total": 1, "preview": [{"page": "wiki/sources/dscr.md", "title": "DSCR", "snippet": "s"}]})
    chat_task.run(kb_root=kb, input={"question": "q", "level": "quick"}, output_path=out)

    lines = read_ndjson(out)
    assert any(l.get("kind") == "raw" and l["page"] == "raw/local/dscr.md" for l in lines)


def test_deep_research_streams_search_read_chunk_done(kb, tmp_path, monkeypatch):
    out = tmp_path / "dr.ndjson"

    def fake_loop(kb_root, question, on_event, opts, rewrite=None):
        on_event({"type": "meta", "task": "deep-research", "kb": str(kb_root), "maxRounds": 1})
        on_event({"type": "search", "query": question, "round": 1})
        on_event({"type": "read", "page": "wiki/sources/x.md", "round": 1})
        return {"context": "ctx", "citations": ["wiki/sources/x.md"], "rounds": 1}

    import weft_agent.tasks.deep_research as dr_task
    monkeypatch.setattr(dr_task, "run_research_loop", fake_loop)
    monkeypatch.setenv("WEFT_LLM_STUB", "1")
    dr_task.run(kb_root=kb, input={"question": "retry budget", "opts": {"maxRounds": 1}}, output_path=out)

    lines = read_ndjson(out)
    types = [l["type"] for l in lines]
    assert types[0] == "meta" and "search" in types and "read" in types and "chunk" in types
    assert lines[-1] == {"type": "done", "citations": ["wiki/sources/x.md"]}
