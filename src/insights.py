"""Rule-based insight engine — surfaces 3PL 業務の注目ポイントを自動抽出.

Keyence 流: 「分析画面を見に行く」のではなく「気付きを向こうから渡してくる」
ように、KPIs と分析結果から自然言語のインサイトを生成する。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable

import numpy as np
import pandas as pd

# severity: 'critical' (要対応), 'warning' (要注視), 'info' (参考)
# category: 'volume', 'sku', 'inventory', 'peak', 'efficiency', 'balance'

_ICON = {"critical": "🚨", "warning": "⚠️", "info": "💡"}


@dataclass(frozen=True)
class Insight:
    severity: str
    category: str
    title: str
    detail: str
    metric: str | None = None        # 数値の文字列表現 (例 "+24.5%")
    suggestion: str | None = None    # 改善のヒント

    @property
    def icon(self) -> str:
        return _ICON.get(self.severity, "•")


# ─────────────────────────────────────────────────────────────────────────────
# 個別ディテクタ
# ─────────────────────────────────────────────────────────────────────────────
def detect_volume_trend(shipments: pd.DataFrame | None, window: int = 7) -> list[Insight]:
    """直近 window 日 vs その前 window 日の出荷量比較。"""
    if shipments is None or shipments.empty or "date" not in shipments.columns:
        return []
    daily = shipments.groupby(shipments["date"].dt.normalize())["qty"].sum().sort_index()
    if len(daily) < window * 2:
        return []
    recent = daily.iloc[-window:].sum()
    prev = daily.iloc[-2 * window:-window].sum()
    if prev <= 0:
        return []
    change = (recent - prev) / prev
    pct = f"{change * 100:+.1f}%"
    if change >= 0.15:
        return [Insight(
            "warning", "volume",
            f"直近 {window} 日の出荷量が前期比 {pct} の増加トレンド",
            f"前 {window} 日: {prev:,.0f} pcs → 直近 {window} 日: {recent:,.0f} pcs",
            pct, "ピッキング・配送リソースの増強を検討。要員シフトを 1〜2 名増。",
        )]
    if change <= -0.15:
        return [Insight(
            "warning", "volume",
            f"直近 {window} 日の出荷量が前期比 {pct} の減少トレンド",
            f"前 {window} 日: {prev:,.0f} pcs → 直近 {window} 日: {recent:,.0f} pcs",
            pct, "減少要因(取引先別・SKU別)をドリルダウンで確認。",
        )]
    return [Insight(
        "info", "volume",
        f"出荷量は安定推移(直近 {window} 日 vs 前 {window} 日: {pct})",
        f"前 {window} 日: {prev:,.0f} pcs / 直近 {window} 日: {recent:,.0f} pcs",
        pct,
    )]


def detect_anomaly_days(shipments: pd.DataFrame | None, z_thresh: float = 2.0, top_n: int = 3) -> list[Insight]:
    """日次出荷量の z-score 外れ値検出。"""
    if shipments is None or shipments.empty or "date" not in shipments.columns:
        return []
    daily = shipments.groupby(shipments["date"].dt.normalize())["qty"].sum().sort_index()
    if len(daily) < 10:
        return []
    mu, sd = daily.mean(), daily.std(ddof=0)
    if sd == 0:
        return []
    z = (daily - mu) / sd
    spikes = z[z >= z_thresh].sort_values(ascending=False).head(top_n)
    dips = z[z <= -z_thresh].sort_values().head(top_n)
    out: list[Insight] = []
    for d, zv in spikes.items():
        out.append(Insight(
            "critical" if zv >= 3 else "warning",
            "volume",
            f"{d:%Y-%m-%d} に物量スパイク (z={zv:+.1f}σ)",
            f"その日の出荷量 {daily[d]:,.0f} pcs は平均 {mu:,.0f} pcs を大きく上回る",
            f"{daily[d] / mu - 1:+.0%}",
            "繁忙日の要員配置をベースシナリオに加える。曜日要因か単発か原因切り分けを推奨。",
        ))
    for d, zv in dips.items():
        out.append(Insight(
            "info", "volume",
            f"{d:%Y-%m-%d} に物量ディップ (z={zv:+.1f}σ)",
            f"その日の出荷量 {daily[d]:,.0f} pcs は平均 {mu:,.0f} pcs を大きく下回る",
            f"{daily[d] / mu - 1:+.0%}",
        ))
    return out


def detect_sku_concentration(shipments: pd.DataFrame | None, top_pct: float = 0.05, threshold: float = 0.5) -> list[Insight]:
    """上位 top_pct の SKU が物量の threshold 超を占めるなら依存リスク警告。"""
    if shipments is None or shipments.empty or "sku" not in shipments.columns:
        return []
    sku_qty = shipments.groupby("sku")["qty"].sum().sort_values(ascending=False)
    total = sku_qty.sum()
    if total <= 0:
        return []
    n = max(1, int(round(len(sku_qty) * top_pct)))
    top_share = sku_qty.head(n).sum() / total
    if top_share >= threshold:
        return [Insight(
            "warning", "sku",
            f"上位 {top_pct:.0%} の SKU({n} 品)が物量の {top_share:.0%} を占有",
            "少数 SKU への依存が高く、欠品時のインパクトが大きい構造。",
            f"{top_share:.0%}",
            "重点 SKU は安全在庫を厚めに / 代替 SKU の育成検討。",
        )]
    return []


def detect_partner_dependence(shipments: pd.DataFrame | None, threshold: float = 0.30) -> list[Insight]:
    """取引先依存度。"""
    if shipments is None or shipments.empty or "partner" not in shipments.columns:
        return []
    pq = shipments.groupby("partner")["qty"].sum().sort_values(ascending=False)
    if pq.sum() <= 0:
        return []
    top = pq.iloc[0]
    share = top / pq.sum()
    if share >= threshold:
        return [Insight(
            "warning", "sku",
            f"{pq.index[0]} 1 社が物量の {share:.0%} を占有",
            "取引先集中度が高い。1 社減便の影響が大きい。",
            f"{share:.0%}",
            "顧客分散の営業戦略 / 専用ライン化の効率検討を推奨。",
        )]
    return []


def detect_peak_concentration(shipments: pd.DataFrame | None) -> list[Insight]:
    """曜日 / 時間帯ピークの偏りを検出。"""
    if shipments is None or shipments.empty:
        return []
    out: list[Insight] = []
    labels = ["月", "火", "水", "木", "金", "土", "日"]
    if "date" in shipments.columns:
        wd = shipments.groupby(shipments["date"].dt.weekday).size()
        if not wd.empty and wd.max() > 0:
            ratio = wd.max() / max(wd.min(), 1)
            if ratio >= 3:
                top_label = labels[int(wd.idxmax())]
                min_label = labels[int(wd.idxmin())]
                out.append(Insight(
                    "warning", "peak",
                    f"曜日偏りが大きい({top_label}が{min_label}の {ratio:.1f} 倍)",
                    f"{top_label}: {int(wd.max()):,} 件 / {min_label}: {int(wd.min()):,} 件",
                    f"x{ratio:.1f}",
                    f"{top_label}の人員シフトを厚く配置。曜日別 KPI でドリルダウン推奨。",
                ))
    if "timestamp" in shipments.columns:
        hr = shipments.groupby(shipments["timestamp"].dt.hour)["qty"].sum()
        if not hr.empty and hr.sum() > 0:
            top_share = hr.max() / hr.sum()
            top_hour = int(hr.idxmax())
            if top_share >= 0.20:
                out.append(Insight(
                    "info", "peak",
                    f"{top_hour:02d}:00 台に物量の {top_share:.0%} が集中",
                    "短時間にピークが寄っている。波動対策の余地あり。",
                    f"{top_share:.0%}",
                    f"{top_hour - 1:02d}:00〜{top_hour + 1:02d}:00 の応援人員 / 締め時間調整を検討。",
                ))
    return out


def detect_inbound_outbound_balance(shipments: pd.DataFrame | None, inbound: pd.DataFrame | None) -> list[Insight]:
    """入荷 vs 出荷の差。"""
    if shipments is None or inbound is None or shipments.empty or inbound.empty:
        return []
    s, i = float(shipments["qty"].sum()), float(inbound["qty"].sum())
    if s <= 0:
        return []
    delta = (i - s) / s
    if delta >= 0.30:
        return [Insight(
            "warning", "balance",
            f"入荷が出荷を {delta:+.0%} 上回る(在庫増局面)",
            f"出荷 {s:,.0f} pcs / 入荷 {i:,.0f} pcs",
            f"{delta:+.0%}",
            "保管スペース・滞留リスクを確認。発注量の見直しを検討。",
        )]
    if delta <= -0.30:
        return [Insight(
            "critical", "balance",
            f"入荷が出荷を {-delta:.0%} 下回る(在庫減局面)",
            f"出荷 {s:,.0f} pcs / 入荷 {i:,.0f} pcs",
            f"{delta:+.0%}",
            "欠品リスクあり。発注タイミング・リードタイムの見直しを推奨。",
        )]
    return []


def detect_dead_stock(turnover_df: pd.DataFrame | None) -> list[Insight]:
    """デッドストック数 / 比率からの警告。"""
    if turnover_df is None or turnover_df.empty:
        return []
    n_total = len(turnover_df)
    n_dead = int(turnover_df["dead_stock"].sum())
    if n_total == 0:
        return []
    rate = n_dead / n_total
    if rate >= 0.20:
        return [Insight(
            "critical", "inventory",
            f"デッドストック SKU が {n_dead:,} 品(全体の {rate:.0%})",
            "保管費の負担が大きい。早期に処分 / 値引き販売の判断を。",
            f"{rate:.0%}",
            "デッドストック上位の処分計画を策定 / 仕入元へ返品・引取可否確認。",
        )]
    if rate >= 0.10:
        return [Insight(
            "warning", "inventory",
            f"デッドストック SKU が {n_dead:,} 品(全体の {rate:.0%})",
            "判定期間で動いていない在庫が一定割合存在する。",
            f"{rate:.0%}",
            "棚卸し / ロケーション最適化と合わせて処分計画を検討。",
        )]
    return []


def detect_stockout_risk(turnover_df: pd.DataFrame | None, days_threshold: int = 7, top_n: int = 5) -> list[Insight]:
    """供給可能日数が短い高回転 SKU。"""
    if turnover_df is None or turnover_df.empty or "days_supply" not in turnover_df.columns:
        return []
    risk = turnover_df[(turnover_df["shipped_qty"] > 0) & (turnover_df["days_supply"] <= days_threshold)]
    risk = risk.sort_values("days_supply").head(top_n)
    if risk.empty:
        return []
    top_skus = ", ".join(risk["sku"].astype(str).tolist())
    return [Insight(
        "critical", "inventory",
        f"欠品リスクの高い SKU が {len(risk):,} 品(供給日数 < {days_threshold} 日)",
        f"対象: {top_skus}",
        f"{len(risk):,} 品",
        "追加発注 / 安全在庫の引き上げ。仕入リードタイムと合わせて再計算。",
    )]


def detect_multi_line_efficiency(kpis: dict) -> list[Insight]:
    """マルチライン率 / 行/PS から効率の余地を示唆。"""
    out: list[Insight] = []
    lpo = kpis.get("lines_per_order")
    mlr = kpis.get("multi_line_rate")
    if lpo is None or (isinstance(lpo, float) and math.isnan(lpo)):
        return out
    if lpo >= 4:
        out.append(Insight(
            "info", "efficiency",
            f"行/PS が {lpo:.1f} と多め(マルチライン率 {mlr:.0%})",
            "1 オーダーあたりの行数が多く、マルチピックの最適化効果が大きい構造。",
            f"{lpo:.1f}",
            "トータルピッキング / ゾーニング / ピックパス最適化のインパクト大。",
        ))
    elif lpo <= 1.3:
        out.append(Insight(
            "info", "efficiency",
            f"行/PS が {lpo:.2f} と少なめ(シングルライン中心)",
            "1 行注文が大半。物量よりも PS 数(伝票枚数)が処理速度のボトルネック。",
            f"{lpo:.2f}",
            "PS あたりの段取りを短縮(出荷ラベル一括 / バッチ梱包)を検討。",
        ))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 集約
# ─────────────────────────────────────────────────────────────────────────────
def generate_insights(
    shipments: pd.DataFrame | None,
    inbound: pd.DataFrame | None,
    inventory: pd.DataFrame | None,
    kpis: dict,
    turnover_df: pd.DataFrame | None,
) -> list[Insight]:
    """全ディテクタを実行し severity 順 (critical → warning → info) で返す。"""
    detectors: list[Iterable[Insight]] = [
        detect_volume_trend(shipments),
        detect_anomaly_days(shipments),
        detect_sku_concentration(shipments),
        detect_partner_dependence(shipments),
        detect_peak_concentration(shipments),
        detect_inbound_outbound_balance(shipments, inbound),
        detect_dead_stock(turnover_df),
        detect_stockout_risk(turnover_df),
        detect_multi_line_efficiency(kpis),
    ]
    out: list[Insight] = []
    for d in detectors:
        out.extend(d)
    order = {"critical": 0, "warning": 1, "info": 2}
    out.sort(key=lambda i: order.get(i.severity, 99))
    return out


__all__ = ["Insight", "generate_insights"]
