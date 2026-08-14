"""Headless scenario runner: ``python -m whsim.sim scenario.json`` → run artifacts.

「LLMは実験者、DESは装置」の装置側の口。宣言的なシナリオJSONを受け取り、
ヘッドレスで1回実験し、**全ての数値の出所になる run 成果物**を
``runs/<run_id>/`` に永続化する:

- ``scenario.json``  — 解決済みシナリオのスナップショット（編集適用前の宣言）
- ``model.json``     — 編集適用後の完全なモデル（これだけで追試できる）
- ``events.jsonl``   — 生イベントログ（rep0。``events_repNN.jsonl`` で全rep）
- ``summary.json``   — KPI（イベントログ集計）＋ run_id / seed / scenario_hash
- ``runs/index.jsonl`` — run台帳（1行1run: いつ・どのシナリオ・主要KPI）

シナリオJSONの形（全キー任意 — never-blocks）::

    {
      "name": "台数を1台減らす",
      "template": "line_inspection",          // または "model": "path/to/model.json"
      "edits": {"resources.workers.0.count": 9},   // dotted-path (Scenario.edits と同一)
      "seed": 42,            // simulation.random_seed を上書き
      "reps": 2,             // simulation.replications を上書き
      "duration_s": 14400.0  // simulation.duration_s を上書き
    }

再現性の契約: 同一シナリオJSON・同一seedの2回の実行は、イベント列が完全一致
する（``scenario_hash`` は解決済みシナリオの正準JSONの sha256 で、応答を見た
誰もが「同じ実験だったか」を突き合わせられる）。

薄いラッパ規約: この module は物理を1行も持たない — モデル解決・編集適用は
``engine.scenarios``、実行は ``engine.run``、KPIは ``kpis``（イベントログ集計）
の既存純関数を呼ぶだけ。MCP層はさらにこの上の薄いラッパになる。
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import sys
from pathlib import Path

# Repo-root runs/ by default (gitignored); tests and the MCP layer override it.
DEFAULT_RUNS_DIR = Path(__file__).resolve().parents[2] / "runs"
INDEX_JSONL = "index.jsonl"

# The headline KPIs a run ledger row carries (small on purpose — the full set
# lives in the run's own summary.json).
LEDGER_KPIS = ("throughput_per_hr", "completion_rate", "picker_utilization",
               "packer_utilization", "walk_per_order_m",
               "congestion_wait_total_s", "verdict")


def canonical_hash(obj) -> str:
    """sha256 of the canonical (sorted-keys, compact) JSON of ``obj``."""
    blob = json.dumps(obj, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _resolve_model(scenario: dict):
    """Scenario dict → a ready-to-run WarehouseModel (edits applied)."""
    from whsim import templates
    from whsim.engine.scenarios import apply_scenario
    from whsim.schema.model import Scenario, WarehouseModel

    if scenario.get("model"):
        md = json.loads(Path(scenario["model"]).read_text("utf-8"))
        base = WarehouseModel.model_validate(md)
    else:
        base = templates.load_template_model(
            str(scenario.get("template") or "ecommerce_small"))
    model = apply_scenario(base, Scenario(name=str(scenario.get("name") or ""),
                                          edits=dict(scenario.get("edits") or {})))
    if scenario.get("seed") is not None:
        model.simulation.random_seed = int(scenario["seed"])
    if scenario.get("reps") is not None:
        model.simulation.replications = max(1, int(scenario["reps"]))
    if scenario.get("duration_s") is not None:
        model.simulation.duration_s = float(scenario["duration_s"])
    return model


def run_scenario_dict(scenario: dict, seed: int | None = None,
                      runs_dir: Path | str | None = None) -> dict:
    """Run one scenario headlessly; persist artifacts; return the summary.

    ``seed`` (optional) overrides the scenario's own seed — the caller's knob
    for replication studies. Returns the summary dict (also written to
    ``summary.json``), whose every number is a ``kpis.compute`` output over the
    run's own event log.
    """
    from whsim import eventlog, kpis as kpi_mod
    from whsim.engine.run import run_replications

    scenario = dict(scenario or {})
    if seed is not None:
        scenario["seed"] = int(seed)
    model = _resolve_model(scenario)
    resolved = {**scenario, "seed": model.simulation.random_seed,
                "reps": model.simulation.replications,
                "duration_s": model.simulation.duration_s}
    scenario_hash = canonical_hash(resolved)

    started = _dt.datetime.now().isoformat(timespec="seconds")
    results, _heat = run_replications(model)
    kpis = kpi_mod.compute(results, model)

    base = Path(runs_dir) if runs_dir is not None else DEFAULT_RUNS_DIR
    base.mkdir(parents=True, exist_ok=True)
    run_id = f"r{_dt.datetime.now().strftime('%Y%m%d-%H%M%S')}-{scenario_hash[:8]}"
    # A same-second re-run of the same scenario must not overwrite its twin.
    run_dir = base / run_id
    n = 1
    while run_dir.exists():
        n += 1
        run_dir = base / f"{run_id}-{n}"
    run_id = run_dir.name
    run_dir.mkdir(parents=True)

    (run_dir / "scenario.json").write_text(
        json.dumps(resolved, ensure_ascii=False, indent=2), "utf-8")
    (run_dir / "model.json").write_text(model.model_dump_json(indent=2), "utf-8")
    eventlog.dump_all(results, run_dir)
    summary = {
        "run_id": run_id,
        "seed": model.simulation.random_seed,
        "scenario_hash": scenario_hash,
        "name": str(scenario.get("name") or ""),
        "started": started,
        "reps": model.simulation.replications,
        "duration_s": model.simulation.duration_s,
        "artifacts_path": str(run_dir),
        "kpis": kpis,
    }
    (run_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), "utf-8")

    row = {"run_id": run_id, "started": started, "scenario_hash": scenario_hash,
           "name": summary["name"], "seed": summary["seed"],
           **{k: kpis.get(k) for k in LEDGER_KPIS}}
    with open(base / INDEX_JSONL, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return summary


def run_scenario_file(path: str | Path, seed: int | None = None,
                      runs_dir: Path | str | None = None) -> dict:
    scenario = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(scenario, dict):
        raise ValueError("シナリオJSONはオブジェクトである必要があります")
    return run_scenario_dict(scenario, seed=seed, runs_dir=runs_dir)


def list_runs(runs_dir: Path | str | None = None) -> list[dict]:
    """The run ledger, oldest first (``[]`` when no runs yet)."""
    base = Path(runs_dir) if runs_dir is not None else DEFAULT_RUNS_DIR
    idx = base / INDEX_JSONL
    if not idx.is_file():
        return []
    out = []
    for line in idx.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a torn line must not hide the rest of the ledger
    return out


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    seed = None
    if "--seed" in args:
        i = args.index("--seed")
        try:
            seed = int(args[i + 1])
        except (IndexError, ValueError):
            print("--seed には整数を指定してください", file=sys.stderr)
            return 2
        del args[i:i + 2]
    if len(args) != 1:
        print("usage: python -m whsim.sim <scenario.json> [--seed N]",
              file=sys.stderr)
        return 2
    try:
        summary = run_scenario_file(args[0], seed=seed)
    except FileNotFoundError:
        print(f"シナリオファイルが見つかりません: {args[0]}", file=sys.stderr)
        return 1
    except (ValueError, json.JSONDecodeError) as e:
        print(f"シナリオJSONを読めませんでした: {e}", file=sys.stderr)
        return 1
    print(json.dumps({k: summary[k] for k in
                      ("run_id", "seed", "scenario_hash", "artifacts_path")},
                     ensure_ascii=False, indent=2))
    print("verdict:", summary["kpis"].get("verdict", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
