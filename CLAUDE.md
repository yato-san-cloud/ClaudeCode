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
artifacts, so each is independently testable/replaceable. **See
`docs/ARCHITECTURE.md`** for the full module map, the 12 invariants, the
replay/MapMaker data contracts, and extension points — read it before a large change.

- `templates.py` — a template is a fully filled-in (provisional) `model.json`.
- `importer.py` — tolerant ZIP→subtree merge; broken/non-JSON files are skipped,
  never fatal; partial import is fine.
- `mapcsv.py` / `rmpm.py` — tolerant MapMaker importers (Hitachi WorldMap Map CSV /
  native `.rmpm.json`); shelves keep their MapMaker name (→ slottable location names),
  walls/stations mapped, mm→m. `racktypes.py` — 6 storage-equipment presets served at
  `/api/racktypes` and mirrored into the JS editor/3D (keep in parity).
- `provenance.py` — tracks each subtree's source (imported/interview/provisional);
  surfaced in output as "N% your data". First-class, not bookkeeping.
- `project.py` — persists workspace under `projects/<name>/` (gitignored runtime
  data); the simulator is the source of truth, the analysis tool just supplies ZIPs.
- `engine/` — SimPy DES: `routing.py`, `build.py`, `processes.py`, `run.py`, `scenarios.py`,
  `graph.py` (wall-aware aisle grid + Dijkstra; `World.dist` = measured override > graph > Manhattan).
- `distances.py` — tolerant import of a measured shelf-to-shelf distance matrix (CSV/JSON).
  Pickers and AGVs are individual agents (AGV mode is a pipeline: AGV agents fetch totes →
  ready queue → pickers handle), emitting trajectory keyframes for replay. Batch/zone/wave
  pull `batch_size` orders per trip; `peak_factor` scales demand. `scenarios.py` applies
  dotted-path edits for what-if comparison (+ `payback_months` from operating-cost savings).
- `kpis.py` includes cost: ¥/order, monthly_cost/opex, headcount, AGV utilisation.
- `analytic.py` — closed-form M/M/c estimate; also the engine's sanity oracle in tests.
- `kpis.py` — event log → KPIs + a plain-language (Japanese) verdict.
- `design.py` — design-side helpers: `materialize_racks` expands a storage zone's
  parametric rack params (or authored MapMaker-style shelves) into the concrete
  `locations` grid, propagating shelf names to location names and re-pegging SKUs.
- `cad.py` — tolerant DXF import (ezdxf) → bounds/walls/zones in meters (unit auto-detect).
- `export_doc.py` — editable PPTX + PDF proposal (python-pptx / reportlab, CJK fonts).
- `render/replay.py` — replay contract consumed by both the 2D canvas and 3D (three.js) views.
- `render/png2d.py` — proposal PNG (layout + congestion heatmap + verdict + provenance footer).
- `render/anim2d.py` — server-side animated 2D replay GIF (no browser needed).
- `web/` — FastAPI backend + single-page frontend (`static/`). `js/view3d.js` (three.js
  replay — realistic per-`rack_type` geometry, human pickers, pick-event glow) and
  `js/designer.js` (MapMaker-style free shelf editor: placement/edge-snap/control-points/
  pan-zoom/undo + 棚一括生成 + 面積オート生成 + a storage-equipment palette) are mounted by
  `app.js`. Shared frontend helpers live in `js/util.js` (`$`/`api`/`esc`) and
  `js/constants.js` (label/colour maps). three.js is vendored under `static/vendor/`.
  The UI is a phase-driven journey (取込→分析→設計→検証→提案) rather than flat tabs:
  `js/journey.js` renders the 5-phase stepper + sub-tabs and drives view selection
  (`switchView` keeps it in sync), `js/overview.js` is the ①取込 landing dashboard
  (readiness checklist + next-step), and `js/phasehint.js` is the per-phase goal/CTA
  banner; Cody and 知見 (notes) are cross-cutting across all phases.
  The editor saves via `POST /design`; the engine honours per-stage method (manual vs AGV).

### Commands

- Install: `pip install -e ".[dev]"`; web app adds `,web`; CAD/PPTX/PDF add `,docs` —
  everything: `pip install -e ".[dev,web,docs]"`
- Flow: `whsim new <name> -t ecommerce_small` → `whsim import <name> <zip>` →
  `whsim run <name>` → `whsim render <name>` (or `whsim simulate <name>` for run+render);
  `whsim estimate <name>` for the instant analytic estimate; `whsim animate <name>` for a
  replay GIF; `whsim serve` for the web app at http://127.0.0.1:8000.
- Tests: `pytest -q`; single test e.g. `pytest tests/test_engine.py::test_kpis_are_sane`
- Lint: `ruff check src`
- Regenerate template / sample data: `python scripts/gen_template_ecommerce.py`,
  `python scripts/gen_sample_data.py`
- **UI screenshot PDCA (headless)**: playwright is installed and an existing
  chromium lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  (`p.chromium.launch(executable_path=...)`, args `--no-sandbox
  --disable-dev-shm-usage`; add `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader` for WebGL/3D). Pattern: start uvicorn on a spare
  port → create the sample project (`POST /api/projects/sample`) → optionally
  import `reference/mapmaker/exported/LW.rmpm.json` → drive the UI by clicking
  `.jn-pill[data-phase=…]` / `.jn-sub[data-view=…]` and `#runBtn` (wait for
  `#status` to contain 完了) → screenshot per view. Pre-set localStorage
  `whsim-onboarded-v*='1'` so coachmarks don't cover shots. See the transcript
  scripts in `/tmp/shoot_whsim.py` style; verify shots by Reading the PNGs
  before shipping UI changes.

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
