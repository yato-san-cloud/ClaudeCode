"""JANコードから三辺サイズを調べて在庫Excelに転記するツール。"""

from .models import Dimensions, ProductInfo
from .parser import parse_dimensions

__all__ = ["Dimensions", "ProductInfo", "parse_dimensions"]
__version__ = "0.1.0"
