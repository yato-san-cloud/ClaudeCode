"""Shared user-facing labels + small palettes used across render modules.

Kept in one place so the zone-type → 日本語 map and the ABC palette can't drift
between the proposal PNG (`render/png2d.py`) and the replay GIF
(`render/anim2d.py`). Mirrors the JS `ZONE_JP` / `ABC_COLOR` in
`web/static/js/constants.js` — keep the two sides in parity.
"""

from __future__ import annotations

# whsim zone type → 日本語 label.
ZONE_JP: dict[str, str] = {
    "receiving": "入荷", "storage": "保管", "picking": "ピッキング",
    "packing": "梱包", "shipping": "出荷", "staging": "一時保管",
}

# ABC velocity class → colour (fast movers hot, slow movers cool).
ABC_COLOR: dict[str, str] = {"A": "#d7301f", "B": "#fc8d59", "C": "#fdcc8a"}
