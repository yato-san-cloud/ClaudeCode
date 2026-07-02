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
  `.rmpm.json` export / **NATIVE `.rmpm`** = Java serialization, parsed via
  javaobj-py3 and validated byte-equal against the JSON-export oracle); shelves
  keep their MapMaker name (→ slottable location names), walls/stations mapped,
  mm→m. `racktypes.py` — 9 storage-equipment presets (incl. メザニン/移動ラック/
  ハンガー) with unit economics, served at `/api/racktypes` and mirrored into the
  JS editor/3D (keep in parity).
- `analysis/data_io.py` — real-WMS-grade table loading: header-row auto-detect
  (タイトル行/メタ行 skip), 合計/小計 row drop, header NFKC fold so 半角カナ
  (商品ｺｰﾄﾞ/出荷ﾊﾞﾗ数) auto-map, ragged-CSV salvage, legacy `.xls` via xlrd
  (in deps). `cad.py` rejects DWG-mis-saved-as-DXF with a how-to-fix message and
  salvages malformed DXF via ezdxf.recover.
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
- `kpis.py` — event log → KPIs + a plain-language (Japanese) verdict. Multi-rep runs
  add `kpis.ci` (95% t-CI per headline metric + n_recommended for a ±5% target);
  the KPI view shows 「±X (95%CI, n=N)」 and an honest n=1 disclosure.
- `asrs.py` — FEM 9.851 / Bozer-White クレーンサイクル解析 (E(SC)/E(DC) → cycles/h →
  必要クレーン台数). 保管設計 (`storage.py`) の自動倉庫サイジングと GET /storage payload
  の additive `asrs` ブロック; クレーンつまみは /api/racktypes 配信 (no hardcode).
- `analysis/inventoryopt.py` — 在庫最適化 (安全在庫・発注点). SKU別 日次需要 (需要ゼロ日
  含む) から μ/σ を実測で直接算出; SS = z·σ·√(LT+R), ROP = μ·LT+SS; 低頻度SKUは
  ポアソン切替 (scipy不使用). GET /inventory-opt → ②分析「物量サマリ」カード
  (`js/dataanalysis.js`); 理論値の注記付き (never oversell).
- `export/` — brand theme: `Settings.brand` (宛先/自社名/accent/logo/footer, all
  defaulted) → PPTX/PDF 表紙とアクセント色に反映; POST /brand/logo でロゴ保存;
  設定タブ「ブランド」(js/settings.js). Default brand is colour-identical (no-op).
- `design.py` — design-side helpers: `materialize_racks` expands a storage zone's
  parametric rack params (or authored MapMaker-style shelves) into the concrete
  `locations` grid, propagating shelf names to location names and re-pegging SKUs.
- `storage.py` — 保管設備の試算 (demand → 保管方法 → 間口/台数/坪数; cost is 参考) +
  `place_equipment` authors the sized units into the storage zone (ピック面/バック
  2層・アイル向き; `POST /storage/apply-layout`); ③設計「保管設計」 (`js/storage.js`).
- `cost.py` — 解析的原価積み上げ (LOGISTEED 試算フロー 6費目; no sim, 爆速). Labour
  uses the **3-tier productivity**: 実測採用値(settings.productivity_overrides) >
  物流形態ベンチマーク(settings.benchmark_productivity) > エンジン既定. ⑤提案前の
  ③設計「原価試算」 (`js/cost.js`, GET /cost). Same 3-tier in `analysis/staffing.py`
  `resolve_productivity` so the 人員タイムチャート honours it too. ピッキングの既定層は
  作業方式連動 (pickrate の動作時間モデルから導出; override/benchmark があれば不変).
- `analysis/staffing.py` — 人員タイムチャートの解析ソルバー。工程は編集可能マスタ
  `process_master(model)` 経由 (完全フリー工程; GENERIC_PROCESSES を直接 import しない),
  バッチ投入ゲート (`settings.batch_schedule`, 窓外は窓内クランプ=never-blocks), 入荷の
  時間形状はタイムスタンプがあればデータ駆動 (無ければ従来の 8-16 固定窓と同一)。
  シナリオ保存 + GET /timetable/compare で 作業方式/バッチ別の比較。
- `benchmarks.py` — 生産性ベンチマークライブラリ (物流形態別 想定生産性プリセット;
  the company's 集合知の箱, seeds replaceable). GET /api/benchmarks, POST
  /benchmark/{id}/apply. The 想定 tier of the productivity stack.
- `workmethod.py` `METHOD_PRESETS` (都度/マルチ/ゾーン/種まき = 5軸の各点) +
  `recommend`; `POST /workmethod/compare` runs all 4 via DES (move-vs-sort
  trade-off) → ⑤提案「作業方法比較」 (`js/workcompare.js`: 散布図＋KPI表＋推奨＋採用).
- `pickrate.py` — 生産性試算: 解析的(動作時間)ピッキング生産性. 各作業方式を
  tour≈0.75·√(picks·面積)+2·搬出距離 の動作時間モデルで即算出 (no sim, 爆速).
  SLC流ステップ②: レイアウト幾何(MapMaker距離)×動作時間で オーダー/マルチ/トータル
  を DES 前に当てる. GET /pickrate → ③設計「生産性試算」 (`js/pickrate.js`:
  移動vs仕分け散布図＋KPI表＋推奨＋採用). 重厚なDESは④検証で裏取り.
- 生産性フィードバック: `kpis.measured_productivity` (実測) → ④検証で 想定vs実測 を
  並べ「実測を採用」→ settings.productivity_overrides → cost/timetable に波及.
- `scorecard.py` — 採点表レール: 設計の従属変数6行(判定/人員/原価/生産性/坪数/連鎖)を
  既存純関数(analytic/cost/pickrate/storage)の合成＋連鎖チェックで解析的に即算出.
  `GET /scorecard`(保存モデル) と `POST /scorecard`(編集中セクション上書き=ドラッグ中も
  ライブ再計算). never-blocks. `scenariostore.py` — 名前付きシナリオ(設計スナップ＋採点表)を
  `projects/<name>/scenarios/` に凍結, GET/POST/DELETE /scenarios. → 右常設ドック
  `js/scorecard.js`(Claude Code風 折畳/分割, ②③④表示・①⑤非表示, ③はdesignerと非重複で
  細ストリップ収縮, 比較=なし/最後の実行(DES)/保存シナリオ で▲▼デルタ). designerは
  `whsim:design-dirty`に編集中セクションを載せて発火→app.jsが250msデバウンスでライブPOST.
- `analysis/ingest.py` — ETL: uploaded shipments CSV → `model.orders.outbound`
  (`POST /import/shipments`); real calendar weekday/hour survive via `arrival_s`.
- `bi.py` `derive_volumes` — 仮値 荷姿変換 (パレット/オリコン/カゴ台車); the BI→
  タイムチャート bridge is `bi/apply` → `bi.json` → `timetable/from-bi` (the 物量シミュ
  CTA and マテリアルフロー「基礎物量を取込」 both consume it).
- `cad.py` — tolerant DXF import (ezdxf) → bounds/walls/zones in meters (unit auto-detect).
- `export_doc.py` — editable PPTX + PDF proposal (python-pptx / reportlab, CJK fonts).
- `render/replay.py` — replay contract consumed by both the 2D canvas and 3D (three.js) views.
- `render/png2d.py` — proposal PNG (layout + congestion heatmap + verdict + provenance footer).
- `render/anim2d.py` — server-side animated 2D replay GIF (no browser needed).
- `web/` — FastAPI backend + single-page frontend (`static/`). `js/view3d.js` (three.js
  replay — realistic per-`rack_type` geometry, human pickers, pick-event glow) and
  `js/designer.js` (library-&-hotbar layout editor: 3 tabs 配置/フロー/動線. The 配置 tab
  has a persistent object LIBRARY — 棚9種/ゾーン/マテハン設備/躯体 as icon cards; click-to-arm
  or drag-onto-floor, ghost preview at real footprint, digits 1-9 MapMaker-compatible.
  CAD trust: 1m/5m grid, status bar, edge-snap, Shift-ortho walls with live lengths,
  W×D readouts, doors projected onto the envelope; unified select + object inspector,
  棚一括生成 / 面積オート生成, undo) are mounted by `app.js`. Shared frontend helpers
  live in `js/util.js` (`$`/`api`/`esc`) and `js/constants.js` (label/colour maps).
  three.js is vendored under `static/vendor/`.
  `js/progress.js` — 待ち表現: ▶実行/作業方法比較/シナリオ比較は SimPyの
  シミュ内時計(`GET /run/progress` を300msポーリング)を本物の進捗バー＋ETAにし、
  フォークリフトが荷物を運びながら走る(`startRunProgress`); 取込など短い同期処理は
  フォークリフト往復の不確定インジケータ(`forkliftBusy`)。
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
