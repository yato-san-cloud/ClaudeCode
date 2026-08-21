"""Client-ready proposal export package: editable PowerPoint and PDF builders.

Public builders: :func:`build_pptx` (python-pptx) and :func:`build_pdf`
(reportlab). Shared, render-agnostic data/row/tile builders live in
:mod:`._data`; CJK font registration in :mod:`.fonts`.
"""

from __future__ import annotations

from .fonts import _register_cjk_font
from .pdf import build_pdf
from .pptx import build_pptx

__all__ = ["build_pptx", "build_pdf", "_register_cjk_font"]
