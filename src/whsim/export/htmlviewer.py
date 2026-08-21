"""共有可能ビューア — a single, self-contained, READ-ONLY HTML deliverable.

``build_viewer_html`` assembles one HTML *string* the salesperson can mail to the
荷主: KPI cards, the proposal PNG (embedded as a base64 ``<img>``), the scorecard
table, and a lightweight top-down 2D replay player written from scratch inline.

Design constraints (asserted by tests):

* **Fully self-contained** — zero external URLs. Nothing is fetched at open time:
  the PNG is a ``data:`` URI, the replay is inlined JSON, the player JS/CSS are
  written into the template. It opens from ``file://`` with no server.
* **Never blocks** — every section is guarded. A bare model (no run) still yields
  valid HTML with a 「実行結果がまだありません」 notice; a missing PNG or replay
  simply omits that block.

The player is intentionally dependency-free (no three.js, no vendored libs): it
lerps worker/AGV keyframes between samples over the same 2D contract that
``render/replay.py`` emits (``meta.bounds``, ``zones``, ``shelves``, ``walls``,
``workers[].keyframes = [t, x, y, state]``).
"""

from __future__ import annotations

import base64
import html
import json
from typing import Any

# Headline KPI cards: (key, label, unit, formatter). Only cards whose value is a
# finite number are emitted, so a partial kpis dict never shows fabricated zeros.
_KPI_CARDS: list[tuple[str, str, str, str]] = [
    ("throughput_per_hr", "スループット", "件/時", "num1"),
    ("completion_rate", "出荷完了率", "%", "pct"),
    ("total_cost_per_order", "1件あたりコスト", "円/件", "yen0"),
    ("monthly_cost", "月間コスト", "円/月", "yen0"),
    ("headcount", "必要人員", "名", "num0"),
    ("picker_utilization", "ピッカー稼働率", "%", "pct"),
    ("payback_months", "投資回収", "ヶ月", "num1"),
    ("walk_per_order_m", "1件あたり歩行", "m", "num1"),
]

# System font stack that resolves to a clean CJK-capable face on Win/mac/Linux.
_FONT_STACK = (
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", '
    '"Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans JP", sans-serif'
)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _fmt(kind: str, v: float) -> str:
    """Format a KPI value; ``pct`` accepts either a fraction (≤1) or an already-%."""
    if kind == "pct":
        scaled = v * 100.0 if abs(v) <= 1.0 else v
        return f"{scaled:.1f}"
    if kind == "yen0":
        return f"{round(v):,}"
    if kind == "num0":
        return f"{round(v):,}"
    if kind == "num1":
        return f"{v:.1f}"
    return str(v)


def _headcount(kpis: dict) -> float | None:
    if _is_num(kpis.get("headcount")):
        return float(kpis["headcount"])
    parts = [kpis.get(k) for k in ("n_pickers", "n_packers", "n_agvs")]
    nums = [float(p) for p in parts if _is_num(p)]
    return sum(nums) if nums else None


def _accent(model, brand) -> str:
    """Resolve the brand accent colour (settings.brand > explicit brand arg)."""
    color = None
    try:
        b = brand if brand is not None else getattr(model.settings, "brand", None)
        color = getattr(b, "accent_color", None) if b is not None else None
        if isinstance(b, dict):
            color = b.get("accent_color")
    except Exception:  # noqa: BLE001 — never blocks; fall through to default
        color = None
    if isinstance(color, str) and color.strip():
        c = color.strip()
        # Guard against anything that could break out of the CSS value context.
        if all(ch not in c for ch in "\"'();{}<>") and len(c) <= 32:
            return c
    return "#2383E2"


def _brand_names(model, brand) -> tuple[str, str, str]:
    """(company_name, client_name, footer_note) — all defaulted to empty."""
    b = brand if brand is not None else getattr(getattr(model, "settings", None), "brand", None)

    def _get(name: str) -> str:
        try:
            if isinstance(b, dict):
                return str(b.get(name, "") or "")
            return str(getattr(b, name, "") or "")
        except Exception:  # noqa: BLE001
            return ""

    return _get("company_name"), _get("client_name"), _get("footer_note")


def _kpi_cards_html(kpis: dict | None) -> str:
    """Big-number KPI cards + 95% CI note when a multi-rep ``ci`` block is present."""
    k = kpis or {}
    ci = k.get("ci") if isinstance(k.get("ci"), dict) else {}
    ci_metrics = ci.get("metrics") if isinstance(ci.get("metrics"), dict) else {}
    cards: list[str] = []
    for key, label, unit, kind in _KPI_CARDS:
        val = _headcount(k) if key == "headcount" else k.get(key)
        if not _is_num(val):
            continue
        value_txt = _fmt(kind, float(val))
        sub = ""
        m = ci_metrics.get(key)
        if isinstance(m, dict) and _is_num(m.get("half_width")):
            half = float(m["half_width"])
            n = int(m.get("n", ci.get("n", 0)) or 0)
            hw = _fmt(kind, half) if kind != "pct" else f"{(half * 100 if abs(half) <= 1 else half):.1f}"
            sub = f"±{hw}（95%CI, n={n}）"
        cards.append(
            '<div class="kpi-card">'
            f'<div class="k-label">{html.escape(label)}</div>'
            f'<div class="k-val">{html.escape(value_txt)}'
            f'<span class="k-unit">{html.escape(unit)}</span></div>'
            + (f'<div class="k-sub">{html.escape(sub)}</div>' if sub else "")
            + "</div>"
        )
    if not cards:
        return '<p class="empty-note">KPIはまだありません。</p>'
    # Honest n=1 disclosure when there were no confidence intervals to report.
    disclosure = ""
    if not ci_metrics:
        disclosure = '<p class="ci-note">※ 単一試行（n=1）の結果です。ばらつきの区間は表示していません。</p>'
    return '<div class="kpi-grid">' + "".join(cards) + "</div>" + disclosure


def _scorecard_html(scorecard: dict | None) -> str:
    """The scorecard's 6 dependent-variable rows as a compact table."""
    rows = (scorecard or {}).get("rows") if isinstance(scorecard, dict) else None
    if not rows:
        return '<p class="empty-note">採点表はまだありません。</p>'
    trs: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = html.escape(str(row.get("label", "")))
        value = html.escape(str(row.get("value", "—")))
        unit = html.escape(str(row.get("unit", "")))
        sub = html.escape(str(row.get("sub", "")))
        tone = str(row.get("tone", "neutral"))
        tone_cls = tone if tone in ("ok", "warn", "bad") else "neutral"
        unit_html = f' <span class="sc-unit">{unit}</span>' if unit else ""
        trs.append(
            f'<tr><th>{label}</th>'
            f'<td class="sc-val tone-{tone_cls}">{value}{unit_html}</td>'
            f'<td class="sc-sub">{sub}</td></tr>'
        )
    return (
        '<table class="scorecard"><thead><tr>'
        '<th>項目</th><th>値</th><th>補足</th></tr></thead>'
        '<tbody>' + "".join(trs) + "</tbody></table>"
    )


def _png_html(png_bytes: bytes | None) -> str:
    """The proposal PNG as an inline base64 ``data:`` URI (no external request)."""
    if not png_bytes:
        return ""
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return (
        '<section class="section"><h2>レイアウト縮図と混雑ヒートマップ</h2>'
        f'<img class="proposal-png" alt="提案レイアウト図" '
        f'src="data:image/png;base64,{b64}"></section>'
    )


def _safe_json(obj: Any) -> str:
    """JSON for inlining inside a <script> — escape ``</`` so it can't close the tag."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def build_viewer_html(
    model,
    replay: dict | None = None,
    kpis: dict | None = None,
    scorecard: dict | None = None,
    png_bytes: bytes | None = None,
    brand=None,
) -> str:
    """Assemble one self-contained, read-only proposal viewer HTML string.

    All arguments are optional / tolerant: any ``None`` simply omits its section
    (a bare model still yields valid HTML with a 「実行結果がまだありません」 note).
    The output makes zero external requests — the PNG is inlined as a data URI and
    the replay is embedded JSON consumed by an inline canvas player.
    """
    accent = _accent(model, brand)
    company, client, footer_note = _brand_names(model, brand)
    try:
        title_name = str(getattr(model.meta, "name", "") or "").strip() or "倉庫"
    except Exception:  # noqa: BLE001
        title_name = "倉庫"

    has_run = bool(kpis) or bool(replay and (replay.get("workers") or replay.get("agvs")))

    kpi_section = (
        '<section class="section"><h2>主要KPI</h2>' + _kpi_cards_html(kpis) + "</section>"
        if kpis else ""
    )
    png_section = _png_html(png_bytes)
    scorecard_section = (
        '<section class="section"><h2>採点表</h2>' + _scorecard_html(scorecard) + "</section>"
        if scorecard else ""
    )

    # The player renders only when the replay carries geometry we can draw; its
    # JS is likewise omitted entirely so a player-free export has no dangling refs.
    player_section = ""
    player_js = ""
    replay_json = "null"
    if replay and isinstance(replay, dict):
        replay_json = _safe_json(replay)
        player_js = _PLAYER_JS
        player_section = (
            '<section class="section"><h2>2Dリプレイ</h2>'
            '<div class="player">'
            '<canvas id="wh-canvas" width="900" height="520"></canvas>'
            '<div class="controls">'
            '<button type="button" id="wh-play">▶ 再生</button>'
            '<label class="ctl">速度 '
            '<select id="wh-speed">'
            '<option value="1">1x</option>'
            '<option value="2">2x</option>'
            '<option value="4" selected>4x</option>'
            '<option value="8">8x</option>'
            '<option value="16">16x</option>'
            "</select></label>"
            '<input type="range" id="wh-time" min="0" max="1000" value="0" step="1">'
            '<span id="wh-clock" class="clock">0:00</span>'
            "</div></div></section>"
        )

    no_run_note = (
        "" if has_run
        else '<section class="section"><p class="empty-note big">実行結果がまだありません。'
             'シミュレーションを実行すると、KPI・レイアウト図・リプレイがここに表示されます。</p></section>'
    )

    brandline = ""
    if company or client:
        left = html.escape(client + " 御中") if client else ""
        right = html.escape("提案元: " + company) if company else ""
        brandline = f'<div class="brandline"><span>{left}</span><span>{right}</span></div>'
    footer_html = html.escape(footer_note) if footer_note else ""

    return _TEMPLATE.format(
        title=html.escape(title_name + " 倉庫運用 提案ビューア"),
        title_name=html.escape(title_name),
        font=_FONT_STACK,
        accent=html.escape(accent),
        brandline=brandline,
        no_run_note=no_run_note,
        kpi_section=kpi_section,
        png_section=png_section,
        scorecard_section=scorecard_section,
        player_section=player_section,
        footer=footer_html,
        replay_json=replay_json,
        player_js=player_js,
    )


# The canvas player, written from scratch. Reads the inlined REPLAY global (the
# render/replay.py 2D contract) and animates it top-down with no dependencies.
_PLAYER_JS = r"""
(function () {
  var R = window.__WHSIM_REPLAY__;
  var canvas = document.getElementById('wh-canvas');
  if (!R || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#2383E2';

  var meta = (R.meta && typeof R.meta === 'object') ? R.meta : {};
  var bounds = (meta.bounds && typeof meta.bounds === 'object') ? meta.bounds : {};
  var W = Number(bounds.width) > 0 ? Number(bounds.width) : 40;
  var D = Number(bounds.depth) > 0 ? Number(bounds.depth) : 30;
  var win = Number(meta.replay_window_s) || Number(meta.duration_s) || 0;

  // Gather every animated agent's keyframe track [t,x,y,state].
  var tracks = [];
  var push = function (list, role) {
    (Array.isArray(list) ? list : []).forEach(function (a) {
      var kf = a && Array.isArray(a.keyframes) ? a.keyframes : [];
      if (kf.length) tracks.push({ kf: kf, role: a.role || role });
    });
  };
  push(R.workers, 'worker');
  push(R.agvs, 'agv');
  push(R.forklifts, 'forklift');

  // Derive the window from the last keyframe timestamp if meta lacked it.
  if (!(win > 0)) {
    tracks.forEach(function (t) {
      var last = t.kf[t.kf.length - 1];
      if (last && Number(last[0]) > win) win = Number(last[0]);
    });
  }
  if (!(win > 0)) win = 1;

  // World->canvas transform: fit with margin, flip Y (warehouse up = canvas up).
  var pad = 14;
  var sx = (canvas.width - pad * 2) / W;
  var sy = (canvas.height - pad * 2) / D;
  var s = Math.min(sx, sy);
  var ox = pad + (canvas.width - pad * 2 - W * s) / 2;
  var oy = pad + (canvas.height - pad * 2 - D * s) / 2;
  var PX = function (x) { return ox + Number(x) * s; };
  var PY = function (y) { return oy + (D - Number(y)) * s; };

  var COLOR = {
    worker: accent, helper: accent, packer: '#e08b2e',
    inspect: '#8b5cf6', agv: '#12a150', forklift: '#c0334c'
  };
  var STATE = { pick: '#e08b2e', pack: '#e08b2e', walk: null, inspect: '#8b5cf6' };

  function drawStatic() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Floor.
    ctx.fillStyle = '#f7fafc';
    ctx.strokeStyle = '#cfd9e4';
    ctx.lineWidth = 1.4;
    ctx.fillRect(PX(0), PY(D), W * s, D * s);
    ctx.strokeRect(PX(0), PY(D), W * s, D * s);
    // Zones.
    (Array.isArray(R.zones) ? R.zones : []).forEach(function (z) {
      ctx.fillStyle = hexA(z.color || '#dfe6ee', 0.45);
      ctx.fillRect(PX(z.x), PY(Number(z.y) + Number(z.h)), Number(z.w) * s, Number(z.h) * s);
      ctx.strokeStyle = '#c3cedb';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(PX(z.x), PY(Number(z.y) + Number(z.h)), Number(z.w) * s, Number(z.h) * s);
    });
    // Shelf runs (thin rectangles centred on x, spanning y0..y1).
    ctx.fillStyle = '#9fb0c4';
    (Array.isArray(R.shelves) ? R.shelves : []).forEach(function (sh) {
      var depth = Number(sh.depth) > 0 ? Number(sh.depth) : 1;
      var y0 = Number(sh.y0), y1 = Number(sh.y1);
      var lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      ctx.fillRect(PX(Number(sh.x) - depth / 2), PY(hi), depth * s, (hi - lo) * s);
    });
    // Walls.
    ctx.strokeStyle = '#5b6675';
    (Array.isArray(R.walls) ? R.walls : []).forEach(function (w) {
      var pts = Array.isArray(w.points) ? w.points : [];
      if (pts.length < 2) return;
      ctx.lineWidth = Math.max(1.5, (Number(w.thickness) || 0.2) * s);
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var X = PX(p[0]), Y = PY(p[1]);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    });
  }

  // Linear position of a track at time t (clamped to its keyframe span).
  function posAt(kf, t) {
    if (t <= Number(kf[0][0])) return kf[0];
    var last = kf[kf.length - 1];
    if (t >= Number(last[0])) return last;
    var lo = 0, hi = kf.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (Number(kf[mid][0]) <= t) lo = mid; else hi = mid;
    }
    var a = kf[lo], b = kf[hi];
    var t0 = Number(a[0]), t1 = Number(b[0]);
    var f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return [t,
      Number(a[1]) + (Number(b[1]) - Number(a[1])) * f,
      Number(a[2]) + (Number(b[2]) - Number(a[2])) * f,
      a[3]];
  }

  function drawAgents(t) {
    tracks.forEach(function (tr) {
      var p = posAt(tr.kf, t);
      var state = p[3];
      var col = STATE[state] || COLOR[tr.role] || accent;
      ctx.beginPath();
      ctx.arc(PX(p[1]), PY(p[2]), tr.role === 'agv' ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    });
  }

  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return 'rgba(200,210,225,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function fmtClock(t) {
    var m = Math.floor(t / 60), sec = Math.floor(t % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  var timeS = 0, playing = false, speed = 4, lastTs = 0;
  var playBtn = document.getElementById('wh-play');
  var speedSel = document.getElementById('wh-speed');
  var slider = document.getElementById('wh-time');
  var clock = document.getElementById('wh-clock');

  function render() {
    drawStatic();
    drawAgents(timeS);
    if (slider) slider.value = String(Math.round((timeS / win) * 1000));
    if (clock) clock.textContent = fmtClock(timeS);
  }

  function tick(ts) {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    timeS += dt * speed;
    if (timeS >= win) { timeS = win; playing = false; if (playBtn) playBtn.textContent = '▶ 再生'; }
    render();
    if (playing) requestAnimationFrame(tick);
  }

  if (playBtn) playBtn.addEventListener('click', function () {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
    if (playing) {
      if (timeS >= win) timeS = 0;
      lastTs = 0;
      requestAnimationFrame(tick);
    }
  });
  if (speedSel) speedSel.addEventListener('change', function () {
    speed = Number(speedSel.value) || 1;
  });
  if (slider) slider.addEventListener('input', function () {
    timeS = (Number(slider.value) / 1000) * win;
    render();
  });

  render();
})();
"""


_TEMPLATE = """<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{ --accent: {accent}; }}
* {{ box-sizing: border-box; }}
body {{
  margin: 0; padding: 0; background: #eef1f5;
  font-family: {font}; color: #1f2733; line-height: 1.6;
}}
.wrap {{ max-width: 900px; margin: 0 auto; padding: 24px 20px 48px; }}
header.doc {{
  border-bottom: 3px solid var(--accent); padding-bottom: 14px; margin-bottom: 8px;
}}
header.doc h1 {{ font-size: 22px; margin: 0 0 4px; color: #0b1220; }}
header.doc .sub {{ font-size: 12px; color: #8593a8; letter-spacing: .04em; }}
.brandline {{ display: flex; justify-content: space-between; font-size: 12px;
  color: #3d4a60; margin-top: 8px; }}
.section {{ background: #fff; border: 1px solid #e7ebf1; border-radius: 10px;
  padding: 18px 20px; margin-top: 16px; }}
.section h2 {{ font-size: 12px; letter-spacing: .12em; text-transform: uppercase;
  color: #8593a8; margin: 0 0 14px; font-weight: 600; }}
.kpi-grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }}
.kpi-card {{ border: 1px solid #e7ebf1; border-radius: 9px; padding: 12px 13px; }}
.k-label {{ font-size: 10.5px; color: #8593a8; margin-bottom: 5px; }}
.k-val {{ font-size: 22px; font-weight: 700; color: #0b1220; font-variant-numeric: tabular-nums; }}
.k-unit {{ font-size: 11px; font-weight: 400; color: #8593a8; margin-left: 3px; }}
.k-sub {{ font-size: 10.5px; margin-top: 5px; color: #8593a8; font-variant-numeric: tabular-nums; }}
.ci-note, .empty-note {{ font-size: 11px; color: #8593a8; margin: 10px 0 0; }}
.empty-note.big {{ font-size: 14px; color: #3d4a60; text-align: center; padding: 20px 0; }}
@media (max-width: 560px) {{ .kpi-grid {{ grid-template-columns: repeat(2, 1fr); }} }}
.proposal-png {{ max-width: 100%; display: block; border: 1px solid #e7ebf1; border-radius: 6px; }}
table.scorecard {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
table.scorecard th, table.scorecard td {{ text-align: left; padding: 9px 10px;
  border-bottom: 1px solid #f0f2f6; }}
table.scorecard thead th {{ font-size: 10px; letter-spacing: .05em; text-transform: uppercase;
  color: #8593a8; font-weight: 600; border-bottom: 1px solid #e7ebf1; }}
table.scorecard tbody th {{ font-weight: 600; color: #0b1220; width: 22%; }}
.sc-val {{ font-variant-numeric: tabular-nums; font-weight: 600; }}
.sc-unit {{ font-size: 10px; color: #8593a8; font-weight: 400; }}
.sc-sub {{ color: #8593a8; font-size: 11.5px; }}
.tone-ok {{ color: #0e7a52; }} .tone-warn {{ color: #9a6212; }} .tone-bad {{ color: #c0334c; }}
.tone-neutral {{ color: #1f2733; }}
.player {{ }}
#wh-canvas {{ width: 100%; height: auto; border: 1px solid #e7ebf1; border-radius: 6px;
  background: #fff; display: block; }}
.controls {{ display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }}
.controls button {{ font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 7px;
  border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }}
.controls .ctl {{ font-size: 12px; color: #3d4a60; }}
.controls select {{ font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 6px;
  border: 1px solid #cfd9e4; }}
#wh-time {{ flex: 1; min-width: 120px; accent-color: var(--accent); }}
.clock {{ font-size: 12px; color: #3d4a60; font-variant-numeric: tabular-nums; min-width: 44px; }}
footer.doc {{ margin-top: 24px; font-size: 11px; color: #8593a8; text-align: center; }}
footer.doc .foot-note {{ margin-bottom: 6px; color: #3d4a60; }}
</style>
</head>
<body>
<div class="wrap">
<header class="doc">
<h1>{title_name} 倉庫運用 提案ビューア</h1>
<div class="sub">WAREHOUSE OPERATIONS — 読み取り専用ビューア</div>
{brandline}
</header>
{no_run_note}
{kpi_section}
{png_section}
{scorecard_section}
{player_section}
<footer class="doc">
{footer}
<div>本ビューアはシミュレーション結果に基づく試算です（読み取り専用・単一HTML）。</div>
</footer>
</div>
<script>window.__WHSIM_REPLAY__ = {replay_json};</script>
<script>{player_js}</script>
</body>
</html>
"""
