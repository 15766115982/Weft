"""govern-decide — governance decision with precedent few-shot context
(port of llm/lib/tasks/govern-decide.mjs).
"""
from ..decisions import decisions_by_type
from ..runner import run_json_prompt

VALID_DECISIONS = {"approved", "rejected", "candidate"}


def run(kb_root, input=None, output_path=None):
    input = input or {}
    decision_type = input.get("decision_type") or "approve"
    context = input.get("context") or ""
    precedents = decisions_by_type(kb_root, decision_type)
    if precedents:
        precedent_text = "\n".join(
            f"- id: {d.get('id')}\n  decision: {d.get('decision')}\n  reason: {d.get('reason') or '(no reason)'}"
            for d in precedents[-5:]
        )
    else:
        precedent_text = "(no precedents)"

    res = run_json_prompt(kb_root, "govern-decide", {
        "decision_type": decision_type,
        "context": context,
        "precedents": precedent_text,
    })
    data = res["data"]
    decision = data.get("decision")
    return {
        "task": "govern-decide",
        "decision_type": decision_type,
        "decision": decision if decision in VALID_DECISIONS else "candidate",
        "reason": data.get("reason") or "",
        "referenced_decisions": data.get("referenced_decisions") if isinstance(data.get("referenced_decisions"), list) else [],
    }
