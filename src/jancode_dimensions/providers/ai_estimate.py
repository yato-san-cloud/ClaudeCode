"""Claude API で商品名から三辺サイズを推定するプロバイダ(ROMS方式)。

「JAN→正確な三辺サイズ」の無料DBは存在しないため、市販の梱包支援SaaSと
同じく、商品名からLLMがパッケージサイズを推定するアプローチを取る。
あくまで推定値であり、結果は 備考 列に「AI推定(要確認)」と明示される。

- 商品名(title_hint)が無い場合は推定しない(JAN番号だけからの推定は
  ハルシネーションリスクが高すぎるため)
- structured outputs (output_config.format) でJSONスキーマを強制するため、
  応答のパース失敗は起きない
- 推定結果はキャッシュに蓄積され、同じJANを再度推定することはない

要: 環境変数 ANTHROPIC_API_KEY (https://console.anthropic.com/)
依存: anthropic パッケージ (pip install anthropic)
"""

from __future__ import annotations

import json
from typing import Optional

from ..models import Dimensions, ProductInfo
from .base import DimensionProvider

DEFAULT_MODEL = "claude-opus-4-8"

_SYSTEM = (
    "あなたはEC物流の梱包サイズ見積もりの専門家です。"
    "与えられた商品名(と参考のJANコード)から、その商品の小売パッケージ"
    "(外装・外箱)のおおよその三辺サイズをcm単位で推定してください。"
    "宅配便の箱選定に使うため、迷ったら実寸よりわずかに大きめに見積もってください。"
    "商品名から商品カテゴリすら特定できない場合は estimable を false にしてください。"
)

_SCHEMA = {
    "type": "object",
    "properties": {
        "estimable": {
            "type": "boolean",
            "description": "商品を特定または類推でき、サイズを推定できたか",
        },
        "width_cm": {"type": "number", "description": "幅(cm)。estimable=falseなら0"},
        "depth_cm": {"type": "number", "description": "奥行(cm)。estimable=falseなら0"},
        "height_cm": {"type": "number", "description": "高さ(cm)。estimable=falseなら0"},
        "confidence": {
            "type": "string",
            "enum": ["high", "medium", "low"],
            "description": "推定の確からしさ",
        },
    },
    "required": ["estimable", "width_cm", "depth_cm", "height_cm", "confidence"],
    "additionalProperties": False,
}


class AiEstimateProvider(DimensionProvider):
    name = "ai_estimate"
    is_remote = True

    def __init__(self, model: str = DEFAULT_MODEL, client=None) -> None:
        self.model = model
        self._client = client  # テスト用にスタブを注入できる
        if client is None:
            # lookup 内のエラーは握りつぶす契約なので、依存の欠如だけは
            # ここで検出して分かりやすく失敗させる(全行が黙って未取得になるのを防ぐ)。
            try:
                import anthropic  # noqa: F401
            except ImportError as e:
                raise ValueError(
                    "ai プロバイダには anthropic パッケージが必要です: pip install anthropic"
                ) from e

    def _get_client(self):
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic()
        return self._client

    def lookup(self, jan: str, title_hint: Optional[str] = None) -> Optional[ProductInfo]:
        title = str(title_hint).strip() if title_hint is not None else ""
        if not title:
            return None

        try:
            response = self._get_client().messages.create(
                model=self.model,
                max_tokens=512,
                system=_SYSTEM,
                output_config={"format": {"type": "json_schema", "schema": _SCHEMA}},
                messages=[
                    {"role": "user", "content": f"商品名: {title}\nJANコード: {jan}"}
                ],
            )
            if response.stop_reason == "refusal":
                return None
            text = next(b.text for b in response.content if b.type == "text")
            data = json.loads(text)
        except Exception:
            return None

        if not data.get("estimable"):
            return None
        try:
            w = float(data["width_cm"])
            d = float(data["depth_cm"])
            h = float(data["height_cm"])
        except (KeyError, TypeError, ValueError):
            return None
        if w <= 0 or d <= 0 or h <= 0:
            return None

        return ProductInfo(
            jan=jan,
            source=self.name,
            title=None,  # 照合ではなく推定なので照合商品名は出さない
            dimensions=Dimensions(w, d, h).rounded(),
            raw_text=f"AI推定 model={self.model} confidence={data.get('confidence')}",
        )
