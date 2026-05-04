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


__all__ = ["trends_line", "pareto", "weekday_bar", "hour_bar", "hour_weekday_heatmap"]
