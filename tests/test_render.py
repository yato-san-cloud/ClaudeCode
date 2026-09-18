from whsim import kpis, templates
from whsim.engine.run import run_replications
from whsim.render import render


def test_render_produces_a_nonempty_png(tmp_path):
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1800.0
    results, heat = run_replications(m)
    metrics = kpis.compute(results)
    out = render(m, heat, metrics, "test summary", tmp_path / "out.png")
    assert out.is_file()
    assert out.stat().st_size > 5_000  # a real image, not an empty stub
