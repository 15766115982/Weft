"""prompt — generic template JSON prompt runner.
Eval suites (chat-eval judges) drive template prompts by name with variables;
this task exposes run_json_prompt over the CLI contract.
input: {prompt_name, vars} → output {prompt_name, data, raw}
"""
from ..runner import run_json_prompt


def run(kb_root, input=None, output_path=None):
    input = input or {}
    name = input.get("prompt_name") or ""
    if not name.strip():
        raise ValueError("prompt requires input.prompt_name")
    res = run_json_prompt(kb_root, name, input.get("vars") or {})
    return {"task": "prompt", "prompt_name": name, "data": res["data"], "raw": res["raw"]}
