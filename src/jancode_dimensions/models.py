"""ドメインモデル。すべての寸法は cm を正規単位として保持する。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Dimensions:
    """三辺サイズ。単位はすべて cm。

    幅(width)・奥行(depth)・高さ(height)の割り当ては取得元の表記に依存し、
    必ずしも正確に対応しない。ただし三辺合計(total_cm)は順序に依存しないため、
    宅配便サイズ区分の判定にはそのまま利用できる。
    """

    width_cm: float
    depth_cm: float
    height_cm: float

    @property
    def total_cm(self) -> float:
        """三辺合計(cm)。宅配便のサイズ区分(60/80/100...)の判定に使う。"""
        return round(self.width_cm + self.depth_cm + self.height_cm, 1)

    def rounded(self, ndigits: int = 1) -> "Dimensions":
        return Dimensions(
            round(self.width_cm, ndigits),
            round(self.depth_cm, ndigits),
            round(self.height_cm, ndigits),
        )


@dataclass
class ProductInfo:
    """プロバイダが返す1商品分の情報。"""

    jan: str
    source: str
    title: Optional[str] = None
    dimensions: Optional[Dimensions] = None
    raw_text: Optional[str] = None
