"""Register a CJK font so matplotlib renders Japanese (not tofu)."""

from __future__ import annotations

import glob
import os

import matplotlib.pyplot as plt
from matplotlib import font_manager

# Linux (Noto), then Windows (Meiryo / Yu Gothic / MS Gothic), then macOS.
_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
    r"C:\Windows\Fonts\meiryo.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\YuGothR.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
)
_done = False


def _windows_font_dir_candidates() -> list[str]:
    win = os.environ.get("WINDIR", r"C:\Windows")
    fonts = os.path.join(win, "Fonts")
    pats = ("meiryo*.ttc", "YuGoth*.tt?", "msgothic.ttc", "msmincho.ttc")
    out: list[str] = []
    for p in pats:
        out.extend(glob.glob(os.path.join(fonts, p)))
    return out


def setup_jp_font() -> None:
    global _done
    if _done:
        return
    candidates = list(_CANDIDATES)
    if os.name == "nt":  # also scan the Windows Fonts dir for any CJK face
        candidates += _windows_font_dir_candidates()
    for path in candidates:
        try:
            font_manager.fontManager.addfont(path)
            plt.rcParams["font.family"] = font_manager.FontProperties(
                fname=path).get_name()
            plt.rcParams["axes.unicode_minus"] = False
            _done = True
            return
        except (FileNotFoundError, RuntimeError, OSError):
            continue
    _done = True  # give up quietly; latin still renders
