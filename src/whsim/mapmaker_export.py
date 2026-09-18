"""MapMaker カスタム版 v5.1β への **書出し・協調** レイヤ（whsim → MapMaker）。

取込（MapMaker → whsim）は `rmpm.py` / `mapcsv.py` / `cad.py` / `locmaster.py` が
担当してきた。逆向き — whsim で設計・シミュレーションした結果を、MapMaker を
使っている人の作業机の上に返す道 — が無かった。このモジュールがその4本を敷く。

1. :func:`shelves_csv` — whsim の棚を MapMaker「CSVから棚を一括生成」が読める
   **棚一覧CSV** に。whsim のテンプレート／逆算配置を MapMaker で *編集可能な棚*
   として開き直せる（＝設計の続きを本家のエディタでやれる）。
2. :func:`ledger_row_from` / :func:`ledger_append` — MapMaker の **シナリオ台帳**
   （`ledger.csv`）に whsim の実行・出力を1行追記する。「あの案、いつ何を出した
   っけ」の答えを MapMaker 側と *同じ1枚* に集める。
3. :func:`diagnosis_md` / :func:`diagnosis_csv` — MapMaker の**一括診断**（収納力・
   什器集計・面積・キューブ利用率＝静的な器の話）と並べて読める「whsim 側の診断」
   ＝**動的系**（判定・稼働率・歩行m/件・スループット）。MapMaker と同じ流儀で
   **計算前提を必ず本文に併記**する。
4. :func:`travel_diff` — MapMaker の **棚別走行距離CSV** を読み、whsim の経路グラフ
   距離とロケ単位で突き合わせる。幾何が食い違ったまま DES を回しても意味が無い
   ので、動的シミュレーションの**前に置くゲート**。

規約（whsim ハウススタイル）:

* **依存追加なし**・純関数中心（副作用は :func:`ledger_append` のファイル追記のみ）。
* **never blocks**: 読めない行・欠けたフィールドは *数えて落とす*。例外を投げて
  呼び出し側を止めない。部分的な結果は正常で、有用。
* 実顧客データはテストに持ち込まない（合成モデル＋合成CSV）。

---

**列名について（重要）**: MapMaker カスタム版 v5.x の 棚一覧CSV / シナリオ台帳 は
コンパイル済みの改造 jar 側にあり、`reference/mapmaker/decompiled/` にあるのは
*素の v2.0*（`MapCsvExporter` は列名を持たない ordinal 形式の地図CSV）だけ。
よって本モジュールの列名は

* 実データで確認済みの ロケマスタCSV（`locmaster.py` 冒頭 —
  `エリア,列,棚,段,間口,フルロケ,X_mm,Y_mm,什器種別,什器名,footprint_m2`）と
* 説明書に列挙のある 通路一覧CSV / 棚別走行距離CSV（`_mm` 接尾辞・日本語見出し）

から **推定** している。答え合わせ用の一覧は `docs/mapmaker-v5-export.md`。
推定を外していても壊れないよう、書出し側は *取込側が探しそうな列を重複して* 出し
（座標は `X_mm/Y_mm/幅_mm/奥行_mm` と `左_mm/上_mm/右_mm/下_mm` の両方）、読取り側
（:func:`travel_diff`）は列名エイリアスで引く。
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import math
import os

from whsim import racktypes

# --- 文字コード -------------------------------------------------------------
# 説明書は棚一覧CSV・通路一覧CSV・走行距離CSV・シナリオ台帳のいずれにも
# 「Excelでそのまま開ける文字コードです」「Excelでそのまま開けます」と書く。
# 素の MapMaker v2.0 の MapCsvExporter は BOM 無し UTF-8 固定
# (`private static final String ENCODING = "UTF-8"`) だが、それは列見出しを持たない
# 数値だけの地図CSVで、日本語を1文字も含まない。日本語見出しの CSV を BOM 無し
# UTF-8 で書くと日本語版 Excel はダブルクリック時に CP932 と誤認して文字化けする
# ＝「そのまま開ける」を満たさない。したがって改造版は
#   (a) BOM 付き UTF-8 か (b) CP932
# のどちらかのはずで、Java 側で `﻿` を1文字先頭に足すだけで済む (a) を既定と
# する（Java の既定 charset に依存せず、絵文字・環境依存文字でも落ちない）。
# CP932 だった場合に備えて `encoding=` で切替可能にしてある（CP932 は表現できない
# 文字があるので errors="replace" 相当の運用が要る — ledger_append 参照）。
DEFAULT_ENCODING = "utf-8-sig"

# CRLF: Excel と Windows 版 MapMaker が相手。csv.writer の既定に合わせる。
_NEWLINE = "\r\n"


# --- 1. 棚一覧CSV -----------------------------------------------------------
# 推定スキーマ。座標系は MapMaker ネイティブ（mm・原点左上・+x 右 / +y 下）で、
# whsim 側の m をそのまま ×1000 する（rmpm.py の取込が原点を平行移動しているので、
# 元図面の絶対座標には戻らない —— `origin_mm` で戻せる。docs 参照）。
SHELF_CSV_COLUMNS: tuple[str, ...] = (
    "フロア",
    "棚名",
    "X_mm",
    "Y_mm",
    "幅_mm",
    "奥行_mm",
    "左_mm",
    "上_mm",
    "右_mm",
    "下_mm",
    "段数",
    "間口数",
    "什器種別",
    "什器名",
)

# whsim racktypes id → MapMaker 什器種別（locmaster.GEAR_TO_RACK の逆写像。
# 1対多の側は代表値を選ぶ）。
RACK_TO_GEAR: dict[str, str] = {
    "light": "軽量棚",
    "medium": "中量棚",
    "pallet": "パレットラック",
    "nestainer": "ネステナー",
    "flow": "フローラック",
    "mobile": "移動ラック",
    "mezzanine": "メザニン",
    "hanger": "ハンガー",
    "asrs": "自動倉庫",
}


def _mm(v: float) -> int:
    """m → mm（整数）。非有限値は 0 に落とす（DXF/CSV を壊さないための防御）。"""
    try:
        f = float(v) * 1000.0
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(f):
        return 0
    return round(f)


def _run_name(run, index: int) -> str:
    """Shelf name for a run: authored name > the cells' shared location name > R{i}.

    A reconstructed run has no name of its own, but the Locations standing in it
    do (``materialize_racks`` propagates the shelf name down), and that name is
    the join key against 在庫・出荷履歴 — so it must survive the round trip even
    when the racking was parametric rather than hand-drawn.
    """
    name = str(run.get("name") or "").strip()
    if name:
        return name
    counts: dict[str, int] = {}
    for cell in (run.get("cells") or []):
        cn = str(cell.get("name") or "").strip()
        if cn:
            counts[cn] = counts.get(cn, 0) + 1
    if counts:
        best = max(counts, key=lambda k: counts[k])
        # Only a name the cells SHARE names the shelf. `materialize_racks` and the
        # ロケマスタ path both give every slot in one shelf the same name, so a
        # majority is the normal case — but if the slots carry per-slot names
        # instead, picking one of them would label the whole run after a single
        # location. Fall back to a positional id rather than mislabel.
        if counts[best] * 2 >= sum(counts.values()):
            return best
    return f"R{index + 1:03d}"


def _shelf_rows(model, floor: str = "1F", origin_mm: tuple[float, float] = (0.0, 0.0)):
    """描かれた棚を1行ずつ。

    幾何は `render.shelves.shelf_runs` から採る —— **描かれたラック＝ジオメトリの
    唯一の真実**（`rackgeom` と同じ元）なので、手置きの `ShelfArea` でも、ゾーンの
    パラメトリックなラック定義でも、同じ矩形が出る。ここで `zone.shelves` だけを
    読むと、テンプレート由来（＝パラメトリック）のモデルが棚0件の CSV になり、
    「whsim で設計したレイアウトを MapMaker で開き直す」という道が塞がる。
    """
    ox, oy = float(origin_mm[0]), float(origin_mm[1])
    try:
        from whsim.render.shelves import shelf_runs
        runs = shelf_runs(model) or []
    except Exception:  # noqa: BLE001 — never blocks: 幾何が読めなければ棚0件
        runs = []
    from whsim.rackgeom import run_rect
    for i, run in enumerate(runs):
        try:
            rect = run_rect(run)
        except (TypeError, ValueError, KeyError, AttributeError):
            continue  # never blocks: 座標が読めない棚は落とす
        if rect is None:
            continue
        x, y, w, h = rect
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            continue
        rtid = str(run.get("rack_type") or racktypes.DEFAULT)
        rt = racktypes.get(rtid)
        # 段数は什器プリセットの levels。間口数は「棚の長辺 ÷ 間口ピッチ」＝
        # MapMaker の 段数・間口数一括設定 が持つのと同じ2値。
        bay = float(run.get("pitch") or rt.get("bay", 1.2) or 1.2)
        long_side = max(w, h)
        faces = max(1, round(long_side / bay)) if bay > 0 else 1
        left, top = ox + _mm(x), oy + _mm(y)
        yield {
            "フロア": floor,
            "棚名": _run_name(run, i),
            "X_mm": int(left),
            "Y_mm": int(top),
            "幅_mm": _mm(w),
            "奥行_mm": _mm(h),
            "左_mm": int(left),
            "上_mm": int(top),
            "右_mm": int(left + _mm(w)),
            "下_mm": int(top + _mm(h)),
            "段数": int(rt.get("levels", 1) or 1),
            "間口数": faces,
            "什器種別": RACK_TO_GEAR.get(rtid, "中量棚"),
            "什器名": str(rt.get("label", "") or ""),
        }


def shelves_csv(model, floor: str = "1F",
                origin_mm: tuple[float, float] = (0.0, 0.0)) -> str:
    """whsim の棚を MapMaker「CSVから棚を一括生成」向けの **棚一覧CSV** 文字列に。

    * 単位は mm（whsim は m、MapMaker はネイティブ mm）。
    * **ロケ名は verbatim 保持** — 棚名は在庫・履歴との join キーなので、丸めたり
      詰め直したりしない（`docs/mapmaker-witness-integration.md` §7）。
    * `origin_mm` は元図面の原点オフセット。`rmpm.py` の取込は最小角へ平行移動して
      しまうので、元の絶対座標に戻したいときだけ与える（既定 0 = whsim 座標のまま）。

    返すのは文字列。バイト列が要るときは
    ``shelves_csv(m).encode(DEFAULT_ENCODING)`` で良い（BOM はここで付く）。
    棚が1枚も無いモデルでもヘッダだけの CSV を返す（空文字列を返して呼び出し側を
    分岐させない）。
    """
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(SHELF_CSV_COLUMNS),
                       lineterminator=_NEWLINE, extrasaction="ignore")
    w.writeheader()
    for row in _shelf_rows(model, floor=floor, origin_mm=origin_mm):
        w.writerow(row)
    return buf.getvalue()


# --- 2. シナリオ台帳 --------------------------------------------------------
# 説明書:「日時・ファイル・フロア数・棚数・有効ロケ数・ネス基数・面積・操作種別 の
# 1行が自動で追記されます」。列順は説明書の列挙順そのまま。
LEDGER_COLUMNS: tuple[str, ...] = (
    "日時", "ファイル", "フロア数", "棚数", "有効ロケ数", "ネス基数", "面積", "操作種別",
)

# 操作種別。MapMaker 側は「ロケマスタCSV」「棚一覧CSV」「CAD(DXF)」等を書くので、
# whsim 由来の行は一目で分かる語に寄せる（台帳を混ぜても出所が追える）。
KIND_RUN = "whsim実行"          # DES を回した
KIND_EXPORT = "whsim出力"        # 何かを書き出した
KIND_SHELVES_CSV = "whsim棚一覧CSV"
KIND_DIAGNOSIS = "whsim動的診断"


def _shelf_areas(model) -> list:
    """Hand-authored `ShelfArea` objects (may be empty on a parametric model)."""
    out = []
    layout = getattr(model, "layout", None)
    for z in (getattr(layout, "zones", []) or []) if layout is not None else []:
        if getattr(z, "type", None) == "storage":
            out.extend(getattr(z, "shelves", None) or [])
    return out


def _shelf_count(model) -> int:
    """棚数 — **棚一覧CSV と同じ数え方**（`_shelf_rows` の行数）。

    台帳の「棚数」と同時に出す CSV の行数が食い違うと、同じ倉庫の話をしている
    2枚が別の warehouse を指しているように読める。数える口を1つにしておく。
    """
    return sum(1 for _ in _shelf_rows(model))


def _nestainer_units(model) -> int:
    """ネス基数 ＝ ネステナーの「基」の総数（段数 × 間口数 の合計）。

    MapMaker の検算式「有効ロケ−ネス基数＝間口数」（説明書 v4.9 段数表示）は
    ネステナーを *1段=1基* と数える運用を示す。whsim には基の実体が無いので、
    ネステナー棚の 段数×間口数 を積む —— 仮定であることは docs に明記。
    """
    total = 0
    for row in _shelf_rows(model):
        if row.get("什器種別") != "ネステナー":
            continue
        total += int(row.get("間口数") or 0) * int(row.get("段数") or 0)
    return total


def _floor_area_m2(model) -> float:
    try:
        b = model.layout.bounds
        return round(float(b.width) * float(b.depth), 1)
    except (AttributeError, TypeError, ValueError):
        return 0.0


def ledger_row_from(model, kind: str = KIND_EXPORT, file: str = "",
                    now: _dt.datetime | None = None) -> dict:
    """モデルから台帳1行を組む（純関数。ファイルには触らない）。

    `kind` は操作種別（:data:`KIND_RUN` などを推奨、任意文字列も可）。`file` は
    実際に出したファイル名／パス。`now` はテスト用の時刻注入。

    * フロア数: whsim は単一フロアモデルなので常に 1。
    * 棚数: 棚一覧CSV と同じ行数（描かれた棚。パラメトリックなラックも含む）。
    * 有効ロケ数: `model.locations` の数（未使用指定の概念が whsim に無いので、
      materialize されたロケ＝有効ロケ）。
    * ネス基数: :func:`_nestainer_units` 参照。
    * 面積: 建屋 `bounds.width × bounds.depth`（m²）。
    """
    # 台帳の日時は PC のローカル壁時計（MapMaker 本体が書く行と揃える）。
    ts = (now or _dt.datetime.now()).strftime("%Y-%m-%d %H:%M:%S")  # noqa: DTZ005
    return {
        "日時": ts,
        "ファイル": str(file or ""),
        "フロア数": 1,
        "棚数": _shelf_count(model),
        "有効ロケ数": len(getattr(model, "locations", []) or []),
        "ネス基数": _nestainer_units(model),
        "面積": _floor_area_m2(model),
        "操作種別": str(kind or ""),
    }


def _existing_header(path: str, encoding: str) -> list[str] | None:
    """既存 ledger.csv の1行目を列名として読む（読めなければ None）。"""
    try:
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            return None
    except OSError:
        return None
    for enc in (encoding, "utf-8-sig", "cp932", "utf-8"):
        try:
            with open(path, encoding=enc, newline="") as fh:
                first = fh.readline()
        except (OSError, UnicodeDecodeError, LookupError):
            continue
        if not first.strip():
            return None
        cols = next(csv.reader([first.rstrip("\r\n")]), [])
        cols = [c.strip() for c in cols if c.strip()]
        return cols or None
    return None


def ledger_append(path: str, row: dict, encoding: str = DEFAULT_ENCODING) -> bool:
    """シナリオ台帳 `ledger.csv` に1行追記する。追記できたら True。

    * **パスは引数**。`%USERPROFILE%\\MapMakerシナリオ台帳\\ledger.csv` という
      Windows 既定への依存はここには持ち込まない（whsim は Linux でも回る）。
      MapMaker の既定に合わせたいときは呼び出し側でそのパスを組む。
    * ファイルが無ければ親ディレクトリごと作り、**ヘッダを書いてから**追記する。
      既にある場合は **既存のヘッダの列順に合わせて**書く（MapMaker 本体が書いた
      台帳に whsim が列順違いの行を混ぜて壊す、を避ける。未知の列は空欄）。
    * never blocks: 書けない（権限・ディスク・文字コード）ときは False を返すだけ
      で例外は投げない。台帳は記録であって、記録に失敗しても本体の仕事は続く。
    """
    try:
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        header = _existing_header(path, encoding)
        new_file = header is None
        cols = list(header or LEDGER_COLUMNS)
        # BOM は先頭1回だけ。追記時に utf-8-sig を使うと行頭に BOM が挿さるので、
        # 2行目以降は素の utf-8 で書く。
        enc = encoding if new_file else ("utf-8" if encoding == "utf-8-sig" else encoding)
        # CP932 に無い文字（絵文字・環境依存字）で台帳が書けなくなるのは本末転倒。
        _utf8ish = enc.lower().replace("_", "-") in ("utf-8", "utf-8-sig")
        errors = "strict" if _utf8ish else "replace"
        with open(path, "a", encoding=enc, errors=errors, newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, lineterminator=_NEWLINE,
                               extrasaction="ignore", restval="")
            if new_file:
                w.writeheader()
            w.writerow({k: row.get(k, "") for k in cols})
        return True
    except (OSError, UnicodeEncodeError, LookupError, TypeError, ValueError):
        return False


# --- 3. 動的診断（一括診断の隣に置く1枚） -----------------------------------
# 指標名の頭に必ず「動的系:」を付ける。MapMaker の一括診断は 収納力・什器集計・
# 面積・キューブ利用率・通路幅・棚別走行距離 ＝ *静的な器* の語彙で、そこに
# 「稼働率」「スループット」を素の名前で混ぜると同名衝突・意味衝突が起きる。
_DYN = "動的系"


def _fmt(v, nd: int = 2) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "はい" if v else "いいえ"
    if isinstance(v, (int,)):
        return f"{v:,}"
    if isinstance(v, float):
        if not math.isfinite(v):
            return "-"
        return f"{v:,.{nd}f}"
    return str(v)


def _assumptions(model, kpis: dict | None) -> list[tuple[str, str]]:
    """**計算前提** — 何を仮定して上の数字が出たか。MapMaker の流儀に合わせ、
    出力物には必ずこれを併記する（数字だけが独り歩きしないように）。"""
    out: list[tuple[str, str]] = []
    try:
        proc = model.process
        out.append(("歩行速度", f"{float(proc.walk_speed_mps):.2f} m/s"))
        out.append(("梱包時間", f"{float(proc.pack_time_s):.0f} s/件"))
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        from whsim.workmethod import method_name, orders_per_trip
        work = model.process.effective_work()
        out.append(("作業方法", (
            f"{method_name(work)}"
            f"（搬送={work.transport} / まとめ={work.orders_per_trip}件"
            f" / ゾーン={work.zoning} / 採り方={work.consolidation}"
            f" / 投入={work.release}）")))
        out.append(("1トリップ集約", f"{orders_per_trip(model)} 件"))
    except Exception:  # noqa: BLE001, S110 — 前提の1行が欠けても診断は出す
        pass
    try:
        pickers = sum(w.count for w in model.resources.workers if w.role == "picker")
        stations = sum(max(0, s.count) for s in model.resources.stations)
        out.append(("人員", f"ピッカー {pickers} 名 / 梱包台 {stations} 台"))
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        out.append(("シミュレーション時間", f"{float(model.simulation.duration_s) / 3600:.1f} h"))
    except (AttributeError, TypeError, ValueError):
        pass
    if getattr(model, "orders", None) is not None and getattr(model.orders, "outbound", None):
        out.append(("需要", f"実オーダー {len(model.orders.outbound):,} 件を投入"))
    else:
        try:
            p = model.orders.profile
            out.append(("需要", (
                f"プロファイル生成 {float(p.rate_per_hr):.0f} 件/h"
                f" × ピーク係数 {float(p.peak_factor):.2f}"
                f"（平均 {float(p.lines_per_order_mean):.1f} 行/件）")))
        except (AttributeError, TypeError, ValueError):
            pass
    out.append(("距離の測り方", _distance_note(model)))
    out.append(("ロケ数", f"{len(getattr(model, 'locations', []) or []):,}"))
    out.append(("面積", f"{_floor_area_m2(model):,.1f} m²（建屋 bounds）"))
    if kpis:
        reps = kpis.get("replications")
        if reps:
            out.append(("試行回数", f"{reps} 回の平均"))
    out.append(("指標の出所",
                "解析（analytic.estimate, M/M/c 閉形式）"
                + ("＋DES（kpis.compute）" if kpis else "のみ — DES 未実行")))
    out.append(("静的指標の扱い", (
        "収納力・什器集計・面積・キューブ利用率・通路幅は本表に含まない"
        "（MapMaker の一括診断が正）")))
    return out


def _distance_note(model) -> str:
    """距離を何で測ったか（経路グラフ or マンハッタン）を1行で。"""
    try:
        from whsim.engine.graph import AisleGraph
        g = AisleGraph.from_model(model)
        if g.enabled:
            return "経路グラフ（壁・棚を避ける最短路 / engine.graph.AisleGraph）"
    except Exception:  # noqa: BLE001, S110 — 測れなければ既定の説明に落とす
        pass
    return "マンハッタン距離（障害物なし＝経路グラフ無効）"


def _dynamic_metrics(model, kpis: dict | None) -> list[tuple[str, str, str]]:
    """(指標, 値, 単位) の列。指標名は必ず ``動的系:`` 接頭辞つき。"""
    rows: list[tuple[str, str, str]] = []
    est: dict = {}
    try:
        from whsim import analytic
        est = analytic.estimate(model) or {}
    except Exception:  # noqa: BLE001 — 解析が落ちても DES 側だけで出す
        est = {}

    if est:
        overloaded = bool(est.get("overloaded"))
        rows.append((f"{_DYN}:判定", "⚠ 捌けない" if overloaded else "✓ 捌ける", ""))
        rows.append((f"{_DYN}:ボトルネック", str(est.get("bottleneck_jp") or "-"), ""))
        rows.append((f"{_DYN}:ピッカー稼働率",
                     _fmt(_pct100(est.get("picker_utilization")), 1), "%"))
        if est.get("packer_utilization") is not None:
            rows.append((f"{_DYN}:梱包稼働率",
                         _fmt(_pct100(est.get("packer_utilization")), 1), "%"))
        if est.get("agv_utilization") is not None:
            rows.append((f"{_DYN}:AGV稼働率",
                         _fmt(_pct100(est.get("agv_utilization")), 1), "%"))
        rows.append((f"{_DYN}:歩行距離", _fmt(est.get("walk_m_per_order"), 1), "m/件"))
        rows.append((f"{_DYN}:能力", _fmt(est.get("capacity_orders_per_hr"), 1), "件/h"))
        rows.append((f"{_DYN}:需要", _fmt(est.get("offered_orders_per_hr"), 1), "件/h"))
        rows.append((f"{_DYN}:1トリップ件数", _fmt(est.get("orders_per_trip"), 2), "件"))

    if kpis:
        rows.append((f"{_DYN}:スループット(DES)", _fmt(kpis.get("throughput_per_hr"), 1), "件/h"))
        rows.append((f"{_DYN}:完了率(DES)",
                     _fmt(_pct100(kpis.get("completion_rate")), 1), "%"))
        rows.append((f"{_DYN}:ピッカー稼働率(DES)",
                     _fmt(_pct100(kpis.get("picker_utilization")), 1), "%"))
        rows.append((f"{_DYN}:歩行距離(DES)", _fmt(kpis.get("walk_per_order_m"), 1), "m/件"))
        rows.append((f"{_DYN}:サイクルタイム(DES)", _fmt(kpis.get("cycle_mean_s"), 1), "s"))
        if kpis.get("verdict"):
            rows.append((f"{_DYN}:所見(DES)", str(kpis.get("verdict")), ""))
    return rows


def _pct100(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f * 100.0 if math.isfinite(f) else None


def diagnosis_md(model, kpis: dict | None = None, title: str = "") -> str:
    """**動的系診断** を Markdown で。MapMaker の一括診断MD／ナレッジMD の隣に置く。

    MapMaker と同じ流儀で **計算前提を必ず本文に併記** する（説明書:「計算前提は
    結果にも必ず併記されるので、数字だけが独り歩きしません」）。指標名は
    ``動的系:`` を冠して、一括診断の 収納力・キューブ利用率 等と衝突させない。

    `kpis` は :func:`whsim.kpis.compute` の戻り（省略可 — 解析だけでも1枚出る）。
    """
    name = title or getattr(getattr(model, "meta", None), "name", "") or "untitled"
    lines: list[str] = []
    lines.append(f"# whsim 動的診断 — {name}")
    lines.append("")
    lines.append("> MapMaker の**一括診断**（収納力・什器集計・面積・キューブ利用率・"
                 "通路幅・棚別走行距離）は *器* の診断。この表はその隣に置く "
                 "**動的系** ＝ 人とモノが動いたときに何件捌けるか、の診断です。"
                 "指標名が重ならないよう、すべて `動的系:` を冠しています。")
    lines.append("")
    lines.append("## 指標")
    lines.append("")
    lines.append("| 指標 | 値 | 単位 |")
    lines.append("|---|---:|---|")
    metrics = _dynamic_metrics(model, kpis)
    if not metrics:
        lines.append("| （算出できませんでした） | - | |")
    for k, v, u in metrics:
        lines.append(f"| {k} | {v} | {u} |")
    lines.append("")
    lines.append("## 計算前提")
    lines.append("")
    lines.append("この表の数字は、下の前提の上でだけ成り立ちます。前提が変われば数字も"
                 "変わります。**数字を引用するときは、必ずこの節ごと引用してください。**")
    lines.append("")
    lines.append("| 前提 | 値 |")
    lines.append("|---|---|")
    for k, v in _assumptions(model, kpis):
        lines.append(f"| {k} | {v} |")
    lines.append("")
    return "\n".join(lines) + "\n"


def diagnosis_csv(model, kpis: dict | None = None) -> str:
    """同じ内容を CSV（Excel向け）で。列＝ ``区分,指標,値,単位``。

    **計算前提も同じ表に** ``区分=計算前提`` の行として載る —— 別ファイルに分けると
    数字だけがコピーされて前提が置き去りになるため（一括診断CSVと同じ思想）。
    """
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator=_NEWLINE)
    w.writerow(["区分", "指標", "値", "単位"])
    for k, v, u in _dynamic_metrics(model, kpis):
        w.writerow([_DYN, k, v, u])
    for k, v in _assumptions(model, kpis):
        w.writerow(["計算前提", k, v, ""])
    return buf.getvalue()


# --- 4. 棚別走行距離CSV の突き合わせ（幾何ゲート） ---------------------------
# 説明書の列: フロア,ロケ,X_mm,Y_mm,走行距離_mm,走行距離_m,近い順位,ゾーン,距離種別
TRAVEL_CSV_COLUMNS: tuple[str, ...] = (
    "フロア", "ロケ", "X_mm", "Y_mm", "走行距離_mm", "走行距離_m", "近い順位", "ゾーン", "距離種別",
)

# 列名エイリアス（NFKC 畳み込み＋小文字化して照合）。取込側の寛容さはここでも同じ。
_TRAVEL_ALIASES: dict[str, tuple[str, ...]] = {
    "floor": ("フロア", "階", "floor"),
    "loc": ("ロケ", "ロケーション", "フルロケ", "棚名", "location", "loc"),
    "x": ("x_mm", "位置x_mm", "x", "xmm"),
    "y": ("y_mm", "位置y_mm", "y", "ymm"),
    "dist_mm": ("走行距離_mm", "距離_mm", "distance_mm"),
    "dist_m": ("走行距離_m", "距離_m", "distance_m"),
    "rank": ("近い順位", "順位", "rank"),
    "zone": ("ゾーン", "zone", "abc"),
    "kind": ("距離種別", "種別", "distance_type"),
}

_DECODINGS = ("utf-8-sig", "utf-8", "cp932", "shift_jis", "latin-1")


def _decode(data: bytes) -> str:
    for enc in _DECODINGS:
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("latin-1", "replace")


def _fold(s: object) -> str:
    import unicodedata
    return unicodedata.normalize("NFKC", str(s)).strip().lower().replace(" ", "")


def _num(v) -> float | None:
    try:
        f = float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _depot(model) -> tuple[float, float]:
    """I/O 起点。MapMaker の走行距離は検品場(START)起点なので、whsim も
    `resources.stations[0]` を採る（analytic.estimate と同じ選び方）。"""
    try:
        st = model.resources.stations[0]
        return (float(st.x), float(st.y))
    except (AttributeError, IndexError, TypeError, ValueError):
        return (0.0, 0.0)


def _model_points(model) -> dict[str, tuple[float, float]]:
    """ロケ名（正規化キー）→ 代表座標(m)。

    棚(ShelfArea)は中心、ロケ(Location)は自身の座標。MapMaker の走行距離CSVは
    *棚単位*（ロケ番号 = 棚名）で出るので、まず Location、無ければ ShelfArea で
    引けるように両方を積む（`locmaster.normalize_loc` と同じ棚粒度の正規化キーも
    別名として張り、`AAA-00-02-1-08` ↔ `AAA-00-02` のズレを吸収する）。
    """
    pts: dict[str, tuple[float, float]] = {}

    def put(key: object, xy: tuple[float, float]) -> None:
        k = _fold(key)
        if k and k not in pts:
            pts[k] = xy

    for sh in _shelf_areas(model):
        try:
            xy = (float(sh.x) + float(sh.w) / 2.0, float(sh.y) + float(sh.h) / 2.0)
        except (TypeError, ValueError, AttributeError):
            continue
        nm = (getattr(sh, "name", "") or "").strip()
        if nm:
            put(nm, xy)
    for loc in (getattr(model, "locations", []) or []):
        try:
            xy = (float(loc.x), float(loc.y))
        except (TypeError, ValueError, AttributeError):
            continue
        for key in ((getattr(loc, "name", "") or "").strip(),
                    (getattr(loc, "address", "") or "").strip(),
                    (getattr(loc, "id", "") or "").strip()):
            if key:
                put(key, xy)

    # 棚粒度の別名（AAA-00-02-01-01 → AAA-00-02）。既存キーは上書きしない。
    try:
        from whsim.locmaster import normalize_loc
    except Exception:  # noqa: BLE001
        return pts
    for key in list(pts):
        short = normalize_loc(key)
        if short:
            put(short, pts[key])
    return pts


def _lookup(pts: dict, raw: str) -> tuple[float, float] | None:
    k = _fold(raw)
    if k in pts:
        return pts[k]
    try:
        from whsim.locmaster import normalize_loc
    except Exception:  # noqa: BLE001
        return None
    short = normalize_loc(raw)
    if short:
        return pts.get(_fold(short))
    return None


def travel_diff(model, mapmaker_csv_path: str, tol_m: float = 5.0,
                top_n: int = 10) -> dict:
    """MapMaker の **棚別走行距離CSV** と whsim の経路距離を *ロケ単位* で突き合わせる。

    幾何（棚の位置・通路の抜け）が両者で一致していなければ、その先の動的
    シミュレーションは何を出しても信用できない。だからこれは DES の**前**に置く
    ゲートで、返すのは「合っているか」と「どこがズレているか」。

    距離は whsim の既存の距離計算をそのまま使う ——
    ``engine.graph.AisleGraph.from_model(model).distance(起点, 棚)``（壁・棚を避ける
    最短路）。障害物が無いモデルでは同クラスが Manhattan に落ちるので、結果の
    ``distance_source`` で どちらで測ったかが分かる。

    Returns::

        {"matched": int, "unmatched": int, "skipped_rows": int, "csv_rows": int,
         "mean_abs_diff_m": float, "max_abs_diff_m": float,
         "mean_rel_diff_pct": float, "median_abs_diff_m": float,
         "within_tol": int, "ok": bool, "tol_m": float,
         "distance_source": "graph"|"manhattan", "origin_m": (x, y),
         "top": [{"loc","mapmaker_m","whsim_m","diff_m","rel_pct"}, ...],
         "warnings": [str]}

    never blocks: ファイルが読めない・列が無い・行が壊れている、いずれも
    ``warnings`` に積んで **数えて落とす**。例外は投げない。
    """
    out: dict = {
        "matched": 0, "unmatched": 0, "skipped_rows": 0, "csv_rows": 0,
        "mean_abs_diff_m": 0.0, "max_abs_diff_m": 0.0, "mean_rel_diff_pct": 0.0,
        "median_abs_diff_m": 0.0, "within_tol": 0, "ok": False,
        "tol_m": float(tol_m), "distance_source": "manhattan",
        "origin_m": _depot(model), "top": [], "warnings": [],
    }
    try:
        with open(mapmaker_csv_path, "rb") as fh:
            text = _decode(fh.read())
    except OSError as e:
        out["warnings"].append(f"CSV を読めませんでした: {e}")
        return out

    rows = list(csv.reader(io.StringIO(text, newline="")))
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        out["warnings"].append("空の CSV です。")
        return out

    head = [_fold(c) for c in rows[0]]
    idx: dict[str, int] = {}
    for key, names in _TRAVEL_ALIASES.items():
        folded = {_fold(n) for n in names}
        for i, h in enumerate(head):
            if h in folded:
                idx[key] = i
                break
    if "loc" not in idx or not ("dist_m" in idx or "dist_mm" in idx):
        out["warnings"].append(
            "ロケ列 / 走行距離列が見つかりません（想定ヘッダ: "
            + ",".join(TRAVEL_CSV_COLUMNS) + "）。")
        return out

    # 距離エンジン。グラフが有効なら壁・棚を避ける最短路、無効なら Manhattan。
    dist_fn = None
    try:
        from whsim.engine.graph import AisleGraph
        g = AisleGraph.from_model(model)
        if g.enabled:
            dist_fn = g.distance
            out["distance_source"] = "graph"
    except Exception as e:  # noqa: BLE001 — 距離が測れなくても診断は返す
        out["warnings"].append(f"経路グラフを構築できませんでした（Manhattan で代用）: {e}")
    if dist_fn is None:
        from whsim.engine.routing import manhattan
        dist_fn = manhattan

    pts = _model_points(model)
    origin = _depot(model)
    diffs: list[tuple[float, dict]] = []
    rels: list[float] = []

    for raw in rows[1:]:
        out["csv_rows"] += 1
        try:
            loc = (raw[idx["loc"]] or "").strip()
        except IndexError:
            out["skipped_rows"] += 1
            continue
        if not loc:
            out["skipped_rows"] += 1
            continue
        mm_m = None
        if "dist_m" in idx and idx["dist_m"] < len(raw):
            mm_m = _num(raw[idx["dist_m"]])
        if mm_m is None and "dist_mm" in idx and idx["dist_mm"] < len(raw):
            v = _num(raw[idx["dist_mm"]])
            mm_m = v / 1000.0 if v is not None else None
        if mm_m is None:
            out["skipped_rows"] += 1
            continue
        xy = _lookup(pts, loc)
        if xy is None:
            out["unmatched"] += 1
            continue
        try:
            wh_m = float(dist_fn(origin, xy))
        except Exception:  # noqa: BLE001
            out["skipped_rows"] += 1
            continue
        if not math.isfinite(wh_m):
            out["skipped_rows"] += 1
            continue
        d = wh_m - mm_m
        rel = (abs(d) / mm_m * 100.0) if mm_m > 1e-9 else 0.0
        rels.append(rel)
        diffs.append((abs(d), {
            "loc": loc,
            "mapmaker_m": round(mm_m, 2),
            "whsim_m": round(wh_m, 2),
            "diff_m": round(d, 2),
            "rel_pct": round(rel, 1),
        }))

    out["matched"] = len(diffs)
    if not diffs:
        out["warnings"].append(
            "突き合わせできた行がありません（ロケ名が図面の棚名と一致していますか）。")
        return out

    absd = sorted(a for a, _ in diffs)
    out["mean_abs_diff_m"] = round(sum(absd) / len(absd), 2)
    out["max_abs_diff_m"] = round(absd[-1], 2)
    out["median_abs_diff_m"] = round(absd[len(absd) // 2], 2)
    out["mean_rel_diff_pct"] = round(sum(rels) / len(rels), 1) if rels else 0.0
    out["within_tol"] = sum(1 for a in absd if a <= tol_m)
    # ゲート判定: 突き合わせできた棚の 9 割が許容差以内なら「幾何は合っている」。
    out["ok"] = out["within_tol"] >= 0.9 * len(absd)
    diffs.sort(key=lambda t: -t[0])
    out["top"] = [d for _, d in diffs[: max(0, int(top_n))]]
    if out["unmatched"]:
        out["warnings"].append(
            f"CSV の {out['unmatched']} 行はモデル側に同名のロケ／棚がありません。")
    if out["skipped_rows"]:
        out["warnings"].append(f"読めない行を {out['skipped_rows']} 件落としました。")
    if not out["ok"]:
        out["warnings"].append(
            f"幾何が一致していません（許容 {tol_m:g} m 以内は "
            f"{out['within_tol']}/{len(absd)} 棚）。DES を回す前にレイアウトの"
            "取込・原点・通路の抜けを確認してください。")
    return out
