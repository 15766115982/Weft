import httpx
import pytest

from weft_agent import client


def cfg(provider="openai", **over):
    base = {
        "provider": provider,
        "endpoint": "http://llm.test",
        "model": "m-1",
        "deployment": "dep-1",
        "auth": {"type": "api_key", "api_key": "WEFT_TEST_KEY"},
    }
    base.update(over)
    return base


@pytest.fixture(autouse=True)
def test_key(monkeypatch):
    monkeypatch.setenv("WEFT_TEST_KEY", "sk-test")


def mock_http(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_endpoint_openai():
    assert client.build_endpoint(cfg()) == "http://llm.test/chat/completions"


def test_endpoint_azure():
    url = client.build_endpoint(cfg("azure"))
    assert url == ("http://llm.test/openai/deployments/dep-1/chat/completions"
                   "?api-version=2025-01-01-preview")


def test_endpoint_requires_base():
    with pytest.raises(ValueError, match="endpoint"):
        client.build_endpoint({"provider": "openai", "endpoint": ""})


def test_auth_header_openai_bearer():
    assert client.get_auth_header(cfg()) == {"Authorization": "Bearer sk-test"}


def test_auth_header_azure_api_key():
    assert client.get_auth_header(cfg("azure")) == {"api-key": "sk-test"}


def test_auth_header_missing_env(monkeypatch):
    monkeypatch.delenv("WEFT_TEST_KEY")
    with pytest.raises(RuntimeError, match="env var not set"):
        client.get_auth_header(cfg())


def test_chat_completion_non_stream():
    def handler(request):
        assert request.headers["Authorization"] == "Bearer sk-test"
        body = __import__("json").loads(request.content)
        assert body["model"] == "m-1"
        return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})

    out = client.chat_completion(cfg(), [{"role": "user", "content": "x"}],
                                 http=mock_http(handler))
    assert out["choices"][0]["message"]["content"] == "hi"


def test_chat_completion_retries_on_500(monkeypatch):
    monkeypatch.setattr(client, "DEFAULT_BACKOFF_S", [0, 0, 0])  # no sleeping in tests
    attempts = []

    def handler(request):
        attempts.append(1)
        if len(attempts) < 2:
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    out = client.chat_completion(cfg(), [], http=mock_http(handler))
    assert out["choices"][0]["message"]["content"] == "ok"
    assert len(attempts) == 2


def test_chat_completion_stream_deltas():
    sse = (
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request):
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    deltas = list(client.chat_completion(cfg(), [], stream=True, http=mock_http(handler)))
    assert deltas == ["he", "llo"]


def test_azure_body_has_no_model():
    def handler(request):
        body = __import__("json").loads(request.content)
        assert "model" not in body
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    client.chat_completion(cfg("azure"), [], http=mock_http(handler))
