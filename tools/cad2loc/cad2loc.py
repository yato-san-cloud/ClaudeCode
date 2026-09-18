#!/usr/bin/env python
"""Launcher so the tool runs straight from a checkout without installing:

    python tools/cad2loc/cad2loc.py input.dxf --config mapping.yaml -o layout.geojson

(The sibling `cad2loc/` package wins over this module name in the import system,
so `from cad2loc.cli import main` below resolves to the package.)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cad2loc.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
