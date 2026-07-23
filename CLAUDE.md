# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ChiroApp — a Flask-based desktop app (Japanese UI) for chiropractors:
X-ray pelvis analysis (landmark detection + human correction + measurements)
and orthopedic referral-letter PDF generation. Packaged with pywebview +
PyInstaller; Windows/macOS binaries are built by GitHub Actions.

## Commands

- Run (dev, browser): `python app.py` → http://localhost:5000
- Run (desktop window): `python desktop.py`
- Tests (no pytest needed): `python tests/test_basic.py`
- Icons: `python generate_icons.py` / sample X-ray: `python generate_sample_xray.py`
- Package (on target OS): `pyinstaller chiro_app.spec`
- CI builds: `.github/workflows/build-desktop.yml` (push to the active branch or manual dispatch)

## Architecture invariants

- `modules/xray_analyzer.py` is the source of truth for measurement geometry.
  `static/js/xray_editor.js` mirrors the same formulas for live UI updates —
  change both together.
- Pelvic geometry uses TRUE HORIZONTAL (image-y) as the reference axis, per the
  Gonstead rolling-ruler-parallel-to-film-edge method — not perpendicular to the
  tilted femoral-head line. PI/AS is from innominate vertical length (iliac crest
  → ischial tuberosity); longer side = PI. Significance threshold is ≥5mm
  (calibrated). Clinical rounding: 0.5° / 0.5mm. Never assert a full listing —
  measurements + a hedged "示唆" only (sources conflict on PI↔femur-head side).
- DICOM: `modules/dicom_loader.py` normalizes to 8-bit PNG and extracts
  PixelSpacing → mm/px (detector-plane, magnification-uncorrected). pydicom is
  imported lazily so the app boots without it; DICOM upload just errors if absent.
- Landmark ids are viewer-coordinate based (`left_*` = screen-left). Patient-side
  labels are derived via `ap_standard` (AP standard: screen-left = patient RIGHT).
- mm values are only emitted when a `mm_per_px` calibration is provided; never
  fabricate a px→mm scale.
- Display filters (contrast/brightness/invert) use the same formula in CSS
  (`xray_editor.js`) and OpenCV (`apply_display_filters`) so preview == export.
- `app.py` resolves template/static paths via `sys._MEIPASS` for PyInstaller;
  keep that when touching Flask setup.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/chiro-referral-automation-UQwhE`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
