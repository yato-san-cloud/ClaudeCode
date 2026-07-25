"""Register a CJK font so matplotlib renders Japanese (not tofu).

Resolution order is: explicit well-known paths → recursive globs over the usual
font directories → any already-registered family whose name looks Japanese. The
winner is installed as the *first* entry of ``font.sans-serif`` because
matplotlib only falls back **forward** through that list: a latin-only primary
(DejaVu) never reaches a CJK face behind it, so the JP font must lead and latin
follows as the fallback.
"""

from __future__ import annotations

import glob
import os

import matplotlib.pyplot as plt
from matplotlib import font_manager

# Linux (Noto / IPA / VL / Takao), then Windows (Meiryo / Yu Gothic / MS Gothic),
# then macOS. First hit wins, so the nicest faces come first.
_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf",
    r"C:\Windows\Fonts\meiryo.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\YuGothR.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Debian/Ubuntu japanese font packages (fonts-ipafont / vlgothic / takao).
    "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/truetype/vlgothic/VL-PGothic-Regular.ttf",
    "/usr/share/fonts/truetype/vlgothic/VL-Gothic-Regular.ttf",
    "/usr/share/fonts/truetype/takao-gothic/TakaoPGothic.ttf",
    # Last resort: a bitmap-ish pan-Unicode face (ugly, but never tofu).
    "/usr/share/fonts/opentype/unifont/unifont_jp.otf",
)

# Recursive globs, tried when none of the explicit paths exist (a font may live
# under a distro-specific directory we cannot enumerate up-front).
_GLOB_DIRS = ("/usr/share/fonts", "/usr/local/share/fonts",
              os.path.expanduser("~/.fonts"), os.path.expanduser("~/.local/share/fonts"))
_GLOB_PATS = ("**/NotoSansCJK*.*", "**/NotoSansJP*.*", "**/*Gothic*.tt?",
              "**/*gothic*.tt?", "**/*Mincho*.tt?")

# Families already known to matplotlib that carry kana/kanji, best first.
_FAMILY_HINTS = ("Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Meiryo",
                 "Yu Gothic", "MS Gothic", "IPAPGothic", "IPAGothic",
                 "VL PGothic", "VL Gothic", "TakaoPGothic", "Unifont-JP")

_LATIN_TAIL = ["DejaVu Sans", "Liberation Sans", "Arial", "Helvetica", "sans-serif"]

_done = False
_family: str = ""
_has_bold: bool | None = None


def _windows_font_dir_candidates() -> list[str]:
    win = os.environ.get("WINDIR", r"C:\Windows")
    fonts = os.path.join(win, "Fonts")
    pats = ("meiryo*.ttc", "YuGoth*.tt?", "msgothic.ttc", "msmincho.ttc")
    out: list[str] = []
    for p in pats:
        out.extend(glob.glob(os.path.join(fonts, p)))
    return out


def _glob_candidates() -> list[str]:
    out: list[str] = []
    for d in _GLOB_DIRS:
        if not os.path.isdir(d):
            continue
        for pat in _GLOB_PATS:
            try:
                out.extend(sorted(glob.glob(os.path.join(d, pat), recursive=True)))
            except OSError:
                continue
    return out


def _registered_jp_family() -> str:
    """A CJK-capable family matplotlib already knows about (name heuristic)."""
    known = {f.name for f in font_manager.fontManager.ttflist}
    for name in _FAMILY_HINTS:
        if name in known:
            return name
    return ""


def _install(name: str) -> None:
    """Make `name` the primary family, with latin faces behind it as fallback."""
    global _family
    _family = name
    tail = [t for t in _LATIN_TAIL if t != name]
    plt.rcParams["font.family"] = "sans-serif"
    plt.rcParams["font.sans-serif"] = [name, *tail]
    plt.rcParams["axes.unicode_minus"] = False


def setup_jp_font() -> None:
    global _done
    if _done:
        return
    _done = True  # only ever probe the filesystem once
    candidates = list(_CANDIDATES)
    if os.name == "nt":  # also scan the Windows Fonts dir for any CJK face
        candidates += _windows_font_dir_candidates()
    for path in candidates + _glob_candidates():
        if not os.path.exists(path):
            continue
        try:
            font_manager.fontManager.addfont(path)
            _install(font_manager.FontProperties(fname=path).get_name())
            return
        except (FileNotFoundError, RuntimeError, OSError, ValueError):
            continue
    name = _registered_jp_family()  # nothing on disk: reuse what is registered
    if name:
        _install(name)
    # else: give up quietly; latin still renders


def jp_family() -> str:
    """Resolved Japanese family name ("" when none was found)."""
    setup_jp_font()
    return _family


def bold_available() -> bool:
    """True when the resolved Japanese family ships a real bold weight.

    Free JP faces (IPAGothic, VL Gothic) are regular-only, so matplotlib silently
    renders ``weight="bold"`` at weight 400 — headings then carry no emphasis.
    Callers use this to decide whether to synthesise weight with a hairline
    stroke instead. Falls back to True (assume real bold) if anything is odd, so
    we never double-embolden a font that already has one.
    """
    global _has_bold
    if _has_bold is not None:
        return _has_bold
    setup_jp_font()
    if not _family:
        _has_bold = True
        return _has_bold
    try:
        reg = font_manager.findfont(
            font_manager.FontProperties(family=_family, weight="normal"),
            fallback_to_default=False)
        bold = font_manager.findfont(
            font_manager.FontProperties(family=_family, weight="bold"),
            fallback_to_default=False)
        _has_bold = reg != bold
    except Exception:  # noqa: BLE001 — emphasis detection is cosmetic only
        _has_bold = True
    return _has_bold
