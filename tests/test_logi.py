"""Logi3D-inspired features: CAD import, proposal docs, pick-strategy effect."""

import ezdxf

from whsim import cad, export_doc, kpis, templates
from whsim.engine.run import run_once
from whsim.schema.model import Equipment


def _dxf_bytes() -> bytes:
    import io
    doc = ezdxf.new()
    doc.header["$INSUNITS"] = 4  # mm
    msp = doc.modelspace()
    msp.add_lwpolyline([(0, 0), (40000, 0), (40000, 25000), (0, 25000), (0, 0)])
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def test_dxf_import_to_meters():
    res = cad.import_dxf_bytes(_dxf_bytes())
    assert res["bounds"]["width"] == 40.0  # 40000mm -> 40m
    assert res["bounds"]["depth"] == 25.0
    assert len(res["walls"]) >= 1


def test_proposal_docs_generated(tmp_path):
    m = templates.load_template_model("ecommerce_small")
    m.simulation.duration_s = 1200
    k = kpis.compute([run_once(m)])
    pptx = export_doc.build_pptx(k, "テスト倉庫", "実データ 0%", None, tmp_path / "p.pptx")
    pdf = export_doc.build_pdf(k, "テスト倉庫", "実データ 0%", None, tmp_path / "p.pdf")
    assert pptx.stat().st_size > 5_000
    assert pdf.stat().st_size > 2_000


def test_pick_strategy_reduces_walking_vs_discrete():
    base = templates.load_template_model("ecommerce_small")
    base.simulation.duration_s = 3600

    def walk(strategy):
        m = base.model_copy(deep=True)
        m.process.pick_strategy = strategy
        return kpis.compute([run_once(m)])["walk_per_order_m"]

    d = walk("discrete")
    # every batching strategy should walk no more per order than naive discrete,
    # and wave (largest pool) should be the shortest.
    assert walk("batch") <= d + 1e-6
    assert walk("wave") <= d + 1e-6
    assert walk("wave") <= walk("batch") + 1e-6


def test_forklifts_are_demand_linked():
    base = templates.load_template_model("ecommerce_small")
    base.simulation.duration_s = 3600
    base.resources.equipment = [Equipment(id="fl", type="forklift", count=2)]

    hi = base.model_copy(deep=True)
    hi.orders.profile.rate_per_hr = 240
    lo = base.model_copy(deep=True)
    lo.orders.profile.rate_per_hr = 20

    def putaways(m):
        return sum(1 for e in run_once(m).events if e["event"] == "forklift_done")

    assert putaways(hi) > putaways(lo)
