"""WMS サンプルデータ生成 (whsim データ分析タブ「サンプルで試す」用)。
曜日/時間帯ピーク偏りを持つ出荷・入荷・在庫のダミーフレームを返す。元 3PL ツールの
scripts/generate_sample_data.py から build_frames とヘルパを移植 (CLI 部は除外)。"""

import numpy as np
import pandas as pd


def _build_master(rng: np.random.Generator, n_sku: int, n_partner: int) -> tuple[pd.DataFrame, list[str]]:
    skus = pd.DataFrame(
        {
            "sku_code": [f"SKU{i:04d}" for i in range(1, n_sku + 1)],
            "sku_name": [f"商品{i:04d}" for i in range(1, n_sku + 1)],
            "popularity": rng.dirichlet(np.ones(n_sku) * 0.6),
        }
    )
    partners = [f"取引先{chr(ord('A') + i)}" for i in range(n_partner)]
    return skus, partners


def _hour_weights() -> np.ndarray:
    # Peak in late morning and mid-afternoon, quiet at night.
    base = np.array([0.2] * 7 + [0.6, 1.2, 1.8, 2.0, 1.6, 1.0, 1.4, 1.8, 1.5, 1.0, 0.6, 0.4] + [0.2] * 5)
    return base / base.sum()


def _weekday_weights() -> np.ndarray:
    # Mon-Fri busy, Sat moderate, Sun quiet (0=Mon).
    return np.array([1.2, 1.1, 1.0, 1.1, 1.4, 0.6, 0.2])


def build_frames(days: int = 90, n_sku: int = 50, n_partner: int = 10, seed: int = 42) -> dict[str, pd.DataFrame]:
    """Build dummy shipment/inbound/inventory DataFrames (WMS-style Japanese columns).

    Returns a dict with keys 'shipments', 'inbound', 'inventory'. Used both by the
    CLI file generator and by the app's "サンプルで試す" button (in-memory).
    """
    rng = np.random.default_rng(seed)
    skus, partners = _build_master(rng, n_sku, n_partner)
    end = pd.Timestamp.today().normalize()
    start = end - pd.Timedelta(days=days - 1)
    dates = pd.date_range(start, end, freq="D")
    hour_w = _hour_weights()
    wd_w = _weekday_weights()

    ship_rows = []
    order_seq = 0
    # Lines-per-order distribution: skewed toward 1-2 lines, long tail to 8.
    line_choices = [1, 2, 3, 4, 5, 6, 7, 8]
    line_probs = [0.40, 0.25, 0.15, 0.08, 0.05, 0.03, 0.025, 0.015]
    for d in dates:
        daily_orders = max(1, int(rng.normal(loc=60 * wd_w[d.weekday()], scale=10)))
        for _ in range(daily_orders):
            order_seq += 1
            order_id = f"PS-{d:%Y%m%d}-{order_seq:06d}"
            hour = int(rng.choice(24, p=hour_w))
            minute = int(rng.integers(0, 60))
            ts = d + pd.Timedelta(hours=hour, minutes=minute)
            partner = rng.choice(partners)
            n_lines = int(rng.choice(line_choices, p=line_probs))
            n_lines = min(n_lines, n_sku)
            sku_idxs = rng.choice(n_sku, size=n_lines, replace=False, p=skus["popularity"].values)
            for sidx in sku_idxs:
                ship_rows.append(
                    {
                        "受注番号": order_id,
                        "出荷日時": ts,
                        "出荷日": ts.normalize(),
                        "SKU": skus.loc[int(sidx), "sku_code"],
                        "商品名": skus.loc[int(sidx), "sku_name"],
                        "出荷数": int(rng.integers(1, 8)),
                        "取引先": partner,
                    }
                )
    ship = pd.DataFrame(ship_rows)

    in_rows = []
    for d in dates:
        if d.weekday() >= 5:
            continue
        for _ in range(int(rng.integers(15, 40))):
            sku_idx = int(rng.integers(0, n_sku))
            in_rows.append(
                {
                    "入荷日": d,
                    "SKU": skus.loc[sku_idx, "sku_code"],
                    "商品名": skus.loc[sku_idx, "sku_name"],
                    "入荷数": int(rng.integers(20, 200)),
                    "仕入先": f"仕入先{rng.integers(1, 6)}",
                }
            )
    inbound = pd.DataFrame(in_rows)

    received = inbound.groupby("SKU")["入荷数"].sum()
    shipped = ship.groupby("SKU")["出荷数"].sum()
    stock = (received.subtract(shipped, fill_value=0)).clip(lower=0).astype(int)
    inventory = (
        skus.assign(在庫数=skus["sku_code"].map(stock).fillna(0).astype(int))
        .assign(基準日=end, ロケーション=lambda df: ["A-" + str(i % 20 + 1).zfill(2) for i in range(len(df))])
        .rename(columns={"sku_code": "SKU", "sku_name": "商品名"})[["基準日", "SKU", "商品名", "ロケーション", "在庫数"]]
    )

    return {"shipments": ship, "inbound": inbound, "inventory": inventory}


