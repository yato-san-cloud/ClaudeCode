"""whsim MCP サーバー — LLMが道具越しに実験する口（stdio）。

起動: ``python -m whsim.mcp_server``（接続手順は ``docs/mcp-lab.md``）。

分業は1行で言える: **LLMは実験者、DESは装置**。物理・乱数・KPI集計は全て既存の
Python側（``whsim.engine`` → ``whsim.kpis`` → ``whsim.sim``）にあり、この層は
**薄いラッパでシミュレーションロジックを一切持たない**。ここに書いてよいのは

* 入力の検証（パス・run_id・範囲）、
* ``whsim.sim`` / ``whsim.lab_report`` への呼び出し、
* 応答の整形（＝run成果物からの転記）

だけで、シミュレーション由来でない数値は作らない。全ての数値出力は
``runs/<run_id>/`` の成果物（``events.jsonl`` → ``summary.json``）に紐づき、
「その数字はどのrunのどのログから来たか」を誰でも後から追試できる
（＝もっともらしい捏造を構造的に塞ぐ）。

runs/ の場所は ``WHSIM_RUNS_DIR`` があればそれ、無ければ
``whsim.sim.DEFAULT_RUNS_DIR``（``whsim.sim`` は環境変数を見ないので、この層で
``runs_dir=`` 引数として渡す）。

ツール関数は素の Python 関数のまま登録している（``add_tool``）ので、MCP
プロトコルを介さずそのまま呼べる＝テストできる。
"""

from __future__ import annotations

import datetime as _dt
import itertools
import json
import os
from pathlib import Path
from typing import Any

from whsim import lab_report as lab
from whsim import sim as sim_mod
from whsim.lab_report import LabError

SERVER_NAME = "whsim-lab"

# 応答に生ログを流さないための上限（詳細は成果物ファイルを読む）。
MAX_EVENT_SAMPLE = 200
DEFAULT_EVENT_SAMPLE = 20
MAX_LEDGER_ROWS = 200
DEFAULT_LEDGER_ROWS = 50
# スイープの実行本数の上限（1本1DES — 無制限だと会話が返って来なくなる）。
MAX_SWEEP_CASES = 64
MAX_SEED = 2 ** 32 - 1
# 1回のスイープで表に載せられる指標の数（表であって生ログではない）。
MAX_SWEEP_METRICS = 60

SWEEPS_SUBDIR = "sweeps"

# init_state_from_snapshot が認識する初期状態のキー（最小I/F）。
SNAPSHOT_KEYS = ("t", "orders", "inventory", "workers", "equipment")


def _runs_dir() -> Path:
    return lab.runs_dir()


# --------------------------------------------------------------------------
# 入力の検証（この層の仕事はここまで — 物理には一切触らない）
# --------------------------------------------------------------------------

def _as_dict(value: Any, what: str) -> dict:
    """dict か JSON文字列 → dict。それ以外は明確なエラー。"""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            obj = json.loads(value)
        except json.JSONDecodeError as e:
            raise LabError(f"{what} をJSONとして読めませんでした: {e}") from e
        if not isinstance(obj, dict):
            raise LabError(f"{what} はJSONオブジェクトである必要があります（{type(obj).__name__} でした）")
        return obj
    raise LabError(f"{what} はJSONオブジェクトかその文字列で渡してください（{type(value).__name__} でした）")


def _read_scenario_file(path: str) -> dict:
    p = Path(path).expanduser()
    if not p.is_file():
        raise LabError(f"シナリオファイルが見つかりません: {p}")
    try:
        obj = json.loads(p.read_text("utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        raise LabError(f"シナリオファイルを読めませんでした: {p} — {e}") from e
    except json.JSONDecodeError as e:
        raise LabError(f"シナリオJSONを読めませんでした: {p} — {e}") from e
    if not isinstance(obj, dict):
        raise LabError(f"シナリオJSONはオブジェクトである必要があります: {p}")
    return obj


def _resolve_scenario(scenario_path: str | None, scenario_json: Any) -> dict:
    if scenario_path and scenario_json:
        raise LabError("scenario_path と scenario_json は同時に指定できません")
    if scenario_path:
        return _read_scenario_file(scenario_path)
    if scenario_json is not None:
        return _as_dict(scenario_json, "scenario_json")
    raise LabError("scenario_path か scenario_json のどちらかを指定してください")


def _resolve_base_scenario(base_scenario: Any) -> dict:
    """base_scenario はパスかJSON（dict / JSON文字列）。"""
    if isinstance(base_scenario, dict):
        return dict(base_scenario)
    if isinstance(base_scenario, str):
        s = base_scenario.strip()
        if s.startswith("{"):
            return _as_dict(s, "base_scenario")
        return _read_scenario_file(s)
    raise LabError("base_scenario はファイルパスかJSONオブジェクトで渡してください")


def _validate_seed(seed: Any) -> int | None:
    if seed is None:
        return None
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise LabError(f"seed は整数で指定してください（{seed!r}）")
    if not 0 <= seed <= MAX_SEED:
        raise LabError(f"seed が範囲外です（0〜{MAX_SEED}）: {seed}")
    return seed


def _validate_scenario(scenario: dict) -> dict:
    """実験のつまみ（seed/reps/duration_s/edits）だけを検証する。

    モデル本体の値（人員数など）は検証しない — スキーマ側が clamp して警告を
    出す既存の never-blocks の作法に任せる。ここで見るのは「実験として成立
    しない指定」だけ。
    """
    s = dict(scenario)
    if "seed" in s and s["seed"] is not None:
        s["seed"] = _validate_seed(s["seed"])
    reps = s.get("reps")
    if reps is not None and (isinstance(reps, bool) or not isinstance(reps, int) or reps < 1):
        raise LabError(f"reps は1以上の整数で指定してください（{reps!r}）")
    if s.get("duration_s") is not None:
        d = s["duration_s"]
        if isinstance(d, bool) or not isinstance(d, (int, float)) or d <= 0:
            raise LabError(f"duration_s は正の数で指定してください（{d!r}）")
    if "edits" in s and s["edits"] is not None:
        if not isinstance(s["edits"], dict):
            raise LabError("edits は dotted-path をキーにしたオブジェクトで指定してください")
        bad = [k for k in s["edits"] if not isinstance(k, str) or not k]
        if bad:
            raise LabError(f"edits のキーは dotted-path 文字列である必要があります: {bad}")
    if s.get("model") and not Path(str(s["model"])).expanduser().is_file():
        raise LabError(f"model に指定されたファイルがありません: {s['model']}")
    return s


def _validate_diff(diff_json: Any) -> dict:
    diff = _as_dict(diff_json, "diff_json")
    if not diff:
        raise LabError("diff_json が空です（dotted-path → 値 を1つ以上指定してください）")
    bad = [k for k in diff if not isinstance(k, str) or not k.strip()]
    if bad:
        raise LabError(f"diff_json のキーは dotted-path 文字列である必要があります: {bad}")
    return diff


def _validate_metrics(metrics: Any) -> list[str]:
    """表に載せる KPI キーの検証。``None`` は既定の主要KPI（既存の応答と同一）。

    KPI そのものは ``kpis.compute`` の出力（＝runの成果物）で、ここが決めるのは
    **どれを表に転記するか**だけ。既定に入っていない KPI（``containers_in_use_peak``
    や ``conveyor_gate_stops`` のようなライン運用の読み出し）はこの引数で名指しする。
    """
    if metrics is None:
        return list(lab.HEADLINE_KPIS)
    if not isinstance(metrics, list) or not metrics:
        raise LabError('metrics は KPI キーの配列で指定してください'
                       '（未指定なら既定の主要KPI。例: ["containers_in_use_peak", '
                       '"conveyor_gate_stops"]）')
    keys: list[str] = []
    for m in metrics:
        if not isinstance(m, str) or not m.strip():
            raise LabError(f"metrics のキーは KPI 名の文字列である必要があります: {m!r}")
        keys.append(m)
    if len(keys) > MAX_SWEEP_METRICS:
        raise LabError(f"metrics が多すぎます: {len(keys)} > {MAX_SWEEP_METRICS}")
    return keys


def _compact_params(params: dict) -> dict:
    """応答に載せる params（配列/オブジェクトの値は要約する）。

    ``param_grid`` の値には ``resources.conveyors`` 丸ごとのような複合値も置ける。
    それを 64 ケース分そのまま返すと応答が実験そのものより大きくなるので、複合値は
    形だけにする（全量は ``table.json`` に残っている＝出所は失わない）。
    """
    out = {}
    for k, v in (params or {}).items():
        out[k] = v if (v is None or isinstance(v, (str, int, float, bool))) \
            else f"<{type(v).__name__} len={len(v)}>"
    return out


def _check_applied(run_id: str, diff: dict) -> tuple[list[str], list[dict]]:
    """diff が本当に効いたかを **成果物 model.json** で後から確かめる。

    ``apply_scenario`` は寛容（解決できない dotted-path は黙って捨てる）ので、
    「台数を減らした」と言いながら何も変わっていない、が起こり得る。焼かれた
    モデルを読み直して突き合わせれば、その齟齬は実験者に見える。
    """
    model = lab.load_artifact(run_id, lab.MODEL_JSON, _runs_dir())
    applied, unapplied = [], []
    for path, want in diff.items():
        segs = path.split(".")
        try:
            got = lab.get_by_path(model, segs)
        except LabError:
            unapplied.append({"path": path, "reason": "モデルに存在しないパスです"})
            continue
        if isinstance(want, (str, int, float, bool)) or want is None:
            if lab.same_value(got, want):
                applied.append(path)
            else:
                unapplied.append({"path": path, "reason": "適用後の値が指定と違います",
                                  "requested": want, "model": got})
        else:
            # 複合値（リスト/オブジェクト）はスキーマが既定値で埋めるため単純比較
            # できない。パスが解決することだけを確かめる。
            applied.append(path)
    return applied, unapplied


def _run(scenario: dict, seed: int | None) -> dict:
    """``whsim.sim`` の1本実行（唯一の実行口）。装置側の例外は明確な文言に包む。

    ここで物理は何も起きない — 例外の文言を人が読める形にするだけで、原因を
    こちらで決めつけない（pydantic の指摘をそのまま添える）。
    """
    try:
        return sim_mod.run_scenario_dict(scenario, seed=seed, runs_dir=_runs_dir())
    except LabError:
        raise
    except Exception as e:                          # 装置側の失敗を文言化する
        raise LabError(f"シナリオを実行できませんでした: {type(e).__name__}: {e}") from e


def _read_events(path: Path) -> list[dict]:
    """イベントログを1行1JSONで読む（壊れた行は飛ばす — 途中で切れたログでも
    それ以前の全イベントは読める）。"""
    try:
        text = path.read_text("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise LabError(f"イベントログを読めませんでした: {path} — {e}") from e
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def _stamp(prefix: str, key: Any) -> str:
    return (f"{prefix}{_dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"  # noqa: DTZ005
            f"-{sim_mod.canonical_hash(key)[:8]}")


# --------------------------------------------------------------------------
# ツール（MCP I/F）— どれも whsim.sim / whsim.lab_report の薄い呼び出し
# --------------------------------------------------------------------------

def run_scenario(scenario_path: str | None = None,
                 scenario_json: dict[str, Any] | str | None = None,
                 seed: int | None = None) -> dict:
    """シナリオを1本ヘッドレス実行し、run成果物を永続化してKPIを返す。

    scenario_path か scenario_json のどちらか一方を渡す。シナリオJSONの形
    （全キー任意）: ``{name, template|model, edits{dotted-path: 値}, seed,
    reps, duration_s}``。返す KPI は全て ``runs/<run_id>/events.jsonl`` の
    集計（``whsim.kpis``）で、``artifacts_path`` 配下に scenario/model/
    events/summary が残るので誰でも追試できる。
    """
    scen = _validate_scenario(_resolve_scenario(scenario_path, scenario_json))
    summary = _run(scen, _validate_seed(seed))
    return {
        "run_id": summary["run_id"],
        "seed": summary["seed"],
        "scenario_hash": summary["scenario_hash"],
        "artifacts_path": summary["artifacts_path"],
        "summary": summary,
    }


def apply_diff_and_run(base_scenario: dict[str, Any] | str,
                       diff_json: dict[str, Any] | str,
                       seed: int | None = None) -> dict:
    """基準シナリオに dotted-path の差分をマージして1本実行する（差分実験）。

    base_scenario はファイルパスかJSON。diff_json は
    ``{"resources.workers.0.count": 9}`` のような dotted-path 編集で、基準の
    ``edits`` にマージされる（同じキーは差分が勝つ）。実行後、焼かれた
    ``model.json`` を読み直して差分が本当に効いたかを確かめ、効かなかった
    パスは ``unapplied_edits`` に出す（黙って無視しない）。
    """
    base = _validate_scenario(_resolve_base_scenario(base_scenario))
    diff = _validate_diff(diff_json)
    scen = dict(base)
    scen["edits"] = {**(base.get("edits") or {}), **diff}
    if base.get("name"):
        scen["name"] = f"{base['name']} + diff"
    scen = _validate_scenario(scen)
    summary = _run(scen, _validate_seed(seed))
    applied, unapplied = _check_applied(summary["run_id"], diff)
    return {
        "run_id": summary["run_id"],
        "seed": summary["seed"],
        "scenario_hash": summary["scenario_hash"],
        "artifacts_path": summary["artifacts_path"],
        "scenario": scen,
        "diff": diff,
        "applied_edits": applied,
        "unapplied_edits": unapplied,
        "summary": summary,
    }


def compare_runs(run_ids: list[str], metrics: list[str] | None = None) -> dict:
    """複数runのKPI差分表（絶対値・差・変化率）。先頭の run_id が基準。

    **全数値は各runの summary.json からの転記**で、差と変化率はその転記どうしの
    算術。``sources`` に出所ファイルのパスが入るので、表の数字はいつでも
    成果物と突き合わせられる。
    """
    if not isinstance(run_ids, list) or not run_ids:
        raise LabError("run_ids に run_id を1つ以上（配列で）渡してください")
    return lab.compare_runs(run_ids, metrics, _runs_dir())


def sweep(base_scenario: dict[str, Any] | str,
          param_grid: dict[str, Any] | str,
          seeds: list[int],
          metrics: list[str] | None = None) -> dict:
    """パラメータ格子×seed を全数実行し、結果テーブルを永続化する。

    param_grid は ``{"resources.workers.0.count": [8, 9, 10]}`` のように
    dotted-path → 値のリスト。総ケース数（格子の直積 × seed 数）が
    上限を超えるときは実行前に断る。**1本失敗してもスイープは止まらず**、
    その失敗は結果テーブル（``index.jsonl``）にエラー行として残る。

    ``metrics`` は表に載せる KPI キー（未指定＝既定の主要KPI）。既定に入っていない
    読み出し（``containers_in_use_peak`` / ``conveyor_gate_stops`` /
    ``conveyor_block_ratio`` など）はここで名指しする — 名指ししないと、その KPI は
    掃引の表にもこの応答にも出ない。

    ケースごとの行（params ↔ run_id ↔ KPI）は ``rows`` でそのまま返す。掃引の
    目的は**曲線**なので、表がファイルにしか無いと臨界点を読むのに run 1本ずつ
    問い合わせる羽目になる。

    掃引した dotted-path が効かなかった場合は ``unapplied_edits`` に出し、全ケースの
    KPI が完全一致した場合は ``warnings`` に出す（``apply_scenario`` は解決できない
    パスを黙って捨て、自由 dict のキー名違いは「適用された」ように見えるので、
    **同じ数字が並んだだけの掃引**を「効かなかった」と読み違えないため）。
    """
    base = _validate_scenario(_resolve_base_scenario(base_scenario))
    mets = _validate_metrics(metrics)
    grid = _as_dict(param_grid, "param_grid")
    if not grid:
        raise LabError("param_grid が空です（dotted-path → 値のリスト を指定してください）")
    for k, v in grid.items():
        if not isinstance(k, str) or not k.strip():
            raise LabError(f"param_grid のキーは dotted-path 文字列である必要があります: {k!r}")
        if not isinstance(v, list) or not v:
            raise LabError(f"param_grid の値は空でないリストである必要があります: {k} → {v!r}")
    if not isinstance(seeds, list) or not seeds:
        raise LabError("seeds に seed を1つ以上（配列で）渡してください")
    seed_list = [_validate_seed(s) for s in seeds]

    keys = list(grid)
    combos = list(itertools.product(*[grid[k] for k in keys]))
    total = len(combos) * len(seed_list)
    if total > MAX_SWEEP_CASES:
        raise LabError(f"ケース数が上限を超えています: {total} > {MAX_SWEEP_CASES}"
                       "（格子かseedを減らしてください）")

    sweep_id = _stamp("s", {"base": base, "grid": grid, "seeds": seed_list})
    sdir = _runs_dir() / SWEEPS_SUBDIR / sweep_id
    rows: list[dict] = []
    for i, (combo, sd) in enumerate(itertools.product(combos, seed_list), start=1):
        params = dict(zip(keys, combo))
        scen = dict(base)
        scen["edits"] = {**(base.get("edits") or {}), **params}
        scen["name"] = f"{base.get('name') or 'sweep'} #{i}"
        row: dict[str, Any] = {"case": i, "seed": sd, "params": params}
        try:
            summary = _run(scen, sd)
        except Exception as e:                      # noqa: BLE001 — 1本の失敗で掃引を止めない
            row.update({"status": "error", "run_id": None, "kpis": {},
                        "unapplied_edits": [], "error": f"{type(e).__name__}: {e}"})
        else:
            # 焼かれた model.json で「そのケースの編集が本当に効いたか」を確かめる
            # （効かなかったケースが黙って基準と同じ数字を出すのが一番危ない）。
            try:
                _applied, unapplied = _check_applied(summary["run_id"], params)
            except LabError as e:                   # 確認できないことは確認できないと言う
                unapplied = [{"path": "*", "reason": f"適用結果を確認できませんでした: {e}"}]
            row.update({"status": "ok", "run_id": summary["run_id"],
                        "seed": summary["seed"],
                        "scenario_hash": summary["scenario_hash"],
                        "artifacts_path": summary["artifacts_path"],
                        "kpis": {m: summary["kpis"].get(m) for m in mets},
                        "unapplied_edits": unapplied,
                        "error": None})
        rows.append(row)

    manifest = {"sweep_id": sweep_id, "base_scenario": base, "param_grid": grid,
                "seeds": seed_list, "cases": total, "metrics": mets,
                "created": _dt.datetime.now().isoformat(timespec="seconds")}  # noqa: DTZ005
    paths = lab.write_sweep_table(sdir, manifest, rows, mets)
    ok = [r for r in rows if r["status"] == "ok"]

    # 効かなかった編集（パス単位に畳む — 同じ格子は全ケースで同じパスを編集する）。
    unapplied: dict[str, dict] = {}
    for r in rows:
        for u in r.get("unapplied_edits") or ():
            e = unapplied.setdefault(str(u.get("path")),
                                     {"path": u.get("path"), "reason": u.get("reason"),
                                      "cases": []})
            e["cases"].append(r["case"])
    # 同一seedのケースのKPIが1つ残らず一致＝掃引したつまみが動いていない疑い。
    # 「効かない」と「本当に効果が無い」は別物なので、断定せず注意として返す。
    by_seed: dict[Any, list[dict]] = {}
    for r in ok:
        by_seed.setdefault(r["seed"], []).append(r["kpis"])
    groups = [v for v in by_seed.values() if len(v) > 1]
    kpi_identical = bool(groups) and all(all(k == v[0] for k in v) for v in groups)
    warnings: list[str] = []
    if unapplied:
        warnings.append("モデルに効かなかった編集があります（unapplied_edits）: "
                        + ", ".join(sorted(unapplied)))
    if kpi_identical:
        warnings.append(
            "同一seedの全ケースでKPIが完全に一致しました — 掃引したつまみが"
            "モデルに効いていない可能性があります（自由 dict のキー名違い・配列の"
            "添字違いなど）。焼かれた model.json で確かめてください。")

    return {
        "sweep_id": sweep_id,
        "dir": paths["dir"],
        "table_path": paths["table_csv"],
        "table_json": paths["table_json"],
        "index_path": paths["index"],
        "cases": total,
        "ok": len(ok),
        "failed": total - len(ok),
        "metrics": mets,
        "run_ids": [r["run_id"] for r in ok],
        "rows": [{"case": r["case"], "seed": r["seed"],
                  "params": _compact_params(r.get("params")),
                  "status": r["status"], "run_id": r.get("run_id"),
                  "kpis": r.get("kpis") or {},
                  "unapplied_edits": r.get("unapplied_edits") or [],
                  "error": r.get("error")} for r in rows],
        "summary": lab.summarize_rows(rows, mets),
        "unapplied_edits": list(unapplied.values()),
        "warnings": warnings,
        "errors": [{"case": r["case"], "params": _compact_params(r["params"]),
                    "seed": r["seed"], "error": r["error"]}
                   for r in rows if r["status"] == "error"],
    }


def query_events(run_id: str, filter: dict[str, Any] | str | None = None,
                 limit: int = DEFAULT_EVENT_SAMPLE, rep: int = 0) -> dict:
    """runのイベントログを絞り込んで**要約統計＋先頭limit行**だけ返す。

    filter は ``{"type": "aisle_wait" | ["pick_start", ...], "actor":
    "picker-5", "t_range": [0, 600]}``。全量は応答に載せない（件数・時間範囲・
    type別内訳・数値フィールドの合計/平均だけ）。生ログが要るときは
    ``get_run_artifacts`` が返すパスの ``events.jsonl`` を直接読む。
    """
    rid = lab.validate_run_id(run_id)
    if isinstance(rep, bool) or not isinstance(rep, int) or rep < 0:
        raise LabError(f"rep は0以上の整数で指定してください（{rep!r}）")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise LabError(f"limit は1以上の整数で指定してください（{limit!r}）")
    if limit > MAX_EVENT_SAMPLE:
        raise LabError(f"limit が上限を超えています: {limit} > {MAX_EVENT_SAMPLE}")
    d = lab.run_dir(rid, _runs_dir())
    name = "events.jsonl" if rep == 0 else f"events_rep{rep:02d}.jsonl"
    path = d / name
    if not path.is_file():
        raise LabError(f"レプリケーション {rep} のイベントログがありません: {path}")
    events = _read_events(path)

    f = _as_dict(filter, "filter") if filter is not None else {}
    types = f.get("type")
    types = [types] if isinstance(types, str) else (list(types) if types else None)
    actor = f.get("actor")
    if actor is not None and not isinstance(actor, str):
        raise LabError(f"filter.actor は文字列で指定してください（{actor!r}）")
    tr = f.get("t_range")
    if tr is not None:
        if (not isinstance(tr, (list, tuple)) or len(tr) != 2
                or not all(isinstance(x, (int, float)) and not isinstance(x, bool)
                           for x in tr)):
            raise LabError("filter.t_range は [開始秒, 終了秒] の数値2つで指定してください")
        if float(tr[0]) > float(tr[1]):
            raise LabError(f"filter.t_range が逆順です: {list(tr)}")

    def keep(e: dict) -> bool:
        if types is not None and e.get("event") not in types:
            return False
        if actor is not None and actor not in (e.get("worker"), e.get("resource")):
            return False
        return tr is None or float(tr[0]) <= float(e.get("t", 0.0)) <= float(tr[1])

    hits = [e for e in events if keep(e)]
    by_type: dict[str, int] = {}
    for e in hits:
        by_type[str(e.get("event"))] = by_type.get(str(e.get("event")), 0) + 1
    ts = [float(e["t"]) for e in hits if isinstance(e.get("t"), (int, float))]
    # 数値フィールドの合計/平均（wait/dist/busy…）— イベントの値そのものの集計。
    fields: dict[str, dict] = {}
    for e in hits:
        for k, v in e.items():
            if k == "t" or isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            acc = fields.setdefault(k, {"n": 0, "sum": 0.0})
            acc["n"] += 1
            acc["sum"] += float(v)
    for k, acc in fields.items():
        acc["mean"] = acc["sum"] / acc["n"] if acc["n"] else None
    return {
        "run_id": rid,
        "rep": rep,
        "source": str(path),
        "total_events": len(events),
        "matched": len(hits),
        "t_min": min(ts) if ts else None,
        "t_max": max(ts) if ts else None,
        "by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        "numeric_fields": fields,
        "limit": limit,
        "sample": hits[:limit],
        "truncated": len(hits) > limit,
    }


def get_run_artifacts(run_id: str) -> dict:
    """runの成果物ファイル一覧（パスとサイズ）。中身は載せない。"""
    rid = lab.validate_run_id(run_id)
    d = lab.run_dir(rid, _runs_dir())
    files = []
    for p in sorted(d.iterdir()):
        if p.is_file():
            files.append({"name": p.name, "path": str(p), "bytes": p.stat().st_size})
    return {"run_id": rid, "dir": str(d), "files": files}


def list_runs(limit: int = DEFAULT_LEDGER_ROWS) -> dict:
    """run台帳（新しい順）: 日時・シナリオハッシュ・主要KPI。"""
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise LabError(f"limit は1以上の整数で指定してください（{limit!r}）")
    limit = min(limit, MAX_LEDGER_ROWS)
    rows = sim_mod.list_runs(_runs_dir())
    return {"runs_dir": str(_runs_dir()), "total": len(rows), "limit": limit,
            "runs": list(reversed(rows))[:limit]}


def init_state_from_snapshot(state_json: dict[str, Any] | str) -> dict:
    """反実仮想の入口（**I/Fと最小実装のみ**）: 初期状態スナップショットの検証。

    渡された state_json が「このrunの初期状態として使える形か」を返すだけで、
    エンジンへの投入はまだ行わない（DES側にウォームスタートの口が無いため）。
    実WMSからの較正は別ランの仕事。
    """
    state = _as_dict(state_json, "state_json")
    reasons: list[str] = []
    recognized: dict[str, Any] = {}
    if "t" in state:
        t = state["t"]
        if isinstance(t, bool) or not isinstance(t, (int, float)) or t < 0:
            reasons.append("t は0以上の数値（開始時刻・秒）である必要があります")
        else:
            recognized["t"] = float(t)
    for key in ("orders", "workers", "equipment"):
        if key in state:
            if not isinstance(state[key], list):
                reasons.append(f"{key} は配列である必要があります")
            else:
                recognized[key] = len(state[key])
    if "inventory" in state:
        if not isinstance(state["inventory"], dict):
            reasons.append("inventory はオブジェクト（SKU → 数量）である必要があります")
        else:
            recognized["inventory"] = len(state["inventory"])
    unknown = sorted(set(state) - set(SNAPSHOT_KEYS))
    if not recognized and not reasons:
        reasons.append(f"認識できるキーがありません（想定: {', '.join(SNAPSHOT_KEYS)}）")
    return {
        "usable": not reasons,
        "reasons": reasons,
        "recognized": recognized,
        "unknown_keys": unknown,
        "engine_supported": False,
        "note": ("構造の検証のみです。DESは現状ウォームスタートを受け付けないため、"
                 "この状態から実行することはまだできません（実WMS較正は別ラン）。"),
    }


def generate_report(run_ids: list[str], out_dir: str | None = None,
                    metrics: list[str] | None = None) -> dict:
    """複数runの比較レポート（Markdown＋PNG＋numbers.json）を書き出す。

    レポート内の数値は1つ残らず run成果物からの転記で、``numbers.json`` に
    ``{出所run_id, 成果物ファイル, キー}`` つきで並ぶ。書き出し直後に
    ``verify_report`` を回した結果を ``verification`` に同梱する（自己照合）。
    """
    if not isinstance(run_ids, list) or not run_ids:
        raise LabError("run_ids に run_id を1つ以上（配列で）渡してください")
    return lab.generate_report(run_ids, out_dir, _runs_dir(), metrics)


def verify_report(report_dir: str) -> dict:
    """レポートの機械照合: 台帳の全数値を成果物から再計算し、本文の全数値が
    台帳にあることを確かめる（片方だけでは捏造を許すので両方向）。"""
    if not isinstance(report_dir, str) or not report_dir.strip():
        raise LabError("report_dir にレポートディレクトリのパスを指定してください")
    return lab.verify_report(report_dir, _runs_dir())


TOOLS = (run_scenario, apply_diff_and_run, compare_runs, sweep, query_events,
         get_run_artifacts, list_runs, init_state_from_snapshot, generate_report,
         verify_report)

INSTRUCTIONS = (
    "倉庫の離散事象シミュレータ whsim の実験装置。あなたは実験者、DESは装置です。\n"
    "run_scenario / apply_diff_and_run で実験し、compare_runs で比べ、query_events で"
    "根拠のログを確かめ、generate_report で記録します。\n"
    "返る数値は全て runs/<run_id>/ の成果物（events.jsonl→summary.json）由来です。"
    "成果物に無い数値を自分で作らないでください — レポートの照合(verify_report)で落ちます。"
)


def build_server():
    """MCPサーバーを組み立てて返す（stdio 起動は :func:`main`）。"""
    try:                                   # mcp>=2 は FastMCP を MCPServer に改名
        from mcp.server.mcpserver import MCPServer as _Server
    except ImportError:                    # mcp 1.x
        from mcp.server.fastmcp import FastMCP as _Server
    srv = _Server(name=SERVER_NAME, instructions=INSTRUCTIONS)
    for fn in TOOLS:
        srv.add_tool(fn)
    return srv


def main() -> int:
    if os.environ.get(lab.RUNS_DIR_ENV):
        _runs_dir().mkdir(parents=True, exist_ok=True)
    build_server().run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
