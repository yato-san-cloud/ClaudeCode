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


@app.command()
def estimate(name: str):
    """Instant closed-form estimate (no discrete-event run)."""
    proj = _open_project(name)
    est = analytic.estimate(proj.load_model())
    typer.echo(json.dumps(est, ensure_ascii=False, indent=2))


@app.command()
def run(name: str):
    """Run the discrete-event simulation and store the run artifacts."""
    proj = _open_project(name)
    model = proj.load_model()
    results, heat = run_replications(model)
    metrics = kpi_mod.compute(results)

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
def serve(host: str = "127.0.0.1", port: int = 8000):
    """Launch the web app (template -> import -> run -> animated 2D/3D replay)."""
    import uvicorn
    uvicorn.run("whsim.web.app:app", host=host, port=port)


@app.command()
def simulate(name: str):
    """Convenience: run + render in one step."""
    proj = _open_project(name)
    model = proj.load_model()
    results, heat = run_replications(model)
    metrics = kpi_mod.compute(results)
    run_dir = proj.new_run_dir()
    (run_dir / "kpis.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    np.save(run_dir / "heatmap.npy", heat)
    out = render_png(model, heat, metrics, proj.load_provenance().summary(),
                     run_dir / "layout_heatmap.png")
    typer.echo("verdict: " + metrics["verdict"])
    typer.echo(f"png -> {out}")


if __name__ == "__main__":
    app()
