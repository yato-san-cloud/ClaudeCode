#!/usr/bin/env python3
"""log-forge CLI entry point.

    python tools/logforge/logforge.py convert input.xlsx --mapping mapping.yaml -o outdir/

The implementation lives in the sibling package ``lfcore``; this file only puts
its directory on sys.path so the tool runs from a clone without installation.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lfcore.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
