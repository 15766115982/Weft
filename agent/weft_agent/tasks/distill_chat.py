"""distill-chat — distill a portal chat transcript into a chat distillation
document body (ADR-0013 / contract §2 chat source amendment).

Input:  {"messages": [{"role": "user"|"assistant", "text": "...", "ts": "ISO"}...]}
Output: {"title", "body", "message_count"} — body = H1 title + LLM-distilled text
with [T-n] reference markers + a mechanically appended numbered transcript
appendix (the model never writes the appendix, so its fidelity is structural).

The connector and the portal validate markers against the appendix; this task's
only hard failure is an over-budget transcript — explicit error, never silent
truncation (a truncated transcript would silently break the evidence chain).
"""
import re

from ..runner import run_json_prompt

# Anchors shared with the acquisition chat connector (deliberate duplication —
# the services have no shared lib; keep the two copies in sync by hand).
APPENDIX_MARKER = "<!-- transcript-appendix -->"
APPENDIX_HEADING_ZH = "附录:对话转录"
APPENDIX_HEADING_EN = "Transcript Appendix"

MAX_TRANSCRIPT_CHARS = 30000


def _has_cjk(text: str) -> bool:
    return bool(re.search(r"[一-鿿]", text))


def _entry(idx: int, msg: dict) -> str:
    role = msg.get("role") or "user"
    ts = msg.get("ts") or "unknown-time"
    return f"### [T{idx}] {role} · {ts}\n\n{(msg.get('text') or '').strip()}"


def run(kb_root, input=None, output_path=None):
    input = input or {}
    messages = input.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("distill-chat requires a non-empty messages array")

    total = sum(len(str(m.get("text") or "")) for m in messages if isinstance(m, dict))
    if total > MAX_TRANSCRIPT_CHARS:
        raise RuntimeError(
            f"对话过长(约 {total} 字符,上限 {MAX_TRANSCRIPT_CHARS}),请先清空后分段整理。"
        )

    transcript = "\n\n".join(
        f"[T{i}] {m.get('role') or 'user'}: {(m.get('text') or '').strip()}"
        for i, m in enumerate(messages, 1)
    )
    res = run_json_prompt(kb_root, "distill-chat", {"transcript": transcript})
    data = res["data"]
    title = str(data.get("title") or "对话整理").strip()
    distilled = str(data.get("body") or "").strip()

    # The model was told not to, but if it echoed an appendix anyway, cut it —
    # the only appendix is the mechanical one below.
    cut = distilled.find(APPENDIX_MARKER)
    if cut >= 0:
        distilled = distilled[:cut].rstrip()
    # A distilled body must never carry frontmatter (the connector mints it).
    if distilled.startswith("---"):
        end = distilled.find("\n---", 3)
        if end > 0:
            distilled = distilled[end + 4:].lstrip()

    heading = APPENDIX_HEADING_ZH if _has_cjk(transcript) else APPENDIX_HEADING_EN
    appendix = "\n\n".join(_entry(i, m) for i, m in enumerate(messages, 1))
    body = (f"# {title}\n\n{distilled}\n\n"
            f"## {heading}\n{APPENDIX_MARKER}\n\n{appendix}\n")

    return {
        "task": "distill-chat",
        "title": title,
        "body": body,
        "message_count": len(messages),
    }
