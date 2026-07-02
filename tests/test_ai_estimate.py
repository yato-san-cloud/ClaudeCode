import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from jancode_dimensions.providers.ai_estimate import AiEstimateProvider  # noqa: E402


class StubMessages:
    """anthropic クライアントの messages.create を模したスタブ。"""

    def __init__(self, payload=None, stop_reason="end_turn", error=None):
        self.payload = payload
        self.stop_reason = stop_reason
        self.error = error
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="text", text=json.dumps(self.payload))],
        )


def _provider(payload=None, stop_reason="end_turn", error=None):
    messages = StubMessages(payload, stop_reason, error)
    client = SimpleNamespace(messages=messages)
    return AiEstimateProvider(client=client), messages


def test_estimates_from_title():
    provider, messages = _provider(
        {"estimable": True, "width_cm": 30, "depth_cm": 20, "height_cm": 10, "confidence": "medium"}
    )
    info = provider.lookup("4901234567894", title_hint="サンプル商品A 500ml×24本")
    assert info is not None
    assert info.source == "ai_estimate"
    assert info.dimensions.total_cm == 60.0
    assert "confidence=medium" in info.raw_text

    # リクエスト内容: モデル・structured output・商品名の埋め込みを確認
    kwargs = messages.calls[0]
    assert kwargs["model"] == "claude-opus-4-8"
    assert kwargs["output_config"]["format"]["type"] == "json_schema"
    assert "サンプル商品A" in kwargs["messages"][0]["content"]


def test_no_title_hint_skips_api_call():
    provider, messages = _provider({"estimable": True})
    assert provider.lookup("4901234567894") is None
    assert provider.lookup("4901234567894", title_hint="   ") is None
    assert messages.calls == []  # 商品名なしではAPIを呼ばない


def test_not_estimable_returns_none():
    provider, _ = _provider(
        {"estimable": False, "width_cm": 0, "depth_cm": 0, "height_cm": 0, "confidence": "low"}
    )
    assert provider.lookup("4901234567894", title_hint="謎の商品") is None


def test_invalid_dimensions_returns_none():
    provider, _ = _provider(
        {"estimable": True, "width_cm": -5, "depth_cm": 20, "height_cm": 10, "confidence": "low"}
    )
    assert provider.lookup("4901234567894", title_hint="商品") is None


def test_refusal_returns_none():
    provider, _ = _provider(
        {"estimable": True, "width_cm": 1, "depth_cm": 1, "height_cm": 1, "confidence": "high"},
        stop_reason="refusal",
    )
    assert provider.lookup("4901234567894", title_hint="商品") is None


def test_api_error_returns_none():
    provider, _ = _provider(error=RuntimeError("network down"))
    assert provider.lookup("4901234567894", title_hint="商品") is None


def test_custom_model():
    messages = StubMessages(
        {"estimable": True, "width_cm": 1, "depth_cm": 1, "height_cm": 1, "confidence": "high"}
    )
    provider = AiEstimateProvider(
        model="claude-haiku-4-5", client=SimpleNamespace(messages=messages)
    )
    provider.lookup("4901234567894", title_hint="商品")
    assert messages.calls[0]["model"] == "claude-haiku-4-5"
