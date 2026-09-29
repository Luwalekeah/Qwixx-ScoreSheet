"""SupabaseStore against a real local HTTP server that stands in for Supabase's REST API."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import streamlit as st

import persistence
from persistence import StoreError, SupabaseStore, get_store

GAME_ID = "0b8f3c1e-6f5d-4d43-9d1c-2f0f5a4b7e11"
JWT_KEY = "eyJhbGciOiJIUzI1NiJ9.e30.secret-signature"
PUBLISHABLE_KEY = "sb_publishable_abc123"


class FakeSupabase:
    """Records requests; the test decides what each call returns."""

    def __init__(self):
        self.requests = []
        self.response = (200, b"null")
        self.delay = 0

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
                if outer.delay:
                    time.sleep(outer.delay)
                status, payload = outer.response
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        class QuietServer(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                pass  # a client that gave up (the timeout test) is expected, not noteworthy

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def supabase():
    fake = FakeSupabase()
    yield fake
    fake.close()


def test_save_calls_the_save_game_function(supabase):
    SupabaseStore(supabase.url, JWT_KEY).save("quiddler", GAME_ID, {"v": 1, "players": ["A", "B"]})
    (req,) = supabase.requests
    assert req["path"] == "/rest/v1/rpc/save_game"
    assert req["body"] == {"p_app": "quiddler", "p_id": GAME_ID, "p_state": {"v": 1, "players": ["A", "B"]}}


def test_save_accepts_204_no_content_for_void_functions(supabase):
    supabase.response = (204, b"")
    SupabaseStore(supabase.url, JWT_KEY).save("quiddler", GAME_ID, {"v": 1})  # must not raise


def test_load_returns_the_saved_state(supabase):
    supabase.response = (200, json.dumps({"v": 1, "rounds": 5}).encode())
    state = SupabaseStore(supabase.url, JWT_KEY).load("quiddler", GAME_ID)
    assert state == {"v": 1, "rounds": 5}
    (req,) = supabase.requests
    assert req["path"] == "/rest/v1/rpc/load_game"
    assert req["body"] == {"p_app": "quiddler", "p_id": GAME_ID}


@pytest.mark.parametrize("body", [b"null", b"[1, 2]", b'"text"', b"42"])
def test_load_of_a_missing_or_non_object_result_is_none(supabase, body):
    supabase.response = (200, body)
    assert SupabaseStore(supabase.url, JWT_KEY).load("quiddler", GAME_ID) is None


def test_jwt_keys_are_sent_as_apikey_and_bearer(supabase):
    SupabaseStore(supabase.url, JWT_KEY).load("quiddler", GAME_ID)
    headers = {k.lower(): v for k, v in supabase.requests[0]["headers"].items()}
    assert headers["apikey"] == JWT_KEY
    assert headers["authorization"] == f"Bearer {JWT_KEY}"


def test_publishable_keys_are_sent_as_apikey_only(supabase):
    SupabaseStore(supabase.url, PUBLISHABLE_KEY).load("quiddler", GAME_ID)
    headers = {k.lower(): v for k, v in supabase.requests[0]["headers"].items()}
    assert headers["apikey"] == PUBLISHABLE_KEY
    assert "authorization" not in headers


@pytest.mark.parametrize("status", [400, 401, 404, 500, 503])
def test_http_errors_become_store_errors_without_leaking_secrets(supabase, status):
    supabase.response = (status, b'{"message": "nope"}')
    with pytest.raises(StoreError) as info:
        SupabaseStore(supabase.url, JWT_KEY).load("quiddler", GAME_ID)
    text = str(info.value)
    assert str(status) in text
    assert JWT_KEY not in text and supabase.url not in text


def test_invalid_json_is_a_store_error(supabase):
    supabase.response = (200, b"<html>gateway</html>")
    with pytest.raises(StoreError, match="not JSON"):
        SupabaseStore(supabase.url, JWT_KEY).load("quiddler", GAME_ID)


def test_unreachable_server_is_a_store_error(supabase):
    url = supabase.url
    supabase.close()
    with pytest.raises(StoreError, match="ConnectionError"):
        SupabaseStore(url, JWT_KEY).save("quiddler", GAME_ID, {"v": 1})


def test_a_slow_server_times_out_instead_of_hanging_the_app(supabase, monkeypatch):
    monkeypatch.setattr(persistence, "REQUEST_TIMEOUT_SECONDS", 0.2)
    supabase.delay = 1.5
    started = time.monotonic()
    with pytest.raises(StoreError, match="Timeout"):
        SupabaseStore(supabase.url, JWT_KEY).save("quiddler", GAME_ID, {"v": 1})
    assert time.monotonic() - started < 1.2


def test_oversized_state_is_refused_before_any_request(supabase):
    with pytest.raises(StoreError, match="too large"):
        SupabaseStore(supabase.url, JWT_KEY).save("quiddler", GAME_ID, {"blob": "x" * 20_000})
    assert supabase.requests == []


# --- configuration -------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_config(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    monkeypatch.setattr(st, "secrets", {})


def test_persistence_is_off_by_default():
    assert get_store() is None


def test_both_url_and_key_are_required(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
    assert get_store() is None


def test_configured_from_environment(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://abc.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", JWT_KEY)
    assert isinstance(get_store(), SupabaseStore)


def test_configured_from_streamlit_secrets(monkeypatch):
    monkeypatch.setattr(st, "secrets", {"SUPABASE_URL": "https://abc.supabase.co", "SUPABASE_KEY": PUBLISHABLE_KEY})
    assert isinstance(get_store(), SupabaseStore)


def test_a_missing_secrets_file_is_not_an_error(monkeypatch):
    class NoSecretsFile:
        def get(self, name):
            raise FileNotFoundError("no secrets.toml")

    monkeypatch.setattr(st, "secrets", NoSecretsFile())
    assert get_store() is None


@pytest.mark.parametrize("url", ["http://abc.supabase.co", "ftp://abc.supabase.co", "abc.supabase.co", "http://localhost.evil.example"])
def test_plain_http_to_a_remote_host_is_refused(monkeypatch, url):
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_KEY", JWT_KEY)
    assert get_store() is None


@pytest.mark.parametrize("url", ["http://localhost:54321", "http://127.0.0.1:54321"])
def test_plain_http_is_allowed_for_local_development(monkeypatch, url):
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_KEY", JWT_KEY)
    assert isinstance(get_store(), SupabaseStore)
