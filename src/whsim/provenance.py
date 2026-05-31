"""Provenance: where each part of the model came from.

This is a first-class feature, not bookkeeping. It is what lets the product be
*easy* (auto-fill everything from a template) and *trustworthy* (never silently
present invented numbers as real). The same map is the future LLM dialogue's
to-do list: it only needs to ask about subtrees still marked ``provisional``.
"""

from __future__ import annotations

from enum import Enum

from whsim.schema.model import MERGEABLE_SUBTREES


# Business-facing Japanese labels for schema subtrees (no raw identifiers to users).
_JP = {
    "meta": "基本情報",
    "layout": "レイアウト",
    "locations": "ロケーション",
    "items": "商品マスタ",
    "process": "オペレーション",
    "resources": "人員・設備",
    "orders": "出荷・入荷データ",
    "simulation": "実行条件",
}


class Source(str, Enum):
    IMPORTED = "imported"        # came from the customer's dropped data
    INTERVIEW = "interview"      # the salesperson confirmed/typed it
    PROVISIONAL = "provisional"  # template default, nobody has touched it


class Provenance:
    """Per-subtree source tracking for one project model."""

    def __init__(self, template_id: str, subtrees: dict[str, str] | None = None):
        self.template_id = template_id
        # Every subtree starts as a provisional template default.
        self.subtrees: dict[str, Source] = {
            name: Source.PROVISIONAL for name in MERGEABLE_SUBTREES
        }
        if subtrees:
            for k, v in subtrees.items():
                if k in self.subtrees:
                    self.subtrees[k] = Source(v)

    def mark(self, subtree: str, source: Source) -> None:
        if subtree in self.subtrees:
            self.subtrees[subtree] = source

    def confidence(self) -> float:
        """Fraction of subtrees backed by real input (imported or confirmed)."""
        if not self.subtrees:
            return 0.0
        real = sum(1 for s in self.subtrees.values() if s is not Source.PROVISIONAL)
        return real / len(self.subtrees)

    def summary(self) -> str:
        imported = [_JP.get(k, k) for k, v in self.subtrees.items()
                    if v is Source.IMPORTED]
        provisional = [_JP.get(k, k) for k, v in self.subtrees.items()
                       if v is Source.PROVISIONAL]
        pct = round(self.confidence() * 100)
        return (
            f"実データ {pct}% ／ "
            f"取り込み済み: {('・'.join(imported)) or 'なし'} ／ "
            f"テンプレ仮値: {('・'.join(provisional)) or 'なし'}"
        )

    def to_dict(self) -> dict:
        return {
            "template_id": self.template_id,
            "subtrees": {k: v.value for k, v in self.subtrees.items()},
            "confidence": self.confidence(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Provenance":
        return cls(d.get("template_id", ""), d.get("subtrees"))
