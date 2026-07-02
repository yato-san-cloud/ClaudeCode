"""三辺サイズの取得元(プロバイダ)群。

取得元は後から差し替え・追加できるよう、共通インターフェース
``DimensionProvider`` を実装する。標準では以下を提供する:

- LocalMasterProvider : 自社マスタ(CSV/手入力)。最も確実。外部依存なし。
- RakutenProvider     : 楽天市場 商品検索API(説明文からのテキスト抽出)。要APIキー。
- YahooProvider       : Yahoo!ショッピング 商品検索API v3(同上)。要APIキー。
- AiEstimateProvider  : Claude API による商品名からのサイズ推定(ROMS方式)。要APIキー。
"""

from .ai_estimate import AiEstimateProvider
from .base import DimensionProvider
from .local_master import LocalMasterProvider
from .rakuten import RakutenProvider
from .yahoo import YahooProvider

__all__ = [
    "AiEstimateProvider",
    "DimensionProvider",
    "LocalMasterProvider",
    "RakutenProvider",
    "YahooProvider",
]
