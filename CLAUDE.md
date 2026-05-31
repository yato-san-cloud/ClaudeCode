# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: whsim (warehouse simulator)

A warehouse simulator whose thesis is to **decouple input difficulty from
computational accuracy**: a non-technical salesperson loosely models a warehouse
from a template, while a heavyweight discrete-event simulation (SimPy) runs
underneath and emits a proposal-grade 2D PNG. See `README.md` for the full pitch.

### Architecture (the load-bearing idea)

Everything hangs off **one contract: the canonical schema
`whsim.schema.WarehouseModel`** (`src/whsim/schema/model.py`). Every field has a
default, so any model is always valid and always runnable ("never blocks on
missing data"). Components are pure functions over that schema plus run
artifacts, so each is independently testable/replaceable:

- `templates.py` — a template is a fully filled-in (provisional) `model.json`.
- `importer.py` — tolerant ZIP→subtree merge; broken/non-JSON files are skipped,
  never fatal; partial import is fine.
- `provenance.py` — tracks each subtree's source (imported/interview/provisional);
  surfaced in output as "N% your data". First-class, not bookkeeping.
- `project.py` — persists workspace under `projects/<name>/` (gitignored runtime
  data); the simulator is the source of truth, the analysis tool just supplies ZIPs.
- `engine/` — SimPy DES: `routing.py`, `build.py`, `processes.py`, `run.py`. Pickers are
  individual agents; the run emits per-worker trajectory keyframes for replay.
- `analytic.py` — closed-form M/M/c estimate; also the engine's sanity oracle in tests.
- `kpis.py` — event log → KPIs + a plain-language (Japanese) verdict.
- `design.py` — design-side helpers: `materialize_racks` expands a storage zone's
  parametric rack params into the concrete `locations` grid (re-pegs item SKUs).
- `render/replay.py` — replay contract consumed by both the 2D canvas and 3D (three.js) views.
- `render/png2d.py` — proposal PNG (layout + congestion heatmap + verdict + provenance footer).
- `render/anim2d.py` — server-side animated 2D replay GIF (no browser needed).
- `web/` — FastAPI backend + single-page frontend (`static/`). `js/view3d.js` (three.js
  replay) and `js/designer.js` (interactive layout/equipment/flow editor) are self-contained
  ES modules mounted by `app.js`. three.js is vendored under `static/vendor/`.
  The editor saves via `POST /design`; the engine honours per-stage method (manual vs AGV).

### Commands

- Install: `pip install -e ".[dev]"` (add `,web` for the web app: `pip install -e ".[dev,web]"`)
- Flow: `whsim new <name> -t ecommerce_small` → `whsim import <name> <zip>` →
  `whsim run <name>` → `whsim render <name>` (or `whsim simulate <name>` for run+render);
  `whsim estimate <name>` for the instant analytic estimate; `whsim animate <name>` for a
  replay GIF; `whsim serve` for the web app at http://127.0.0.1:8000.
- Tests: `pytest -q`; single test e.g. `pytest tests/test_engine.py::test_kpis_are_sane`
- Lint: `ruff check src`
- Regenerate template / sample data: `python scripts/gen_template_ecommerce.py`,
  `python scripts/gen_sample_data.py`

### Conventions

- Python ≥3.10, pydantic v2, SimPy 4, NumPy, Matplotlib (Agg, headless), Typer.
- Code identifiers/comments in English; user-facing strings and docs in Japanese.
- Add a new template = add `templates/<id>/{template.json,manifest.json}`; no code change.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/warehouse-simulator-qBrf0`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
