"""cad2loc — DXF warehouse drawing -> WHSIM_CONTRACTS v1.0 layout.geojson.

Standalone tool: it must NOT import the whsim package. Dependencies are limited to
ezdxf / shapely / networkx / scikit-learn / pyyaml.
"""

from .errors import Cad2locError

__version__ = "0.1.0"
GENERATOR = f"cad2loc {__version__}"

__all__ = ["GENERATOR", "Cad2locError", "__version__"]
