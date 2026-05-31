"""Register a CJK font so matplotlib renders Japanese (not tofu)."""

from __future__ import annotations

import matplotlib.pyplot as plt
from matplotlib import font_manager

_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
)
_done = False


def setup_jp_font() -> None:
    global _done
    if _done:
        return
    for path in _CANDIDATES:
        try:
            font_manager.fontManager.addfont(path)
            plt.rcParams["font.family"] = font_manager.FontProperties(
                fname=path).get_name()
            plt.rcParams["axes.unicode_minus"] = False
            _done = True
            return
        except (FileNotFoundError, RuntimeError):
            continue
    _done = True  # give up quietly; latin still renders
