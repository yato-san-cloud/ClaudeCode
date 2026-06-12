"""Parity guard: the scorecard's 連鎖 (area-chain) rule must agree with the
designer's. The chain rule lives in BOTH ``whsim.scorecard.STAGE_ZONE_TYPES``
(server, scores the 連鎖 row) and ``designer/constants.js`` STAGE_ZONE_TYPES
(client, highlights the flow tab). If they drift, the rail and the editor would
disagree on what counts as a valid area chain — this test makes that impossible.
Skipped when node is unavailable."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from whsim import scorecard

NODE = shutil.which("node")
CONSTANTS_JS = (Path(scorecard.__file__).resolve().parent
                / "web" / "static" / "js" / "designer" / "constants.js")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not installed")


def _js_stage_zone_types(tmp_path: Path) -> dict:
    harness = tmp_path / "p.mjs"
    harness.write_text(
        f"import {{ STAGE_ZONE_TYPES }} from {json.dumps(str(CONSTANTS_JS))};\n"
        "process.stdout.write(JSON.stringify(STAGE_ZONE_TYPES));\n",
        encoding="utf-8")
    out = subprocess.run([NODE, str(harness)], capture_output=True, text=True, timeout=20)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_stage_zone_types_match_js(tmp_path):
    js = _js_stage_zone_types(tmp_path)
    py = scorecard.STAGE_ZONE_TYPES
    assert set(js) == set(py), f"stage ids differ: js={set(js)} py={set(py)}"
    for stage in py:
        assert list(js[stage]) == list(py[stage]), (
            f"allowed zone types for '{stage}' differ: js={js[stage]} py={py[stage]}")
