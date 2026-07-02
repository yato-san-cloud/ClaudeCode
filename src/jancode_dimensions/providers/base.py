"""プロバイダの共通インターフェース。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from ..models import ProductInfo


class DimensionProvider(ABC):
    """JANコードから商品情報(できれば三辺サイズ)を引く取得元。"""

    #: ログ/転記の「取得元」欄に出す識別名。
    name: str = "base"

    @abstractmethod
    def lookup(self, jan: str) -> Optional[ProductInfo]:
        """JANに対応する商品情報を返す。

        - 商品が見つかりサイズも取れた場合: dimensions 付きの ProductInfo
        - 商品は見つかったがサイズ不明: dimensions=None の ProductInfo
        - 商品自体が見つからない/エラー: None

        通信エラーは内部で握りつぶし None を返すこと(処理を止めない)。
        """
        raise NotImplementedError
