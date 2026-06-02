"""Plotly chart builders shared across the dashboard tabs.

Colours come from the design system (src/theme.py) so meaning maps to colour
consistently everywhere: 入庫/出庫 fixed, A/B/C single-hue 3-step, 増=緑/減=赤,
one heatmap scale. The active Plotly template (registered by theme) supplies
fonts, grid, margins and legend — charts only set what is chart-specific.
"""
from __future__ import annotations

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go

from src import theme as T

# Chart-specific layout only; fonts/grid/bg/margins come from the template.
_LAYOUT = dict(
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
)


def trends_line(df: pd.DataFrame, value: str = "qty", title: str = "物量推移") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.line(df, x="period", y=value, color="kind", markers=True, title=title,
                  color_discrete_map=T.FLOW)
    fig.update_traces(line=dict(width=2.4), marker=dict(size=5))
    fig.update_layout(xaxis_title="期間", yaxis_title=value, **_LAYOUT)
    return fig


def pareto(df: pd.DataFrame, key: str, value: str = "qty", title: str = "ABC 分析") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    top = df.head(50)
    # Bars coloured by ABC rank when available (A=濃 / B=中 / C=淡), else primary.
    if "rank" in top.columns:
        bar_colors = [T.RANK.get(r, T.PRIMARY) for r in top["rank"]]
    else:
        bar_colors = T.PRIMARY
    fig = go.Figure()
    fig.add_bar(x=top[key].astype(str), y=top[value], name=value, marker_color=bar_colors)
    fig.add_trace(
        go.Scatter(
            x=top[key].astype(str), y=top["cum_share"] * 100, name="累積構成比 (%)",
            yaxis="y2", mode="lines+markers", line=dict(color=T.ACCENT, width=2.4),
            marker=dict(size=5),
        )
    )
    # 80% reference line (Pareto convention).
    fig.add_hline(y=80, line=dict(color=T.INK_FAINT, width=1, dash="dash"),
                  yref="y2", annotation_text="80%", annotation_position="right",
                  annotation_font=dict(size=11, color=T.INK_FAINT))
    fig.update_layout(
        title=title, yaxis=dict(title=value),
        yaxis2=dict(title="累積構成比 (%)", overlaying="y", side="right", range=[0, 100],
                    showgrid=False),
        **_LAYOUT,
    )
    return fig


def weekday_bar(df: pd.DataFrame, value: str = "lines", title: str = "曜日別") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.bar(df, x="weekday", y=value, title=title,
                 color_discrete_sequence=[T.PRIMARY])
    fig.update_layout(xaxis_title="曜日", yaxis_title=value, **_LAYOUT)
    return fig


def hour_bar(df: pd.DataFrame, value: str = "lines", title: str = "時間帯別") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.bar(df, x="hour", y=value, title=title, color_discrete_sequence=[T.PRIMARY])
    fig.update_layout(xaxis_title="時間帯 (時)", yaxis_title=value, xaxis=dict(dtick=1), **_LAYOUT)
    return fig


def hour_weekday_heatmap(matrix: pd.DataFrame, title: str = "曜日 × 時間帯ヒートマップ") -> go.Figure:
    if matrix.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.imshow(
        matrix.values, x=[f"{h}時" for h in matrix.columns], y=list(matrix.index),
        aspect="auto", color_continuous_scale=T.HEATMAP_SCALE, title=title,
    )
    fig.update_layout(**_LAYOUT)
    return fig


def anomaly_line(df: pd.DataFrame, title: str = "日次推移 + 異常検知") -> go.Figure:
    """日次出荷量、7日移動平均、異常点(z>=しきい値)を 1 つに重ねる。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=df["date"], y=df["qty"], mode="lines+markers", name="日次出荷",
                             line=dict(color=T.PRIMARY, width=2.2), marker=dict(size=4)))
    if "ma7" in df.columns:
        fig.add_trace(go.Scatter(x=df["date"], y=df["ma7"], mode="lines", name="7日移動平均",
                                 line=dict(color=T.INK_FAINT, dash="dot", width=1.8)))
    if "anomaly" in df.columns:
        anom = df[df["anomaly"]]
        if not anom.empty:
            fig.add_trace(go.Scatter(
                x=anom["date"], y=anom["qty"], mode="markers", name="異常検知",
                marker=dict(color=T.ACCENT, size=13, symbol="x-thin", line=dict(width=2.5)),
                hovertemplate="%{x|%Y-%m-%d}<br>qty=%{y}<br>z=%{customdata:+.1f}σ<extra></extra>",
                customdata=anom["z"],
            ))
    fig.update_layout(title=title, xaxis_title="日付", yaxis_title="出荷数量", **_LAYOUT)
    return fig


def forecast_band(df: pd.DataFrame, title: str = "出荷予測 (14日先)") -> go.Figure:
    """実績(青実線)+ 予測(アンバー点線)+ 95%バンド。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    actual = df[df["kind"] == "actual"]
    fc = df[df["kind"] == "forecast"]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=actual["date"], y=actual["qty"], mode="lines", name="実績",
                             line=dict(color=T.PRIMARY, width=2.4)))
    if not fc.empty:
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["upper"], mode="lines", showlegend=False,
                                 line=dict(width=0)))
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["lower"], mode="lines", name="95% バンド",
                                 fill="tonexty", fillcolor="rgba(242,162,12,0.16)",
                                 line=dict(width=0)))
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["qty"], mode="lines+markers", name="予測",
                                 line=dict(color=T.ACCENT, dash="dot", width=2.4),
                                 marker=dict(size=5)))
    fig.update_layout(title=title, xaxis_title="日付", yaxis_title="出荷数量", **_LAYOUT)
    return fig


def sku_portfolio_scatter(df: pd.DataFrame, title: str = "SKU ポートフォリオ (回転率 × 在庫)") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.scatter(
        df, x="turnover", y="stock_qty", color="quadrant",
        hover_name="sku", size="shipped_qty", size_max=30, title=title,
        labels={"turnover": "回転率", "stock_qty": "在庫数", "shipped_qty": "期間出荷数"},
        color_discrete_map=T.QUADRANT,
    )
    fig.update_traces(marker=dict(line=dict(width=0.5, color="#FFFFFF")))
    fig.update_layout(**_LAYOUT)
    return fig


def partner_heatmap(matrix: pd.DataFrame, title: str = "取引先 × 曜日 ヒートマップ") -> go.Figure:
    if matrix.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.imshow(
        matrix.values, x=list(matrix.columns), y=list(matrix.index),
        aspect="auto", color_continuous_scale=T.HEATMAP_SCALE, title=title,
        labels={"x": "曜日", "y": "取引先", "color": "値"},
    )
    fig.update_layout(**_LAYOUT)
    return fig


def contribution_waterfall(df: pd.DataFrame, key: str, title: str = "期間A → 期間B 変化の寄与度") -> go.Figure:
    """期間対比の寄与度 (delta) を棒で表示。増=緑 / 減=赤 (全タブ共通の増減色)。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    colors = [T.DELTA_UP if d >= 0 else T.DELTA_DOWN for d in df["delta"]]
    fig = go.Figure(go.Bar(
        x=df[key].astype(str), y=df["delta"], marker_color=colors,
        hovertemplate="%{x}<br>delta=%{y:+,.0f}<extra></extra>",
    ))
    fig.update_layout(title=title, xaxis_title=key, yaxis_title="期間B - 期間A", **_LAYOUT)
    return fig


def lifecycle_donut(df: pd.DataFrame, title: str = "SKU ライフサイクル分布") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    counts = df["status"].value_counts()
    fig = go.Figure(go.Pie(
        labels=counts.index, values=counts.values, hole=0.55, sort=False,
        marker=dict(colors=T.LIFECYCLE_COLORS, line=dict(color="#FFFFFF", width=1.5)),
    ))
    fig.update_layout(title=title, **_LAYOUT)
    return fig


__all__ = [
    "trends_line", "pareto", "weekday_bar", "hour_bar", "hour_weekday_heatmap",
    "anomaly_line", "forecast_band", "sku_portfolio_scatter",
    "partner_heatmap", "contribution_waterfall", "lifecycle_donut",
]
