"""時間帯波形から1日の到着系列を組み立てる (hourly demand shape → arrivals).

狙い: これで「一様投入の臨界点」ではなく「**実際の時間帯波形での臨界点**」が出せる
— 6時に97件・7時に865件と来る現場は、同じ日量でも一様ポアソンとは別の倉庫になる。

現状の需要は2択だった: ``orders.profile.rate_per_hr``（一様ポアソン）か、取り込んだ
実オーダー（``arrival_s`` 付き＝``analysis.ingest``）。ところが実務でまず出てくるのは
明細ではなく**時間帯別の件数表**（6時 97件, 7時 865件, …, 21時 9件）1枚だけ、という
ことが多い。その1枚を捨てずに DES へ渡すのがこのモジュール。

規約:

* ``arrival_s`` は **0 時起点の秒**（``ingest`` と同じ土俵＝BI の
  ``floor(arrival_s/3600)%24`` がそのまま実時刻になる）。返すのは
  :class:`whsim.schema.model.Order` のリストで、``orders.outbound`` へそのまま入る。
* 時間帯**内**は一様ランダム、seed 固定＝**同じ入力から常に同じ系列**（再現性）。
* 明細(SKU)はここでは発明しない: 呼び出し側が ``skus=`` を渡すか、
  :func:`apply_to_model` がモデルの ``items``（＝エンジンが実際に拾える SKU）から
  引く。渡されなければ明細ゼロの Order を返す（never blocks; 件数だけの波形として
  人員/入荷側の検討には使える）。
* 取込は寛容: 壊れた行は**数えて落とす**、致命的にしない。
"""

from __future__ import annotations

import math
import random
import re
import unicodedata
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from whsim.schema.model import Order, OrderLine

__all__ = [
    "apply_to_model",
    "describe",
    "from_hourly",
    "normalise_hourly",
    "read_hourly_csv",
]

# Column-name hints for the tolerant CSV reader (folded/substring-matched by
# analysis.data_io.guess_column, so 全角・半角カナ・大文字小文字は吸収される).
HOUR_HINTS: tuple[str, ...] = ("時間帯", "時間", "時刻", "時", "hour", "hh", "time")
COUNT_HINTS: tuple[str, ...] = (
    "件数", "オーダー数", "受注件数", "出荷件数", "注文数", "出荷数", "行数", "数量",
    "count", "orders", "qty", "volume", "件",
)

# A day's worth of drain time appended to the window so the last hour's orders can
# actually finish (mirrors engine.run.representative_day's 2h tail).
_DRAIN_TAIL_S = 2 * 3600.0


# --- normalisation ------------------------------------------------------------

def normalise_hourly(hourly: Any) -> dict[int, float]:
    """任意の「時間帯→件数」表現 → ``{0..23: count>=0}``（寛容・決定論的）。

    dict / [(hour, count)] / [{"hour": h, "count": c}] / 24 個の並び を受ける。
    範囲外の時・負数・数にならない値は**黙って落とす**（同じ時が重複したら足す）。
    """
    pairs: list[tuple[Any, Any]] = []
    if isinstance(hourly, Mapping):
        pairs = list(hourly.items())
    elif isinstance(hourly, (list, tuple)):
        seq = list(hourly)
        if seq and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in seq):
            pairs = list(enumerate(seq))          # bare 24-slot vector
        else:
            for it in seq:
                if isinstance(it, Mapping):
                    h = it.get("hour", it.get("時", it.get("h")))
                    c = it.get("count", it.get("件数", it.get("orders", it.get("n"))))
                    pairs.append((h, c))
                elif isinstance(it, (list, tuple)) and len(it) >= 2:
                    pairs.append((it[0], it[1]))
    out: dict[int, float] = {}
    for h, c in pairs:
        hour = _parse_hour(h)
        cnt = _parse_count(c)
        if hour is None or cnt is None:
            continue
        out[hour] = out.get(hour, 0.0) + cnt
    return dict(sorted(out.items()))


def _parse_hour(v: Any) -> int | None:
    """"6" / "06:00" / "6時" / "6〜7時" / 6.0 / Timestamp → 0..23（不可なら None）。"""
    if v is None or isinstance(v, bool):
        return None
    hour = getattr(v, "hour", None)
    if hour is not None and not isinstance(v, (int, float, str)):
        try:
            return int(hour) if 0 <= int(hour) <= 23 else None
        except (TypeError, ValueError):
            return None
    if isinstance(v, (int, float)):
        if not math.isfinite(v):             # NaN / inf
            return None
        h = int(v)
        return h if 0 <= h <= 23 else None
    s = unicodedata.normalize("NFKC", str(v)).strip()
    if not s:
        return None
    m = re.match(r"^\D*?(\d{1,2})", s)
    if not m:
        return None
    h = int(m.group(1))
    return h if 0 <= h <= 23 else None


def _parse_count(v: Any) -> float | None:
    """"1,234" / "97件" / 97 / 97.0 → float>=0（不可・負数なら None）。"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) and f >= 0 else None
    s = unicodedata.normalize("NFKC", str(v)).strip().replace(",", "").replace(" ", "")
    if not s:
        return None
    m = re.match(r"^[-+]?\d*\.?\d+", s)
    if not m:
        return None
    try:
        f = float(m.group(0))
    except ValueError:
        return None
    return f if math.isfinite(f) and f >= 0 else None


def describe(hourly: Any) -> dict:
    """波形のひと目サマリ: ``{total, peak_hour, peak_count, peak_share, hours, …}``。

    ``peak_share`` は「ピーク時間帯が1日の何割か」— 一様投入なら 1/稼働時間 に
    なるので、その乖離がそのまま「均さないと詰まる度合い」になる。
    """
    h = normalise_hourly(hourly)
    total = float(sum(h.values()))
    active = {k: v for k, v in h.items() if v > 0}
    peak_hour = max(active, key=lambda k: (active[k], -k)) if active else None
    peak_count = float(active[peak_hour]) if peak_hour is not None else 0.0
    return {
        "total": round(total, 3),
        "peak_hour": peak_hour,
        "peak_count": round(peak_count, 3),
        "peak_share": round(peak_count / total, 4) if total > 0 else 0.0,
        "active_hours": len(active),
        "first_hour": min(active) if active else None,
        "last_hour": max(active) if active else None,
        "mean_count": round(total / len(active), 3) if active else 0.0,
        "hours": [{"hour": k, "count": round(float(v), 3),
                   "share": round(v / total, 4) if total > 0 else 0.0}
                  for k, v in sorted(h.items())],
    }


# --- arrivals -----------------------------------------------------------------

def _allocate(counts: dict[int, float], total_orders: int | None) -> dict[int, int]:
    """件数を整数の到着本数へ（``total_orders`` 指定時は最大剰余法で総数ぴったり）。"""
    if not counts:
        return {}
    if total_orders is None:
        return {h: round(c) for h, c in counts.items() if round(c) > 0}
    target = max(0, int(total_orders))
    raw_total = float(sum(counts.values()))
    if target == 0 or raw_total <= 0:
        return {}
    exact = {h: c / raw_total * target for h, c in counts.items()}
    out = {h: int(v) for h, v in exact.items()}
    short = target - sum(out.values())
    if short > 0:
        # largest remainder; ties resolved by the earlier hour (deterministic)
        order = sorted(exact, key=lambda h: (-(exact[h] - int(exact[h])), h))
        for h in order[:short]:
            out[h] += 1
    return {h: n for h, n in out.items() if n > 0}


def from_hourly(
    hourly: Mapping[int, float] | Sequence[tuple[int, float]],
    total_orders: int | None = None,
    seed: int = 42,
    lines_per_order: float = 1.0,
    skus: Sequence[str] | None = None,
    sku_weights: Sequence[float] | None = None,
    qty_per_line: int = 1,
    prefix: str = "H",
) -> list[Order]:
    """時間帯別件数 → 1日の到着系列（``arrival_s`` は 0 時起点の秒）。

    各時間帯の件数に比例して到着を割り付け、**時間帯内は一様ランダム**（``seed``
    固定なので同じ入力からは常に同じ系列＝再現可能）。``total_orders`` を渡すと
    波形の**形**を保ったままその総数へスケールする（最大剰余法なので合計は厳密）。

    明細は ``skus`` を渡したときだけ作る（``sku_weights`` があればエンジンの
    ``_sample_order`` と同じ重み付き抽選）。``lines_per_order`` は平均で、端数は
    seed 付きベルヌーイで割り振る（例 2.5 → 2行と3行が半々）。
    """
    counts = normalise_hourly(hourly)
    per_hour = _allocate(counts, total_orders)
    if not per_hour:
        return []
    rng = random.Random(seed)

    times: list[float] = []
    for h in sorted(per_hour):
        base = h * 3600.0
        # Clamped BELOW the next hour: a value that rounds up to the boundary would
        # land in the following hour (and 23時 would spill into "day 2", which the
        # engine's busiest-day collapse then treats as a multi-day import).
        times.extend(round(min(base + rng.random() * 3600.0, base + 3599.9), 1)
                     for _ in range(per_hour[h]))
    times.sort()

    pool = [str(s) for s in (skus or []) if str(s)]
    weights = None
    if pool and sku_weights and len(sku_weights) == len(pool):
        w = [max(float(x), 1e-6) for x in sku_weights]
        weights = w if sum(w) > 0 else None
    base_lines = max(0, int(lines_per_order))
    frac = max(0.0, float(lines_per_order) - base_lines)
    qty = max(1, int(qty_per_line))

    orders: list[Order] = []
    for i, t in enumerate(times):
        n_lines = max(1, base_lines + (1 if rng.random() < frac else 0))
        lines: list[OrderLine] = []
        if pool:
            picks = (rng.choices(pool, weights=weights, k=n_lines) if weights
                     else [rng.choice(pool) for _ in range(n_lines)])
            lines = [OrderLine.model_construct(sku=s, qty=qty) for s in picks]
        orders.append(Order.model_construct(order_id=f"{prefix}{i + 1:06d}",
                                            arrival_s=float(t), lines=lines))
    return orders


# --- tolerant CSV ---------------------------------------------------------

def read_hourly_csv(path_or_bytes: Any, filename: str = "") -> dict:
    """時間帯別件数の CSV/Excel を寛容に読む → ``{"hourly", "dropped", …}``。

    見出し行の自動判定・全角/半角・BOM・合計行の除去は
    :mod:`whsim.analysis.data_io` の実装をそのまま使う（同じ現場ファイルを2通りに
    解釈しないため）。列名は「時/時間帯/hour」「件数/注文数/オーダー数/count」等の
    別名に寛容で、見つからなければ**横持ち**（見出しが 0..23 時、値が1行以上）も試す。

    壊れた行は落として数える（``dropped``）— 1行の不備で1枚を捨てない。
    """
    from whsim.analysis import data_io

    name = filename
    if isinstance(path_or_bytes, (bytes, bytearray)):
        raw = bytes(path_or_bytes)
        name = name or "hourly.csv"
    else:
        p = Path(str(path_or_bytes))
        raw = p.read_bytes()
        name = name or p.name
    out: dict = {"hourly": {}, "rows": 0, "used": 0, "dropped": 0, "columns": [],
                 "hour_column": None, "count_column": None, "shape": None,
                 "warnings": []}
    try:
        df = data_io.load_table(raw, name)
    except Exception as e:  # noqa: BLE001 — tolerant: an unreadable file is a warning
        out["warnings"].append(f"表を読み込めませんでした: {e}")
        return out
    if df is None or df.empty:
        out["warnings"].append("データ行がありません。")
        return out
    out["columns"] = [str(c) for c in df.columns]
    out["rows"] = len(df)

    hour_col = data_io.guess_column(df.columns, HOUR_HINTS)
    count_col = data_io.guess_column(df.columns, COUNT_HINTS,
                                     exclude=[hour_col] if hour_col else [])
    if hour_col is not None and count_col is None and len(df.columns) == 2:
        # a 2-column 時間帯×件数 table whose count header we could not name
        count_col = next(c for c in df.columns if c != hour_col)

    acc: dict[int, float] = {}
    if hour_col is not None and count_col is not None:
        out.update({"shape": "long", "hour_column": str(hour_col),
                    "count_column": str(count_col)})
        for h_raw, c_raw in zip(df[hour_col], df[count_col]):
            if _blank(h_raw) and _blank(c_raw):
                continue
            hour, cnt = _parse_hour(h_raw), _parse_count(c_raw)
            if hour is None or cnt is None:
                out["dropped"] += 1
                continue
            acc[hour] = acc.get(hour, 0.0) + cnt
            out["used"] += 1
    else:
        hour_cols = [(c, _parse_hour(c)) for c in df.columns]
        hour_cols = [(c, h) for c, h in hour_cols if h is not None]
        if len(hour_cols) >= 3:
            out["shape"] = "wide"
            for c, h in hour_cols:
                for cell in df[c]:
                    if _blank(cell):
                        continue
                    cnt = _parse_count(cell)
                    if cnt is None:
                        out["dropped"] += 1
                        continue
                    acc[h] = acc.get(h, 0.0) + cnt
                    out["used"] += 1
        else:
            out["warnings"].append(
                "時間帯の列と件数の列を見つけられませんでした（例: 「時」「件数」）。")
            return out
    out["hourly"] = dict(sorted(acc.items()))
    if not acc:
        out["warnings"].append("有効な時間帯別件数がありませんでした。")
    return out


def _blank(v: Any) -> bool:
    """Empty padding cell (None / NaN / whitespace) — skipped, never counted as a
    dropped row: real exports are full of blank filler."""
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    return str(v).strip() == ""


# --- model wiring -------------------------------------------------------------

def apply_to_model(model: Any, hourly: Any, total_orders: int | None = None,
                   seed: int = 42, lines_per_order: float | None = None,
                   set_window: bool = True) -> dict:
    """波形をモデルの ``orders.outbound`` に流し込む（要約を返す）。

    SKU はモデルが**実際に拾えるもの**から引く（``items`` → 無ければ棚に載っている
    ``locations[].sku``）。``lines_per_order`` 省略時は
    ``orders.profile.lines_per_order_mean`` を使う＝プロファイル既定と地続き。

    ``set_window``: 到着は0時起点なので、既定の8時間窓のままだと 10時台の山が窓の
    外に落ちて「1件も処理しない」実行になる。最後の到着＋2時間まで
    ``simulation.duration_s`` を**伸ばすだけ**（縮めない）。
    """
    # Prefer SKUs the engine can actually reach: pegged to a slot (or carrying a
    # default_location), exactly like engine.build's sku_xy. A line pointing at an
    # unplaced SKU is silently skipped there, which would quietly thin the demand.
    placed = {str(loc.sku) for loc in (getattr(model, "locations", None) or [])
              if getattr(loc, "sku", None)}
    items = [it for it in (getattr(model, "items", None) or []) if getattr(it, "sku", "")]
    pool = [it for it in items if str(it.sku) in placed or it.default_location] or items
    skus = [str(it.sku) for it in pool]
    weights = [max(float(getattr(it, "pick_freq", 0.0) or 0.0), 1e-6) for it in pool]
    if not skus:                       # no item master at all: fall back to the slots
        skus = sorted(placed)
        weights = [1.0] * len(skus)
    if lines_per_order is None:
        lines_per_order = float(getattr(model.orders.profile, "lines_per_order_mean", 1.0) or 1.0)

    orders = from_hourly(hourly, total_orders=total_orders, seed=seed,
                         lines_per_order=lines_per_order,
                         skus=skus or None, sku_weights=weights or None)
    model.orders.outbound = orders
    summary = describe(hourly)
    summary.update({
        "orders": len(orders),
        "lines": int(sum(len(o.lines) for o in orders)),
        "skus": len(skus),
        "seed": seed,
        "lines_per_order": round(float(lines_per_order), 3),
        "first_arrival_s": orders[0].arrival_s if orders else None,
        "last_arrival_s": orders[-1].arrival_s if orders else None,
        "duration_s": float(model.simulation.duration_s),
        "window_extended": False,
    })
    if set_window and orders:
        need = float(orders[-1].arrival_s) + _DRAIN_TAIL_S
        if need > float(model.simulation.duration_s):
            model.simulation.duration_s = need
            summary["duration_s"] = need
            summary["window_extended"] = True
    return summary
