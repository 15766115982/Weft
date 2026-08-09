"""govern-run — the graph-constrained governance run, streaming NDJSON (ADR-0012).

input:  { "brief": "operator standing instructions (GOVERNANCE.md + portal prompt)",
          "run_id": "portal job id (checkpoint thread)", "resume": false }
output: NDJSON frames — phase / human-list / doc / doc-error / synthesis /
        synthesis-error / synthesis-skipped / report.

WEFT_LLM_STUB mode stubs only the LLM judgments; the governance CLI calls are
real, so e2e exercises the full graph against a scratch KB deterministically.
"""
from ..checkpoints import checkpoint_saver
from ..govern_graph import build_govern_app
from ..stream import NdjsonWriter


def run(kb_root, input=None, output_path=None):
    input = input or {}
    writer = NdjsonWriter(output_path)
    brief = input.get("brief") or ""
    run_id = input.get("run_id") or "govern-run"
    writer.write({"type": "meta", "task": "govern-run", "kb": str(kb_root), "run_id": run_id})

    with checkpoint_saver(kb_root) as saver:
        app = build_govern_app(kb_root, writer.write, brief=brief, checkpointer=saver)
        cfg = {"configurable": {"thread_id": run_id}}
        if input.get("resume") is True and app.get_state(cfg).next:
            final = app.invoke(None, cfg)  # resume from checkpoint
        else:
            final = app.invoke({}, cfg)

    results = final.get("results") or []
    created = sum(1 for r in results if r.get("action") == "auto:create-source")
    updated = sum(1 for r in results if r.get("action") == "auto:update-source")
    deduped = sum(1 for r in results if r.get("action") == "auto:dedup-source")
    syntheses = final.get("syntheses") or []
    report = {
        "ok": True,
        "created": created,
        "updated": updated,
        "deduped": deduped,
        "doc_errors": final.get("doc_errors") or [],
        "syntheses": len(syntheses),
        "syntheses_candidate": sum(1 for s in syntheses if s.get("candidate")),
        "synth_errors": final.get("synth_errors") or [],
        "human_lists": final.get("plan_report") or {},
    }
    writer.write({"type": "report", **report})
    writer.end()
    return report
