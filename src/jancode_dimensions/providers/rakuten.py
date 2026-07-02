"""楽天市場 商品検索API を使うプロバイダ。

JANをキーワード検索し、ヒット商品の商品名・説明文(itemCaption)から
三辺サイズをテキスト抽出する。楽天APIは三辺サイズの構造化フィールドを
持たないため、抽出はベストエフォート(取れない商品も多い)。

要: 楽天アプリID (https://webservice.rakuten.co.jp/)
    環境変数 RAKUTEN_APP_ID もしくはコンストラクタ引数で渡す。
"""

from __future__ import annotations

import os
from typing import Optional

from ..models import ProductInfo
from ..parser import parse_dimensions
from .base import DimensionProvider

_ENDPOINT = "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601"


class RakutenProvider(DimensionProvider):
    name = "rakuten"
    is_remote = True

    def __init__(self, app_id: Optional[str] = None, timeout: float = 10.0) -> None:
        self.app_id = app_id or os.environ.get("RAKUTEN_APP_ID")
        self.timeout = timeout
        if not self.app_id:
            raise ValueError(
                "楽天アプリIDが未設定です。環境変数 RAKUTEN_APP_ID を設定してください。"
            )

    def lookup(self, jan: str) -> Optional[ProductInfo]:
        import requests  # 遅延import: APIを使うときだけ依存を要求する

        params = {
            "applicationId": self.app_id,
            "keyword": jan,
            "hits": 1,
            "format": "json",
            "formatVersion": 2,
        }
        try:
            resp = requests.get(_ENDPOINT, params=params, timeout=self.timeout)
            resp.raise_for_status()
            items = resp.json().get("Items", [])
        except Exception:
            return None

        if not items:
            return None
        item = items[0]
        title = item.get("itemName")
        raw = " ".join(filter(None, [item.get("itemName"), item.get("itemCaption")]))
        return ProductInfo(
            jan=jan,
            source=self.name,
            title=title,
            dimensions=parse_dimensions(raw),
            raw_text=raw or None,
        )
