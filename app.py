"""Streamlit dashboard: 3PL 倉庫 物量分析ツール."""
from __future__ import annotations

from typing import Iterable

import pandas as pd
import streamlit as st

from scripts.generate_sample_data import build_frames
from src import analyses, charts
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

WEEKDAY = ["月", "火", "水", "木", "金", "土", "日"]

# 表示用に論理列名を日本語へ置き換えるマップ。
TREND_COLS = {"period": "期間", "kind": "区分", "qty": "数量", "lines": "件数"}
ABC_COLS = {"sku": "SKU", "partner": "取引先", "qty": "数量", "share": "構成比", "cum_share": "累積構成比", "rank": "ランク"}
INV_COLS = {
    "sku": "SKU",
    "stock_qty": "在庫数",
    "shipped_qty": "期間出荷数",
    "turnover": "回転率",
    "days_supply": "供給可能日数",
    "last_ship_date": "最終出荷日",
    "days_since_last_ship": "最終出荷からの経過日数",
    "dead_stock": "デッドストック",
}


@st.cache_data(show_spinner="サンプルデータを生成中…")
def load_sample() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Build demo data in-memory and run it through the auto column mapping."""
    frames = build_frames(days=90, seed=42)
    ship = apply_mapping(frames["shipments"], initial_mapping(frames["shipments"], SHIPMENT_FIELDS), SHIPMENT_FIELDS)
    inb = apply_mapping(frames["inbound"], initial_mapping(frames["inbound"], INBOUND_FIELDS), INBOUND_FIELDS)
    inv = apply_mapping(frames["inventory"], initial_mapping(frames["inventory"], INVENTORY_FIELDS), INVENTORY_FIELDS)
    return ship, inb, inv


def file_block(label: str, key: str, fields: Iterable[FieldSpec], expanded: bool) -> pd.DataFrame | None:
    """Render uploader + sheet selector + column mapping. Returns standardized DataFrame or None."""
    fields = list(fields)
    with st.sidebar.expander(label, expanded=expanded):
        up = st.file_uploader("ファイルを選択 (CSV / Excel)", type=["csv", "xlsx", "xls"], key=f"up_{key}")
        if up is None:
            return None
        raw = up.getvalue()
        sheet = None
        if up.name.lower().endswith((".xlsx", ".xls")):
            sheet = st.selectbox("シート", list_excel_sheets(raw), key=f"sheet_{key}")
        try:
            df = load_table(raw, up.name, sheet=sheet)
        except Exception as e:  # noqa: BLE001 - surface any load error to the user
            st.error(f"読込に失敗しました: {e}")
            return None

        st.caption(f"📄 {len(df):,} 行 × {len(df.columns)} 列")
        guess = initial_mapping(df, fields)
        if all(guess[f.key] for f in fields if f.required):
            st.caption("✅ 列を自動で割り当てました（必要なら下で変更できます）")
        st.markdown("**列の割り当て**　`*` は必須")
        cols = ["(未選択)"] + list(df.columns)
        mapping: dict[str, str | None] = {}
        for f in fields:
            default = cols.index(guess[f.key]) if guess[f.key] in df.columns else 0
            req = " *" if f.required else ""
            choice = st.selectbox(f"{f.label}{req}", cols, index=default, key=f"map_{key}_{f.key}")
            mapping[f.key] = None if choice == "(未選択)" else choice

        miss = missing_required(mapping, fields)
        if miss:
            st.warning(f"必須項目「{', '.join(miss)}」を割り当ててください。")
            return None
        return apply_mapping(df, mapping, fields)


def segmented(label: str, options: list[str], key: str) -> str:
    """A segmented control that always returns a value (never None)."""
    return st.segmented_control(label, options, default=options[0], key=key) or options[0]


# ── ヘッダー ────────────────────────────────────────────────────────────────
st.title("📦 3PL 倉庫 物量分析ツール")
st.caption("出荷・入荷・在庫データから 物量推移 / ABC / ピーク / 在庫回転 を可視化します。")

st.session_state.setdefault("sample_mode", False)


def _enable_sample() -> None:
    st.session_state.sample_mode = True


def _disable_sample() -> None:
    st.session_state.sample_mode = False


# ── サイドバー: データ取込 ──────────────────────────────────────────────────
st.sidebar.header("① データを用意")

if st.session_state.sample_mode:
    st.sidebar.success("🎲 サンプルデータを表示中")
    st.sidebar.button("✕ サンプルを終了して自分のデータを使う", width="stretch", on_click=_disable_sample)
    shipments, inbound, inventory = load_sample()
else:
    st.sidebar.button(
        "▶ サンプルデータで試す",
        type="primary",
        width="stretch",
        help="ファイルが無くても、ダミーデータですぐに動作を確認できます。",
        on_click=_enable_sample,
    )
    st.sidebar.caption("または手持ちのファイルをアップロード ↓")
    status_box = st.sidebar.empty()  # 取込状況をここに後から描画
    shipments = file_block("出荷明細", "ship", SHIPMENT_FIELDS, expanded=True)
    inbound = file_block("入荷明細", "in", INBOUND_FIELDS, expanded=False)
    inventory = file_block("在庫スナップショット", "inv", INVENTORY_FIELDS, expanded=False)
    with status_box.container():
        for name, df in [("出荷明細", shipments), ("入荷明細", inbound), ("在庫", inventory)]:
            if df is not None and not df.empty:
                st.markdown(f"✅ **{name}** &nbsp;{len(df):,} 行")
            else:
                st.markdown(f"⚪ {name} &nbsp;<span style='color:gray'>未取込</span>", unsafe_allow_html=True)

has_any = any(df is not None and not df.empty for df in (shipments, inbound, inventory))

# ── サイドバー: 期間フィルタ ────────────────────────────────────────────────
if has_any:
    st.sidebar.header("② 期間で絞り込み")
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

st.sidebar.markdown("---")
st.sidebar.caption("アップロードしたデータはこのセッション内でのみ処理され、サーバには保存されません。")


# ── メイン: 未取込時のウェルカム画面 ────────────────────────────────────────
if not has_any:
    st.info("👈 まずは左のサイドバーから、データを用意してください。")
    c1, c2 = st.columns([1, 1])
    with c1:
        st.markdown(
            "### はじめての方へ\n"
            "1. 左の **「▶ サンプルデータで試す」** を押すと、すぐに全機能を体験できます。\n"
            "2. 慣れたら、お手持ちの **CSV / Excel** をアップロードしてください。\n"
            "3. 列名が違っても大丈夫 — アップロード後に **項目を選ぶだけ** で分析できます。"
        )
        st.button("▶ サンプルデータで試す", type="primary", on_click=_enable_sample)
    with c2:
        st.markdown(
            "### 必要なデータ\n"
            "| 種別 | 必須項目 | あると良い項目 |\n"
            "| --- | --- | --- |\n"
            "| 出荷明細 | 出荷日 / SKU / 出荷数量 | 出荷日時・取引先 |\n"
            "| 入荷明細 | 入荷日 / SKU / 入荷数量 | 仕入先 |\n"
            "| 在庫 | SKU / 在庫数量 | 基準日・ロケーション |"
        )
    st.stop()


# ── メイン: KPI サマリー ────────────────────────────────────────────────────
k1, k2, k3, k4 = st.columns(4)
ship_qty = int(shipments["qty"].sum()) if shipments is not None and not shipments.empty else 0
in_qty = int(inbound["qty"].sum()) if inbound is not None and not inbound.empty else 0
sku_set = set()
for df in (shipments, inbound, inventory):
    if df is not None and "sku" in df.columns:
        sku_set |= set(df["sku"].dropna().unique())
k1.metric("総出荷数", f"{ship_qty:,}")
k2.metric("総入荷数", f"{in_qty:,}")
k3.metric("対象 SKU 数", f"{len(sku_set):,}")
period_txt = "—"
if shipments is not None and not shipments.empty and "date" in shipments.columns:
    period_txt = f"{shipments['date'].min():%m/%d} 〜 {shipments['date'].max():%m/%d}"
k4.metric("出荷対象期間", period_txt)

st.markdown("")

tab_trend, tab_abc, tab_peak, tab_inv = st.tabs(
    ["📈 物量推移", "🏷️ ABC 分析", "⏰ ピーク分析", "🔄 在庫回転"]
)

# ── 物量推移 ────────────────────────────────────────────────────────────────
with tab_trend:
    if shipments is None and inbound is None:
        st.info("出荷明細または入荷明細を取り込むと、推移グラフが表示されます。")
    else:
        st.caption("入荷・出荷の物量がどう動いているかを時系列で確認します。")
        c1, c2 = st.columns(2)
        with c1:
            freq_label = segmented("集計単位", ["日次", "週次", "月次"], key="freq")
        with c2:
            metric_label = segmented("指標", ["数量", "件数"], key="trend_metric")
        freq = {"日次": "D", "週次": "W", "月次": "M"}[freq_label]
        value = "qty" if metric_label == "数量" else "lines"
        df_trend = analyses.volume_trends(shipments, inbound, freq=freq)
        st.plotly_chart(
            charts.trends_line(df_trend, value=value, title=f"{freq_label}の{metric_label}推移"),
            width="stretch",
        )
        if not df_trend.empty:
            with st.expander("集計データを見る"):
                st.dataframe(df_trend.rename(columns=TREND_COLS), width="stretch", hide_index=True)

# ── ABC 分析 ────────────────────────────────────────────────────────────────
with tab_abc:
    if shipments is None or shipments.empty:
        st.info("出荷明細を取り込むと、ABC 分析が表示されます。")
    else:
        st.caption("出荷数量の多い順に並べ、上位(A)・中位(B)・下位(C)にランク分けします。")
        c1, c2 = st.columns(2)
        with c1:
            axis_opts = {"SKU": "sku"}
            if "partner" in shipments.columns:
                axis_opts["取引先"] = "partner"
            axis_label = segmented("分析軸", list(axis_opts), key="abc_axis")
            axis = axis_opts[axis_label]
        with c2:
            a, b = st.slider("A / B ランクの累積構成比しきい値", 0.5, 0.99, (0.7, 0.9), 0.05)
        df_abc = analyses.abc_analysis(shipments, key=axis, a_cutoff=a, b_cutoff=b)
        st.plotly_chart(
            charts.pareto(df_abc, key=axis, title=f"{axis_label}別 Pareto / ABC"),
            width="stretch",
        )
        if not df_abc.empty:
            counts = df_abc["rank"].value_counts().reindex(["A", "B", "C"]).fillna(0).astype(int)
            m1, m2, m3 = st.columns(3)
            m1.metric("A ランク", f"{counts.get('A', 0):,} 件")
            m2.metric("B ランク", f"{counts.get('B', 0):,} 件")
            m3.metric("C ランク", f"{counts.get('C', 0):,} 件")
            st.dataframe(
                df_abc.rename(columns=ABC_COLS),
                width="stretch",
                hide_index=True,
                column_config={
                    "構成比": st.column_config.NumberColumn(format="percent"),
                    "累積構成比": st.column_config.NumberColumn(format="percent"),
                },
            )

# ── ピーク分析 ──────────────────────────────────────────────────────────────
with tab_peak:
    if shipments is None or shipments.empty:
        st.info("出荷明細を取り込むと、ピーク分析が表示されます。")
    else:
        st.caption("曜日や時間帯ごとの繁閑を把握し、人員シフトの検討に活用します。")
        metric_label = segmented("指標", ["件数", "数量"], key="peak_metric")
        value = "lines" if metric_label == "件数" else "qty"
        by_w, by_h, hm = analyses.peak_analysis(shipments)
        col_a, col_b = st.columns(2)
        col_a.plotly_chart(charts.weekday_bar(by_w, value=value, title=f"曜日別{metric_label}"), width="stretch")
        if not by_h.empty:
            col_b.plotly_chart(charts.hour_bar(by_h, value=value, title=f"時間帯別{metric_label}"), width="stretch")
        else:
            col_b.info("時刻別の分析には「出荷日時」列の割り当てが必要です。")
        if not hm.empty:
            st.plotly_chart(charts.hour_weekday_heatmap(hm), width="stretch")

# ── 在庫回転 ────────────────────────────────────────────────────────────────
with tab_inv:
    if inventory is None or inventory.empty:
        st.info("在庫スナップショットを取り込むと、回転率と滞留状況が表示されます。")
    else:
        st.caption("SKU ごとの回転率を算出し、長く動いていない在庫(デッドストック)を洗い出します。")
        dead_days = st.slider("デッドストック判定（最終出荷からの経過日数）", 14, 180, 60, 7)
        df_inv = analyses.inventory_turnover(inventory, shipments, dead_stock_days=dead_days)
        if df_inv.empty:
            st.warning("計算結果が空です。在庫データの SKU / 在庫数量 の割り当てを確認してください。")
        else:
            avg_turn = df_inv["turnover"].replace([float("inf")], 0).mean()
            m1, m2, m3 = st.columns(3)
            m1.metric("対象 SKU", f"{len(df_inv):,}")
            m2.metric("デッドストック SKU", f"{int(df_inv['dead_stock'].sum()):,}")
            m3.metric("平均回転率", f"{avg_turn:.2f}")
            display = df_inv.copy()
            for c in ("turnover", "days_supply"):
                if c in display.columns:
                    display[c] = display[c].round(2)
            cfg = {"デッドストック": st.column_config.CheckboxColumn()}
            st.dataframe(display.rename(columns=INV_COLS), width="stretch", hide_index=True, column_config=cfg)
            dead_df = display[display["dead_stock"]]
            with st.expander(f"⚠️ デッドストック一覧（{len(dead_df):,} 件）"):
                if dead_df.empty:
                    st.success("デッドストックはありません。")
                else:
                    st.dataframe(dead_df.rename(columns=INV_COLS), width="stretch", hide_index=True)
