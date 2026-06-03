"""Static serving guards for the phase-journey navigation refactor.

There are no HTML-structure assertions elsewhere, so the SPA can break at runtime
(a bad import, a renamed panel id) while every API test stays green. These cheap
checks catch a 404'd module or a journey/panel wiring regression."""

from fastapi.testclient import TestClient

from whsim.web.app import app

client = TestClient(app)

# New + load-bearing front-end modules that app.js imports.
JS_MODULES = [
    "app.js", "js/journey.js", "js/overview.js", "js/phasehint.js",
    "js/onboarding.js", "js/notes.js", "js/materialflow.js",
]


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_js_modules_serve():
    for p in JS_MODULES:
        r = client.get(f"/{p}")
        assert r.status_code == 200, p
        assert "javascript" in r.headers.get("content-type", "")


def test_journey_nav_wired_in_index():
    """The flat tab bar was replaced by the 5-phase journey: the mount point and
    the phase-hint banner must exist, and app.js must import the journey module."""
    html = client.get("/").text
    assert 'id="journey"' in html
    assert 'id="phaseHint"' in html
    assert 'id="overview"' in html
    app_js = client.get("/app.js").text
    assert "mountJourney" in app_js and "mountOverview" in app_js


def test_api_unknown_still_404():
    # /api/* stays owned by FastAPI routes, not swallowed by the static mount.
    assert client.get("/api/definitely-not-a-route").status_code == 404
