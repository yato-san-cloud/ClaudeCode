"""Custom (editable) work processes must flow through the productivity feedback
loop: the 想定 vs 実測 comparison in the analysis payload (`_analysis_payload`)
and the 実測生産性 derivation (`kpis._measured_productivity`) both resolve their
process ids through `staffing.process_master(model)` rather than hardcoding the
engine-default ids. With no custom list the behaviour is byte-identical to before.
"""

from whsim.kpis import _measured_productivity
from whsim.schema.model import WarehouseModel, WorkProcess
from whsim.web.routes._common import _analysis_payload


def _measured_metrics(measured: dict) -> dict:
    """Minimal metrics dict carrying just the measured_productivity feedback."""
    return {"verdict": "ok", "measured_productivity": measured}


def test_default_model_keeps_canonical_ids():
    """Empty work_processes ⇒ measured keys are the canonical ピッキング/梱包."""
    model = WarehouseModel()
    out = _measured_productivity(
        res=None, model=model, picker_busy=3600.0, packer_busy=3600.0, completed=10
    )
    assert "ピッキング" in out
    assert "梱包" in out


def test_renamed_picking_process_flows_through_measured():
    """A renamed out_lines/行h process receives the picker's measured rate."""
    model = WarehouseModel()
    model.process.work_processes = [
        WorkProcess(id="ピック作業", section="出荷", driver="out_lines",
                    prod=60, unit="行/h"),
        WorkProcess(id="梱包作業", section="出荷", driver="out_orders",
                    prod=30, unit="件/h"),
    ]
    out = _measured_productivity(
        res=None, model=model, picker_busy=3600.0, packer_busy=3600.0, completed=10
    )
    assert "ピック作業" in out
    assert "梱包作業" in out
    # The hardcoded defaults must NOT linger when the process was renamed.
    assert "ピッキング" not in out
    assert "梱包" not in out


def test_custom_process_appears_in_analysis_payload_comparison():
    """A renamed process surfaces in the 想定 vs 実測 productivity_compare table."""
    model = WarehouseModel()
    model.process.work_processes = [
        WorkProcess(id="ピック作業", section="出荷", driver="out_lines",
                    prod=55, unit="行/h"),
    ]
    metrics = _measured_metrics({"ピック作業": 48.0})
    payload = _analysis_payload(model, metrics, source="run")
    procs = {row["process"] for row in payload["productivity_compare"]}
    assert "ピック作業" in procs
    row = next(r for r in payload["productivity_compare"] if r["process"] == "ピック作業")
    assert row["unit"] == "行/h"
    assert row["measured"] == 48.0
    assert row["benchmark"] == 55.0  # engine-default prod from the custom process


def test_default_payload_comparison_unchanged():
    """With no custom processes the canonical id still keys the comparison."""
    model = WarehouseModel()
    metrics = _measured_metrics({"ピッキング": 50.0})
    payload = _analysis_payload(model, metrics, source="run")
    procs = {row["process"] for row in payload["productivity_compare"]}
    assert "ピッキング" in procs
