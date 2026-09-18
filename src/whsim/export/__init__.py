"""Client-ready proposal export package: editable PowerPoint and PDF builders.

Public builders: :func:`build_pptx` (python-pptx) and :func:`build_pdf`
(reportlab). Shared, render-agnostic data/row/tile builders live in
:mod:`._data`; CJK font registration in :mod:`.fonts`; text metrics
(shrink-to-fit / pagination, so a slide can never silently overflow) in
:mod:`.textfit`.

Both builders take ``assumptions=`` — the 前提条件 are data, not a constant, so a
危険側 (unsafe-side) assumption can be stated ON the assumptions slide. Supplying
nothing keeps the historical default, byte for byte.
"""

from __future__ import annotations

from .fonts import _register_cjk_font
from .pdf import build_pdf
from .pptx import build_pptx

__all__ = ["build_pptx", "build_pdf", "_register_cjk_font"]
