"""Shared, render-agnostic data/row/tile builders for proposal export.

These helpers turn a finished simulation's KPIs (+ optional scenarios/insights)
into the formatted strings, rows, and tiles consumed by both the PPTX and PDF
builders. They are pure and defensive: missing inputs degrade to placeholders,
never raise. User-facing strings are Japanese; code and comments are English.
"""

from __future__ import annotations

import datetime as _dt
import re as _re
from pathlib import Path

# --- Shared formatting helpers -------------------------------------------------

DASH = "—"  # placeholder for missing values

# Brand palette: matches the web app (Notion-blue accent, warm-ink text).
NOTION_BLUE = (0x23, 0x83, 0xE2)  # #2383E2 primary accent
INK = (0x37, 0x35, 0x2F)          # #37352F warm ink for body text
# Kept for backwards compatibility with anything importing these names.
INDIGO = NOTION_BLUE
NEUTRAL = INK
GREEN = (0x1B, 0x7F, 0x4B)
RED = (0xB0, 0x2A, 0x2A)
AMBER = (0xB5, 0x6A, 0x00)
LIGHT = (0xEE, 0xF3, 0xFB)        # pale blue tile / zebra row
SUBTLE = (0x78, 0x72, 0x6B)       # muted footnote ink
WHITE = (0xFF, 0xFF, 0xFF)

# CJK-friendly font family for pptx runs (uses the viewer's installed fonts).
PPTX_FONT = "Noto Sans CJK JP"

PRODUCT_NAME = "whsim 倉庫シミュレーター"


def _strip_html(s) -> str:
    """Insight `fact` strings may carry HTML spans (web UI). Flatten to text."""
    if s is None:
        return ""
    return _re.sub(r"<[^>]+>", "", str(s)).strip()


def _currency_symbol(kpis: dict) -> str:
    return str(kpis.get("currency") or "¥")


def _fmt_num(val, digits: int = 0) -> str:
    """Format a number with thousands separators; return DASH if missing."""
    if val is None:
        return DASH
    try:
        f = float(val)
    except (TypeError, ValueError):
        return DASH
    if digits <= 0:
        return f"{f:,.0f}"
    return f"{f:,.{digits}f}"


def _fmt_money(val, kpis: dict, digits: int = 0) -> str:
    if val is None:
        return DASH
    s = _fmt_num(val, digits)
    if s == DASH:
        return DASH
    return f"{_currency_symbol(kpis)}{s}"


def _fmt_pct(val) -> str:
    """Format a fraction-or-percent value as a percentage string."""
    if val is None:
        return DASH
    try:
        f = float(val)
    except (TypeError, ValueError):
        return DASH
    # Heuristic: values <= 1.5 are treated as fractions, else already percent.
    if f <= 1.5:
        f *= 100.0
    return f"{f:,.1f}%"


def _headline_tiles(kpis: dict) -> list[tuple[str, str, str]]:
    """The four hero KPIs for the executive summary, as (label, value, unit)."""
    comp = kpis.get("completion_rate")
    arrived = kpis.get("orders_arrived")
    completed = kpis.get("orders_completed")
    if completed is not None and arrived:
        ship = f"{_fmt_num(completed)} / {_fmt_num(arrived)}"
    else:
        ship = _fmt_pct(comp)
    return [
        ("処理能力", _fmt_num(kpis.get("throughput_per_hr"), 1), "件/時"),
        ("出荷完了", ship, "件" if (completed is not None and arrived) else ""),
        ("ボトルネック", str(kpis.get("bottleneck_jp") or DASH), ""),
        ("1件あたりコスト", _fmt_money(kpis.get("total_cost_per_order"), kpis, 1), ""),
    ]


def _fmt_minutes(seconds) -> str:
    if seconds is None:
        return DASH
    try:
        return f"{float(seconds) / 60.0:,.1f}"
    except (TypeError, ValueError):
        return DASH


def _detail_rows(kpis: dict) -> list[tuple[str, str]]:
    """The full KPI detail table (Japanese labels, '—' for anything missing)."""
    p5, p95 = kpis.get("throughput_p5"), kpis.get("throughput_p95")
    if p5 is not None or p95 is not None:
        thr_range = f"{_fmt_num(p5, 1)} 〜 {_fmt_num(p95, 1)} 件/時"
    else:
        thr_range = DASH
    cycle = f"{_fmt_minutes(kpis.get('cycle_p50_s'))} / {_fmt_minutes(kpis.get('cycle_p95_s'))} 分"
    rows = [
        ("スループット (件/時)", _fmt_num(kpis.get("throughput_per_hr"), 1)),
        ("スループット p5〜p95", thr_range),
        ("出荷完了率", _fmt_pct(kpis.get("completion_rate"))),
        ("ピッカー稼働率", _fmt_pct(kpis.get("picker_utilization"))),
        ("梱包稼働率", _fmt_pct(kpis.get("packer_utilization"))),
        ("AGV稼働率", _fmt_pct(kpis.get("agv_utilization"))),
        ("サイクルタイム 中央値/p95", cycle),
        ("1件あたり歩行 (m)", _fmt_num(kpis.get("walk_per_order_m"), 0)),
        ("必要人員 (名)", _fmt_num(kpis.get("headcount"))),
        ("月間コスト", _fmt_money(kpis.get("monthly_cost"), kpis)),
        ("月間運用費 (OPEX)", _fmt_money(kpis.get("monthly_opex"), kpis)),
        ("1件あたりコスト", _fmt_money(kpis.get("total_cost_per_order"), kpis, 1)),
    ]
    # 生産性の内訳 (要素作業分解): present only on runs that carry the breakdown.
    walk_s = kpis.get("picker_walk_s")
    handle_s = kpis.get("picker_handle_s")
    idle_s = kpis.get("picker_idle_s")
    if isinstance(walk_s, (int, float)) and (walk_s or handle_s or idle_s):
        total = (walk_s or 0) + (handle_s or 0) + (idle_s or 0)
        if total > 0:
            rows.append(("ピッカー生産性 (件/人時)",
                         _fmt_num(kpis.get("orders_per_picker_hr"), 1)))
            rows.append(("　└ 内訳 移動/手扱い/手待ち",
                         f"{_fmt_pct((walk_s or 0) / total)} / "
                         f"{_fmt_pct((handle_s or 0) / total)} / "
                         f"{_fmt_pct((idle_s or 0) / total)}"))
    return rows


def _normalize_scenarios(scenarios) -> list[dict]:
    """Coerce the various scenario shapes into a flat list of comparison rows.

    Accepts:
      * the /run-scenarios payload: {"baseline": {...}, "alternatives": [...]}
      * a plain list of {"name","description","kpis", ...} dicts
    Each item is {name, description, kpis(dict), is_baseline(bool)}. Returns []
    for anything unusable so callers can simply skip the section.
    """
    if not scenarios:
        return []
    items: list[dict] = []
    try:
        if isinstance(scenarios, dict):
            base = scenarios.get("baseline")
            alts = scenarios.get("alternatives") or []
            seq = ([base] if base else []) + list(alts)
        else:
            seq = list(scenarios)
        for i, sc in enumerate(seq):
            if not isinstance(sc, dict):
                continue
            items.append({
                "name": str(sc.get("name") or (f"案{i}" if i else "現行")),
                "description": str(sc.get("description") or ""),
                "kpis": sc.get("kpis") or {},
                "is_baseline": bool(sc.get("is_baseline", i == 0)),
            })
    except Exception:
        return []
    return items


def _normalize_insights(insights) -> list[dict]:
    """Coerce insights into [{severity, title, fact, action}] (text-only)."""
    if not insights:
        return []
    out: list[dict] = []
    try:
        for ins in insights:
            if not isinstance(ins, dict):
                # allow bare strings as a simple recommendation
                out.append({"severity": "info", "title": str(ins),
                            "fact": "", "action": ""})
                continue
            out.append({
                "severity": str(ins.get("severity") or "info"),
                "title": _strip_html(ins.get("title")),
                "fact": _strip_html(ins.get("fact")),
                "action": _strip_html(ins.get("action")),
            })
    except Exception:
        return []
    return [o for o in out if o.get("title") or o.get("action")]


_SEV_COLOR = {"danger": RED, "warn": AMBER, "ok": GREEN, "info": NEUTRAL}


def _delta_str(base, alt, *, money=False, kpis=None, lower_is_better=True) -> str:
    """Signed delta alt-vs-base, with an arrow; '—' when not comparable."""
    try:
        b, a = float(base), float(alt)
    except (TypeError, ValueError):
        return DASH
    d = a - b
    if abs(d) < 1e-9:
        return "±0"
    arrow = "▲" if d > 0 else "▼"
    mag = _fmt_money(abs(d), kpis or {}, 1) if money else _fmt_num(abs(d), 1)
    return f"{arrow} {mag}"


def _verdict_text(kpis: dict) -> str:
    v = kpis.get("verdict")
    if v:
        return str(v)
    return "判定結果なし"


def _is_ok(kpis: dict) -> bool:
    return bool(kpis.get("can_handle_demand"))


def _assumptions_lines(kpis: dict, provenance_summary: str) -> list[str]:
    rate = _fmt_money(kpis.get("labour_rate_per_hr"), kpis)
    capex = _fmt_money(kpis.get("capex_total"), kpis)
    lines = [
        "本提案は離散事象シミュレーション(SimPy)に基づく概算です。",
    ]
    if provenance_summary:
        lines.append(str(provenance_summary))
    lines.append(
        f"前提条件: 人件費 {rate}/人時 ・ AGV投資 {capex} ・ 36ヶ月償却"
    )
    return lines


def _methodology_footer(provenance_summary: str) -> str:
    """One-line methodology + data-provenance footer used on every document."""
    base = "本提案は離散事象シミュレーション(SimPy)に基づく"
    if provenance_summary:
        return f"{base} ／ {provenance_summary}"
    return base


def _date_str() -> str:
    return _dt.date.today().strftime("%Y年%m月%d日")


def _png_exists(png_path) -> Path | None:
    if not png_path:
        return None
    p = Path(png_path)
    return p if p.is_file() else None


def _storage_table(storage: dict | None):
    """設備機器数の取りまとめ for the proposal 保管設計 slide. Returns
    ``(header, rows, summary)`` or ``None`` when there's no storage estimate.

      header  = ["保管方法", "SKU数", "間口", "台数", "坪数"]
      rows    = per-method string cells (racktypes order)
      summary = {"units","cells","tsubo","skus","cost"} preformatted strings
    """
    if not isinstance(storage, dict) or not storage.get("has_data"):
        return None
    methods = storage.get("by_method") or []
    if not methods:
        return None
    header = ["保管方法", "SKU数", "間口", "台数", "坪数"]
    rows = []
    for m in methods:
        rows.append([
            str(m.get("label", m.get("rack_type", ""))),
            _fmt_num(m.get("items"), 0),
            _fmt_num(m.get("cells"), 0),
            _fmt_num(m.get("units"), 0),
            _fmt_num(m.get("footprint_tsubo"), 1),
        ])
    t = storage.get("totals") or {}
    c = storage.get("cost") or {}
    summary = {
        "skus": _fmt_num(t.get("skus"), 0),
        "cells": _fmt_num(t.get("cells"), 0),
        "units": _fmt_num(t.get("units"), 0),
        "tsubo": f"{_fmt_num(t.get('tsubo_storage'), 1)} 坪",
        "cost": _fmt_money(c.get("total_yen"), {"currency": "¥"}, 0),
    }
    return header, rows, summary


def _batch_summary_line(batches) -> str | None:
    """バッチ投入スケジュール({section: [{hour, pct}]})を1行に要約する。

    有効な投入が無ければ None（呼び出し側はバッチ行ごと省略する）。
    """
    if not isinstance(batches, dict) or not batches:
        return None
    parts: list[str] = []
    for sec, blist in batches.items():
        if not isinstance(blist, list) or not blist:
            continue
        chunks: list[str] = []
        for b in blist:
            if not isinstance(b, dict):
                continue
            try:
                h = int(b.get("hour", b.get("time")))
                pct = float(b.get("pct", b.get("percent", 0)) or 0)
            except (TypeError, ValueError):
                continue
            if pct <= 0:
                continue
            chunks.append(f"{h:02d}:00→{_fmt_num(pct, 0)}%")
        if chunks:
            parts.append(f"{sec} " + " / ".join(chunks))
    if not parts:
        return None
    return "バッチ投入：" + " ／ ".join(parts)


def _staffing_section(model) -> dict | None:
    """人員配置と工程フローのセクション用データを ``model`` から導出する。

    受注(物量)を持たない bare モデルや、導出中の任意の失敗時には ``None`` を返し、
    呼び出し側はセクションごと省略する（never-blocks）。返り値は描画非依存の
    整形済み文字列のみ（summary tiles / 判定 / バッチ要約 / 工程フロー表）。

    導出手順:
      1. モデル自身の出荷/入荷受注 → ``ingest.orders_to_frame`` でフレーム化。
      2. ``staffing.staffing_profile`` で工程別の日次物量を得る。
      3. ``staffing.solve_staffing`` で総工数・ピーク人数・終了時刻・充足判定。
      4. ``staffing.flow_seed`` で工程フロー(工程/区分/生産性/依存)を得る。
    """
    if model is None:
        return None
    try:
        from whsim.analysis import ingest, staffing

        orders = getattr(model, "orders", None)
        ship = ingest.orders_to_frame(getattr(orders, "outbound", []) or [])
        if ship is None or ship.empty:
            return None
        inb = ingest.orders_to_frame(getattr(orders, "inbound", []) or [])
        prof = staffing.staffing_profile(
            ship, inb if inb is not None and not inb.empty else None, model=model)
        volumes = {p["id"]: p["daily_volume"] for p in prof.get("processes", [])}
        if not any(float(v or 0) > 0 for v in volumes.values()):
            return None
        batches = getattr(getattr(model, "settings", None), "batch_schedule", {}) or {}
        if not isinstance(batches, dict):
            batches = {}
        result = staffing.solve_staffing(
            volumes, model=model, start_hour=9, end_hour=18,
            placement="level", batches=batches)
        flow = staffing.flow_seed(model)
    except Exception:  # noqa: BLE001 — never blocks; skip the section on any failure
        return None

    feasible = bool(result.get("feasible"))
    peak = result.get("peak_headcount") or 0
    total_mh = result.get("total_man_hours") or 0
    finish = result.get("makespan_hour") or result.get("finish_hour") \
        or result.get("end_hour")
    tiles = [
        ("総工数", _fmt_num(total_mh, 1), "人時"),
        ("ピーク人数", _fmt_num(peak, 0), "名"),
        ("終了時刻", f"{int(finish)}:00" if finish is not None else DASH, ""),
    ]
    if feasible:
        verdict = "判定：現行の人員配置で当日物量を充足できます。"
    else:
        short = result.get("shortfall_man_hours") or 0
        verdict = f"判定：当日物量に対し人員が不足します（不足 {_fmt_num(short, 1)} 人時）。"

    flow_rows: list[list[str]] = []
    for f in flow or []:
        unit = str(f.get("unit") or "")
        try:
            prod_txt = f"{float(f.get('productivity')):g} {unit}".strip()
        except (TypeError, ValueError):
            prod_txt = unit or DASH
        deps = [str(d) for d in (f.get("depends") or [])]
        flow_rows.append([
            str(f.get("id", "工程")),
            str(f.get("section", "")),
            prod_txt,
            "、".join(deps) if deps else DASH,
        ])

    return {
        "tiles": tiles,
        "verdict": verdict,
        "verdict_ok": feasible,
        "batch_line": _batch_summary_line(batches),
        "flow_header": ["工程", "区分", "生産性", "依存"],
        "flow_rows": flow_rows,
    }


# Shared scenario-comparison metric spec, used by both builders.
_SCENARIO_METRICS = [
    ("処理能力 (件/時)", "throughput_per_hr", 1, False),
    ("出荷完了率", "completion_rate", None, False),
    ("必要人員 (名)", "headcount", 0, False),
    ("1件あたりコスト", "total_cost_per_order", 1, True),
    ("月間コスト", "monthly_cost", 0, True),
    ("投資回収 (月)", "payback_months", 1, False),
]
