"""検索オーケストレーション: キャッシュ → 各プロバイダの順で三辺サイズを引く。"""

from __future__ import annotations

import time
import unicodedata
from dataclasses import dataclass
from typing import List, Optional, Sequence

from .cache import Cache
from .models import Dimensions, ProductInfo
from .providers.base import DimensionProvider


def normalize_jan(value: object) -> str:
    """Excel/CSV 由来の表記ゆれを吸収して正規化したJAN文字列を返す。"""
    s = unicodedata.normalize("NFKC", str(value)).strip()
    if s.endswith(".0") and s[:-2].isdigit():  # 4901234567894.0 → 4901234567894
        s = s[:-2]
    return s.replace(" ", "").replace("-", "")


@dataclass
class LookupResult:
    jan: str
    dimensions: Optional[Dimensions]
    source: Optional[str]
    title: Optional[str]
    raw_text: Optional[str]
    from_cache: bool

    @property
    def found(self) -> bool:
        return self.dimensions is not None


class LookupPipeline:
    def __init__(
        self,
        providers: Sequence[DimensionProvider],
        cache: Optional[Cache] = None,
        sleep_between: float = 0.0,
    ) -> None:
        self.providers: List[DimensionProvider] = list(providers)
        self.cache = cache
        # リモートプロバイダ(is_remote=True)呼び出しの最小間隔(秒)。
        self.sleep_between = sleep_between
        self._last_remote_ts = float("-inf")

    def _throttle(self) -> None:
        """前回のリモート呼び出しから sleep_between 秒経つまで待つ。"""
        if not self.sleep_between:
            return
        wait = self._last_remote_ts + self.sleep_between - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def lookup(self, jan_raw: object, title_hint: Optional[str] = None) -> LookupResult:
        jan = normalize_jan(jan_raw)
        hint = str(title_hint).strip() if title_hint is not None else ""
        hint = hint or None

        # 1) キャッシュ。verified(人手確認済み)、もしくはサイズ取得済みなら再利用。
        if self.cache is not None:
            cached = self.cache.get(jan)
            if cached is not None and (
                cached.dimensions is not None or self.cache.is_verified(jan)
            ):
                return self._result(jan, cached, from_cache=True)

        # 2) プロバイダを順に試す。サイズが取れた時点で確定。
        # リモートAPIは結果の成否によらず呼び出し間隔を保証する(レート制限対策)。
        # 商品名ヒントが無い場合、先行プロバイダで判明した商品名を後続へ引き継ぐ
        # (例: 楽天で商品名だけ取れた → AI推定プロバイダがそれを使う)。
        last_seen: Optional[ProductInfo] = None
        for provider in self.providers:
            remote = getattr(provider, "is_remote", False)
            if remote:
                self._throttle()
            info = provider.lookup(jan, title_hint=hint)
            if remote:
                self._last_remote_ts = time.monotonic()
            if info is None:
                continue
            last_seen = info
            if hint is None and info.title:
                hint = info.title
            if info.dimensions is not None:
                if self.cache is not None:
                    self.cache.put(info)
                return self._result(jan, info, from_cache=False)

        # 3) どこからもサイズが取れなかった。商品名等が拾えていれば記録する。
        if self.cache is not None and last_seen is not None:
            self.cache.put(last_seen)
        return self._result(jan, last_seen, from_cache=False)

    @staticmethod
    def _result(jan: str, info: Optional[ProductInfo], from_cache: bool) -> LookupResult:
        if info is None:
            return LookupResult(jan, None, None, None, None, from_cache)
        return LookupResult(
            jan=jan,
            dimensions=info.dimensions,
            source=info.source,
            title=info.title,
            raw_text=info.raw_text,
            from_cache=from_cache,
        )
