"""Design system for the 3PL dashboard — tone "Clean Logistics".

One place for the visual language so every tab is cohesive (the renewal brief's
core ask): semantic colour tokens, a single Plotly template, a global CSS layer
(KPI cards, section titles, tabs, insight cards, tables, mobile), and the insight
-card HTML builder. Stays inside Streamlit's constraints — theme tokens + custom
CSS cards + a Plotly template — no DOM surgery.

Usage in app.py:
    from src import theme
    theme.register_plotly_template()   # once, before any chart is built
    theme.inject_css()                 # once, near the top
"""
from __future__ import annotations

import plotly.graph_objects as go
import plotly.io as pio
import streamlit as st

# ── colour tokens ───────────────────────────────────────────────────────────
PRIMARY = "#1565C0"
PRIMARY_DARK = "#0D47A1"
PRIMARY_SOFT = "#E8F1FC"
ACCENT = "#F2A20C"          # amber — highlights, anomalies, "next action"
INK = "#1F2A37"
INK_SOFT = "#5B6B7B"
INK_FAINT = "#8A98A8"
SURFACE = "#FFFFFF"
SURFACE_2 = "#F4F7FB"
LINE = "#E3E8EF"
GRID = "#EDF1F6"

# semantic
SUCCESS = "#2E9E5B"
DANGER = "#D64550"
WARNING = "#E8911A"
INFO = PRIMARY

# increase / decrease (一貫した増減色, all tabs)
DELTA_UP = SUCCESS
DELTA_DOWN = DANGER

# flow: 出荷(outbound) / 入荷(inbound)
FLOW = {"出荷": PRIMARY, "入荷": "#2BA89E", "outbound": PRIMARY, "inbound": "#2BA89E"}

# ABC rank — single-hue 3-step (A=濃 / B=中 / C=淡)
RANK = {"A": PRIMARY_DARK, "B": "#5B9BD5", "C": "#C2D8F0"}

# SKU portfolio quadrants (scatter ⇄ donut share these)
QUADRANT = {
    "🟢 優良(高回転・少在庫)": SUCCESS,
    "🔵 主力(高回転・多在庫)": PRIMARY,
    "🟠 過剰(低回転・多在庫)": ACCENT,
    "⚪ 死蔵候補(低回転・少在庫)": "#9AA7B4",
}
LIFECYCLE_COLORS = [SUCCESS, PRIMARY, ACCENT, "#E07B53", "#9AA7B4"]

# one continuous heatmap scale everywhere (淡→濃, single hue)
HEATMAP_SCALE = [[0.0, "#EAF2FB"], [0.5, "#7FB0E4"], [1.0, PRIMARY_DARK]]

# categorical colourway for misc multi-series charts
CATEGORICAL = [PRIMARY, "#2BA89E", ACCENT, "#7E57C2", "#EC6A5C", "#26849E", "#9AA7B4"]

# insight severity (refined from the original 3-step)
SEVERITY = {
    "critical": {"bg": "#FCEDEC", "bar": DANGER, "ink": "#A02622", "chip": "要対応"},
    "warning": {"bg": "#FDF4E5", "bar": WARNING, "ink": "#8A5A12", "chip": "要注視"},
    "info": {"bg": PRIMARY_SOFT, "bar": PRIMARY, "ink": "#0D47A1", "chip": "参考"},
}

FONT_STACK = ('"Inter","Noto Sans JP","Hiragino Kaku Gothic ProN","Yu Gothic",'
              '"Meiryo",system-ui,sans-serif')


# ── Plotly template ─────────────────────────────────────────────────────────
def register_plotly_template(name: str = "logi") -> None:
    """Register and activate a clean template applied to every chart."""
    tmpl = go.layout.Template()
    tmpl.layout = go.Layout(
        font=dict(family=FONT_STACK, size=13, color=INK),
        paper_bgcolor=SURFACE,
        plot_bgcolor=SURFACE,
        colorway=CATEGORICAL,
        title=dict(font=dict(size=15, color=INK), x=0.01, xanchor="left", pad=dict(b=6)),
        margin=dict(l=48, r=20, t=48, b=44),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1,
                    bgcolor="rgba(0,0,0,0)", font=dict(size=12, color=INK_SOFT)),
        xaxis=dict(showgrid=False, zeroline=False, linecolor=LINE, ticks="outside",
                   tickcolor=LINE, tickfont=dict(size=12, color=INK_SOFT),
                   title=dict(font=dict(size=12, color=INK_SOFT))),
        yaxis=dict(showgrid=True, gridcolor=GRID, zeroline=False, linecolor="rgba(0,0,0,0)",
                   tickfont=dict(size=12, color=INK_SOFT),
                   title=dict(font=dict(size=12, color=INK_SOFT))),
        colorscale=dict(sequential=HEATMAP_SCALE),
        hoverlabel=dict(bgcolor=INK, font=dict(color="#FFFFFF", family=FONT_STACK, size=12),
                        bordercolor=INK),
    )
    pio.templates[name] = tmpl
    # Compose with plotly_white so unspecified bits stay sane.
    pio.templates.default = f"plotly_white+{name}"


# ── insight card ──────────────────────────────────────────────────────────────
def insight_card_html(icon: str, title: str, detail: str, suggestion: str | None,
                      metric: str | None, severity: str) -> str:
    """Refined severity card: left accent bar, severity chip, metric, 次の一手 pill."""
    s = SEVERITY.get(severity, SEVERITY["info"])
    metric_html = (f"<span class='ins-metric' style='color:{s['bar']}'>{metric}</span>"
                   if metric else "")
    sug_html = (f"<div class='ins-action'><span class='ins-action-tag'>次の一手</span>{suggestion}</div>"
                if suggestion else "")
    return (
        f"<div class='ins-card' style='background:{s['bg']};border-left:5px solid {s['bar']}'>"
        f"<div class='ins-head'>"
        f"<span class='ins-chip' style='background:{s['bar']}'>{s['chip']}</span>"
        f"<span class='ins-title' style='color:{s['ink']}'>{icon} {title}</span>"
        f"{metric_html}</div>"
        f"<div class='ins-detail'>{detail}</div>{sug_html}</div>"
    )


# ── global CSS ────────────────────────────────────────────────────────────────
def _css() -> str:
    return f"""
    <style>
    :root {{
      --logi-primary:{PRIMARY}; --logi-accent:{ACCENT}; --logi-ink:{INK};
      --logi-ink-soft:{INK_SOFT}; --logi-line:{LINE}; --logi-surface-2:{SURFACE_2};
    }}
    html, body, .stApp, [class*="st-"] {{ font-family:{FONT_STACK}; }}
    .stApp {{ color:{INK}; }}
    .block-container {{ padding-top:1.6rem; padding-bottom:3rem; max-width:1280px; }}

    /* App title + caption */
    h1 {{ font-weight:800; letter-spacing:-.01em; color:{INK}; }}

    /* Section titles (markdown ##### …) → accent rule + tracking */
    [data-testid="stMarkdownContainer"] h5 {{
      position:relative; margin:1.5rem 0 .6rem; padding-left:.7rem;
      font-size:1.02rem; font-weight:700; color:{INK}; letter-spacing:.01em;
    }}
    [data-testid="stMarkdownContainer"] h5::before {{
      content:""; position:absolute; left:0; top:.15em; bottom:.15em; width:4px;
      border-radius:2px; background:{PRIMARY};
    }}

    /* KPI metric → card */
    div[data-testid="stMetric"] {{
      background:{SURFACE}; border:1px solid {LINE}; border-radius:.7rem;
      padding:.85rem 1rem; box-shadow:0 1px 2px rgba(16,40,80,.04);
      transition:border-color .15s, box-shadow .15s;
    }}
    div[data-testid="stMetric"]:hover {{
      border-color:#C9D7E8; box-shadow:0 3px 10px rgba(16,40,80,.07);
    }}
    div[data-testid="stMetricValue"] {{
      font-variant-numeric:tabular-nums; font-weight:750; color:{INK}; line-height:1.1;
    }}
    div[data-testid="stMetricLabel"] {{ color:{INK_SOFT}; font-weight:600; }}
    div[data-testid="stMetricLabel"] p {{ font-size:.82rem; }}

    /* Tabs → underline-active, comfortable hit area */
    div[data-baseweb="tab-list"] {{
      gap:.15rem; border-bottom:1px solid {LINE}; flex-wrap:wrap;
    }}
    button[data-baseweb="tab"] {{
      font-weight:600; color:{INK_SOFT}; padding:.55rem .85rem;
    }}
    button[data-baseweb="tab"][aria-selected="true"] {{ color:{PRIMARY}; }}
    div[data-baseweb="tab-highlight"], div[data-baseweb="tab-border"] {{ background:{PRIMARY} !important; }}

    /* Insight cards */
    .ins-card {{ padding:.7rem .95rem; margin-bottom:.55rem; border-radius:.55rem; }}
    .ins-head {{ display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }}
    .ins-chip {{ color:#fff; font-size:.68rem; font-weight:700; padding:.08rem .5rem;
      border-radius:99px; letter-spacing:.02em; white-space:nowrap; }}
    .ins-title {{ font-weight:700; font-size:.97rem; }}
    .ins-metric {{ margin-left:auto; font-weight:800; font-variant-numeric:tabular-nums;
      white-space:nowrap; }}
    .ins-detail {{ color:{INK_SOFT}; font-size:.86rem; margin-top:.25rem; line-height:1.5; }}
    .ins-action {{ margin-top:.45rem; font-size:.85rem; color:{INK}; }}
    .ins-action-tag {{ display:inline-block; background:{INK}; color:#fff; font-size:.66rem;
      font-weight:700; padding:.06rem .45rem; border-radius:4px; margin-right:.45rem; }}

    /* Dataframe — softer chrome */
    div[data-testid="stDataFrame"] {{ border:1px solid {LINE}; border-radius:.6rem; }}

    /* Buttons — primary fill uses theme primaryColor; refine secondary */
    .stButton > button {{ border-radius:.5rem; font-weight:600; }}

    /* Sidebar polish */
    section[data-testid="stSidebar"] {{ border-right:1px solid {LINE}; }}
    section[data-testid="stSidebar"] .block-container {{ padding-top:1rem; }}

    /* Mobile — vertical stacking, readable metrics, tab wrap */
    @media (max-width: 760px) {{
      section[data-testid="stSidebar"] {{ min-width:88vw !important; }}
      div[data-testid="stHorizontalBlock"] > div[data-testid="stColumn"] {{
        flex:1 1 100% !important; min-width:100% !important;
      }}
      div[data-testid="stMetricValue"] {{ font-size:1.35rem !important; }}
      h1 {{ font-size:1.5rem !important; }}
      .block-container {{ padding:1rem .6rem 2rem !important; }}
      button[data-baseweb="tab"] {{ padding:.4rem .55rem !important; font-size:.9rem !important; }}
    }}
    </style>
    """


def inject_css() -> None:
    st.markdown(_css(), unsafe_allow_html=True)
