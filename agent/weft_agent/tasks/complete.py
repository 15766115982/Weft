"""complete — one-shot free-form prompt → text (agent-service extension task,
ADR-0012: backs the portal's judge backend and other single-call consumers).
Not a template prompt: the caller owns the full prompt text.
"""
import os

from ..client import chat_completion
from ..runner import SYSTEM_MESSAGE, load_model_config


def run(kb_root, input=None, output_path=None):
    input = input or {}
    prompt = input.get("prompt") or ""
    if not prompt.strip():
        raise ValueError("complete requires input.prompt")
    system = input.get("system") or SYSTEM_MESSAGE

    if os.environ.get("WEFT_LLM_STUB"):
        return {"task": "complete", "text": "[]"}  # judge-shaped callers parse a JSON array

    config = load_model_config(kb_root)
    defaults = config.get("defaults") or {}
    res = chat_completion(
        config,
        [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        max_tokens=input.get("max_tokens") or defaults.get("max_tokens"),
    )
    text = ((res.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return {"task": "complete", "text": text}
