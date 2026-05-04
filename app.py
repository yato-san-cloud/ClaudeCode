"""Streamlit dashboard: 3PL 倉庫 物量分析ツール."""
from __future__ import annotations

from typing import Iterable

import pandas as pd
import streamlit as st

from src import analyses, charts, data_io
from src.data_io import (
    INBOUND_FIELDS,
    INVENTORY_FIELDS,
    SHIPMENT_FIELDS,
    FieldSpec,
    apply_mapping,
    initial_mapping,
    list_excel_sheets,
    load_table,
    missing_required,
)

st.set_page_config(page_title="3PL 倉庫 物量分析", page_icon="📦", layout="wide")
st.title("📦 3PL 倉庫 物量分析ツール")
st.caption("出荷・入荷・在庫データをアップロードして、推移 / ABC / ピーク / 在庫回転を分析します。")


def _file_block(label: str, key: str, fields: Iterable[FieldSpec]) -> pd.DataFrame | None:
    """Render uploader + sheet selector + column mapping. Returns standardized DataFrame or None."""
    with st.sidebar.expander(label, expanded=True):
        up = st.file_uploader("ファイル", type=["csv", "xlsx", "xls"], key=f"up_{key}")
        if up is None:
            return None
        raw = up.getvalue()
        sheet = None
        if up.name.lower().endswith((".xlsx", ".xls")):
            sheets = list_excel_sheets(raw)
            sheet = st.selectbox("シート", sheets, key=f"sheet_{key}")
        try:
            df = load_table(raw, up.name, sheet=sheet)
        except Exception as e:
            st.error(f"読込失敗: {e}")
            return None
        st.caption(f"{len(df):,} 行 / {len(df.columns)} 列")
        cols = ["(未選択)"] + list(df.columns)
        guess = initial_mapping(df, fields)
        mapping: dict[str, str | None] = {}
        for f in fields:
            default = cols.index(guess[f.key]) if guess[f.key] in df.columns else 0
            req = " *" if f.required else ""
            choice = st.selectbox(f"{f.label}{req}", cols, index=default, key=f"map_{key}_{f.key}")
            mapping[f.key] = None if choice == "(未選択)" else choice
        miss = missing_required(mapping, fields)
        if miss:
            st.warning(f"必須項目が未指定: {', '.join(miss)}")
            return None
        return apply_mapping(df, mapping, fields)


st.sidebar.header("📥 データ取込")
shipments = _file_block("出荷明細", "ship", SHIPMENT_FIELDS)
inbound = _file_block("入荷明細", "in", INBOUND_FIELDS)
inventory = _file_block("在庫スナップショット", "inv", INVENTORY_FIELDS)

st.sidebar.header("🔎 期間フィルタ")
all_dates: list[pd.Timestamp] = []
for df in (shipments, inbound):
    if df is not None and "date" in df.columns and not df.empty:
        all_dates.extend([df["date"].min(), df["date"].max()])
if all_dates:
    lo, hi = min(all_dates).date(), max(all_dates).date()
    if lo == hi:
        st.sidebar.caption(f"対象期間: {lo}")
        date_range = (lo, hi)
    else:
        date_range = st.sidebar.slider("期間", min_value=lo, max_value=hi, value=(lo, hi))

    def _filter(df: pd.DataFrame | None) -> pd.DataFrame | None:
        if df is None or "date" not in df.columns:
            return df
        m = (df["date"].dt.date >= date_range[0]) & (df["date"].dt.date <= date_range[1])
        return df.loc[m]

    shipments = _filter(shipments)
    inbound = _filter(inbound)


tab_trend, tab_abc, tab_peak, tab_inv = st.tabs(
    ["📈 物量推移", "🏷️ ABC 分析", "⏰ ピーク分析", "🔄 在庫回転"]
)

with tab_trend:
    if shipments is None and inbound is None:
        st.info("出荷明細または入荷明細をアップロードしてください。")
    else:
        freq_label = st.radio("集計単位", ["日次", "週次", "月次"], horizontal=True, key="freq")
        freq = {"日次": "D", "週次": "W", "月次": "M"}[freq_label]
        metric = st.radio("指標", ["数量 (qty)", "件数 (lines)"], horizontal=True, key="metric")
        value = "qty" if metric.startswith("数量") else "lines"
        df_trend = analyses.volume_trends(shipments, inbound, freq=freq)
        st.plotly_chart(charts.trends_line(df_trend, value=value, title=f"{freq_label} 物量推移"), use_container_width=True)
        if not df_trend.empty:
            with st.expander("集計データ"):
                st.dataframe(df_trend, use_container_width=True)

with tab_abc:
    if shipments is None or shipments.empty:
        st.info("出荷明細をアップロードしてください。")
    else:
        axis_options = ["sku"]
        if "partner" in shipments.columns:
            axis_options.append("partner")
        axis = st.radio("分析軸", axis_options, format_func={"sku": "SKU", "partner": "取引先"}.get, horizontal=True)
        col1, col2 = st.columns(2)
        a = col1.slider("A ランク累積閾値", 0.5, 0.9, 0.7, 0.05)
        b = col2.slider("B ランク累積閾値", a + 0.05, 0.99, max(0.9, a + 0.05), 0.05)
        df_abc = analyses.abc_analysis(shipments, key=axis, a_cutoff=a, b_cutoff=b)
        st.plotly_chart(
            charts.pareto(df_abc, key=axis, title=f"{axis} 別 Pareto / ABC"),
            use_container_width=True,
        )
        if not df_abc.empty:
            counts = df_abc["rank"].value_counts().reindex(["A", "B", "C"]).fillna(0).astype(int)
            c1, c2, c3 = st.columns(3)
            c1.metric("A ランク", f"{counts.get('A', 0):,} 件")
            c2.metric("B ランク", f"{counts.get('B', 0):,} 件")
            c3.metric("C ランク", f"{counts.get('C', 0):,} 件")
            st.dataframe(df_abc, use_container_width=True)

with tab_peak:
    if shipments is None or shipments.empty:
        st.info("出荷明細をアップロードしてください。")
    else:
        by_w, by_h, hm = analyses.peak_analysis(shipments)
        metric = st.radio("指標", ["件数 (lines)", "数量 (qty)"], horizontal=True, key="peak_metric")
        value = "lines" if metric.startswith("件数") else "qty"
        col_a, col_b = st.columns(2)
        col_a.plotly_chart(charts.weekday_bar(by_w, value=value), use_container_width=True)
        if not by_h.empty:
            col_b.plotly_chart(charts.hour_bar(by_h, value=value), use_container_width=True)
        else:
            col_b.info("時刻情報 (出荷日時) 列がマッピングされていません。")
        if not hm.empty:
            st.plotly_chart(charts.hour_weekday_heatmap(hm), use_container_width=True)

with tab_inv:
    if inventory is None or inventory.empty:
        st.info("在庫スナップショットをアップロードしてください。")
    else:
        dead_days = st.slider("デッドストック判定 (最終出荷からの経過日数)", 14, 180, 60, 7)
        df_inv = analyses.inventory_turnover(inventory, shipments, dead_stock_days=dead_days)
        if df_inv.empty:
            st.warning("計算結果が空です。在庫データの SKU/数量列を確認してください。")
        else:
            total_skus = len(df_inv)
            dead = int(df_inv["dead_stock"].sum())
            avg_turn = df_inv["turnover"].replace([float("inf")], 0).mean()
            c1, c2, c3 = st.columns(3)
            c1.metric("対象 SKU", f"{total_skus:,}")
            c2.metric("デッドストック SKU", f"{dead:,}")
            c3.metric("平均回転率", f"{avg_turn:.2f}")
            display = df_inv.copy()
            for c in ("turnover", "days_supply"):
                if c in display.columns:
                    display[c] = display[c].round(2)
            st.dataframe(display, use_container_width=True)
            with st.expander("デッドストック一覧"):
                st.dataframe(display[display["dead_stock"]], use_container_width=True)


st.sidebar.markdown("---")
st.sidebar.caption(
    "サンプルデータ生成: `python scripts/generate_sample_data.py`\n\n"
    "アップロードしたデータはセッション内のみで処理され、保存されません。"
)
