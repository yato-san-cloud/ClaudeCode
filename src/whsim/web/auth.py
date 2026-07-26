"""Single-password gate for a self-hosted whsim.

whsim is meant to run on ONE machine (the owner's PC) and be reached from
elsewhere (a company laptop) over a tunnel. That means the whole surface --
including every ``/api/*`` route -- has to sit behind something, because the
project data is real customer WMS material: layouts, shipment histories, cost
assumptions. An unguarded ``/api/projects`` is a full export of that.

Design constraints this file answers to:

* **No new dependencies.** Signing is ``hmac``/``hashlib``, randomness is
  ``secrets``. There is no user table, no OAuth, no third-party identity
  provider -- the data never leaves the host and no account is registered
  anywhere.
* **Stateless sessions.** The cookie carries its own expiry and an HMAC over it,
  keyed by material derived from the password. Restarting the server keeps
  sessions valid; CHANGING the password invalidates every one of them, which is
  the revocation story you actually want for a single-user deployment.
* **Off unless configured.** With no password set the gate is inert, so local
  use and the test-suite behave exactly as before. The fail-safe lives at the
  bind site instead: ``whsim serve`` refuses to listen on a non-loopback address
  without a password (see ``cli.serve``), so you cannot expose this by accident.

Threat model, stated plainly: this stops the internet at large from reading or
deleting your projects. It is NOT multi-user isolation, and anyone holding the
password holds everything. That is the right trade for one person self-hosting
their own work; it would be the wrong trade for a shared service.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass, field

# Cookie carrying the signed session. Host-only (no Domain attribute) so a
# tunnel hostname cannot hand it to a sibling subdomain.
COOKIE_NAME = "whsim_session"

# How long a login lasts. Long enough not to nag someone using this all day,
# short enough that a forgotten session on a borrowed machine expires.
SESSION_TTL_S = 14 * 24 * 3600

# Key derivation. The salt is a constant: the secret input is the password, and
# a per-install random salt would have to be persisted somewhere, which buys
# nothing here (the password is already the only secret).
_KDF_SALT = b"whsim-session-key-v1"
_KDF_ROUNDS = 200_000

# Brute-force damping. A tunnel exposes the login form to the whole internet, so
# a wrong password has to cost something. Per-IP, in memory, no dependency.
MAX_ATTEMPTS = 8
LOCKOUT_S = 300.0

# Paths reachable WITHOUT a session: the login form itself, the endpoint that
# processes it, and a liveness probe for the tunnel/supervisor. Everything else
# — including all of /api — requires one.
_OPEN_PATHS = frozenset({"/login", "/api/login", "/api/logout", "/healthz", "/favicon.ico"})


def configured_password() -> str | None:
    """The configured password, or ``None`` when the gate is disabled."""
    pw = os.environ.get("WHSIM_PASSWORD")
    if pw is None:
        return None
    pw = pw.strip()
    return pw or None


def enabled() -> bool:
    return configured_password() is not None


#: Memoised key derivation. The KDF is deliberately slow (that is its job), so
#: it must run ONCE per password, not once per request: every page load pulls
#: ~80 assets, and deriving on each of them added seconds of pure CPU to a cold
#: load. Bounded to one entry because there is exactly one password.
_key_cache: dict[str, bytes] = {}


def _signing_key(password: str) -> bytes:
    """Derive the cookie-signing key from the password (memoised).

    Deterministic, so sessions survive a restart; password-bound, so changing
    the password revokes every outstanding session.
    """
    key = _key_cache.get(password)
    if key is None:
        key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _KDF_SALT, _KDF_ROUNDS)
        _key_cache.clear()          # only ever one live password
        _key_cache[password] = key
    return key


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(txt: str) -> bytes:
    pad = "=" * (-len(txt) % 4)
    return base64.urlsafe_b64decode(txt + pad)


def issue_token(password: str, now: float | None = None) -> str:
    """A signed session token: ``<payload>.<hmac>``."""
    now = time.time() if now is None else now
    payload = json.dumps({"exp": int(now + SESSION_TTL_S), "jti": secrets.token_hex(8)},
                         separators=(",", ":"), sort_keys=True).encode("utf-8")
    body = _b64e(payload)
    sig = hmac.new(_signing_key(password), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_b64e(sig)}"


def token_valid(token: str | None, password: str, now: float | None = None) -> bool:
    """Constant-time signature check, then expiry. Never raises."""
    if not token or "." not in token:
        return False
    body, _, sig = token.partition(".")
    try:
        expected = hmac.new(_signing_key(password), body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(_b64d(sig), expected):
            return False
        claims = json.loads(_b64d(body))
    except Exception:      # noqa: BLE001 — any malformed token is simply invalid
        return False
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return (time.time() if now is None else now) < exp


@dataclass
class _Attempts:
    """Per-IP failed-login bookkeeping."""

    count: int = 0
    until: float = 0.0


@dataclass
class LoginLimiter:
    """In-memory, per-IP lockout after repeated failures.

    Deliberately tiny: one process, one user. The map is pruned on write so a
    stream of forged client IPs cannot grow it without bound.
    """

    _by_ip: dict[str, _Attempts] = field(default_factory=dict)

    def _prune(self, now: float) -> None:
        if len(self._by_ip) < 1024:
            return
        for ip in [k for k, v in self._by_ip.items() if v.until < now and v.count == 0]:
            self._by_ip.pop(ip, None)

    def blocked_for(self, ip: str, now: float | None = None) -> float:
        """Seconds remaining in this IP's lockout (0.0 when it may try)."""
        now = time.time() if now is None else now
        a = self._by_ip.get(ip)
        if a is None or a.until <= now:
            return 0.0
        return a.until - now

    def record_failure(self, ip: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._prune(now)
        a = self._by_ip.setdefault(ip, _Attempts())
        if a.until and a.until <= now:      # a lapsed lockout starts a fresh tally
            a.count = 0
        a.count += 1
        if a.count >= MAX_ATTEMPTS:
            a.until = now + LOCKOUT_S
            a.count = 0

    def record_success(self, ip: str) -> None:
        self._by_ip.pop(ip, None)


limiter = LoginLimiter()


def client_ip(request) -> str:
    """Best-effort client address.

    Behind Cloudflare Tunnel the peer is the local ``cloudflared``, so the real
    address arrives in a header. Only trusted when whsim is told it sits behind
    a proxy -- otherwise anyone could spoof the header and dodge the lockout by
    rotating it.
    """
    if os.environ.get("WHSIM_TRUST_PROXY") == "1":
        for h in ("cf-connecting-ip", "x-real-ip"):
            v = request.headers.get(h)
            if v:
                return v.split(",")[0].strip()
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return getattr(getattr(request, "client", None), "host", None) or "-"


def secure_cookies() -> bool:
    """Whether to set the ``Secure`` flag.

    A tunnel terminates TLS, so the hop whsim sees is plain HTTP; the browser's
    connection is still HTTPS. Default ON (the intended deployment) and allow it
    off for plain-HTTP LAN use, where a Secure cookie would simply never be sent.
    """
    return os.environ.get("WHSIM_INSECURE_COOKIE") != "1"


def is_open_path(path: str) -> bool:
    """Paths served without a session (login form + its assets + health)."""
    return path in _OPEN_PATHS or path.startswith("/static/login")
