"""Make `import cad2loc` work when running pytest from anywhere in the repo.

tools/cad2loc is intentionally outside the root pytest testpaths: it is a
standalone tool and must not import the whsim package.
"""

import sys
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
if str(TOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOL_ROOT))
