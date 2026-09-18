"""Render-agnostic text metrics: how tall does this text get, and does it fit?

A PowerPoint text box has no reflow of its own — python-pptx writes the runs and
the slide happily renders them past its own edge. That silence is the bug this
module exists to remove: **the layout must never be allowed to dictate the
content**. A proposal whose 危険側 前提条件 has to be rewritten shorter to stay on
the slide has already lost the argument it was written to make.

The numbers here are deliberately *conservative* estimates (they over-state
width, never under-state it), because the only expensive mistake is reporting
"it fits" for text that does not. They are font-metric-free on purpose: no
freetype, no font file, no platform variance — an export must produce the same
deck on a developer laptop and in CI.

Units: font sizes in points, box geometry in inches (72 pt = 1 inch).

A "paragraph" is the dict ``{"text": str, "pt": float}`` (extra keys are carried
through untouched, so callers can hang colour/bold/indent off the same object).
"""

from __future__ import annotations

import math
import unicodedata

#: Line box height as a multiple of the font size. PowerPoint's single spacing
#: is ~1.2em; 1.25 keeps a margin so a rounded-up renderer still fits.
LINE_SPACING = 1.25

#: Floor for shrink-to-fit, as a fraction of the authored size. 0.62 turns the
#: 16pt 前提条件 body into ~10pt — small, still projector-legible. Below that we
#: paginate instead: unreadable text on one slide is not an improvement over
#: readable text on two.
MIN_SCALE = 0.62

#: Advance width (in em) for characters the east-asian tables call halfwidth.
_HALF_EM = 0.58
_SPACE_EM = 0.30

_ELLIPSIS = "…"


def char_width_em(ch: str) -> float:
    """Advance width of one character in em, over-estimated on purpose.

    East-asian ``W``/``F`` (and ``A``, the ambiguous class that CJK fonts render
    full-width — 「—」「・」「±」) count as a full em; everything else takes the
    halfwidth estimate. Control characters are free."""
    if ch < " ":  # control characters take no space
        return 0.0
    if ch == " ":
        return _SPACE_EM
    try:
        eaw = unicodedata.east_asian_width(ch)
    except (TypeError, ValueError):  # pragma: no cover — defensive
        return 1.0
    if eaw in ("W", "F", "A"):
        return 1.0
    return _HALF_EM


def text_width_em(text) -> float:
    """Total advance width of `text` in em (a 10-char CJK run is 10.0)."""
    if not text:
        return 0.0
    return sum(char_width_em(c) for c in str(text))


def wrapped_lines(text, pt: float, width_in: float) -> int:
    """Number of rendered lines `text` needs in a `width_in` box at `pt`.

    Japanese wraps between (almost) any two characters, so a greedy em-count is
    an honest model of the real line breaking; explicit newlines are honoured."""
    if pt <= 0 or width_in <= 0:
        return 1
    cols = (width_in * 72.0) / float(pt)  # available em per line
    if cols <= 0:
        return 1
    total = 0
    for chunk in str(text or "").split("\n"):
        w = text_width_em(chunk)
        total += max(1, int(math.ceil(w / cols - 1e-9)))
    return max(1, total)


def block_height_in(paras, width_in: float, scale: float = 1.0,
                    spacing: float = LINE_SPACING) -> float:
    """Rendered height, in inches, of `paras` laid out in a `width_in` column."""
    h = 0.0
    for p in paras or ():
        pt = float(p.get("pt", 12.0)) * scale
        n = wrapped_lines(p.get("text", ""), pt, width_in)
        h += n * pt * spacing / 72.0
    return h


def overflows(paras, width_in: float, height_in: float, scale: float = 1.0,
              spacing: float = LINE_SPACING) -> bool:
    """True when `paras` would render past the bottom of the box."""
    return block_height_in(paras, width_in, scale, spacing) > height_in + 1e-9


def fit_scale(paras, width_in: float, height_in: float, *,
              min_scale: float = MIN_SCALE, spacing: float = LINE_SPACING) -> float:
    """Largest font scale in ``[min_scale, 1.0]`` that fits, quantised to 1%.

    Returns exactly ``1.0`` when the text already fits — callers rely on that to
    keep an unchanged deck byte-identical. Returns `min_scale` when even the
    floor overflows; the caller then paginates."""
    if not paras:
        return 1.0
    if not overflows(paras, width_in, height_in, 1.0, spacing):
        return 1.0
    lo, hi = int(round(min_scale * 100)), 100
    best = lo
    while lo <= hi:  # binary search on whole percents
        mid = (lo + hi) // 2
        if overflows(paras, width_in, height_in, mid / 100.0, spacing):
            hi = mid - 1
        else:
            best = mid
            lo = mid + 1
    return best / 100.0


def paginate(paras, width_in: float, height_in: float, scale: float = 1.0,
             spacing: float = LINE_SPACING) -> list[list[dict]]:
    """Split `paras` into pages that each fit the box at `scale`.

    A paragraph carrying ``"keep_next": True`` is pushed to the next page rather
    than left as a page's last line, so a headline never gets orphaned from the
    detail it introduces.

    Always returns at least one page, and never drops a paragraph: a single
    paragraph taller than the whole box is kept alone on its own page (clipping
    it would be exactly the silent data loss this module removes — the caller
    should have shrunk first)."""
    paras = list(paras or ())
    if not paras:
        return [[]]

    def _h(p) -> float:
        pt = float(p.get("pt", 12.0)) * scale
        return wrapped_lines(p.get("text", ""), pt, width_in) * pt * spacing / 72.0

    pages: list[list[dict]] = []
    cur: list[dict] = []
    used = 0.0
    for i, p in enumerate(paras):
        h = _h(p)
        if cur and used + h > height_in + 1e-9:
            pages.append(cur)
            cur, used = [], 0.0
        # Widow control: a "keep_next" paragraph whose successor would not fit
        # under it starts the next page instead of ending this one.
        if (cur and p.get("keep_next") and i + 1 < len(paras)
                and used + h + _h(paras[i + 1]) > height_in + 1e-9):
            pages.append(cur)
            cur, used = [], 0.0
        cur.append(p)
        used += h
    pages.append(cur)
    return pages


def fit_line(text, width_in: float, pt: float, *, min_pt: float = 7.0,
             ellipsis: str = _ELLIPSIS) -> tuple[str, float]:
    """Force `text` onto ONE line of `width_in`: shrink first, then elide.

    Used for the per-slide footer, whose 0.4-inch strip sits on the slide edge —
    a second line there runs off the page. Returns ``(text, pt)`` unchanged when
    it already fits, so the common case stays byte-identical.

    Eliding is safe *only* because the footer is the short form of something the
    document states in full elsewhere (the 前提条件 section); never elide the
    only copy of a fact."""
    s = str(text or "")
    if not s or width_in <= 0 or pt <= 0:
        return s, pt
    cols = (width_in * 72.0) / float(pt)
    if text_width_em(s) <= cols:
        return s, pt
    # 1) shrink, in whole points, down to the legibility floor
    size = float(pt)
    while size > min_pt:
        size = max(min_pt, size - 0.5)
        if text_width_em(s) <= (width_in * 72.0) / size:
            return s, size
    # 2) still too wide at the floor -> elide from the tail
    cols = (width_in * 72.0) / size
    budget = cols - text_width_em(ellipsis)
    kept, w = [], 0.0
    for ch in s:
        cw = char_width_em(ch)
        if w + cw > budget:
            break
        kept.append(ch)
        w += cw
    return "".join(kept) + ellipsis, size
