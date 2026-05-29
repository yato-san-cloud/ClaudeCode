"""Plotly chart builders shared across the dashboard tabs."""
from __future__ import annotations

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go


_LAYOUT = dict(
    margin=dict(l=40, r=20, t=40, b=40),
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
    template="plotly_white",
)


def trends_line(df: pd.DataFrame, value: str = "qty", title: str = "物量推移") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.line(df, x="period", y=value, color="kind", markers=True, title=title)
    fig.update_layout(xaxis_title="期間", yaxis_title=value, **_LAYOUT)
    return fig


def pareto(df: pd.DataFrame, key: str, value: str = "qty", title: str = "ABC 分析") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    top = df.head(50)
    fig = go.Figure()
    fig.add_bar(x=top[key].astype(str), y=top[value], name=value, marker_color="#4C78A8")
    fig.add_trace(
        go.Scatter(
            x=top[key].astype(str),
            y=top["cum_share"] * 100,
            name="累積構成比 (%)",
            yaxis="y2",
            mode="lines+markers",
            line=dict(color="#E45756"),
        )
    )
    fig.update_layout(
        title=title,
        yaxis=dict(title=value),
        yaxis2=dict(title="累積構成比 (%)", overlaying="y", side="right", range=[0, 100]),
        **_LAYOUT,
    )
    return fig


def weekday_bar(df: pd.DataFrame, value: str = "lines", title: str = "曜日別") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.bar(df, x="weekday", y=value, title=title, color_discrete_sequence=["#4C78A8"])
    fig.update_layout(xaxis_title="曜日", yaxis_title=value, **_LAYOUT)
    return fig


def hour_bar(df: pd.DataFrame, value: str = "lines", title: str = "時間帯別") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.bar(df, x="hour", y=value, title=title, color_discrete_sequence=["#54A24B"])
    fig.update_layout(xaxis_title="時間帯 (時)", yaxis_title=value, xaxis=dict(dtick=1), **_LAYOUT)
    return fig


def hour_weekday_heatmap(matrix: pd.DataFrame, title: str = "曜日 × 時間帯ヒートマップ") -> go.Figure:
    if matrix.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.imshow(
        matrix.values,
        x=[f"{h}時" for h in matrix.columns],
        y=list(matrix.index),
        aspect="auto",
        color_continuous_scale="Blues",
        title=title,
    )
    fig.update_layout(**_LAYOUT)
    return fig


def anomaly_line(df: pd.DataFrame, title: str = "日次推移 + 異常検知") -> go.Figure:
    """日次出荷量、7日移動平均、異常点(z>=しきい値)を 1 つに重ねる。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=df["date"], y=df["qty"], mode="lines+markers", name="日次出荷",
                             line=dict(color="#4C78A8")))
    if "ma7" in df.columns:
        fig.add_trace(go.Scatter(x=df["date"], y=df["ma7"], mode="lines", name="7日移動平均",
                                 line=dict(color="#888", dash="dot")))
    if "anomaly" in df.columns:
        anom = df[df["anomaly"]]
        if not anom.empty:
            fig.add_trace(go.Scatter(
                x=anom["date"], y=anom["qty"], mode="markers", name="異常検知",
                marker=dict(color="#E45756", size=12, symbol="x-thin", line=dict(width=2)),
                hovertemplate="%{x|%Y-%m-%d}<br>qty=%{y}<br>z=%{customdata:+.1f}σ<extra></extra>",
                customdata=anom["z"],
            ))
    fig.update_layout(title=title, xaxis_title="日付", yaxis_title="出荷数量", **_LAYOUT)
    return fig


def forecast_band(df: pd.DataFrame, title: str = "出荷予測 (14日先)") -> go.Figure:
    """実績(青実線)+ 予測(オレンジ点線)+ 95%バンド。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    actual = df[df["kind"] == "actual"]
    fc = df[df["kind"] == "forecast"]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=actual["date"], y=actual["qty"], mode="lines", name="実績",
                             line=dict(color="#4C78A8")))
    if not fc.empty:
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["upper"], mode="lines", showlegend=False,
                                 line=dict(width=0)))
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["lower"], mode="lines", name="95% バンド",
                                 fill="tonexty", fillcolor="rgba(244,162,97,0.2)",
                                 line=dict(width=0)))
        fig.add_trace(go.Scatter(x=fc["date"], y=fc["qty"], mode="lines+markers", name="予測",
                                 line=dict(color="#F4A261", dash="dot")))
    fig.update_layout(title=title, xaxis_title="日付", yaxis_title="出荷数量", **_LAYOUT)
    return fig


def sku_portfolio_scatter(df: pd.DataFrame, title: str = "SKU ポートフォリオ (回転率 × 在庫)") -> go.Figure:
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.scatter(
        df, x="turnover", y="stock_qty", color="quadrant",
        hover_name="sku", size="shipped_qty", size_max=30,
        title=title,
        labels={"turnover": "回転率", "stock_qty": "在庫数", "shipped_qty": "期間出荷数"},
        color_discrete_map={
            "🟢 優良(高回転・少在庫)": "#2A9D8F",
            "🔵 主力(高回転・多在庫)": "#4C78A8",
            "🟠 過剰(低回転・多在庫)": "#E76F51",
            "⚪ 死蔵候補(低回転・少在庫)": "#999999",
        },
    )
    fig.update_layout(**_LAYOUT)
    return fig


def partner_heatmap(matrix: pd.DataFrame, title: str = "取引先 × 曜日 ヒートマップ") -> go.Figure:
    if matrix.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    fig = px.imshow(
        matrix.values, x=list(matrix.columns), y=list(matrix.index),
        aspect="auto", color_continuous_scale="Blues", title=title,
        labels={"x": "曜日", "y": "取引先", "color": "値"},
    )
    fig.update_layout(**_LAYOUT)
    return fig


def contribution_waterfall(df: pd.DataFrame, key: str, title: str = "期間A → 期間B 変化の寄与度") -> go.Figure:
    """期間対比の寄与度 (delta) を棒で表示。プラスは緑、マイナスは赤。"""
    if df.empty:
        return go.Figure().update_layout(title=title, **_LAYOUT)
    colors = ["#2A9D8F" if d >= 0 else "#E45756" for d in df["delta"]]
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
        labels=counts.index, values=counts.values, hole=0.5, sort=False,
        marker=dict(colors=["#2A9D8F", "#4C78A8", "#E9C46A", "#E76F51", "#999"]),
    ))
    fig.update_layout(title=title, **_LAYOUT)
    return fig


__all__ = [
    "trends_line", "pareto", "weekday_bar", "hour_bar", "hour_weekday_heatmap",
    "anomaly_line", "forecast_band", "sku_portfolio_scatter",
    "partner_heatmap", "contribution_waterfall", "lifecycle_donut",
]
