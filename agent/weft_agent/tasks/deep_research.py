"""deep-research — multi-round retrieval + synthesis, streaming NDJSON
(port of llm/lib/tasks/deep-research.mjs).
"""
from ..research import run_research_loop
from ..runner import run_prompt
from ..stream import NdjsonWriter


def run(kb_root, input=None, output_path=None):
    input = input or {}
    writer = NdjsonWriter(output_path)
    question = input.get("question") or ""
    opts = input.get("opts") or {}

    context = ""
    citations: list[str] = []
    try:
        result = run_research_loop(kb_root, question, on_event=writer.write, opts=opts)
        context = result["context"]
        citations = result["citations"]
    except Exception as err:  # noqa: BLE001
        writer.write({"type": "error", "message": str(err)})

    try:
        run_prompt(kb_root, "deep-research", {"question": question, "context": context},
                   stream=True, on_delta=lambda d: writer.write({"type": "chunk", "text": d}))
    except Exception as err:  # noqa: BLE001
        writer.write({"type": "error", "message": str(err)})

    writer.write({"type": "done", "citations": citations})
    writer.end()

    return {"rounds": opts.get("maxRounds") or 3, "tokens_in": 0, "tokens_out": 0}
