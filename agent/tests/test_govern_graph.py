"""Govern graph tests — stub LLM, REAL governance CLI against a scratch KB."""
import json

import pytest

from conftest import run_cli


def make_raw(kb, name, source_id, title, body, version="2026-08-01T00:00:00Z"):
    p = kb / "raw" / "local" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"""---
source: local
source_id: "{source_id}"
source_url: "file:///fixture/{name}"
source_version: "{version}"
pulled_at: "2026-08-08T00:00:00Z"
title: {title}
connector: local@1.0.0
---

{body}
""", encoding="utf-8")


@pytest.fixture()
def gov_kb(kb_no_config):
    kb = kb_no_config
    make_raw(kb, "doc-one.md", "aaaa1111", "Doc One", "Alpha body about retry budgets.")
    make_raw(kb, "doc-two.md", "bbbb2222", "Doc Two", "Beta body about retry budgets too.")
    return kb


def run_govern_run(kb, run_id="test-run", extra_env=None):
    out = kb / ".kb" / "govern-run.ndjson"
    proc = run_cli(kb, "govern-run", input={"run_id": run_id}, output_path=out,
                   env={"WEFT_LLM_STUB": "1", **(extra_env or {})})
    assert proc.returncode == 0, proc.stderr
    lines = [json.loads(l) for l in out.read_text(encoding="utf-8").splitlines() if l.strip()]
    return json.loads(proc.stdout), lines


def test_govern_run_creates_source_pages(gov_kb):
    summary, lines = run_govern_run(gov_kb)
    assert summary["created"] == 2
    assert summary["doc_errors"] == []
    # real CLI wrote real pages
    pages = sorted((gov_kb / "wiki" / "sources").glob("*.md"))
    assert len(pages) == 2
    text = pages[0].read_text(encoding="utf-8")
    assert "status: approved" in text
    assert "Stub point one." in text  # stub summary body landed
    # index rebuilt
    assert (gov_kb / "wiki" / "index.md").exists()
    # NDJSON contract
    types = [l["type"] for l in lines]
    assert types[0] == "meta" and "phase" in types and "doc" in types and types[-1] == "report"
    # one synthesis cluster: both stub docs share "stub-topic"
    assert summary["syntheses"] == 1
    syn = gov_kb / "wiki" / "syntheses" / "stub-topic.md"
    assert syn.exists()
    assert "raw/local/doc-one.md" in syn.read_text(encoding="utf-8")


def test_govern_run_idempotent_second_run(gov_kb):
    run_govern_run(gov_kb, run_id="r1")
    summary, _ = run_govern_run(gov_kb, run_id="r2")
    assert summary["created"] == 0 and summary["updated"] == 0
    assert summary["doc_errors"] == []


def test_govern_run_doc_fault_isolation(gov_kb):
    # a raw missing required contract fields lands in plan.errors, not pending —
    # but a raw whose file vanishes mid-run would hit doc-error. Simulate by an
    # empty-body raw: the stub returns a body, so instead corrupt one raw's
    # frontmatter source_id (illegal chars) → plan errors list, reported not fatal.
    bad = gov_kb / "raw" / "local" / "bad.md"
    bad.write_text("---\nsource: local\ntitle: Bad\n---\n\nno contract fields\n", encoding="utf-8")
    summary, lines = run_govern_run(gov_kb, run_id="r3")
    assert summary["created"] == 2
    human = [l for l in lines if l["type"] == "human-list" and l["name"] == "errors"]
    assert human and human[0]["count"] == 1


def test_govern_run_crash_and_resume(gov_kb, monkeypatch):
    """Cross-process resume: stop before the synthesis node (interrupt_before —
    the same mechanism a crashed run leaves behind: a checkpoint with pending
    next nodes), then a fresh app instance resumes with invoke(None). A hard
    process kill mid-queue loses at most the in-flight doc: doc-level faults
    are data (doc_errors), not crashes, by design."""
    import weft_agent.govern_graph as gg
    from weft_agent.checkpoints import checkpoint_saver

    monkeypatch.setenv("WEFT_LLM_STUB", "1")
    events = []
    cfg = {"configurable": {"thread_id": "crash-t"}}

    with checkpoint_saver(gov_kb) as saver:
        app = gg.build_govern_app(gov_kb, events.append, checkpointer=saver)
        app.invoke({}, cfg, interrupt_before=["synthesize"])
        mid = app.get_state(cfg)
        assert mid.next == ("synthesize",)
        assert len(mid.values.get("results") or []) == 2  # both docs applied

    # fresh process shape: new saver + new app, same thread_id
    with checkpoint_saver(gov_kb) as saver:
        app2 = gg.build_govern_app(gov_kb, events.append, checkpointer=saver)
        state = app2.get_state(cfg)
        assert state.next == ("synthesize",), "checkpoint survived the process boundary"
        final = app2.invoke(None, cfg)

    assert not final.get("doc_errors")
    assert len(final["results"]) == 2
    assert (gov_kb / "wiki" / "syntheses" / "stub-topic.md").exists()
    assert (gov_kb / "wiki" / "index.md").exists()
    pages = list((gov_kb / "wiki" / "sources").glob("*.md"))
    assert len(pages) == 2
