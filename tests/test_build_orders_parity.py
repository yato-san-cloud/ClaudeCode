"""Parity + speed guard for the vectorised ``ingest.build_orders``.

build_orders was rewritten from a per-row ``iterrows`` loop with full pydantic
construction to vectorised pandas + ``model_construct`` (a ~4× speed-up on a
month-scale file). The arrival_s calendar semantics (real timestamp → clock
seconds, date-only → 8–17時 spread, undated → synthetic week) and the order /
line / item shapes must be byte-identical — golden outputs captured from the old
implementation are asserted here so the rewrite can never silently drift.
"""

import json
from pathlib import Path

import pandas as pd

from whsim.analysis import ingest

GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "build_orders_golden.json").read_text("utf-8"))

FRAMES = {
    # dated + real timestamp + order_id grouping
    "dated_ts_oid": pd.DataFrame({
        "date": ["2025/09/01", "2025/09/01", "2025/09/02", "2025/09/02"],
        "timestamp": ["2025/09/01 09:30", "2025/09/01 09:30",
                      "2025/09/02 14:05", "2025/09/02 14:05"],
        "sku": ["A", "B", "A", "C"], "qty": [2, 1, 5, 3],
        "order_id": ["O1", "O1", "O2", "O2"]}),
    # dated, date-only (no clock) → spread across 8–17時
    "dated_noclock": pd.DataFrame({
        "date": ["2025/09/01", "2025/09/01", "2025/09/01"],
        "sku": ["A", "B", "C"], "qty": [1, 2, 3],
        "order_id": ["O1", "O2", "O3"]}),
    # no dates anywhere + no order_id → synthetic week, per-row orders
    "nodate_nooid": pd.DataFrame({"sku": ["A", "B", "A"], "qty": [1, 2, 4]}),
    # mixed blank/null order_ids (the __row fallback + null-key drop quirk)
    "oid_blanks": pd.DataFrame({
        "date": ["2025/09/03", "2025/09/03", "2025/09/03"],
        "sku": ["A", "A", "B"], "qty": [1, 2, 3],
        "order_id": ["O1", "", None]}),
}


def _capture(df):
    orders, items, summary = ingest.build_orders(df)
    return {
        "orders": [{"id": o.order_id, "arr": round(o.arrival_s, 4),
                    "lines": [[ln.sku, ln.qty] for ln in o.lines]} for o in orders],
        "items": [it.sku for it in items],
        "summary": {k: summary[k] for k in
                    ("orders", "lines", "skus", "units", "dated", "date_min", "date_max")},
    }


def test_build_orders_matches_golden():
    for key, df in FRAMES.items():
        assert _capture(df) == GOLDEN[key], f"build_orders drifted for case {key!r}"


def test_build_orders_types_are_json_clean():
    # model_construct skips coercion — make sure the cleaned frame still yields
    # plain python types (no numpy scalars that would break JSON serialisation).
    orders, items, _ = ingest.build_orders(FRAMES["dated_ts_oid"])
    o = orders[0]
    assert type(o.arrival_s) is float
    for ln in o.lines:
        assert type(ln.sku) is str and type(ln.qty) is int
    assert all(type(it.sku) is str for it in items)


def test_build_orders_scales_fast():
    # A month-scale file must build in well under the old ~10s (vectorised path).
    import random
    import time
    random.seed(3)
    skus = [f"S{i}" for i in range(400)]
    rows = [["2025/09/%02d" % (1 + i % 26), f"K{i // 30:05d}",
             random.choice(skus), random.randint(1, 12)] for i in range(40000)]
    df = pd.DataFrame(rows, columns=["date", "order_id", "sku", "qty"])
    t0 = time.perf_counter()
    orders, _, summary = ingest.build_orders(df)
    dt = time.perf_counter() - t0
    assert summary["lines"] > 0 and len(orders) > 0
    assert dt < 4.0, f"build_orders too slow at 40k rows: {dt:.2f}s"
