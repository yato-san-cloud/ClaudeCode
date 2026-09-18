"""保管戦略 — フリーロケ vs 固定ロケ(リザーブ＋アクティブ) の解析的レコメンド.

Slotting decides *where* a SKU sits; storage strategy decides *how the address
behaves*: free-location (any tote anywhere, density-first) vs fixed-location
(a SKU owns its golden-zone アクティブ pick face, replenished from a bulk リザーブ
behind / above — double-transaction). The trade-off is the eternal one:

    固定ロケ(リザーブ＋アクティブ)  → 歩行短縮 (fast movers in a dense golden zone)
                                       but adds 補充(replenishment) 工数
    フリーロケ                       → 補充ゼロ・保管密度↑ but pick walk grows / no
                                       golden zone

We pick per-SKU from velocity / cube / turnover, then roll up an overall
recommendation, the reserve+active split for the fast movers, an estimated
補充 move count/day, and the 歩行短縮 vs 補充工数 trade-off. Analytic only, no sim.
"""

from __future__ import annotations

from whsim.schema.model import Item, WarehouseModel

# Thresholds (velocity is a demand SHARE in [0,1]; cube uses case_qty as a proxy).
FAST_SHARE = 0.6      # cumulative demand share that defines the "fast" head
BULKY_CASE_QTY = 24   # case_qty at/above which a SKU is "bulky" → density matters
# Active pick face holds this many days of demand before a 補充 is triggered.
ACTIVE_DAYS_DEFAULT = 1.0


def _total_picks_per_day(model: WarehouseModel) -> float:
    """Daily pick lines from the outbound orders (fallback: profile / nominal).

    The outbound list is a SAMPLE of orders (often one representative day after
    ingest), so its total line count is a good daily-lines proxy. If empty, use
    the OrderProfile (rate × lines × shift); last resort a nominal 1000/day."""
    out = model.orders.outbound or []
    lines = sum(len(o.lines or []) for o in out)
    if lines > 0:
        return float(lines)
    prof = model.orders.profile
    if prof and prof.rate_per_hr > 0:
        shift_h = getattr(model.simulation, "shift_hours_per_day", 8.0) or 8.0
        return prof.rate_per_hr * prof.lines_per_order_mean * shift_h
    return 1000.0


def _classify(it: Item, share_rank: float) -> str:
    """Per-SKU strategy: 'reserve_active' (fixed golden zone + bulk reserve),
    'free' (free-location, density-first), or 'fixed' (plain fixed, mid movers).

      fast + small  → reserve_active  (golden zone pays for its 補充)
      slow / bulky  → free            (density beats walk; 補充工数 not worth it)
      else          → fixed           (a stable home, no double-transaction)
    """
    bulky = (it.case_qty or 1) >= BULKY_CASE_QTY
    fast = share_rank <= FAST_SHARE
    if fast and not bulky:
        return "reserve_active"
    if not fast or bulky:
        return "free"
    return "fixed"


def recommend(model: WarehouseModel, params: dict | None = None) -> dict:
    """Per-SKU + overall storage-strategy recommendation (analytic, no sim)."""
    params = params or {}
    active_days = float(params.get("active_days") or ACTIVE_DAYS_DEFAULT)

    items = [it for it in model.items if it.sku]
    if not items:
        return {
            "available": False,
            "recommended_mode": "free",
            "message": "商品データがありません。基礎物量を取り込むと保管戦略を提案します。",
        }

    picks_per_day = _total_picks_per_day(model)
    total_freq = sum(max(0.0, it.pick_freq) for it in items) or 1.0

    # Rank SKUs by velocity desc; cumulative demand share defines the fast head.
    ranked = sorted(items, key=lambda it: (-max(0.0, it.pick_freq), it.sku))
    cum = 0.0
    rows = []
    reserve_active = free = fixed = 0
    replen_moves_per_day = 0.0
    for it in ranked:
        freq = max(0.0, it.pick_freq)
        # share_rank = cumulative demand share at the START of this SKU (exclusive
        # prefix), so the top mover always sits at 0.0 and qualifies as the head.
        share_rank = cum / total_freq
        cum += freq
        mode = _classify(it, share_rank)
        if mode == "reserve_active":
            reserve_active += 1
            # 補充: this SKU's pick face holds active_days of demand; each refill
            # is one bulk→active move. Daily refills ≈ daily demand / active stock.
            daily_lines = freq / total_freq * picks_per_day
            active_stock = max(1.0, (it.case_qty or 1) * active_days * 1.0)
            # one refill per active_stock units consumed (case-grained move).
            daily_units = daily_lines * (it.case_qty or 1)
            replen_moves_per_day += daily_units / active_stock if active_stock else 0.0
        elif mode == "free":
            free += 1
        else:
            fixed += 1
        rows.append({
            "sku": it.sku, "name": it.name or it.sku,
            "pick_freq": round(freq, 4),
            "case_qty": it.case_qty or 1,
            "share_rank": round(share_rank, 4),
            "mode": mode,
        })

    n = len(items)
    # Overall mode: if the fast head is a meaningful slice, a hybrid fixed
    # (reserve+active for fast, free for the long tail) is the recommendation.
    if reserve_active >= max(1, int(0.05 * n)):
        overall = "reserve_active"
        overall_jp = "固定ロケ（リザーブ＋アクティブ：ダブルトランザクション）"
    elif free > fixed:
        overall = "free"
        overall_jp = "フリーロケーション"
    else:
        overall = "fixed"
        overall_jp = "固定ロケーション"

    # Trade-off framing: golden-zone walk saving vs the replenishment labour it costs.
    # Walk saving proxy: the fast head in a golden zone roughly halves their pick
    # walk; express as a share of total pick travel they represent.
    fast_share = sum(max(0.0, it.pick_freq) for it, r in zip(ranked, rows)
                     if r["mode"] == "reserve_active") / total_freq

    return {
        "available": True,
        "recommended_mode": overall,
        "recommended_mode_jp": overall_jp,
        "counts": {"reserve_active": reserve_active, "free": free, "fixed": fixed, "total": n},
        "reserve_active_split": {
            "active_skus": reserve_active,
            "active_days": active_days,
            "note": "アクティブ（ピック面）は需要の速い頭、バックにリザーブ（補充元）。",
        },
        "replenishment": {
            "moves_per_day": round(replen_moves_per_day, 1),
            "note": "リザーブ→アクティブの補充回数/日（解析推定）。",
        },
        "tradeoff": {
            "walk_reduction_share": round(fast_share, 4),
            "replen_moves_per_day": round(replen_moves_per_day, 1),
            "summary": (
                f"速い頭{reserve_active}SKU（出荷の{round(fast_share * 100)}%）を"
                f"ゴールデンゾーンに固定→歩行短縮。代償は補充"
                f"{round(replen_moves_per_day)}回/日。"
                if reserve_active else
                "速い頭が薄く、フリーロケで保管密度を優先するのが有利。補充工数ゼロ。"
            ),
        },
        "skus": rows[:50],
        "skus_total": n,
        "picks_per_day": round(picks_per_day, 1),
    }
