"""Yahoo!ショッピング 商品検索API v3 を使うプロバイダ。

jan_code パラメータで検索し、ヒット商品の name・description から
三辺サイズをテキスト抽出する。Yahoo APIも三辺サイズの構造化フィールドを
持たないため、抽出はベストエフォート。

要: Yahoo! アプリケーションID (Client ID)
    環境変数 YAHOO_APP_ID もしくはコンストラクタ引数で渡す。
"""

from __future__ import annotations

import os
from typing import Optional

from ..models import ProductInfo
from ..parser import parse_dimensions
from .base import DimensionProvider

_ENDPOINT = "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch"


class YahooProvider(DimensionProvider):
    name = "yahoo"
    is_remote = True

    def __init__(self, app_id: Optional[str] = None, timeout: float = 10.0) -> None:
        self.app_id = app_id or os.environ.get("YAHOO_APP_ID")
        self.timeout = timeout
        if not self.app_id:
            raise ValueError(
                "Yahoo アプリIDが未設定です。環境変数 YAHOO_APP_ID を設定してください。"
            )

    def lookup(self, jan: str) -> Optional[ProductInfo]:
        import requests  # 遅延import

        params = {"appid": self.app_id, "jan_code": jan, "results": 1}
        try:
            resp = requests.get(_ENDPOINT, params=params, timeout=self.timeout)
            resp.raise_for_status()
            hits = resp.json().get("hits", [])
        except Exception:
            return None

        if not hits:
            return None
        hit = hits[0]
        title = hit.get("name")
        raw = " ".join(filter(None, [hit.get("name"), hit.get("description")]))
        return ProductInfo(
            jan=jan,
            source=self.name,
            title=title,
            dimensions=parse_dimensions(raw),
            raw_text=raw or None,
        )
