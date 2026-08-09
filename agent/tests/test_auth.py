import json

import pytest

from weft_agent import auth


@pytest.fixture(autouse=True)
def clear_cache():
    auth._cache.clear()
    yield
    auth._cache.clear()


def ok_post(payload=None):
    def post(url, body):
        return 200, json.dumps(payload or {"access_token": "tok-1", "expires_in": 3600})
    return post


def test_spn_token_fetch():
    assert auth.fetch_spn_token("t", "c", "s", http_post=ok_post()) == "tok-1"


def test_spn_token_cached():
    calls = []

    def post(url, body):
        calls.append(url)
        return 200, json.dumps({"access_token": "tok-c", "expires_in": 3600})

    auth.fetch_spn_token("t", "c", "s", http_post=post)
    auth.fetch_spn_token("t", "c", "s", http_post=post)
    assert len(calls) == 1


def test_spn_missing_fields():
    with pytest.raises(ValueError, match="tenant_id"):
        auth.fetch_spn_token("", "c", "s", http_post=ok_post())


def test_spn_http_error():
    with pytest.raises(RuntimeError, match="\\(400\\)"):
        auth.fetch_spn_token("t", "c", "s", http_post=lambda u, b: (400, "bad request"))


def test_spn_missing_access_token():
    with pytest.raises(RuntimeError, match="access_token"):
        auth.fetch_spn_token("t", "c", "s", http_post=ok_post({"expires_in": 1}))
