#!/usr/bin/env python3
"""chrono-lens 自己検証 (ヘッドレス Chromium / playwright)

    python tests/verify.py --runs <ダミー出力ディレクトリ> --shots <スクショ保存先>

検証する受け入れ基準:
  DoD2/3  既知ケース (small_known) で 3ビューが動き、Marey の待機水平区間=2、
          ヒートマップ最大セルが gen_dummy の expected.json と一致し、
          画面表示の KPI がログ再計算値と一致する。
  DoD4    負荷ケース (large_load, positions 約150万行) の読み込み時間と再生fps。
  DoD5    契約違反ラン (bad_contract) が拒否され、違反フィールドが列挙される。

結果は JSON で標準出力に出し、スクリーンショットを --shots に保存する。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
# chrono-lens は Canvas 2D のみ。--use-angle=swiftshader は WebGL 用で、
# 付けると 2D キャンバスの合成がソフトウェア経路に落ちて 15fps 前後に張り付く
# (実測: 同じデータ・同じ画面サイズで 60fps -> 15fps)。ここでは付けない。
ARGS = ["--no-sandbox", "--disable-dev-shm-usage"]
VIEWER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "chronolens.html"))

RUN_FILES = ["layout.geojson", "events.jsonl", "positions.jsonl",
             "summary.json", "meta.json", "scenario.json"]


def files_of(run_dir):
    return [os.path.join(run_dir, f) for f in RUN_FILES
            if os.path.exists(os.path.join(run_dir, f))]


def open_viewer(ctx, console_sink):
    page = ctx.new_page()
    page.set_viewport_size({"width": 1600, "height": 950})
    page.on("console", lambda m: console_sink.append(m.text))
    page.on("pageerror", lambda e: console_sink.append("PAGEERROR " + str(e)))
    page.goto("file://" + VIEWER)
    page.wait_for_function("() => !!window.__chronolens")
    return page


def load_run(page, run_dir, timeout_ms=180000):
    t0 = time.time()
    page.set_input_files("#fileInput", files_of(run_dir))
    page.wait_for_function(
        "() => window.__chronolens.loaded() || !document.getElementById('report').classList.contains('hidden')",
        timeout=timeout_ms)
    return (time.time() - t0) * 1000.0


def check_small(page, run_dir, shots, results):
    with open(os.path.join(run_dir, "expected.json"), encoding="utf-8") as fh:
        exp = json.load(fh)
    wall_ms = load_run(page, run_dir)
    assert page.evaluate("() => window.__chronolens.loaded()"), "small_known が拒否された"
    st = page.evaluate("() => window.__chronolens.stats()")

    # ① ダイヤビュー ------------------------------------------------------
    page.evaluate("() => window.__chronolens.setView('marey')")
    page.wait_for_timeout(350)
    page.screenshot(path=os.path.join(shots, "chronolens_small_marey.png"))
    st = page.evaluate("() => window.__chronolens.stats()")
    marey_wait_drawn = st["mareyWaitSegmentsDrawn"]

    # ② ヒートマップ ------------------------------------------------------
    page.evaluate("() => window.__chronolens.setView('heat')")
    page.wait_for_timeout(400)
    heat = page.evaluate("() => window.__chronolens.heatStats()")
    page.screenshot(path=os.path.join(shots, "chronolens_small_heat.png"))

    # ③ 再生ビュー --------------------------------------------------------
    page.evaluate("() => window.__chronolens.setView('play')")
    page.evaluate("() => window.__chronolens.setSpeed(10)")
    page.evaluate("() => window.__chronolens.play(true)")
    page.wait_for_timeout(2500)
    page.screenshot(path=os.path.join(shots, "chronolens_small_play.png"))
    play_fps = page.evaluate("() => window.__chronolens.state.play.fps")
    page.evaluate("() => window.__chronolens.play(false)")

    # 3ビュー連動: レンジを半分に絞って各ビューの数値が追随するか ----------
    t0, t1 = st["tMin"], st["tMax"]
    mid = t0 + (t1 - t0) * 0.5
    page.evaluate(f"() => window.__chronolens.setRange({t0}, {mid})")
    page.wait_for_timeout(300)
    heat_half = page.evaluate("() => window.__chronolens.heatStats()")
    page.evaluate("() => window.__chronolens.setView('marey')")
    page.wait_for_timeout(300)
    st_half = page.evaluate("() => window.__chronolens.stats()")
    page.screenshot(path=os.path.join(shots, "chronolens_small_linked_range.png"))
    page.evaluate(f"() => window.__chronolens.setRange({t0}, {t1})")
    page.wait_for_timeout(200)

    exp_heat = exp["heatmap_dwell"]
    results["small"] = {
        "load_wall_ms": round(wall_ms, 1),
        "perf": st["perf"],
        "stats": {k: st[k] for k in
                  ("runId", "actors", "events", "positions", "waitSegments", "tMin", "tMax")},
        "kpi_viewer": st["kpi"],
        "summary_file": st["summary"],
        "expected_summary": exp["summary"],
        "marey_wait_segments_drawn": marey_wait_drawn,
        "expected_wait_pairs": exp["counts"]["wait_pairs"],
        "heat_viewer": heat,
        "heat_expected": exp_heat,
        "range_linked": {
            "full": {"heat_sum": heat["sum_s"], "marey_waits": marey_wait_drawn},
            "half": {"heat_sum": heat_half["sum_s"],
                     "marey_waits": st_half["mareyWaitSegmentsDrawn"],
                     "range": st_half["range"]},
        },
        "play_fps": play_fps,
        "contract": st["contract"],
        "checks": {},
    }
    c = results["small"]["checks"]
    c["marey_wait_segments==2"] = (marey_wait_drawn == exp["counts"]["wait_pairs"] == 2)
    c["waitSegments==2"] = (st["waitSegments"] == 2)
    c["heat_max_cell_matches_python"] = (
        heat["max_cell_index"] == exp_heat["max_cell_index"]
        and abs(heat["max_cell_value_s"] - exp_heat["max_cell_dwell_s"]) < 1e-3)
    c["kpi_rows_per_hour_matches_summary"] = (
        abs(st["kpi"]["rows_per_hour"] - st["summary"]["rows_per_hour"]) < 0.5)
    c["kpi_distance_matches_summary"] = (
        abs(st["kpi"]["total_distance_m"] - st["summary"]["total_distance_m"])
        / max(1e-9, st["summary"]["total_distance_m"]) < 0.02)
    c["kpi_wait_total_matches_summary"] = (
        abs(st["kpi"]["wait"]["total"] - st["summary"]["wait_time_s"]["total"]) < 0.5)
    c["range_link_changes_heat"] = heat_half["sum_s"] < heat["sum_s"]
    c["contract_zero_crossings"] = (st["contract"]["edgeRackCrossings"] == 0
                                    and st["contract"]["posInRack"] == 0)
    c["play_fps_positive"] = play_fps > 0
    return results["small"]


def check_large(page, run_dir, shots, results):
    t_wall = load_run(page, run_dir, timeout_ms=600000)
    ok = page.evaluate("() => window.__chronolens.loaded()")
    assert ok, "large_load が拒否された"
    st = page.evaluate("() => window.__chronolens.stats()")

    page.evaluate("() => window.__chronolens.setView('marey')")
    page.wait_for_timeout(1500)          # 読み込み直後の GC を落ち着かせてから測る
    # 操作コストはページ内時計で測る (playwright の往復と GC を混ぜない)
    marey_zoom_ms = page.evaluate(
        "() => {const t=performance.now(); window.__chronolens.setRange(3600,5400);"
        " return performance.now()-t;}")
    marey_full_ms = page.evaluate(
        "() => {const t=performance.now(); window.__chronolens.setRange(0,28800);"
        " return performance.now()-t;}")
    page.evaluate("() => window.__chronolens.setRange(3600, 5400)")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(shots, "chronolens_large_marey.png"))

    t = time.time()
    page.evaluate("() => window.__chronolens.setView('heat')")
    page.wait_for_timeout(500)
    page.evaluate("() => window.__chronolens.setRange(0, 28800)")
    page.wait_for_timeout(900)
    heat_switch_ms = (time.time() - t) * 1000
    heat = page.evaluate("() => window.__chronolens.heatStats()")
    page.screenshot(path=os.path.join(shots, "chronolens_large_heat.png"))

    page.evaluate("() => window.__chronolens.setView('play')")
    page.evaluate("() => window.__chronolens.logFps(true)")
    page.evaluate("() => window.__chronolens.setSpeed(60)")
    page.evaluate("() => window.__chronolens.play(true)")
    page.wait_for_timeout(6000)
    fps_samples, frame_ms = [], []
    for _ in range(10):
        page.wait_for_timeout(500)
        fps_samples.append(page.evaluate("() => window.__chronolens.state.play.fps"))
        frame_ms.append(page.evaluate("() => window.__chronolens.state.play.frameMs"))
    page.screenshot(path=os.path.join(shots, "chronolens_large_play.png"))
    page.evaluate("() => window.__chronolens.play(false)")

    fps_samples = [f for f in fps_samples if f > 0]
    results["large"] = {
        "load_wall_ms": round(t_wall, 1),
        "perf": st["perf"],
        "counts": {"actors": st["actors"], "events": st["events"], "positions": st["positions"]},
        "marey_range_change_ms": round(marey_zoom_ms, 1),
        "marey_full_range_redraw_ms": round(marey_full_ms, 1),
        "heat_view_switch_wall_ms": round(heat_switch_ms, 1),
        "heat_compute_ms": heat["computeMs"],
        "heat_grid": heat["grid_size"],
        "fps_samples": [round(f, 1) for f in fps_samples],
        "fps_min": round(min(fps_samples), 1) if fps_samples else 0,
        "fps_mean": round(sum(fps_samples)/len(fps_samples), 1) if fps_samples else 0,
        "frame_ms_mean": round(sum(frame_ms)/max(1, len(frame_ms)), 3),
        "frame_ms_max": round(max(frame_ms), 3) if frame_ms else 0,
        "frame_budget_fps": round(1000.0 / max(1e-6, max(frame_ms)), 1) if frame_ms else 0,
        "checks": {},
    }
    c = results["large"]["checks"]
    c["positions>=1.4M"] = st["positions"] >= 1_400_000
    c["fps>=30"] = bool(fps_samples) and min(fps_samples) >= 30
    # 描画1コマの実コストが 33.3ms 未満 = 30fps を出せる (rAF の刻みは環境依存)
    c["frame_cost_under_30fps_budget"] = bool(frame_ms) and max(frame_ms) < 33.3
    c["marey_range_change<200ms"] = marey_zoom_ms < 200
    c["marey_full_redraw<200ms"] = marey_full_ms < 200
    return results["large"]


def check_invalid(page, run_dir, shots, results):
    load_run(page, run_dir)
    loaded = page.evaluate("() => window.__chronolens.loaded()")
    rejected = page.evaluate(
        "() => !document.getElementById('report').classList.contains('hidden')")
    page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(shots, "chronolens_invalid_reject.png"), full_page=True)
    rows = page.evaluate("""() => Array.from(document.querySelectorAll('table.rep tbody tr'))
        .map(tr => Array.from(tr.children).map(td => td.textContent.trim()))""")
    body_visible = page.evaluate("() => document.body.innerText.length")
    results["invalid"] = {
        "mounted": loaded, "report_shown": rejected,
        "rows": rows,
        "codes": sorted({r[2] for r in rows}),
        "body_text_len": body_visible,
        "checks": {
            "rejected_not_mounted": (not loaded) and rejected,
            "report_lists_fields": len(rows) >= 5,
            "not_blank_screen": body_visible > 200,
        },
    }
    return results["invalid"]


def check_missing_file(page, run_dir, shots, results):
    """必須ファイルが欠けているケース (DoD5)。"""
    only = [os.path.join(run_dir, "layout.geojson")]
    page.set_input_files("#fileInput", only)
    page.wait_for_function(
        "() => !document.getElementById('report').classList.contains('hidden')", timeout=30000)
    page.screenshot(path=os.path.join(shots, "chronolens_missing_files.png"), full_page=True)
    rows = page.evaluate("""() => Array.from(document.querySelectorAll('table.rep tbody tr'))
        .map(tr => Array.from(tr.children).map(td => td.textContent.trim()))""")
    results["missing_files"] = {
        "rows": rows,
        "checks": {"reports_missing_required": any(r[2] == "FILE_MISSING" for r in rows)},
    }
    return results["missing_files"]


def check_reload(page, runs, shots, results):
    """同じページで複数のランを続けて読む (拒否をまたいでも状態が残らないこと)。"""
    seq, errs = [], []
    page.on("pageerror", lambda e: errs.append(str(e)))
    for run in ("small_known", "large_load", "bad_contract", "small_known"):
        page.set_input_files("#fileInput", files_of(os.path.join(runs, run)))
        page.wait_for_function(
            "() => (window.__chronolens.loaded() && window.__chronolens.stats().runId)"
            " || !document.getElementById('report').classList.contains('hidden')",
            timeout=600000)
        st = page.evaluate("() => window.__chronolens.stats()")
        seq.append({"requested": run, "loaded": st is not None,
                    "runId": st["runId"] if st else None,
                    "positions": st["positions"] if st else None})
    results["reload"] = {
        "sequence": seq, "pageerrors": errs,
        "checks": {
            "each_run_replaces_previous": all(
                s["runId"] == s["requested"] for s in seq if s["loaded"]),
            "rejected_run_clears_state": any(
                (not s["loaded"]) and s["requested"] == "bad_contract" for s in seq),
            "no_pageerrors": not errs,
        },
    }
    return results["reload"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", required=True, help="gen_dummy.py の出力ディレクトリ")
    ap.add_argument("--shots", required=True, help="スクリーンショット保存先")
    ap.add_argument("--skip-large", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.shots, exist_ok=True)
    results, console = {}, []
    with sync_playwright() as p:
        br = p.chromium.launch(executable_path=CHROME, args=ARGS)
        ctx = br.new_context()
        page = open_viewer(ctx, console)

        print("== 既知ケース (small_known) ==", file=sys.stderr)
        check_small(page, os.path.join(a.runs, "small_known"), a.shots, results)

        print("== 不正入力 (bad_contract) ==", file=sys.stderr)
        page2 = open_viewer(ctx, console)
        check_invalid(page2, os.path.join(a.runs, "bad_contract"), a.shots, results)
        page3 = open_viewer(ctx, console)
        check_missing_file(page3, os.path.join(a.runs, "small_known"), a.shots, results)

        if not a.skip_large:
            print("== 負荷ケース (large_load) ==", file=sys.stderr)
            page4 = open_viewer(ctx, console)
            check_large(page4, os.path.join(a.runs, "large_load"), a.shots, results)
            print("== 連続読み込み ==", file=sys.stderr)
            page5 = open_viewer(ctx, console)
            check_reload(page5, a.runs, a.shots, results)

        results["console"] = [c for c in console if c.startswith("[chronolens]")
                              or "ERROR" in c][:40]
        br.close()
    ok = True
    for sect in ("small", "large", "invalid", "missing_files", "reload"):
        for k, v in results.get(sect, {}).get("checks", {}).items():
            if not v:
                ok = False
                print(f"FAIL {sect}.{k}", file=sys.stderr)
    results["all_checks_passed"] = ok
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
