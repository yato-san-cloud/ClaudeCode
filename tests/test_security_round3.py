"""Round-3 security-hardening regression tests for the whsim web product.

These prove the fixes for issues found in the round-3 security review:

  1. ``_safe_name`` now canonicalises to the SAME path segment ``Project`` uses,
     so path-building endpoints (delete/rename/duplicate/compare-png) can never
     point at a different (or escaping) directory than the one a project was
     stored under, and traversal attempts return 4xx without touching the FS
     outside the workspace.
  2. A deeply-nested ("recursion bomb") JSON member in an uploaded ZIP -- or a
     distance-matrix upload -- no longer escapes the tolerant parser as a
     ``RecursionError`` (which would 500 the import / leak a stack trace). It is
     skipped with a warning; the import still succeeds.
  3. The Cody chat seam caps message length so a giant body can't pin CPU.
  4. Oversized uploads are rejected with 413, not OOM.

All HTTP tests use TestClient with PROJECTS_DIR monkeypatched into a tmp dir, so
the real workspace is never touched (same pattern as the other web rounds).
"""

import io
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from whsim.web.app import app

webapp = sys.modules["whsim.web.app"]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import whsim.project as project_mod
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(project_mod, "PROJECTS_DIR", Path("projects"))
    return TestClient(app, raise_server_exceptions=False)


def _make(client, name="proj1", template="ecommerce_small"):
    r = client.post("/api/projects", json={"name": name, "template": template})
    assert r.status_code == 200, r.text
    return r.json()["name"]


# --------------------------------------------------------------------------- #
# 1. Path traversal / safe-name canonicalisation
# --------------------------------------------------------------------------- #
def test_safe_name_only_accepts_canonical_segments():
    """app._safe_name must accept ONLY names already in the form Project stores
    under (so the accepted name == the on-disk segment), and reject anything the
    project sanitiser would have silently transformed. Regression for the
    divergence where 'a:b' passed the old check verbatim but was stored as
    'a_b', leaving delete/rename pointing at the wrong path."""
    from fastapi import HTTPException
    from whsim.project import safe_name as project_safe
    from whsim.web.app import _safe_name
    # Accepted: already-canonical names round-trip unchanged.
    for n in ["proj1", "日本語倉庫", "demo-2", "a_b", "foo.bar"]:
        assert _safe_name(n) == n == project_safe(n), n
    # Rejected: anything that would have been transformed (the divergence cases).
    for bad in ["a:b", "a b", "café", "a\x01b", "../etc", "/abs/x", "a\nb"]:
        with pytest.raises(HTTPException) as ei:
            _safe_name(bad)
        assert ei.value.status_code == 400, bad


@pytest.mark.parametrize("bad", ["..", ".", "...", "   ", "", "/", "\\", "\x00"])
def test_safe_name_rejects_unusable(bad):
    from fastapi import HTTPException
    from whsim.web.app import _safe_name
    with pytest.raises(HTTPException) as ei:
        _safe_name(bad)
    assert ei.value.status_code == 400


def test_traversal_project_name_rejected(client, tmp_path):
    """A create with a traversal-y name is rejected (400) and writes nothing
    outside the workspace."""
    r = client.post("/api/projects",
                    json={"name": "../../../../etc/pwned", "template": "ecommerce_small"})
    assert r.status_code == 400
    assert not (tmp_path / "etc").exists()
    assert not Path("/etc/pwned").exists()


def test_delete_round_trips_with_create(client):
    """A project created under a canonical name is delete-able via that same
    name: the segment the delete endpoint builds matches where it was stored."""
    name = _make(client, "proj_x")
    assert name in client.get("/api/projects").json()
    r = client.delete(f"/api/projects/{name}")
    assert r.status_code == 200, r.text
    assert name not in client.get("/api/projects").json()


def test_rename_traversal_target_rejected(client, tmp_path):
    """The `to` target of a rename is validated too: a traversal target is a
    400 and escapes nothing."""
    _make(client, "src1")
    r = client.post("/api/projects/src1/rename", json={"to": "../escape"})
    assert r.status_code == 400
    assert not Path("/escape").exists()
    assert not (tmp_path / "escape").exists()


def test_compare_png_validates_cmp_segment(client):
    """compare-png builds runs/<cmp>/sN.png from a path segment; a traversal cmp
    must not read outside runs/. Returns 4xx, never serves an arbitrary file."""
    _make(client, "cp1")
    r = client.get("/api/projects/cp1/compare-png/..%2f..%2f..%2fetc/0")
    assert r.status_code in (400, 404)


# --------------------------------------------------------------------------- #
# 2. JSON recursion bomb in uploads
# --------------------------------------------------------------------------- #
def _zip_with(member_name, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member_name, data)
    return buf.getvalue()


def test_importer_recursion_bomb_is_skipped_not_fatal():
    from whsim import importer, templates
    deep = b"[" * 100_000 + b"]" * 100_000
    td = templates.load_template_dict("ecommerce_small")
    # Must not raise RecursionError; the member is skipped with a warning.
    res = importer.import_bytes(td, _zip_with("orders.json", deep))
    assert any("deep" in w.lower() or "nest" in w.lower() for w in res.warnings)
    # The model still validated (import succeeded, "always runs").
    assert res.model is not None


def test_import_endpoint_recursion_bomb_returns_2xx_not_500(client):
    _make(client, "rb1")
    deep = b"[" * 100_000 + b"]" * 100_000
    zbytes = _zip_with("orders.json", deep)
    r = client.post("/api/projects/rb1/import",
                    files={"file": ("u.zip", zbytes, "application/zip")})
    assert r.status_code == 200, r.text  # tolerant: skipped member, never a 500
    assert "warnings" in r.json()


def test_distances_recursion_bomb_not_fatal():
    from whsim import distances
    deep = b"[" * 100_000 + b"]" * 100_000
    res = distances.import_distance_matrix_bytes(deep, "m.json")
    assert res["count"] == 0


def test_import_distances_endpoint_recursion_bomb(client):
    _make(client, "rd1")
    deep = b"[" * 100_000 + b"]" * 100_000
    r = client.post("/api/projects/rd1/import-distances",
                    files={"file": ("m.json", deep, "application/json")})
    # Tolerant parser -> 200 with zero pairs (or a clean 400), never a 500.
    assert r.status_code in (200, 400), r.text


def test_json_depth_scanner_ignores_brackets_in_strings():
    from whsim.importer import MAX_JSON_DEPTH, _json_too_deep
    # Brackets inside a string literal must not inflate the depth count.
    assert _json_too_deep('"' + "[" * (MAX_JSON_DEPTH + 50) + '"') is False
    assert _json_too_deep("[" * (MAX_JSON_DEPTH + 1)) is True
    assert _json_too_deep('{"a": [1, 2, 3]}') is False


# --------------------------------------------------------------------------- #
# 3. Cody chat input cap
# --------------------------------------------------------------------------- #
def test_cody_caps_long_message():
    from whsim import cody
    out = cody.respond("実行" * 100_000)  # ~200k chars
    # Still returns the contract dict, fast, with a valid intent.
    assert set(out) >= {"reply", "mood", "intent", "params", "suggestions"}
    assert isinstance(out["reply"], str)


def test_cody_endpoint_long_message_ok(client):
    r = client.post("/api/cody/chat", json={"message": "実行" * 100_000})
    assert r.status_code == 200, r.text
    assert "reply" in r.json()


# --------------------------------------------------------------------------- #
# 4. Upload size cap
# --------------------------------------------------------------------------- #
def test_oversized_upload_rejected_413(client):
    _make(client, "big1")
    from whsim.web.app import MAX_UPLOAD_BYTES
    blob = b"x" * (MAX_UPLOAD_BYTES + 1024)
    r = client.post("/api/projects/big1/import",
                    files={"file": ("u.zip", blob, "application/zip")})
    assert r.status_code == 413, r.text
