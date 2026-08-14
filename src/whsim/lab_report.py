"""実験ノート層 — run成果物からの**転記**だけで比較表・図・レポートを作る。

「LLMは実験者、DESは装置」の記録側の口。この module は物理を1行も持たず、
**数値を1つも作らない**: 出てくる値は

* ``runs/<run_id>/summary.json`` / ``scenario.json`` から読んだ値そのもの（転記）、
* 転記どうしの四則（差・変化率・最小/最大/平均＝「転記の算術」）

のどちらかだけで、**必ず出所が残る**。レポートは :class:`NumberLedger` を
通してしか数字を書けない — ``cite()`` は成果物ファイルを読んでその値を返すので、
成果物に無い数値はそもそも紙に載せられない。載った数値は全て ``numbers.json``
に ``{出所run_id, 成果物ファイル, キー}`` つきで並び、:func:`verify_report` が
成果物と突き合わせて再計算する（改竄すれば不一致で落ちる）。これが
「もっともらしい捏造」を構造的に塞ぐ仕掛けで、飾りではなく契約。

MCP層はこの module の純関数を呼ぶだけ。MCP無しでも（このファイル単体で）
テストできるように、ここには I/O とパス検証と算術しか無い。
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import json
import os
import re
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from whsim import eventlog
from whsim import sim as sim_mod

# runs/ の場所: 環境変数 > whsim.sim の既定（sim.py は触らないので、ここで解決して
# runs_dir= 引数として渡す）。
RUNS_DIR_ENV = "WHSIM_RUNS_DIR"

SUMMARY_JSON = "summary.json"
SCENARIO_JSON = "scenario.json"
MODEL_JSON = "model.json"
REPORT_MD = "report.md"
NUMBERS_JSON = "numbers.json"
KPI_CHART = "kpi_bars.png"
DELTA_CHART = "delta_pct.png"

# 引用してよい成果物（レポートの数値の出所はこの2つに限る — model.json は
# 入力の焼き付けで、KPIはここには居ない）。
CITABLE = (SUMMARY_JSON, SCENARIO_JSON)

# 比較表の既定の指標。ここは「どれを見せるか」の選択であって、値を作る場所ではない。
HEADLINE_KPIS: tuple[str, ...] = (
    "orders_arrived", "orders_completed", "completion_rate", "throughput_per_hr",
    "cycle_mean_s", "cycle_p95_s", "picker_utilization", "packer_utilization",
    "pick_wait_mean_s", "walk_per_order_m", "walk_total_m",
    "congestion_waits", "congestion_wait_total_s", "congestion_wait_mean_s",
    "congestion_wait_p95_s", "congestion_wait_share",
    "headcount", "total_cost_per_order", "bottleneck_utilization",
)

KPI_JP: dict[str, str] = {
    "orders_arrived": "到着オーダー数", "orders_completed": "完了オーダー数",
    "completion_rate": "完了率", "throughput_per_hr": "処理能力（件/h）",
    "cycle_mean_s": "リードタイム平均（秒）", "cycle_p95_s": "リードタイムp95（秒）",
    "picker_utilization": "ピッカー稼働率", "packer_utilization": "梱包稼働率",
    "pick_wait_mean_s": "ピッキング待ち平均（秒）",
    "walk_per_order_m": "歩行距離（m/件）", "walk_total_m": "歩行距離合計（m）",
    "congestion_waits": "通路待ち回数", "congestion_wait_total_s": "通路待ち合計（秒）",
    "congestion_wait_mean_s": "通路待ち平均（秒）",
    "congestion_wait_p95_s": "通路待ちp95（秒）",
    "congestion_wait_share": "通路待ちの割合",
    "headcount": "人員数", "total_cost_per_order": "原価（¥/件）",
    "bottleneck_utilization": "ボトルネック稼働率",
}

# 図に出す指標（小さく保つ — 図は表の要約であって別の主張ではない）。
CHART_KPIS: tuple[str, ...] = (
    "throughput_per_hr", "completion_rate", "picker_utilization",
    "congestion_wait_total_s", "congestion_wait_mean_s", "walk_per_order_m",
)

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# 本文中の数値トークン（符号つき小数まで。指数表記は使わない＝出さない）。
# 直前がASCII英字/下線のものは識別子の一部（``p95`` の ``95`` 等）なので数値
# として数えない — 日本語に貼り付いた数字（「約52件」）は数える。
_NUM_RE = re.compile(r"(?<![A-Za-z0-9_])[-+]?\d+(?:\.\d+)?")
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_CODE_SPAN_RE = re.compile(r"`[^`]*`")


class LabError(ValueError):
    """利用者に見せる明確なエラー（MCP層はこれを掴んでツールエラーにする）。"""


# --------------------------------------------------------------------------
# パス検証と読み出し（この層の唯一の「賢さ」）
# --------------------------------------------------------------------------

def runs_dir(explicit: str | Path | None = None) -> Path:
    """runs/ の場所: 明示引数 > ``WHSIM_RUNS_DIR`` > ``sim.DEFAULT_RUNS_DIR``。"""
    if explicit:
        return Path(explicit).expanduser()
    env = os.environ.get(RUNS_DIR_ENV)
    if env:
        return Path(env).expanduser()
    return Path(sim_mod.DEFAULT_RUNS_DIR)


def validate_run_id(run_id: Any) -> str:
    """run_id を「ディレクトリ名1つ」に限定する（``..`` やパス区切りを弾く）。"""
    if not isinstance(run_id, str) or not _RUN_ID_RE.match(run_id) or ".." in run_id:
        raise LabError(f"run_id の形式が不正です: {run_id!r}")
    return run_id


def run_dir(run_id: str, base: str | Path | None = None) -> Path:
    """``runs/<run_id>/`` を返す（存在しなければ明確なエラー）。"""
    rid = validate_run_id(run_id)
    d = runs_dir(base) / rid
    if not d.is_dir():
        raise LabError(f"run が見つかりません: {rid}（{runs_dir(base)} 配下）")
    return d


def load_artifact(run_id: str, file: str = SUMMARY_JSON,
                  base: str | Path | None = None) -> dict:
    """run成果物のJSONを1つ読む（引用できるのは :data:`CITABLE` のみ）。"""
    if file not in CITABLE and file != MODEL_JSON:
        raise LabError(f"読み出しを許可していない成果物です: {file}")
    path = run_dir(run_id, base) / file
    try:
        obj = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as e:
        raise LabError(f"成果物がありません: {path}") from e
    except (OSError, json.JSONDecodeError) as e:
        raise LabError(f"成果物を読めませんでした: {path} — {e}") from e
    if not isinstance(obj, dict):
        raise LabError(f"成果物の形が想定外です（オブジェクトではない）: {path}")
    return obj


def load_summary(run_id: str, base: str | Path | None = None) -> dict:
    return load_artifact(run_id, SUMMARY_JSON, base)


def get_by_path(obj: Any, path: Sequence[Any]) -> Any:
    """**セグメント列**での取り出し（``["kpis", "throughput_per_hr"]``）。

    ドット文字列ではなくリストなのは、シナリオの ``edits`` のキー自体が
    ``resources.workers.0.count`` というドット列だから — ``["edits",
    "resources.workers.0.count"]`` は曖昧さ無しに引ける。
    """
    cur = obj
    for seg in path:
        try:
            cur = cur[int(seg)] if isinstance(cur, list) else cur[seg]
        except (KeyError, IndexError, TypeError, ValueError) as e:
            raise LabError(f"成果物にキーがありません: {list(path)}（{seg!r} で失敗）") from e
    return cur


# --------------------------------------------------------------------------
# 数値の書式（レポートに出る文字列＝台帳に載る文字列。ここだけが唯一の書式）
# --------------------------------------------------------------------------

def fmt_num(v: Any) -> str:
    """数値 → レポートの表記。指数表記もカンマも使わない（照合が単純になる）。"""
    if v is None:
        return "—"
    f = float(v)
    if f == int(f) and abs(f) < 1e12:
        return str(int(f))
    s = f"{f:.6f}".rstrip("0").rstrip(".")
    return s or "0"


def fmt_pct(v: Any) -> str:
    """変化率 → ``+3.50`` / ``-12.34``（符号つき固定小数）。"""
    if v is None:
        return "—"
    return f"{float(v):+.2f}"


FORMATS = {"num": fmt_num, "pct": fmt_pct}


# --------------------------------------------------------------------------
# 転記の算術（差・変化率・集計）— 値を作らない、転記どうしを足し引きするだけ
# --------------------------------------------------------------------------

def _delta(a: Any, b: Any) -> float | None:
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return None
    return float(a) - float(b)


def _pct_change(a: Any, b: Any) -> float | None:
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return None
    if float(b) == 0.0:
        return None       # 0 基準の変化率は定義しない（∞をでっち上げない）
    return (float(a) - float(b)) / float(b) * 100.0


OPS = {"delta": _delta, "pct_change": _pct_change}


def compare_runs(run_ids: Sequence[str], metrics: Sequence[str] | None = None,
                 base: str | Path | None = None) -> dict:
    """KPI差分表: 絶対値＋差＋変化率。**全数値は各runの summary.json からの転記**。

    先頭の run_id が基準（baseline）。``metrics`` 未指定なら
    :data:`HEADLINE_KPIS` のうち、どれかの run で数値として存在するものだけ。
    """
    ids = [validate_run_id(r) for r in (run_ids or ())]
    if len(ids) < 1:
        raise LabError("compare_runs には run_id を1つ以上渡してください")
    if len(set(ids)) != len(ids):
        raise LabError(f"run_id が重複しています: {ids}")
    summaries = {rid: load_summary(rid, base) for rid in ids}
    kpis = {rid: (summaries[rid].get("kpis") or {}) for rid in ids}

    if metrics is None:
        keys = [k for k in HEADLINE_KPIS
                if any(isinstance(kpis[r].get(k), (int, float))
                       and not isinstance(kpis[r].get(k), bool) for r in ids)]
    else:
        keys = [str(k) for k in metrics]
        if not keys:
            raise LabError("metrics を空で渡さないでください（未指定なら既定の指標を使います）")

    baseline = ids[0]
    rows = []
    for k in keys:
        vals = {rid: kpis[rid].get(k) for rid in ids}
        b = vals[baseline]
        rows.append({
            "metric": k,
            "label": KPI_JP.get(k, k),
            "values": vals,
            "baseline": b,
            "delta": {rid: _delta(vals[rid], b) for rid in ids},
            "pct_change": {rid: _pct_change(vals[rid], b) for rid in ids},
        })
    return {
        "run_ids": ids,
        "baseline": baseline,
        "sources": {rid: str(run_dir(rid, base) / SUMMARY_JSON) for rid in ids},
        "runs": [{
            "run_id": rid,
            "name": summaries[rid].get("name", ""),
            "seed": summaries[rid].get("seed"),
            "reps": summaries[rid].get("reps"),
            "duration_s": summaries[rid].get("duration_s"),
            "scenario_hash": summaries[rid].get("scenario_hash"),
            "started": summaries[rid].get("started"),
            "verdict": kpis[rid].get("verdict", ""),
        } for rid in ids],
        "metrics": rows,
    }


def summarize_rows(rows: Sequence[dict], metrics: Sequence[str]) -> dict:
    """スイープ結果の集計（min/max/平均＋その run_id）。転記の算術のみ。"""
    out: dict[str, dict] = {}
    for m in metrics:
        pts = [(r["kpis"].get(m), r.get("run_id")) for r in rows
               if r.get("status") == "ok" and isinstance(r.get("kpis"), dict)
               and isinstance(r["kpis"].get(m), (int, float))
               and not isinstance(r["kpis"].get(m), bool)]
        if not pts:
            continue
        lo = min(pts, key=lambda p: p[0])
        hi = max(pts, key=lambda p: p[0])
        out[m] = {
            "n": len(pts),
            "min": lo[0], "min_run_id": lo[1],
            "max": hi[0], "max_run_id": hi[1],
            "mean": sum(p[0] for p in pts) / len(pts),
        }
    return out


# --------------------------------------------------------------------------
# 数値台帳（レポートはこれ越しにしか数字を書けない）
# --------------------------------------------------------------------------

class NumberLedger:
    """レポートに出る全数値の出所台帳。

    ``cite`` は成果物を**読んで**その値を返すので、台帳に載らない数値は
    レポートに書けない（書けば :func:`verify_report` の未裏付けトークンとして
    検出される）。``arith`` も同様に、operand を成果物から読み直して計算する。
    """

    def __init__(self, base: str | Path | None = None):
        self.base = base
        self.records: list[dict] = []
        self._cache: dict[tuple[str, str], dict] = {}

    def _artifact(self, run_id: str, file: str) -> dict:
        key = (run_id, file)
        if key not in self._cache:
            self._cache[key] = load_artifact(run_id, file, self.base)
        return self._cache[key]

    def value(self, run_id: str, path: Sequence[Any], file: str = SUMMARY_JSON) -> Any:
        return get_by_path(self._artifact(run_id, file), path)

    def cite(self, run_id: str, path: Sequence[Any], file: str = SUMMARY_JSON,
             fmt: str = "num") -> str:
        v = self.value(run_id, path, file)
        text = FORMATS[fmt](v)
        self.records.append({
            "id": f"n{len(self.records) + 1:04d}",
            "text": text, "value": v, "format": fmt,
            "source": {"kind": "artifact", "run_id": run_id, "file": file,
                       "path": list(path)},
        })
        return text

    def arith(self, op: str, operands: Sequence[dict], fmt: str = "num") -> str:
        """転記どうしの算術。operand は ``{run_id, file?, path}``。"""
        if op not in OPS:
            raise LabError(f"未知の演算です: {op}")
        refs = [{"run_id": o["run_id"], "file": o.get("file", SUMMARY_JSON),
                 "path": list(o["path"])} for o in operands]
        vals = [self.value(r["run_id"], r["path"], r["file"]) for r in refs]
        v = OPS[op](*vals)
        text = FORMATS[fmt](v)
        self.records.append({
            "id": f"n{len(self.records) + 1:04d}",
            "text": text, "value": v, "format": fmt,
            "source": {"kind": "arithmetic", "op": op, "operands": refs},
        })
        return text

    def as_dict(self, run_ids: Sequence[str], report_id: str) -> dict:
        return {
            "report_id": report_id,
            "runs_dir": str(runs_dir(self.base)),
            "run_ids": list(run_ids),
            "numbers": self.records,
        }


def verify_numbers(ledger: dict, base: str | Path | None = None) -> dict:
    """台帳の全数値を run成果物から**再計算**して突き合わせる。

    ``base`` 未指定なら台帳が記録した ``runs_dir`` を使う（レポートを別マシンへ
    持って行っても、runs/ さえ同じ場所にあれば照合できる）。
    """
    if not isinstance(ledger, dict) or not isinstance(ledger.get("numbers"), list):
        raise LabError("numbers 台帳の形が不正です（numbers 配列がありません）")
    b = base if base is not None else ledger.get("runs_dir")
    mism: list[dict] = []
    for rec in ledger["numbers"]:
        rid = rec.get("id", "?")
        try:
            src = rec["source"]
            fmt = rec.get("format", "num")
            if src["kind"] == "artifact":
                actual = get_by_path(load_artifact(src["run_id"], src["file"], b),
                                     src["path"])
            elif src["kind"] == "arithmetic":
                vals = [get_by_path(load_artifact(o["run_id"], o["file"], b), o["path"])
                        for o in src["operands"]]
                actual = OPS[src["op"]](*vals)
            else:
                mism.append({"id": rid, "reason": f"未知の出所種別: {src.get('kind')}"})
                continue
        except (LabError, KeyError, TypeError) as e:
            mism.append({"id": rid, "reason": f"出所を辿れません: {e}"})
            continue
        if not same_value(actual, rec.get("value")):
            mism.append({"id": rid, "reason": "値が成果物と一致しません",
                         "recorded": rec.get("value"), "artifact": actual})
            continue
        want = FORMATS[fmt](actual)
        if want != rec.get("text"):
            mism.append({"id": rid, "reason": "表記が値と一致しません",
                         "recorded": rec.get("text"), "expected": want})
    return {"ok": not mism, "checked": len(ledger["numbers"]), "mismatches": mism}


def same_value(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(a)))
    return a == b


def strip_code(md: str) -> str:
    """コードフェンス/コードスパンを落とす（識別子・時刻・シナリオ名は照合対象外）。"""
    return _CODE_SPAN_RE.sub(" ", _FENCE_RE.sub(" ", md))


def verify_report(report_dir: str | Path, base: str | Path | None = None) -> dict:
    """レポート照合: 台帳の全数値が成果物と一致し、かつ**本文の全数値が台帳にある**。

    2方向で見る — (1) 台帳→成果物（記録した値が本当にそのrunの値か）、
    (2) 本文→台帳（紙に載った数字が1つ残らず台帳にあるか）。片方だけでは
    「台帳に無い数字を本文に足す」捏造を許してしまう。
    """
    d = Path(report_dir)
    npath, rpath = d / NUMBERS_JSON, d / REPORT_MD
    try:
        ledger = json.loads(npath.read_text("utf-8"))
        md = rpath.read_text("utf-8")
    except FileNotFoundError as e:
        raise LabError(f"レポート成果物がありません: {e}") from e
    except json.JSONDecodeError as e:
        raise LabError(f"numbers.json を読めませんでした: {e}") from e

    res = verify_numbers(ledger, base)
    allowed = {rec.get("text") for rec in ledger["numbers"]}
    tokens = _NUM_RE.findall(strip_code(md))
    unbacked = sorted({t for t in tokens if t not in allowed})
    return {
        "ok": bool(res["ok"]) and not unbacked,
        "checked": res["checked"],
        "mismatches": res["mismatches"],
        "unbacked_numbers": unbacked,
        "report": str(rpath),
        "numbers": str(npath),
    }


# --------------------------------------------------------------------------
# 図（matplotlib Agg・日本語フォントは render/fonts.py の既存流儀を再利用）
# --------------------------------------------------------------------------

def _plt():
    import matplotlib
    matplotlib.use("Agg")   # headless
    import matplotlib.pyplot as plt

    from whsim.render.fonts import setup_jp_font
    setup_jp_font()
    return plt


def _short(rid: str) -> str:
    return rid[-9:] if len(rid) > 9 else rid


def _chart_bars(path: Path, cmp: dict, metrics: Sequence[str]) -> Path | None:
    def numeric(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    rows = [r for r in cmp["metrics"]
            if r["metric"] in metrics and any(numeric(v) for v in r["values"].values())]
    if not rows:
        return None
    plt = _plt()
    n = len(rows)
    cols = min(3, n)
    nrows = (n + cols - 1) // cols
    fig, axes = plt.subplots(nrows, cols, figsize=(3.6 * cols, 2.8 * nrows), dpi=140)
    axes = [axes] if n == 1 else list(axes.flat)
    for ax, row in zip(axes, rows):
        # 欠けている指標の run は棒を描かない（0 を描くと「0だった」という
        # 存在しない測定値を図が主張してしまう）。
        pairs = [(r, row["values"][r]) for r in cmp["run_ids"] if numeric(row["values"].get(r))]
        ax.bar([_short(r) for r, _ in pairs], [v for _, v in pairs],
               color=["#4C72B0" if r == cmp["baseline"] else "#DD8452" for r, _ in pairs])
        ax.set_title(row["label"], fontsize=9)
        ax.tick_params(labelsize=7)
        for i, (_r, v) in enumerate(pairs):
            ax.text(i, v, fmt_num(v), ha="center", va="bottom", fontsize=7)
        ax.margins(y=0.25)
    for ax in axes[len(rows):]:
        ax.axis("off")
    fig.suptitle("KPI比較（左＝基準）", fontsize=11)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


def _chart_delta(path: Path, cmp: dict, metrics: Sequence[str]) -> Path | None:
    ids = [r for r in cmp["run_ids"] if r != cmp["baseline"]]
    rows = [r for r in cmp["metrics"] if r["metric"] in metrics
            and any(isinstance(r["pct_change"].get(i), (int, float)) for i in ids)]
    if not ids or not rows:
        return None
    plt = _plt()
    fig, ax = plt.subplots(figsize=(7.2, 0.5 * len(rows) * max(1, len(ids)) + 1.6), dpi=140)
    labels, vals, colors = [], [], []
    for row in rows:
        for rid in ids:
            v = row["pct_change"].get(rid)
            if not isinstance(v, (int, float)):
                continue
            labels.append(f"{row['label']} / {_short(rid)}")
            vals.append(v)
            colors.append("#55A868" if v >= 0 else "#C44E52")
    ax.barh(labels, vals, color=colors)
    ax.axvline(0.0, color="#333333", linewidth=0.8)
    ax.set_xlabel("基準からの変化率（％）", fontsize=9)
    ax.tick_params(labelsize=8)
    for i, v in enumerate(vals):
        ax.text(v, i, f" {fmt_pct(v)}", va="center", fontsize=7)
    ax.margins(x=0.25)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)
    return path


# --------------------------------------------------------------------------
# レポート本体
# --------------------------------------------------------------------------

def _code(v: Any) -> str:
    """識別子・文字列・真偽値はコードスパンで出す（照合対象は本文の数値のみ）。"""
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return "`" + s.replace("`", "'") + "`"


def _edit_cell(led: NumberLedger, rid: str, key: str, value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return led.cite(rid, ["edits", key], SCENARIO_JSON)
    return _code(value)


def generate_report(run_ids: Sequence[str], out_dir: str | Path | None = None,
                    base: str | Path | None = None,
                    metrics: Sequence[str] | None = None) -> dict:
    """複数runの比較レポート（Markdown＋PNG＋numbers.json）を書き出す。

    レポート内の数値は全て :class:`NumberLedger` 経由＝成果物からの転記なので、
    書き出し直後に :func:`verify_report` を回して結果を同梱する（自己照合）。
    """
    ids = [validate_run_id(r) for r in (run_ids or ())]
    if not ids:
        raise LabError("generate_report には run_id を1つ以上渡してください")
    cmp = compare_runs(ids, metrics, base)
    keys = [r["metric"] for r in cmp["metrics"]]
    led = NumberLedger(base)

    report_id = (f"rep{_dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"  # noqa: DTZ005
                 f"-{sim_mod.canonical_hash(ids)[:8]}")
    d = Path(out_dir) if out_dir else runs_dir(base) / "reports" / report_id
    d.mkdir(parents=True, exist_ok=True)

    bl = cmp["baseline"]
    out = io.StringIO()
    w = out.write
    w("# 実験レポート\n\n")
    w(f"生成: {_code(_dt.datetime.now().isoformat(timespec='seconds'))}"  # noqa: DTZ005
      f" / runs: {_code(str(runs_dir(base)))}\n\n")
    w("この文書の数値は全て run成果物（`summary.json` / `scenario.json`）からの"
      "転記です。出所は `numbers.json` に1件ずつ記録され、"
      "`whsim.lab_report.verify_report()` で機械照合できます"
      "（識別子・時刻・シナリオ名はコードスパンで表記＝照合対象外）。\n\n")

    w("## 前提条件\n\n")
    w("| run_id | 名前 | seed | 反復 | 実験時間（秒） | scenario_hash |\n")
    w("|---|---|---|---|---|---|\n")
    for r in cmp["runs"]:
        rid = r["run_id"]
        w(f"| {_code(rid)} | {_code(r['name'] or '（無題）')} "
          f"| {led.cite(rid, ['seed'])} | {led.cite(rid, ['reps'])} "
          f"| {led.cite(rid, ['duration_s'])} "
          f"| {_code((r['scenario_hash'] or '')[:16])} |\n")
    w("\n")
    for rid in ids:
        scen = load_artifact(rid, SCENARIO_JSON, base)
        src = scen.get("model") or scen.get("template") or "ecommerce_small"
        w(f"- {_code(rid)} — モデル: {_code(str(src))}")
        edits = scen.get("edits") or {}
        if edits:
            cells = ", ".join(f"{_code(k)} = {_edit_cell(led, rid, k, v)}"
                              for k, v in edits.items())
            w(f" / 編集: {cells}")
        w("\n")
    w("\n")

    w("## KPI比較\n\n")
    w(f"基準（baseline）: {_code(bl)}\n\n")
    head = " | ".join(_code(_short(r)) for r in ids)
    w(f"| 指標 | {head} | 差（対基準） | 変化率（％） |\n")
    w("|---" * (len(ids) + 3) + "|\n")
    for k in keys:
        row = next(r for r in cmp["metrics"] if r["metric"] == k)
        cells = []
        for rid in ids:
            v = row["values"].get(rid)
            cells.append(led.cite(rid, ["kpis", k]) if isinstance(v, (int, float))
                         and not isinstance(v, bool) else "—")
        others = [r for r in ids if r != bl]
        dcell = " / ".join(
            led.arith("delta", [{"run_id": r, "path": ["kpis", k]},
                                {"run_id": bl, "path": ["kpis", k]}]) for r in others)
        pcell = " / ".join(
            led.arith("pct_change", [{"run_id": r, "path": ["kpis", k]},
                                     {"run_id": bl, "path": ["kpis", k]}], fmt="pct")
            for r in others)
        w(f"| {row['label']} | " + " | ".join(cells)
          + f" | {dcell or '—'} | {pcell or '—'} |\n")
    w("\n")

    w("## 判定（各runのverdict — シミュレータの出力そのまま）\n\n")
    for r in cmp["runs"]:
        w(f"- {_code(r['run_id'])}: {_code(r['verdict'] or '（なし）')}\n")
    w("\n")

    chart_metrics = [k for k in CHART_KPIS if k in keys] or keys[:6]
    images = []
    p1 = _chart_bars(d / KPI_CHART, cmp, chart_metrics)
    if p1:
        images.append(str(p1))
        w("## 図\n\n")
        w(f"![KPI比較]({KPI_CHART})\n\n")
    p2 = _chart_delta(d / DELTA_CHART, cmp, chart_metrics)
    if p2:
        images.append(str(p2))
        w(f"![変化率]({DELTA_CHART})\n\n")

    w("## 数値の出所（追試の手引き）\n\n")
    for rid in ids:
        w(f"- {_code(rid)} — {_code(str(run_dir(rid, base)))}"
          f"（`scenario.json` / `model.json` / `events.jsonl` / `summary.json`）\n")
    w("\n照合: `python -c \"import json,whsim.lab_report as L;"
      f"print(json.dumps(L.verify_report('{d}'),ensure_ascii=False))\"`\n")

    md = out.getvalue()
    (d / REPORT_MD).write_text(md, "utf-8")
    (d / NUMBERS_JSON).write_text(
        json.dumps(led.as_dict(ids, report_id), ensure_ascii=False, indent=2), "utf-8")
    ver = verify_report(d, base)
    return {
        "report_id": report_id,
        "report_dir": str(d),
        "report_path": str(d / REPORT_MD),
        "numbers_path": str(d / NUMBERS_JSON),
        "images": images,
        "run_ids": ids,
        "metrics": keys,
        "verification": ver,
    }


# --------------------------------------------------------------------------
# スイープの結果テーブル（CSV/JSON 永続化）
# --------------------------------------------------------------------------

def write_sweep_table(sweep_dir: str | Path, manifest: dict, rows: Sequence[dict],
                      metrics: Sequence[str] = HEADLINE_KPIS) -> dict:
    """スイープ結果を ``table.csv`` / ``table.json`` / ``index.jsonl`` に永続化。

    CSV は日本語Excelで開けるよう BOM つき（``eventlog`` と同じ流儀）。
    セルの値は各runの summary からの転記のみ。
    """
    d = Path(sweep_dir)
    d.mkdir(parents=True, exist_ok=True)
    params = sorted({k for r in rows for k in (r.get("params") or {})})
    mets = [m for m in metrics
            if any(isinstance((r.get("kpis") or {}).get(m), (int, float)) for r in rows)]

    buf = io.StringIO()
    cw = csv.writer(buf, lineterminator="\n")
    cw.writerow(["case", "status", "run_id", "seed", *params, *mets, "error"])
    for r in rows:
        cw.writerow([
            r.get("case"), r.get("status"), r.get("run_id") or "", r.get("seed"),
            *[json.dumps((r.get("params") or {}).get(p), ensure_ascii=False)
              if isinstance((r.get("params") or {}).get(p), (dict, list)) else
              (r.get("params") or {}).get(p, "") for p in params],
            *[(r.get("kpis") or {}).get(m, "") for m in mets],
            r.get("error") or "",
        ])
    (d / "table.csv").write_text(eventlog.BOM + buf.getvalue(), "utf-8")
    (d / "table.json").write_text(
        json.dumps({"manifest": manifest, "rows": list(rows)},
                   ensure_ascii=False, indent=2), "utf-8")
    with open(d / "index.jsonl", "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps({"case": r.get("case"), "status": r.get("status"),
                                 "run_id": r.get("run_id"), "seed": r.get("seed"),
                                 "params": r.get("params"), "error": r.get("error")},
                                ensure_ascii=False) + "\n")
    (d / "sweep.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    return {"dir": str(d), "table_csv": str(d / "table.csv"),
            "table_json": str(d / "table.json"), "index": str(d / "index.jsonl"),
            "metrics": mets}
