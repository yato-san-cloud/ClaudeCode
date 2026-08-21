"""CJK font registration for the reportlab PDF builder."""

from __future__ import annotations

from pathlib import Path

_CJK_FONT_NAME = "WhsimCJK"
_CJK_REGISTERED = False


def _register_cjk_font() -> str:
    """Register a CJK font for reportlab; return the usable font name.

    Tries the Noto Sans CJK TTC first (subfontIndex 0), then falls back to a
    built-in CID font so Japanese never renders as tofu.
    """
    global _CJK_REGISTERED
    from reportlab.pdfbase import pdfmetrics

    if _CJK_REGISTERED:
        return _CJK_FONT_NAME

    ttc = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
    if ttc.is_file():
        try:
            from reportlab.pdfbase.ttfonts import TTFont
            pdfmetrics.registerFont(
                TTFont(_CJK_FONT_NAME, str(ttc), subfontIndex=0)
            )
            _CJK_REGISTERED = True
            return _CJK_FONT_NAME
        except Exception:
            pass

    # Fallback: built-in CID font (always available with reportlab).
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    return "HeiseiKakuGo-W5"
