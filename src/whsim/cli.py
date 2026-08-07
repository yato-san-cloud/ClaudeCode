"""Command-line interface: new -> import -> run -> render.

Mirrors the salesperson's flow: start from a template (always runnable), drop in
the customer's ZIP, simulate, and get a proposal-grade PNG.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import typer

from whsim import analytic, kpis as kpi_mod, templates
from whsim.engine.run import run_replications
from whsim.project import Project
from whsim.render import render as render_png

app = typer.Typer(add_completion=False, help="warehouse simulator (whsim)")


def _open_project(name: str) -> Project:
    """Open a project or exit cleanly (no raw traceback for the salesperson)."""
    try:
        return Project.open(name)
    except FileNotFoundError:
        typer.echo(f"プロジェクト '{name}' が見つかりません。"
                   f"先に `whsim new {name}` で作成してください。", err=True)
        raise typer.Exit(code=1)


@app.command("templates")
def list_templates():
    """List available templates."""
    for t in templates.list_templates():
        typer.echo(f"{t['template_id']:20s}  {t.get('name','')}")


@app.command()
def new(name: str, template: str = typer.Option("ecommerce_small", "--template", "-t")):
    """Create a project from a template (always runnable, even before import)."""
    try:
        proj = Project.create(name, template)
    except FileNotFoundError:
        typer.echo(f"テンプレート '{template}' が見つかりません。"
                   f"`whsim templates` で一覧を確認してください。", err=True)
        raise typer.Exit(code=1)
    typer.echo(f"created project '{name}' from template '{template}' at {proj.root}")


@app.command("import")
def import_(name: str, zip_path: Path):
    """Drop a customer ZIP into the project; overwrite the subtrees it provides."""
    proj = _open_project(name)
    if not zip_path.is_file():
        typer.echo(f"ZIP ファイルが見つかりません: {zip_path}", err=True)
        raise typer.Exit(code=1)
    res = proj.import_zip(zip_path)
    typer.echo(f"imported {len(res.files_seen)} file(s); "
               f"updated: {', '.join(sorted(res.touched_subtrees)) or 'none'}")
    for w in res.warnings:
        typer.echo(f"  ! {w}")
    typer.echo("  " + proj.load_provenance().summary())


@app.command("import-kpi")
def import_kpi(name: str, json_path: Path,
               probe: bool = typer.Option(False, "--probe",
                                          help="キー名の答え合わせだけ（書き込まない）")):
    """MapMaker カスタム版の 3D/KPI 用 JSON を取り込む（段数×間口→ロケーション）。

    ``--probe`` を付けると、想定した意味ごとにどのキーが当たったか／未認識キーは
    何かだけを出力する（MapMaker 作者との答え合わせ用。プロジェクトは変更しない）。
    """
    import json as _json

    from whsim import design, mapmaker_kpi
    proj = _open_project(name)
    if not json_path.is_file():
        typer.echo(f"JSON ファイルが見つかりません: {json_path}", err=True)
        raise typer.Exit(code=1)
    try:
        res = mapmaker_kpi.import_kpi_bytes(json_path.read_bytes())
    except ValueError as e:
        typer.echo(f"3D/KPI JSON を解析できませんでした: {e}", err=True)
        raise typer.Exit(code=1)
    if probe:
        typer.echo(_json.dumps({"probe": res["probe"], "stats": res["stats"],
                                "warnings": res["warnings"]},
                               ensure_ascii=False, indent=2))
        return
    md = _json.loads(proj.model_file.read_text("utf-8"))
    for key, dest in (("bounds", "bounds"), ("walls", "walls"), ("zones", "zones")):
        if res.get(key):
            md["layout"][dest] = res[key]
    for key in ("stations", "conveyors"):
        if res.get(key):
            md.setdefault("resources", {})[key] = res[key]
    from whsim.schema.model import WarehouseModel
    model = WarehouseModel.model_validate(md)
    if res.get("locations"):
        mapmaker_kpi.apply_to_model(model, res)   # MapMaker の段数/間口が正
    else:
        design.materialize_racks(model)
    design.synthesize_items(model)
    proj.save_model(model)
    prov = proj.load_provenance()
    from whsim.provenance import Source
    prov.mark("layout", Source.IMPORTED)
    if res.get("locations"):
        prov.mark("locations", Source.IMPORTED)
    proj.save_provenance(prov)
    typer.echo(f"shelves={res['stats']['shelves']} "
               f"walls={len(res['walls'])} conveyors={len(res['conveyors'])} "
               f"locations={len(model.locations)}")
    for w in res["warnings"]:
        typer.echo(f"  ! {w}")


@app.command("probe-kpi")
def probe_kpi(json_path: Path):
    """3D/KPI JSON のキー名だけを調べる（プロジェクト不要・書き込みなし）。"""
    import json as _json

    from whsim import mapmaker_kpi
    if not json_path.is_file():
        typer.echo(f"JSON ファイルが見つかりません: {json_path}", err=True)
        raise typer.Exit(code=1)
    typer.echo(_json.dumps(mapmaker_kpi.probe_kpi_bytes(json_path.read_bytes()),
                           ensure_ascii=False, indent=2))


@app.command()
def estimate(name: str):
    """Instant closed-form estimate (no discrete-event run)."""
    proj = _open_project(name)
    est = analytic.estimate(proj.load_model())
    typer.echo(json.dumps(est, ensure_ascii=False, indent=2))


@app.command()
def settings(name: str):
    """Print the project's cost-model settings as JSON (``{}`` if none set)."""
    proj = _open_project(name)
    try:
        md = json.loads(proj.model_file.read_text("utf-8"))
        cur = md.get("settings")
    except (OSError, json.JSONDecodeError):
        cur = None
    typer.echo(json.dumps(cur if isinstance(cur, dict) else {},
                          ensure_ascii=False, indent=2))


@app.command()
def run(name: str):
    """Run the discrete-event simulation and store the run artifacts."""
    proj = _open_project(name)
    model = proj.load_model()
    results, heat = run_replications(model)
    metrics = kpi_mod.compute(results, model)

    run_dir = proj.new_run_dir()
    (run_dir / "config.json").write_text(model.simulation.model_dump_json(indent=2), "utf-8")
    (run_dir / "kpis.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    np.save(run_dir / "heatmap.npy", heat)
    from whsim.render.replay import build_replay
    replay = build_replay(model, results[0], metrics)
    (run_dir / "replay.json").write_text(json.dumps(replay, ensure_ascii=False), "utf-8")

    typer.echo(f"run -> {run_dir.name}")
    typer.echo("  verdict: " + metrics["verdict"])


@app.command()
def delete(name: str):
    """Delete a project workspace and all its artifacts."""
    import shutil

    from whsim.project import PROJECTS_DIR, safe_name
    try:
        slug = safe_name(name)
    except ValueError:
        typer.echo(f"プロジェクト名 '{name}' は無効です。", err=True)
        raise typer.Exit(code=1)
    root = PROJECTS_DIR / slug
    if not (root / "project.json").is_file():
        typer.echo(f"プロジェクト '{name}' が見つかりません。", err=True)
        raise typer.Exit(code=1)
    shutil.rmtree(root)
    typer.echo(f"deleted project '{name}'")


@app.command()
def render(name: str, run: str = typer.Option("latest", "--run")):
    """Render the proposal PNG for a run."""
    proj = _open_project(name)
    run_dir = proj.latest_run_dir() if run == "latest" else proj.runs_dir / run
    if run_dir is None or not (run_dir / "kpis.json").is_file():
        typer.echo("実行結果が見つかりません。先に `whsim run` を実行してください。", err=True)
        raise typer.Exit(code=1)
    metrics = json.loads((run_dir / "kpis.json").read_text("utf-8"))
    heat = np.load(run_dir / "heatmap.npy")
    out = render_png(proj.load_model(), heat, metrics,
                     proj.load_provenance().summary(), run_dir / "layout_heatmap.png")
    typer.echo(f"png -> {out}")


@app.command()
def animate(name: str, run: str = typer.Option("latest", "--run")):
    """Render an animated 2D replay GIF for a run (no browser needed)."""
    import json as _json

    from whsim.render.anim2d import render_gif
    proj = _open_project(name)
    run_dir = proj.latest_run_dir() if run == "latest" else proj.runs_dir / run
    if run_dir is None or not (run_dir / "replay.json").is_file():
        typer.echo("リプレイが見つかりません。先に `whsim run` を実行してください。", err=True)
        raise typer.Exit(code=1)
    replay = _json.loads((run_dir / "replay.json").read_text("utf-8"))
    out = render_gif(replay, run_dir / "replay_2d.gif")
    typer.echo(f"gif -> {out}")


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = False):
    """Launch the web app (template -> import -> run -> animated 2D/3D replay).

    Pass --reload for development: the server auto-restarts on code edits and
    sends no-cache headers, so a plain browser refresh (F5) always shows the
    latest -- no manual restart or hard-reload. See start.bat for a
    one-command setup that also auto-pulls the branch.

    Remote access: keep the default loopback bind and put a tunnel in front (see
    docs/REMOTE_ACCESS.md). Binding to a reachable address REQUIRES a password --
    the project data is real customer material, so this refuses rather than
    silently publishing it.
    """
    import os

    import uvicorn

    from whsim.web import auth

    # Fail-safe: the gate itself is opt-in (so local use and tests are
    # unchanged), which means the guard against accidental exposure has to live
    # here, at the moment we choose what to listen on.
    if not _is_loopback(host) and not auth.enabled():
        typer.echo(
            f"'{host}' で待ち受けようとしていますが、パスワードが設定されていません。\n"
            "プロジェクトには実データが入るため、外から届く場所へ無防備に公開できません。\n\n"
            "  Linux/macOS:  export WHSIM_PASSWORD='任意のパスワード'\n"
            "  Windows:      set WHSIM_PASSWORD=任意のパスワード\n\n"
            "推奨は既定の 127.0.0.1 のままトンネル経由で公開する構成です "
            "(docs/REMOTE_ACCESS.md)。",
            err=True)
        raise typer.Exit(code=2)

    if reload:
        os.environ["WHSIM_DEV"] = "1"  # app then adds no-cache headers
    if auth.enabled():
        typer.echo("パスワード保護: 有効（全ルート）")
    uvicorn.run("whsim.web.app:app", host=host, port=port, reload=reload)


def _is_loopback(host: str) -> bool:
    """Is this bind address reachable only from this machine?

    Anything we cannot parse is treated as REACHABLE, so an unusual value fails
    closed (demands a password) rather than open.
    """
    import ipaddress

    h = (host or "").strip().strip("[]").lower()
    if h in {"localhost", "localhost.localdomain"}:
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


@app.command()
def simulate(name: str):
    """Convenience: run + render in one step."""
    proj = _open_project(name)
    model = proj.load_model()
    results, heat = run_replications(model)
    metrics = kpi_mod.compute(results, model)
    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    np.save(run_dir / "heatmap.npy", heat)
    out = render_png(model, heat, metrics, proj.load_provenance().summary(),
                     run_dir / "layout_heatmap.png")
    typer.echo("verdict: " + metrics["verdict"])
    typer.echo(f"png -> {out}")


@app.command("mapmaker")
def mapmaker(
    name: str,
    out: str = typer.Option(".", "--out", "-o", help="書出し先ディレクトリ"),
    ledger: str = typer.Option("", "--ledger",
                               help="シナリオ台帳 ledger.csv のパス（既定: 書かない）"),
    travel_csv: str = typer.Option("", "--travel-csv",
                                   help="MapMaker の棚別走行距離CSV（幾何ゲート）"),
    tol_m: float = typer.Option(5.0, "--tol-m", help="幾何ゲートの許容差 (m)"),
):
    """MapMaker カスタム版へ書き出す（棚一覧CSV・動的診断・台帳・幾何ゲート）。

    列名には推定が含まれる。MapMaker 側で読めなかったときは
    docs/mapmaker-v5-export.md の「仮定した列名の一覧」と突き合わせること。
    """
    from whsim import mapmaker_export as mx

    proj = _open_project(name)
    model = proj.load_model()
    out_dir = Path(out or ".")
    out_dir.mkdir(parents=True, exist_ok=True)

    # 0. 幾何ゲート。図面が食い違ったまま動的な数字を出しても意味が無いので先に置く。
    if travel_csv:
        diff = mx.travel_diff(model, travel_csv, tol_m=tol_m)
        typer.echo(f"幾何ゲート: {'OK' if diff['ok'] else 'NG'} "
                   f"(突合 {diff['matched']} 棚 / 平均乖離 {diff['mean_abs_diff_m']} m "
                   f"/ 最大 {diff['max_abs_diff_m']} m / 距離={diff['distance_source']})")
        for d in diff["top"][:5]:
            typer.echo(f"  乖離 {d['diff_m']:+.1f} m  {d['loc']} "
                       f"(MapMaker {d['mapmaker_m']} / whsim {d['whsim_m']})")
        for w in diff["warnings"]:
            typer.echo(f"  ! {w}")

    # 1. 棚一覧CSV — MapMaker の「CSVから棚を一括生成」で開き直せる形。
    shelves = out_dir / f"棚一覧_{name}.csv"
    shelves.write_bytes(mx.shelves_csv(model).encode(mx.DEFAULT_ENCODING))
    typer.echo(f"棚一覧CSV -> {shelves}")

    # 2. 動的診断 — 一括診断（静的な器）の隣に置く1枚。計算前提を必ず併記する。
    kpi_json = None
    run_dir = proj.latest_run_dir()
    if run_dir is not None and (run_dir / "kpis.json").exists():
        kpi_json = json.loads((run_dir / "kpis.json").read_text("utf-8"))
    md = out_dir / f"動的診断_{name}.md"
    md.write_text(mx.diagnosis_md(model, kpi_json), "utf-8")
    csv_out = out_dir / f"動的診断_{name}.csv"
    csv_out.write_bytes(mx.diagnosis_csv(model, kpi_json).encode(mx.DEFAULT_ENCODING))
    typer.echo(f"動的診断 -> {md} / {csv_out}")

    # 3. シナリオ台帳 — 出すと決めた案だけが1行残る。書けなくても本体は止めない。
    if ledger:
        for path_out, kind in ((shelves, mx.KIND_SHELVES_CSV),
                               (md, mx.KIND_DIAGNOSIS)):
            row = mx.ledger_row_from(model, kind, path_out.name)
            if not mx.ledger_append(ledger, row):
                typer.echo(f"  ! 台帳に書けませんでした: {ledger}", err=True)
        typer.echo(f"シナリオ台帳 -> {ledger}")


if __name__ == "__main__":
    app()
