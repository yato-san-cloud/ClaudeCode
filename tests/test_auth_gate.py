"""The self-hosted access gate (``whsim.web.auth`` + ``routes/login.py``).

whsim is meant to be run on the owner's PC and reached from elsewhere over a
tunnel, with real customer WMS data in ``projects/``. So the contract these
tests pin is narrow and blunt:

* with no password configured, NOTHING changes (local use, the other 865 tests);
* with one configured, every route — the SPA *and* all of ``/api`` — needs a
  session, because an unguarded ``/api/projects`` is a full data export;
* the fail-safe against publishing by accident lives at the bind site.
"""

import time

import pytest
from fastapi.testclient import TestClient

from whsim.cli import _is_loopback
from whsim.web import auth
from whsim.web.app import app

PW = "correct horse battery staple"


@pytest.fixture
def guarded(monkeypatch):
    monkeypatch.setenv("WHSIM_PASSWORD", PW)
    auth.limiter._by_ip.clear()
    # A TestClient request is plain http, so a Secure cookie would be dropped.
    monkeypatch.setenv("WHSIM_INSECURE_COOKIE", "1")
    with TestClient(app) as c:
        yield c
    auth.limiter._by_ip.clear()


@pytest.fixture
def open_app(monkeypatch):
    monkeypatch.delenv("WHSIM_PASSWORD", raising=False)
    with TestClient(app) as c:
        yield c


# --- disabled by default -----------------------------------------------------

def test_no_password_means_no_gate(open_app):
    """The default install must behave exactly as it always has."""
    assert not auth.enabled()
    assert open_app.get("/api/projects").status_code == 200
    # ...and the login page just sends you to the app.
    r = open_app.get("/login", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"


# --- the gate ----------------------------------------------------------------

def test_api_is_closed_without_a_session(guarded):
    """The whole data surface, not just the UI."""
    for path in ("/api/projects", "/api/templates", "/api/racktypes",
                 "/api/projects/demo/model", "/api/version"):
        r = guarded.get(path)
        assert r.status_code == 401, f"{path} was reachable unauthenticated"
        assert r.json()["login"] == "/login"


def test_navigation_is_redirected_to_the_login_form(guarded):
    r = guarded.get("/", headers={"accept": "text/html"}, follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].startswith("/login?next=")


def test_login_then_reach_the_data(guarded):
    r = guarded.post("/api/login", json={"password": PW})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert auth.COOKIE_NAME in r.cookies
    assert guarded.get("/api/projects").status_code == 200


def test_wrong_password_is_rejected_and_sets_nothing(guarded):
    r = guarded.post("/api/login", json={"password": "nope"})
    assert r.status_code == 401
    assert auth.COOKIE_NAME not in r.cookies
    assert guarded.get("/api/projects").status_code == 401


def test_logout_closes_the_door_again(guarded):
    guarded.post("/api/login", json={"password": PW})
    assert guarded.get("/api/projects").status_code == 200
    guarded.post("/api/logout")
    assert guarded.get("/api/projects").status_code == 401


def test_health_probe_stays_open_and_leaks_nothing(guarded):
    """The tunnel/supervisor needs a liveness check; whether a project exists is
    itself information the gate protects, so the probe must not carry any."""
    r = guarded.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_login_page_is_served_and_not_cached(guarded):
    r = guarded.get("/login")
    assert r.status_code == 200
    assert "パスワード" in r.text
    assert r.headers.get("cache-control") == "no-store"
    assert "noindex" in r.text


# --- session tokens ----------------------------------------------------------

def test_token_is_signature_checked():
    t = auth.issue_token(PW)
    assert auth.token_valid(t, PW)
    body, _, sig = t.partition(".")
    assert not auth.token_valid(f"{body}.{'A' * len(sig)}", PW)
    assert not auth.token_valid("garbage", PW)
    assert not auth.token_valid(None, PW)
    assert not auth.token_valid("", PW)


def test_changing_the_password_revokes_every_session():
    """The revocation story for a single-user deployment: rotate the password."""
    t = auth.issue_token(PW)
    assert auth.token_valid(t, PW)
    assert not auth.token_valid(t, PW + "!")


def test_expiry_is_enforced():
    now = time.time()
    t = auth.issue_token(PW, now=now)
    assert auth.token_valid(t, PW, now=now + auth.SESSION_TTL_S - 10)
    assert not auth.token_valid(t, PW, now=now + auth.SESSION_TTL_S + 10)


def test_a_forged_expiry_does_not_survive_the_signature():
    """Editing the payload must invalidate the token."""
    import base64
    import json

    t = auth.issue_token(PW)
    body, _, sig = t.partition(".")
    claims = json.loads(auth._b64d(body))
    claims["exp"] = int(time.time()) + 10_000_000
    forged = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":"), sort_keys=True).encode()
    ).decode().rstrip("=")
    assert not auth.token_valid(f"{forged}.{sig}", PW)


# --- brute-force damping -----------------------------------------------------

def test_repeated_failures_lock_the_ip_out(guarded):
    for _ in range(auth.MAX_ATTEMPTS):
        guarded.post("/api/login", json={"password": "nope"})
    r = guarded.post("/api/login", json={"password": "nope"})
    assert r.status_code == 429
    # ...and the lockout holds even against the RIGHT password, so it cannot be
    # used as an oracle.
    assert guarded.post("/api/login", json={"password": PW}).status_code == 429


def test_a_success_clears_the_tally(guarded):
    for _ in range(auth.MAX_ATTEMPTS - 1):
        guarded.post("/api/login", json={"password": "nope"})
    assert guarded.post("/api/login", json={"password": PW}).status_code == 200
    assert auth.limiter.blocked_for("testclient") == 0.0


def test_proxy_headers_are_ignored_unless_trusted(monkeypatch):
    """Otherwise anyone could dodge the lockout by rotating X-Forwarded-For."""
    class _Req:
        headers = {"x-forwarded-for": "9.9.9.9", "cf-connecting-ip": "8.8.8.8"}
        client = type("C", (), {"host": "1.2.3.4"})()

    monkeypatch.delenv("WHSIM_TRUST_PROXY", raising=False)
    assert auth.client_ip(_Req()) == "1.2.3.4"
    monkeypatch.setenv("WHSIM_TRUST_PROXY", "1")
    assert auth.client_ip(_Req()) == "8.8.8.8"


# --- open-redirect -----------------------------------------------------------

@pytest.mark.parametrize("evil", [
    "https://evil.example/steal", "//evil.example/steal", "http://evil.example",
])
def test_next_cannot_leave_this_origin(guarded, evil):
    r = guarded.post("/api/login", json={"password": PW, "next": evil})
    assert r.status_code == 200
    assert r.json()["next"] == "/"


def test_next_keeps_a_same_origin_path(guarded):
    r = guarded.post("/api/login", json={"password": PW, "next": "/?v=dashboard"})
    assert r.json()["next"] == "/?v=dashboard"


# --- the bind-site fail-safe -------------------------------------------------

@pytest.mark.parametrize("host,loopback", [
    ("127.0.0.1", True), ("localhost", True), ("::1", True), ("[::1]", True),
    ("127.5.5.5", True),
    ("0.0.0.0", False), ("192.168.1.10", False), ("example.com", False),
    ("", False), ("garbage", False),
])
def test_loopback_detection_fails_closed(host, loopback):
    """Anything unparseable must be treated as REACHABLE, so an odd value
    demands a password rather than silently publishing the data."""
    assert _is_loopback(host) is loopback


def test_serve_refuses_a_public_bind_without_a_password(monkeypatch):
    import typer

    from whsim import cli

    monkeypatch.delenv("WHSIM_PASSWORD", raising=False)
    called = {}
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: called.setdefault("ran", True))
    with pytest.raises(typer.Exit) as e:
        cli.serve(host="0.0.0.0", port=8000)
    assert e.value.exit_code == 2
    assert "ran" not in called, "the server must not start"


def test_serve_allows_a_public_bind_once_a_password_exists(monkeypatch):
    from whsim import cli

    monkeypatch.setenv("WHSIM_PASSWORD", PW)
    called = {}
    monkeypatch.setattr("uvicorn.run", lambda *a, **k: called.setdefault("ran", True))
    cli.serve(host="0.0.0.0", port=8000)
    assert called.get("ran") is True


# --- the KDF must not run per request ----------------------------------------

def test_key_derivation_is_memoised():
    """The KDF is deliberately slow, so it must run ONCE per password.

    Regression: deriving on every call put 200k PBKDF2 rounds in the path of
    EVERY request. A cold page load pulls ~80 assets, which turned into seconds
    of pure CPU and left the app sitting on its boot splash — measured, not
    theorised.
    """
    import time as _t

    auth._key_cache.clear()
    t = auth.issue_token(PW)                      # pays the derivation once
    n = 300
    start = _t.perf_counter()
    for _ in range(n):
        assert auth.token_valid(t, PW)
    per_call_ms = (_t.perf_counter() - start) / n * 1000
    assert per_call_ms < 1.0, f"{per_call_ms:.2f} ms/validation — KDF is running per request"


def test_memoisation_does_not_weaken_rotation():
    """Caching must not let a stale key validate a token after a password change."""
    auth._key_cache.clear()
    t = auth.issue_token(PW)
    assert auth.token_valid(t, PW)
    assert not auth.token_valid(t, "a different password")
    assert auth.token_valid(t, PW)                # and the original still works
