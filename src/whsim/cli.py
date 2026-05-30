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


@app.command("templates")
def list_templates():
    """List available templates."""
    for t in templates.list_templates():
        typer.echo(f"{t['template_id']:20s}  {t.get('name','')}")


@app.command()
def new(name: str, template: str = typer.Option("ecommerce_small", "--template", "-t")):
    """Create a project from a template (always runnable, even before import)."""
    proj = Project.create(name, template)
    typer.echo(f"created project '{name}' from template '{template}' at {proj.root}")


@app.command("import")
def import_(name: str, zip_path: Path):
    """Drop a customer ZIP into the project; overwrite the subtrees it provides."""
    proj = Project.open(name)
    res = proj.import_zip(zip_path)
    typer.echo(f"imported {len(res.files_seen)} file(s); "
               f"updated: {', '.join(sorted(res.touched_subtrees)) or 'none'}")
    for w in res.warnings:
        typer.echo(f"  ! {w}")
    typer.echo("  " + proj.load_provenance().summary())


@app.command()
def estimate(name: str):
    """Instant closed-form estimate (no discrete-event run)."""
    proj = Project.open(name)
    est = analytic.estimate(proj.load_model())
    typer.echo(json.dumps(est, ensure_ascii=False, indent=2))


@app.command()
def run(name: str):
    """Run the discrete-event simulation and store the run artifacts."""
    proj = Project.open(name)
    model = proj.load_model()
    results, heat = run_replications(model)
    metrics = kpi_mod.compute(results)

    run_dir = proj.new_run_dir()
    (run_dir / "config.json").write_text(model.simulation.model_dump_json(indent=2), "utf-8")
    (run_dir / "kpis.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), "utf-8")
    np.save(run_dir / "heatmap.npy", heat)

    typer.echo(f"run -> {run_dir.name}")
    typer.echo("  verdict: " + metrics["verdict"])


@app.command()
def render(name: str, run: str = typer.Option("latest", "--run")):
    """Render the proposal PNG for a run."""
    proj = Project.open(name)
    run_dir = proj.latest_run_dir() if run == "latest" else proj.runs_dir / run
    if run_dir is None or not run_dir.is_dir():
        raise typer.BadParameter("no run found; call `whsim run` first")
    metrics = json.loads((run_dir / "kpis.json").read_text("utf-8"))
    heat = np.load(run_dir / "heatmap.npy")
    out = render_png(proj.load_model(), heat, metrics,
                     proj.load_provenance().summary(), run_dir / "layout_heatmap.png")
    typer.echo(f"png -> {out}")


@app.command()
def simulate(name: str):
    """Convenience: run + render in one step."""
    proj = Project.open(name)
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
