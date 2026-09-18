"""Parity guard: the browser solver (timetable_solver.js) must agree with the
Python solver (whsim.timetable) on the seed data, slot-for-slot.

The UI re-solves client-side for zero-latency live recalc while the server/tests/
export use Python; this test runs the JS via node and compares, so the two ports
can never silently drift. Skipped when node is unavailable."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

import whsim.timetable as tt

NODE = shutil.which("node")
ROOT = Path(tt.__file__).resolve().parent
SOLVER_JS = ROOT / "web" / "static" / "js" / "timetable_solver.js"
DATA = ROOT / "data" / "timetable"

pytestmark = pytest.mark.skipif(NODE is None, reason="node not installed")


def _js_solve_all(tmp_path: Path) -> dict:
    harness = tmp_path / "parity.mjs"
    harness.write_text(
        f"""
import {{ solve }} from {json.dumps(str(SOLVER_JS))};
import {{ readFileSync }} from 'fs';
const D = {json.dumps(str(DATA) + "/")};
const processes = JSON.parse(readFileSync(D+'process.json','utf8'));
const productivity = JSON.parse(readFileSync(D+'productivity.json','utf8'));
const scenarios = JSON.parse(readFileSync(D+'scenarios.json','utf8'));
const out = {{}};
for (const [name, sc] of Object.entries(scenarios)) {{
  const r = solve(sc, processes, productivity);
  out[name] = {{ peak: r.peak_headcount, req: r.total_required_hours,
    asg: r.total_assigned_hours, hbs: r.headcount_by_slot,
    procs: Object.fromEntries(r.processes.map(p=>[p.id, p.headcounts])),
    warns: r.warnings.length }};
}}
console.log(JSON.stringify(out));
""",
        encoding="utf-8",
    )
    proc = subprocess.run([NODE, str(harness)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_js_and_python_solvers_agree_on_seed(tmp_path):
    seed = tt.load_seed()
    js = _js_solve_all(tmp_path)
    assert set(js) == set(seed["scenarios"])
    for name, scen in seed["scenarios"].items():
        r = tt.solve(scen, seed["processes"], seed["productivity"])
        j = js[name]
        assert r["peak_headcount"] == j["peak"], name
        assert abs(r["total_required_hours"] - j["req"]) < 1e-4, name
        assert abs(r["total_assigned_hours"] - j["asg"]) < 1e-4, name
        assert r["headcount_by_slot"] == j["hbs"], f"{name}: per-slot totals differ"
        assert len(r["warnings"]) == j["warns"], f"{name}: warning count differs"
        for p in r["processes"]:
            assert p["headcounts"] == j["procs"][p["id"]], f"{name}/{p['id']}"
