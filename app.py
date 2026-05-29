"""Streamlit dashboard: 3PL 倉庫 物量分析ツール."""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Iterable

import pandas as pd
import streamlit as st

from scripts.generate_sample_data import build_frames
from src import analyses, charts, insights, sql_analyses
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
from src.duck_io import Catalog

st.set_page_config(page_title="3PL 倉庫 物量分析", page_icon="📦", layout="wide")

# ── 表示用ラベル ───────────────────────────────────────────────────────────
TREND_COLS = {"period": "期間", "kind": "区分", "qty": "数量", "lines": "件数"}
ABC_COLS = {"sku": "SKU", "partner": "取引先", "qty": "数量", "share": "構成比", "cum_share": "累積構成比", "rank": "ランク"}
INV_COLS = {
    "sku": "SKU", "stock_qty": "在庫数", "shipped_qty": "期間出荷数",
    "turnover": "回転率", "days_supply": "供給可能日数",
    "last_ship_date": "最終出荷日", "days_since_last_ship": "最終出荷からの経過日数",
    "dead_stock": "デッドストック",
}

# ── スマホ向け CSS（狭い画面で columns / metric を縦並びに） ────────────────
st.markdown(
    """
    <style>
    @media (max-width: 720px) {
      section[data-testid="stSidebar"] { min-width: 88vw !important; }
      div[data-testid="stHorizontalBlock"] > div[data-testid="stColumn"] {
        flex: 1 1 100% !important;
        min-width: 100% !important;
      }
      div[data-testid="stMetricValue"] { font-size: 1.4rem !important; }
      div[data-testid="stMetricLabel"] { font-size: 0.85rem !important; }
      h1 { font-size: 1.5rem !important; }
      h2 { font-size: 1.2rem !important; }
      div[data-baseweb="tab-list"] { gap: 0.25rem !important; }
      button[data-baseweb="tab"] { padding: 0.4rem 0.6rem !important; font-size: 0.9rem !important; }
      .block-container { padding: 1rem 0.5rem !important; }
    }
    </style>
    """,
    unsafe_allow_html=True,
)

# ── セッション初期化 ───────────────────────────────────────────────────────
ss = st.session_state
ss.setdefault("sample_mode", False)
ss.setdefault("engine", "pandas")           # 'pandas' | 'duckdb'
ss.setdefault("duck_paths", {"shipments": "", "inbound": "", "inventory": ""})
ss.setdefault("duck_temp_dir", None)


def _enable_sample() -> None:
    ss.sample_mode = True


def _disable_sample() -> None:
    ss.sample_mode = False


def segmented(label: str, options: list[str], key: str, default: str | None = None) -> str:
    val = st.segmented_control(label, options, default=default or options[0], key=key)
    return val or (default or options[0])


# ── ヘッダー ────────────────────────────────────────────────────────────────
st.title("📦 3PL 倉庫 物量分析ツール")
st.caption("出荷・入荷・在庫データから 物量推移 / ABC / ピーク / 在庫回転 を可視化します。")

# ── サイドバー: エンジン選択 ─────────────────────────────────────────────────
with st.sidebar:
    st.markdown("### ⚙️ エンジン")
    engine_choice = st.radio(
        "データ処理エンジン",
        ["💨 pandas (標準)", "🦆 DuckDB (巨大データ)"],
        index=0 if ss.engine == "pandas" else 1,
        label_visibility="collapsed",
        help=(
            "標準は pandas でメモリ上に読み込みます。\n"
            "DuckDB モードは CSV / Parquet をディスク上のままスキャンするので、"
            "数GB級のファイルや glob 指定(`data/*.parquet`)が扱えます。"
        ),
    )
    new_engine = "pandas" if engine_choice.startswith("💨") else "duckdb"
    if new_engine != ss.engine:
        ss.engine = new_engine
        ss.sample_mode = False  # エンジン切替時はサンプルを解除
    st.markdown("---")


# ═══════════════════════════════════════════════════════════════════════════
# pandas 経路: 既存どおり DataFrame を返す
# ═══════════════════════════════════════════════════════════════════════════
@st.cache_data(show_spinner="サンプルデータを生成中…")
def load_sample_pandas() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    frames = build_frames(days=90, seed=42)
    ship = apply_mapping(frames["shipments"], initial_mapping(frames["shipments"], SHIPMENT_FIELDS), SHIPMENT_FIELDS)
    inb = apply_mapping(frames["inbound"], initial_mapping(frames["inbound"], INBOUND_FIELDS), INBOUND_FIELDS)
    inv = apply_mapping(frames["inventory"], initial_mapping(frames["inventory"], INVENTORY_FIELDS), INVENTORY_FIELDS)
    return ship, inb, inv


def file_block_pandas(label: str, key: str, fields: Iterable[FieldSpec], expanded: bool) -> pd.DataFrame | None:
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
        except Exception as e:
            st.error(f"読込に失敗しました: {e}")
            return None
        st.caption(f"📄 {len(df):,} 行 × {len(df.columns)} 列")
        guess = initial_mapping(df, fields)
        if all(guess[f.key] for f in fields if f.required):
            st.caption("✅ 列を自動で割り当てました")
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


# ═══════════════════════════════════════════════════════════════════════════
# DuckDB 経路: ファイルパス or アップロード → Catalog にビュー登録
# ═══════════════════════════════════════════════════════════════════════════
@st.cache_resource(show_spinner="DuckDB を準備中…")
def get_catalog() -> Catalog:
    return Catalog()


@st.cache_resource(show_spinner="サンプルデータを生成中…")
def load_sample_duck() -> Catalog:
    cat = Catalog()
    frames = build_frames(days=90, seed=42)
    cat.register_dataframe("shipments", frames["shipments"])
    cat.register_dataframe("inbound", frames["inbound"])
    cat.register_dataframe("inventory", frames["inventory"])
    cat.apply_mapping("shipments", initial_mapping(frames["shipments"], SHIPMENT_FIELDS))
    cat.apply_mapping("inbound", initial_mapping(frames["inbound"], INBOUND_FIELDS))
    cat.apply_mapping("inventory", initial_mapping(frames["inventory"], INVENTORY_FIELDS))
    return cat


def _temp_dir() -> Path:
    if not ss.duck_temp_dir:
        ss.duck_temp_dir = tempfile.mkdtemp(prefix="3pl_")
    return Path(ss.duck_temp_dir)


def file_block_duck(label: str, key: str, fields: Iterable[FieldSpec], cat: Catalog, expanded: bool) -> bool:
    """Register a source on the catalog. Returns True if mapped successfully."""
    fields = list(fields)
    with st.sidebar.expander(label, expanded=expanded):
        mode = segmented(
            "取込方法",
            ["📤 アップロード", "📁 サーバパス"],
            key=f"mode_{key}",
            default="📤 アップロード",
        )
        registered = False

        if mode == "📁 サーバパス":
            path = st.text_input(
                "ファイル / glob (CSV / Parquet)",
                value=ss.duck_paths[key],
                placeholder="例: /data/wms/shipments_2026-*.parquet",
                key=f"path_{key}",
            )
            ss.duck_paths[key] = path
            if path:
                try:
                    cat.register_path(key, path)
                    registered = True
                except Exception as e:
                    st.error(f"登録に失敗しました: {e}")
                    return False
        else:
            up = st.file_uploader(
                "ファイル (CSV / Parquet / Excel)",
                type=["csv", "parquet", "xlsx", "xls"],
                key=f"up_{key}",
            )
            if up is None:
                return False
            lower = up.name.lower()
            if lower.endswith((".csv", ".parquet")):
                # ストリーム ＝ ディスク経由で DuckDB が直接スキャン
                dst = _temp_dir() / f"{key}{Path(up.name).suffix}"
                dst.write_bytes(up.getvalue())
                try:
                    cat.register_path(key, dst)
                    registered = True
                except Exception as e:
                    st.error(f"登録に失敗しました: {e}")
                    return False
            else:
                # Excel: pandas で読んで DuckDB に登録
                sheets = list_excel_sheets(up.getvalue())
                sheet = st.selectbox("シート", sheets, key=f"sheet_{key}")
                try:
                    df = load_table(up.getvalue(), up.name, sheet=sheet)
                except Exception as e:
                    st.error(f"読込に失敗しました: {e}")
                    return False
                cat.register_dataframe(key, df)
                registered = True

        if not registered:
            return False

        # ── マッピング UI ─────────────────────────────────────────────
        n_rows = cat.row_count(key)
        st.caption(f"📊 {n_rows:,} 行（DuckDB がスキャン）")
        raw_cols = cat.columns(key)
        head = cat.head(key, 5)
        guess = initial_mapping(head, fields)
        if all(guess[f.key] for f in fields if f.required):
            st.caption("✅ 列を自動で割り当てました")
        st.markdown("**列の割り当て**　`*` は必須")
        cols = ["(未選択)"] + raw_cols
        mapping: dict[str, str | None] = {}
        for f in fields:
            default = cols.index(guess[f.key]) if guess[f.key] in raw_cols else 0
            req = " *" if f.required else ""
            choice = st.selectbox(f"{f.label}{req}", cols, index=default, key=f"dmap_{key}_{f.key}")
            mapping[f.key] = None if choice == "(未選択)" else choice
        miss = missing_required(mapping, fields)
        if miss:
            st.warning(f"必須項目「{', '.join(miss)}」を割り当ててください。")
            return False
        cat.apply_mapping(key, mapping)
        return True


# ═══════════════════════════════════════════════════════════════════════════
# サイドバー ② データ取込
# ═══════════════════════════════════════════════════════════════════════════
st.sidebar.markdown("### ① データを用意")

shipments = inbound = inventory = None
catalog: Catalog | None = None
has_any = False
date_lo = date_hi = None

if ss.engine == "pandas":
    if ss.sample_mode:
        st.sidebar.success("🎲 サンプルデータを表示中")
        st.sidebar.button("✕ サンプルを終了", width="stretch", on_click=_disable_sample)
        shipments, inbound, inventory = load_sample_pandas()
    else:
        st.sidebar.button(
            "▶ サンプルデータで試す",
            type="primary", width="stretch",
            help="ファイルが無くてもダミーデータで動作確認できます。",
            on_click=_enable_sample,
        )
        st.sidebar.caption("または、お手持ちのファイルを ↓")
        status = st.sidebar.empty()
        shipments = file_block_pandas("出荷明細", "ship", SHIPMENT_FIELDS, expanded=True)
        inbound = file_block_pandas("入荷明細", "in", INBOUND_FIELDS, expanded=False)
        inventory = file_block_pandas("在庫スナップショット", "inv", INVENTORY_FIELDS, expanded=False)
        with status.container():
            for n, df in [("出荷", shipments), ("入荷", inbound), ("在庫", inventory)]:
                if df is not None and not df.empty:
                    st.markdown(f"✅ **{n}** &nbsp;{len(df):,} 行")
                else:
                    st.markdown(f"⚪ {n} &nbsp;<span style='color:gray'>未取込</span>", unsafe_allow_html=True)
    has_any = any(df is not None and not df.empty for df in (shipments, inbound, inventory))

else:  # ── DuckDB engine ─────────────────────────────────────────────────
    if ss.sample_mode:
        st.sidebar.success("🎲 サンプルデータを DuckDB で表示中")
        st.sidebar.button("✕ サンプルを終了", width="stretch", on_click=_disable_sample)
        catalog = load_sample_duck()
    else:
        st.sidebar.button(
            "▶ サンプルデータで試す",
            type="primary", width="stretch",
            on_click=_enable_sample,
        )
        st.sidebar.caption("CSV / Parquet は数GB級でも直接スキャンできます。")
        catalog = get_catalog()
        status = st.sidebar.empty()
        ok_s = file_block_duck("出荷明細", "shipments", SHIPMENT_FIELDS, catalog, expanded=True)
        ok_i = file_block_duck("入荷明細", "inbound", INBOUND_FIELDS, catalog, expanded=False)
        ok_v = file_block_duck("在庫スナップショット", "inventory", INVENTORY_FIELDS, catalog, expanded=False)
        with status.container():
            for label, name, ok in [("出荷", "shipments", ok_s), ("入荷", "inbound", ok_i), ("在庫", "inventory", ok_v)]:
                if ok:
                    st.markdown(f"✅ **{label}** &nbsp;{catalog.view_row_count(name):,} 行")
                else:
                    st.markdown(f"⚪ {label} &nbsp;<span style='color:gray'>未取込</span>", unsafe_allow_html=True)
    has_any = catalog is not None and any(catalog.view(n) for n in ("shipments", "inbound", "inventory"))


# ── サイドバー ② 期間フィルタ ──────────────────────────────────────────────
if has_any:
    st.sidebar.markdown("### ② 期間で絞り込み")
    if ss.engine == "pandas":
        all_dates: list[pd.Timestamp] = []
        for df in (shipments, inbound):
            if df is not None and "date" in df.columns and not df.empty:
                all_dates.extend([df["date"].min(), df["date"].max()])
        if all_dates:
            lo_d, hi_d = min(all_dates).date(), max(all_dates).date()
            if lo_d == hi_d:
                st.sidebar.caption(f"対象期間: {lo_d}")
                date_lo, date_hi = lo_d, hi_d
            else:
                date_lo, date_hi = st.sidebar.slider("期間", min_value=lo_d, max_value=hi_d, value=(lo_d, hi_d))

            def _filter(df: pd.DataFrame | None) -> pd.DataFrame | None:
                if df is None or "date" not in df.columns:
                    return df
                m = (df["date"].dt.date >= date_lo) & (df["date"].dt.date <= date_hi)
                return df.loc[m]

            shipments = _filter(shipments)
            inbound = _filter(inbound)
    else:
        bounds = catalog.date_bounds() if catalog else None
        if bounds:
            lo_d, hi_d = bounds[0].date(), bounds[1].date()
            if lo_d == hi_d:
                st.sidebar.caption(f"対象期間: {lo_d}")
                date_lo, date_hi = lo_d, hi_d
            else:
                date_lo, date_hi = st.sidebar.slider("期間", min_value=lo_d, max_value=hi_d, value=(lo_d, hi_d))

st.sidebar.markdown("---")
st.sidebar.caption("アップロードしたデータはこのセッション内でのみ処理され、サーバに永続化されません。")


# ═══════════════════════════════════════════════════════════════════════════
# 未取込ウェルカム画面
# ═══════════════════════════════════════════════════════════════════════════
if not has_any:
    st.info("👈 まずは左のサイドバーから、データを用意してください。")
    c1, c2 = st.columns([1, 1])
    with c1:
        st.markdown(
            "### はじめての方へ\n"
            "1. 左の **「▶ サンプルデータで試す」** を押すと、すぐに全機能を体験できます。\n"
            "2. 慣れたら、お手持ちの **CSV / Excel / Parquet** をアップロードしてください。\n"
            "3. 列名が違っても大丈夫 — アップロード後に **項目を選ぶだけ** で分析できます。"
        )
        st.button("▶ サンプルデータで試す", type="primary", on_click=_enable_sample, key="welcome_sample")
    with c2:
        st.markdown(
            "### エンジンの使い分け\n"
            "- **💨 pandas (標準)** — 〜数百MB / 通常の Excel・CSV 業務\n"
            "- **🦆 DuckDB (巨大データ)** — GB級 CSV / Parquet、glob指定 (`data/*.parquet`)、サーバパス指定OK\n\n"
            "### 必要なデータ\n"
            "| 種別 | 必須 | あると良い |\n"
            "| --- | --- | --- |\n"
            "| 出荷明細 | 出荷日 / SKU / 出荷数量 | 出荷日時 / 取引先 |\n"
            "| 入荷明細 | 入荷日 / SKU / 入荷数量 | 仕入先 |\n"
            "| 在庫 | SKU / 在庫数量 | 基準日 / ロケーション |"
        )
    st.stop()


# ═══════════════════════════════════════════════════════════════════════════
# 集計エンジンの統一インタフェース
# ═══════════════════════════════════════════════════════════════════════════
def _str_or_none(d) -> str | None:
    return str(d) if d is not None else None


lo_s, hi_s = _str_or_none(date_lo), _str_or_none(date_hi)


def run_volume_trends(freq: str) -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.volume_trends(shipments, inbound, freq=freq)
    return sql_analyses.volume_trends(catalog, freq=freq, lo=lo_s, hi=hi_s)


def run_abc(key: str, a: float, b: float) -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.abc_analysis(shipments, key=key, a_cutoff=a, b_cutoff=b)
    return sql_analyses.abc_analysis(catalog, key=key, a_cutoff=a, b_cutoff=b, lo=lo_s, hi=hi_s)


def run_peak():
    if ss.engine == "pandas":
        return analyses.peak_analysis(shipments) if shipments is not None else (None, None, None)
    return sql_analyses.peak_analysis(catalog, lo=lo_s, hi=hi_s)


def run_turnover(dead_days: int) -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.inventory_turnover(inventory, shipments, dead_stock_days=dead_days)
    return sql_analyses.inventory_turnover(catalog, dead_stock_days=dead_days, lo=lo_s, hi=hi_s)


def run_summary(dead_days: int = 60) -> dict:
    if ss.engine == "pandas":
        return analyses.summary_kpis(shipments, inbound, inventory, dead_stock_days=dead_days)
    return sql_analyses.summary_kpis(catalog, dead_stock_days=dead_days, lo=lo_s, hi=hi_s)


def run_anomalies(z: float = 2.0) -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.daily_anomalies(shipments, z_thresh=z)
    return sql_analyses.daily_anomalies(catalog, z_thresh=z, lo=lo_s, hi=hi_s)


def run_partner_matrix(value: str = "lines") -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.partner_weekday_matrix(shipments, value=value)
    return sql_analyses.partner_weekday_matrix(catalog, value=value, lo=lo_s, hi=hi_s)


def run_period_compare(period_a, period_b, key: str = "sku", top_n: int = 20) -> pd.DataFrame:
    if ss.engine == "pandas":
        return analyses.period_compare(shipments, period_a, period_b, key=key, top_n=top_n)
    return sql_analyses.period_compare(catalog, period_a, period_b, key=key, top_n=top_n)


def _materialize_ship() -> pd.DataFrame | None:
    """For lifecycle/forecast/portfolio in DuckDB mode: materialize the (small) view."""
    if ss.engine == "pandas":
        return shipments
    v = catalog.view("shipments") if catalog else None
    if not v:
        return None
    sql = f"SELECT * FROM {v}"
    if lo_s or hi_s:
        sql += " WHERE " + (f"date >= TIMESTAMP '{lo_s}'" if lo_s else "TRUE")
        if hi_s:
            sql += f" AND date < TIMESTAMP '{hi_s}' + INTERVAL 1 DAY"
    return catalog.query(sql)


def run_forecast(horizon: int = 14) -> pd.DataFrame:
    return analyses.simple_forecast(_materialize_ship(), horizon=horizon)


def run_lifecycle() -> pd.DataFrame:
    return analyses.sku_lifecycle(_materialize_ship())


def run_portfolio() -> pd.DataFrame:
    return analyses.sku_portfolio(run_turnover(60))


def run_insights() -> list[insights.Insight]:
    if ss.engine == "pandas":
        ship_df, inb_df, inv_df = shipments, inbound, inventory
    else:
        ship_df = _materialize_ship()
        inb_df = catalog.query(f"SELECT * FROM {catalog.view('inbound')}") if catalog and catalog.view("inbound") else None
        inv_df = catalog.query(f"SELECT * FROM {catalog.view('inventory')}") if catalog and catalog.view("inventory") else None
    k = run_summary(60)
    ti = run_turnover(60)
    return insights.generate_insights(ship_df, inb_df, inv_df, k, ti)


def has_data(name: str) -> bool:
    if ss.engine == "pandas":
        local = {"shipments": shipments, "inbound": inbound, "inventory": inventory}[name]
        return local is not None and not local.empty
    return catalog is not None and catalog.view(name) is not None


def has_col(name: str, col: str) -> bool:
    if ss.engine == "pandas":
        local = {"shipments": shipments, "inbound": inbound, "inventory": inventory}[name]
        return local is not None and col in local.columns
    return catalog is not None and catalog.has_column(name, col)


def _fmt(value, digits: int = 2, suffix: str = "", na: str = "—") -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return na
    if isinstance(value, float):
        return f"{value:,.{digits}f}{suffix}"
    return f"{value:,}{suffix}"


tab_sum, tab_trend, tab_abc, tab_peak, tab_inv, tab_fc, tab_pf, tab_cmp = st.tabs(
    ["📊 サマリー", "📈 物量推移", "🏷️ ABC 分析", "⏰ ピーク分析",
     "🔄 在庫回転", "🔮 予測", "🧬 SKUポートフォリオ", "🔁 期間対比"]
)


def _insight_card(ins: insights.Insight) -> None:
    """色付きカードを 1 枚描画。"""
    color = {"critical": "#FFEBEE", "warning": "#FFF8E1", "info": "#E8F4FD"}[ins.severity]
    border = {"critical": "#E53935", "warning": "#FB8C00", "info": "#1E88E5"}[ins.severity]
    metric_html = f"<span style='float:right;font-weight:bold;color:{border}'>{ins.metric}</span>" if ins.metric else ""
    sug_html = f"<div style='margin-top:4px;font-size:0.85rem'>💬 {ins.suggestion}</div>" if ins.suggestion else ""
    st.markdown(
        f"<div style='background:{color};border-left:4px solid {border};"
        f"padding:8px 12px;margin-bottom:6px;border-radius:4px'>"
        f"<div style='font-weight:bold'>{ins.icon} {ins.title}{metric_html}</div>"
        f"<div style='font-size:0.85rem;color:#555'>{ins.detail}</div>{sug_html}</div>",
        unsafe_allow_html=True,
    )


# ── サマリー(1枚で 3PL 判断材料を一覧)─────────────────────────────────────
with tab_sum:
    k = run_summary(dead_days=60)
    st.caption("3PL 運用判断に使う KPI を一覧で確認します。期間フィルタが反映されます。")

    # ── 💡 自動インサイト ─────────────────────────────────────────
    ins_list = run_insights()
    if ins_list:
        st.markdown("##### 💡 自動で見つけた注目ポイント")
        n_crit = sum(1 for i in ins_list if i.severity == "critical")
        n_warn = sum(1 for i in ins_list if i.severity == "warning")
        n_info = sum(1 for i in ins_list if i.severity == "info")
        st.caption(f"🚨 要対応 {n_crit} 件 / ⚠️ 要注視 {n_warn} 件 / 💡 参考 {n_info} 件")
        max_show = st.session_state.get("show_all_insights", False)
        items = ins_list if max_show else ins_list[:6]
        for ins in items:
            _insight_card(ins)
        if len(ins_list) > 6 and not max_show:
            if st.button(f"さらに {len(ins_list) - 6} 件を表示"):
                st.session_state.show_all_insights = True
                st.rerun()
        st.divider()

    # Row 1: ボリューム
    st.markdown("##### 📦 ボリューム")
    c = st.columns(4)
    c[0].metric("総出荷ピース", _fmt(k["total_pcs_out"]))
    c[1].metric("総出荷ライン (行)", _fmt(k["total_lines_out"]))
    c[2].metric("総 PS 数", _fmt(k["total_orders"]),
                help="受注番号(伝票/ピッキングスリップ)単位の件数。列が未マッピングの場合は 0。")
    c[3].metric("総入荷ピース", _fmt(k["total_pcs_in"]))

    # Row 2: 効率(3PL特徴量)
    st.markdown("##### ⚡ 効率指標(3PL 特徴量)")
    c = st.columns(4)
    c[0].metric("行 / PS", _fmt(k["lines_per_order"], 2),
                help="1 オーダーあたりの平均ライン数。マルチピックの複雑さの指標。")
    c[1].metric("ピース / PS", _fmt(k["pcs_per_order"], 2),
                help="1 オーダーあたりの平均ピース数。出荷の重さの指標。")
    c[2].metric("ピース / 行", _fmt(k["pcs_per_line"], 2),
                help="1 ライン(行)あたりの平均ピース数。バラ/ケース傾向の指標。")
    c[3].metric("PS / SKU", _fmt(k["orders_per_sku"], 2),
                help="1 SKU が登場した平均オーダー数。ピック頻度の目安。")

    # Row 3: 偏り・健全性
    st.markdown("##### 📊 偏り・在庫健全性")
    c = st.columns(4)
    c[0].metric("マルチライン PS 率",
                _fmt((k["multi_line_rate"] or 0) * 100 if k["multi_line_rate"] is not None and not pd.isna(k["multi_line_rate"]) else float("nan"), 1, "%"),
                help="複数行(マルチピック)を含む PS の比率。")
    c[1].metric("上位 10% SKU 集中度",
                _fmt((k["top10_sku_share"] or 0) * 100 if k["top10_sku_share"] is not None and not pd.isna(k["top10_sku_share"]) else float("nan"), 1, "%"),
                help="物量上位 10% の SKU が占める数量シェア。")
    c[2].metric("平均回転率", _fmt(k["avg_turnover"], 2),
                help="期間出荷数 ÷ 在庫数 の SKU 平均。")
    c[3].metric("デッドストック SKU",
                f"{k['dead_sku_count']:,} / {k['sku_master']:,}" if k["sku_master"] else "—",
                delta=_fmt((k["dead_sku_rate"] or 0) * 100 if not pd.isna(k["dead_sku_rate"]) else float("nan"), 1, "%"),
                delta_color="inverse",
                help="60 日以上動いていない在庫 SKU 数 / マスタ SKU 数。")

    # Row 4: ピーク / SKU 状況
    st.markdown("##### 🔥 ピーク / SKU")
    c = st.columns(4)
    c[0].metric("ピーク曜日", k["peak_weekday"] or "—")
    c[1].metric("ピーク日", k["peak_day"].strftime("%Y-%m-%d") if k["peak_day"] is not None else "—",
                delta=_fmt(k["peak_day_qty"]) + " pcs" if k["peak_day_qty"] else None)
    c[2].metric("アクティブ SKU", _fmt(k["sku_active"]))
    c[3].metric("マスタ SKU", _fmt(k["sku_master"]))

    st.divider()

    # ミニチャート
    mc1, mc2 = st.columns(2)
    with mc1:
        df_trend = run_volume_trends("D")
        st.plotly_chart(charts.trends_line(df_trend, "qty", "日次ピース推移"), width="stretch")
    with mc2:
        if has_data("shipments"):
            by_w, _, _ = run_peak()
            st.plotly_chart(charts.weekday_bar(by_w, "lines", "曜日別 ライン数"), width="stretch")

    # 注意喚起 / 上位リスト
    st.markdown("##### 🔍 注目ポイント")
    cl, cr = st.columns(2)
    with cl:
        st.markdown("**出荷数 上位 5 SKU**")
        if has_data("shipments"):
            top = run_abc("sku", 0.7, 0.9).head(5).rename(columns=ABC_COLS)
            st.dataframe(top[["SKU", "数量", "ランク"]], width="stretch", hide_index=True)
        else:
            st.caption("出荷データ未取込")
    with cr:
        st.markdown("**デッドストック 上位 5 SKU(在庫数 順)**")
        if has_data("inventory"):
            ti = run_turnover(60)
            dead_top = ti[ti["dead_stock"]].head(5).rename(columns=INV_COLS)
            cols = [c for c in ("SKU", "在庫数", "最終出荷からの経過日数") if c in dead_top.columns]
            if dead_top.empty:
                st.success("デッドストックはありません。")
            else:
                st.dataframe(dead_top[cols], width="stretch", hide_index=True)
        else:
            st.caption("在庫データ未取込")

# ── 物量推移 ────────────────────────────────────────────────────────────────
with tab_trend:
    if not has_data("shipments") and not has_data("inbound"):
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
        df_trend = run_volume_trends(freq)
        st.plotly_chart(
            charts.trends_line(df_trend, value=value, title=f"{freq_label}の{metric_label}推移"),
            width="stretch",
        )

        st.markdown("##### 🚨 日次異常検知 (z-score)")
        c_a, c_b = st.columns([3, 1])
        with c_b:
            z = st.slider("検出感度 (z)", 1.5, 3.5, 2.0, 0.1, help="平均から ±n σ を外れた日を異常と判定")
        df_ano = run_anomalies(z=z)
        c_a.plotly_chart(charts.anomaly_line(df_ano, title=f"日次出荷量と異常日(z≥{z})"), width="stretch")
        if not df_ano.empty and df_ano["anomaly"].any():
            with st.expander(f"異常日 {int(df_ano['anomaly'].sum())} 件の詳細"):
                st.dataframe(df_ano[df_ano["anomaly"]].assign(z=lambda d: d["z"].round(2)), width="stretch", hide_index=True)

        if not df_trend.empty:
            with st.expander("集計データを見る"):
                st.dataframe(df_trend.rename(columns=TREND_COLS), width="stretch", hide_index=True)

# ── ABC 分析 ────────────────────────────────────────────────────────────────
with tab_abc:
    if not has_data("shipments"):
        st.info("出荷明細を取り込むと、ABC 分析が表示されます。")
    else:
        st.caption("出荷数量の多い順に並べ、上位(A)・中位(B)・下位(C)にランク分けします。")
        c1, c2 = st.columns(2)
        with c1:
            axis_opts = {"SKU": "sku"}
            if has_col("shipments", "partner"):
                axis_opts["取引先"] = "partner"
            axis_label = segmented("分析軸", list(axis_opts), key="abc_axis")
            axis = axis_opts[axis_label]
        with c2:
            a, b = st.slider("A / B ランクの累積構成比しきい値", 0.5, 0.99, (0.7, 0.9), 0.05)
        df_abc = run_abc(axis, a, b)
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
    if not has_data("shipments"):
        st.info("出荷明細を取り込むと、ピーク分析が表示されます。")
    else:
        st.caption("曜日や時間帯ごとの繁閑を把握し、人員シフトの検討に活用します。")
        metric_label = segmented("指標", ["件数", "数量"], key="peak_metric")
        value = "lines" if metric_label == "件数" else "qty"
        by_w, by_h, hm = run_peak()
        col_a, col_b = st.columns(2)
        col_a.plotly_chart(charts.weekday_bar(by_w, value=value, title=f"曜日別{metric_label}"), width="stretch")
        if by_h is not None and not by_h.empty:
            col_b.plotly_chart(charts.hour_bar(by_h, value=value, title=f"時間帯別{metric_label}"), width="stretch")
        else:
            col_b.info("時刻別の分析には「出荷日時」列の割り当てが必要です。")
        if hm is not None and not hm.empty:
            st.plotly_chart(charts.hour_weekday_heatmap(hm), width="stretch")
        if has_col("shipments", "partner"):
            st.markdown("##### 🤝 取引先 × 曜日 ヒートマップ")
            pmx = run_partner_matrix(value=value)
            if not pmx.empty:
                st.plotly_chart(charts.partner_heatmap(pmx, title=f"取引先 × 曜日 ({metric_label})"), width="stretch")

# ── 在庫回転 ────────────────────────────────────────────────────────────────
with tab_inv:
    if not has_data("inventory"):
        st.info("在庫スナップショットを取り込むと、回転率と滞留状況が表示されます。")
    else:
        st.caption("SKU ごとの回転率を算出し、長く動いていない在庫(デッドストック)を洗い出します。")
        dead_days = st.slider("デッドストック判定（最終出荷からの経過日数）", 14, 180, 60, 7)
        df_inv = run_turnover(dead_days)
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


# ── 🔮 予測 ────────────────────────────────────────────────────────────────
with tab_fc:
    if not has_data("shipments"):
        st.info("出荷明細を取り込むと、予測が表示されます。")
    else:
        st.caption("曜日季節性 + 直近トレンドによる簡易予測。配車・人員計画の早期判断材料に。")
        c = st.columns(3)
        with c[0]:
            horizon = st.slider("予測期間 (日)", 7, 30, 14, 1)
        df_fc = run_forecast(horizon)
        st.plotly_chart(charts.forecast_band(df_fc, title=f"出荷予測 ({horizon} 日先)"), width="stretch")
        fc_only = df_fc[df_fc["kind"] == "forecast"]
        if not fc_only.empty:
            total_fc = float(fc_only["qty"].sum())
            actual_period_avg = float(df_fc[df_fc["kind"] == "actual"]["qty"].tail(horizon).sum())
            m = st.columns(3)
            m[0].metric(f"予測合計({horizon}日)", f"{total_fc:,.0f} pcs")
            m[1].metric(f"直近{horizon}日実績", f"{actual_period_avg:,.0f} pcs")
            delta_pct = (total_fc - actual_period_avg) / actual_period_avg * 100 if actual_period_avg else 0
            m[2].metric("予測 vs 直近", f"{delta_pct:+.1f}%")
            with st.expander("予測明細"):
                st.dataframe(fc_only.assign(qty=lambda d: d["qty"].round(0)).rename(columns={"date": "日付", "qty": "予測数量", "lower": "下限", "upper": "上限"})[["日付", "予測数量", "下限", "上限"]], width="stretch", hide_index=True)


# ── 🧬 SKU ポートフォリオ ──────────────────────────────────────────────────
with tab_pf:
    if not has_data("inventory") or not has_data("shipments"):
        st.info("出荷明細 + 在庫スナップショットを取り込むと表示されます。")
    else:
        st.caption("回転率 × 在庫数で 4 象限に分類。優良 / 過剰 / 主力 / 死蔵候補が一目で分かります。")
        df_pf = run_portfolio()
        if df_pf.empty:
            st.warning("分類できる SKU がありません。")
        else:
            counts = df_pf["quadrant"].value_counts()
            cols = st.columns(4)
            order = ["🟢 優良(高回転・少在庫)", "🔵 主力(高回転・多在庫)", "🟠 過剰(低回転・多在庫)", "⚪ 死蔵候補(低回転・少在庫)"]
            for i, q in enumerate(order):
                cols[i].metric(q, f"{int(counts.get(q, 0)):,} 品")
            st.plotly_chart(charts.sku_portfolio_scatter(df_pf), width="stretch")

            st.markdown("##### 🧬 SKU ライフサイクル分布")
            df_life = run_lifecycle()
            cl, cr = st.columns([1, 2])
            with cl:
                st.plotly_chart(charts.lifecycle_donut(df_life), width="stretch")
            with cr:
                if not df_life.empty:
                    status_counts = df_life["status"].value_counts().rename_axis("status").reset_index(name="count")
                    st.dataframe(status_counts, width="stretch", hide_index=True)
                    st.markdown("**新規 / 成長 SKU 上位**")
                    grown = df_life[df_life["status"].isin(["新規", "成長"])].sort_values("recent_qty", ascending=False).head(10)
                    if not grown.empty:
                        st.dataframe(grown[["sku", "status", "recent_qty", "prev_qty", "change_rate"]].assign(change_rate=lambda d: (d["change_rate"] * 100).round(1)), width="stretch", hide_index=True)


# ── 🔁 期間対比 ────────────────────────────────────────────────────────────
with tab_cmp:
    if not has_data("shipments"):
        st.info("出荷明細を取り込むと、期間対比が表示されます。")
    else:
        st.caption("2 つの期間を比較し、誰(SKU / 取引先)が変化を主導したかを寄与度で可視化します。")
        bounds = None
        if ss.engine == "pandas":
            bounds = (shipments["date"].min().date(), shipments["date"].max().date())
        else:
            db = catalog.date_bounds()
            if db: bounds = (db[0].date(), db[1].date())
        if not bounds or bounds[0] == bounds[1]:
            st.warning("期間が短すぎて対比できません。")
        else:
            mid = bounds[0] + (bounds[1] - bounds[0]) / 2
            c1, c2 = st.columns(2)
            with c1:
                st.markdown("**期間 A (旧)**")
                a_range = st.slider("期間 A", min_value=bounds[0], max_value=bounds[1], value=(bounds[0], mid), key="cmp_a")
            with c2:
                st.markdown("**期間 B (新)**")
                b_range = st.slider("期間 B", min_value=bounds[0], max_value=bounds[1], value=(mid, bounds[1]), key="cmp_b")
            axis_opts = {"SKU": "sku"}
            if has_col("shipments", "partner"):
                axis_opts["取引先"] = "partner"
            axis_label = segmented("分析軸", list(axis_opts), key="cmp_axis")
            axis = axis_opts[axis_label]
            df_cmp = run_period_compare(a_range, b_range, key=axis, top_n=20)
            if df_cmp.empty:
                st.warning("対比結果が空です。期間を広げてください。")
            else:
                total_a = float(df_cmp["qty_a"].sum())
                total_b = float(df_cmp["qty_b"].sum())
                delta = total_b - total_a
                pct = (delta / total_a * 100) if total_a else 0
                m = st.columns(3)
                m[0].metric("期間 A 合計", f"{total_a:,.0f}")
                m[1].metric("期間 B 合計", f"{total_b:,.0f}")
                m[2].metric("変化", f"{delta:+,.0f}", delta=f"{pct:+.1f}%")
                st.plotly_chart(charts.contribution_waterfall(df_cmp, key=axis, title=f"{axis_label} 別 寄与度 (期間B - 期間A)"), width="stretch")
                with st.expander("寄与度 詳細データ"):
                    cols_show = {axis: axis_label, "qty_a": "期間A数量", "qty_b": "期間B数量", "delta": "変化", "contribution": "寄与度"}
                    st.dataframe(df_cmp.rename(columns=cols_show), width="stretch", hide_index=True)
