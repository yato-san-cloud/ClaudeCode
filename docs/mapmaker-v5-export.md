# whsim → MapMaker カスタム版 v5.1β 書出し・協調（`whsim.mapmaker_export`）

MapMaker → whsim の**取込**は `rmpm.py` / `mapcsv.py` / `cad.py` / `locmaster.py` が
担ってきた。このドキュメントはその**逆向き** — whsim で設計・試算したものを、
MapMaker を使っている人の机の上に返す4本 — の仕様書。

| # | 関数 | 出力 | MapMaker 側の受け口 |
|---|---|---|---|
| 1 | `shelves_csv(model, floor="1F", origin_mm=(0,0)) -> str` | 棚一覧CSV | ①作図 →「CSVから棚を一括生成」 |
| 2 | `ledger_row_from(model, kind, file)` / `ledger_append(path, row, encoding)` | シナリオ台帳 `ledger.csv` の1行 | ④出力 →「シナリオ台帳を開く…」 |
| 3 | `diagnosis_md(model, kpis) -> str` / `diagnosis_csv(model, kpis) -> str` | 動的系診断 MD / CSV | ③分析 →「一括診断」の **隣に置く1枚** |
| 4 | `travel_diff(model, mapmaker_csv_path, tol_m=5.0, top_n=10) -> dict` | 突き合わせ結果（dict） | ④出力 →「棚別 走行距離一覧をCSVエクスポート」の読み側 |

規約: **依存追加なし**・純関数中心（副作用は `ledger_append` の追記のみ）・
**never blocks**（読めない行は数えて落とし、例外は投げない）。

---

## 0. いちばん大事な前置き — 列名は「推定」である

MapMaker カスタム版 v5.x の 棚一覧CSV / シナリオ台帳 の列定義は改造 jar の中にあり、
`reference/mapmaker/decompiled/` にあるのは **素の v2.0** だけ。素の v2.0 の
`MapCsvExporter` は列見出しを持たない ordinal 形式の *地図CSV*（`0,1,left,top,right,bottom,name,a,r,g,b`）で、
棚一覧CSV とは別物 —— つまり**答えはソースから取れない**。

そこで本モジュールの列名は、次の2つの「確かな断片」から推定している。

1. **実データで確認済み**のロケマスタCSV（`src/whsim/locmaster.py` 冒頭）:
   `エリア,列,棚,段,間口,フルロケ,X_mm,Y_mm,什器種別,什器名,footprint_m2`
   → 日本語見出し、座標は **`_mm` 接尾辞**、面積は `_m2` 接尾辞。
2. **説明書に列挙のある**2つのCSV（列名が本文に書き出されている）:
   - 通路一覧CSV: `フロア,通路の向き,位置X_mm,位置Y_mm,通路幅_mm,長さ_mm,必要幅_mm,判定`
   - 棚別走行距離CSV: `フロア,ロケ,X_mm,Y_mm,走行距離_mm,走行距離_m,近い順位,ゾーン,距離種別`
   → 先頭が `フロア`、座標は `X_mm`/`Y_mm`。

**外していても壊れない作り**にしてある:

- 書出し側（棚一覧CSV）は *取込側が探しそうな列を重複して* 出す
  （座標を `X_mm/Y_mm + 幅_mm/奥行_mm` と `左_mm/上_mm/右_mm/下_mm` の**両方**で）。
- 読取り側（`travel_diff`）は列名**エイリアス**で引く（`ロケ`≡`フルロケ`≡`棚名`、
  `走行距離_m` が無ければ `走行距離_mm` を使う、等）。

---

## 1. 棚一覧CSV — `shelves_csv()`

whsim で組んだレイアウト（テンプレート／逆算配置／取込み後の編集）を、MapMaker で
**編集可能な棚として開き直す**ための道。ここが繋がると「whsim で当たりを付けて、
細部は本家のエディタで詰める」が一往復で回る。

### スキーマ（★＝推定 / ☆＝説明書・実データ由来）

| 列 | 由来 | 値 | 備考 |
|---|---|---|---|
| `フロア` | ☆ 通路一覧CSV・走行距離CSV の先頭列と同じ語 | `"1F"`（既定） | whsim は単一フロア。`floor=` で変更可 |
| `棚名` | ★ | `ShelfArea.name`（無ければ `id`） | **verbatim 保持**。在庫・履歴との join キー |
| `X_mm` `Y_mm` | ☆ ロケマスタ/走行距離CSVと同じ綴り | 矩形の**左上**角 (mm) | |
| `幅_mm` `奥行_mm` | ★ | `w`×1000 / `h`×1000 | |
| `左_mm` `上_mm` `右_mm` `下_mm` | ★（保険列） | MapMaker 内部 `FreeShelfObject{left,top,right,bottom}` に直対応 | `右=左+幅` / `下=上+奥行` を必ず満たす |
| `段数` | ☆「段数・間口数を一括設定」の語 | racktypes プリセットの `levels` | |
| `間口数` | ☆ 同上 | `round(長辺 ÷ 間口ピッチ)`、最低1 | ピッチは `cell_w` 優先、無ければ racktypes の `bay` |
| `什器種別` | ☆ ロケマスタCSVの列 | 中量棚 / パレットラック / ネステナー … | `RACK_TO_GEAR`（`locmaster.GEAR_TO_RACK` の逆写像） |
| `什器名` | ☆ ロケマスタCSVの列 | racktypes の `label` | 什器マスタ登録名とは一致しない（下記仮定 A4） |

### 単位・座標系

- whsim は **m**、MapMaker はネイティブ **mm**（原点左上・+x 右・+y 下）。`×1000` して整数丸め。
- `rmpm.py` の取込は**原点を最小角へ平行移動**する（`sx()`/`sy()`）ので、往復させても
  元図面の絶対座標には戻らない。元に戻したいときは `origin_mm=(minx, miny)` を渡す。
- 非有限値（NaN/inf）は 0 に落とす。素の MapMaker が `Locale.US` 固定でロケール由来の
  CSV 破壊を潰したのと同じ趣旨の防御。

### 文字コード

`shelves_csv()` は**文字列**を返す。ファイルに落とすときは
`shelves_csv(m).encode(mapmaker_export.DEFAULT_ENCODING)` ＝ **BOM 付き UTF-8**。
理由は §2 と共通（下記）。

---

## 2. シナリオ台帳 — `ledger_row_from()` / `ledger_append()`

説明書:「ロケマスタCSV／棚一覧CSV／CAD(DXF)／3D-KPI JSON／一括診断CSV／ナレッジMD を
**実際に出力したときだけ**、日時・ファイル・フロア数・棚数・有効ロケ数・ネス基数・
面積・操作種別 の1行が自動で追記されます」。
whsim 側の「人が外に出すと決めた案」も同じ1枚に積む。

### スキーマ

| 列 | 由来 | whsim の値 |
|---|---|---|
| `日時` | ☆ 説明書の列挙順そのまま | `YYYY-MM-DD HH:MM:SS`（ローカル壁時計。★書式は推定） |
| `ファイル` | ☆ | 実際に出したファイル名／パス（引数） |
| `フロア数` | ☆ | 常に `1`（whsim は単一フロアモデル） |
| `棚数` | ☆ | 保管ゾーンの `ShelfArea` 数 |
| `有効ロケ数` | ☆ | `len(model.locations)`（★仮定 A2） |
| `ネス基数` | ☆ | ネステナー棚の Σ(段数 × 間口数)（★仮定 A3） |
| `面積` | ☆（単位は★） | `bounds.width × bounds.depth`（**m²**） |
| `操作種別` | ☆ | `whsim実行` / `whsim出力` / `whsim棚一覧CSV` / `whsim動的診断` |

操作種別は定数で公開: `KIND_RUN` `KIND_EXPORT` `KIND_SHELVES_CSV` `KIND_DIAGNOSIS`。
MapMaker 本体が書く「棚一覧CSV」等と一目で区別できる語に寄せてある。

### 保存先

説明書の既定は `%USERPROFILE%\MapMakerシナリオ台帳\ledger.csv`。
**このモジュールはその既定パスを持たない** —— `ledger_append(path, ...)` は
パスを引数で受ける（whsim は Linux/コンテナでも回るため）。MapMaker の既定に
合わせたいときは呼び出し側で組む:

```python
os.path.join(os.path.expanduser("~"), "MapMakerシナリオ台帳", "ledger.csv")
```

### 文字コード — なぜ BOM 付き UTF-8 か

説明書は台帳・通路一覧CSV・走行距離CSVのいずれにも
**「Excelでそのまま開けます」「Excelでそのまま開ける文字コードです」**と書く。
一方、素の MapMaker v2.0 の `MapCsvExporter` は
`private static final String ENCODING = "UTF-8"`（**BOM 無し**）。
しかしそれは列見出しを持たない数値だけの地図CSVで、**日本語を1文字も含まない**。

日本語見出しの CSV を BOM 無し UTF-8 で書くと、日本語版 Excel はダブルクリック時に
CP932 と誤認して文字化けする＝「そのまま開ける」を満たさない。よって改造版は
**(a) BOM 付き UTF-8** か **(b) CP932** のどちらか。Java 側の実装コストは
(a) が「先頭に `﻿` を1文字足すだけ」で圧倒的に小さく、既定 charset にも
環境依存文字にも影響されない。→ **既定は `utf-8-sig`（`DEFAULT_ENCODING`）**。

(b) だった場合に備えて `ledger_append(..., encoding="cp932")` で切替可能。
CP932 で表現できない文字（絵文字・環境依存字）は `errors="replace"` で潰す
——台帳が1行も残らないより、1文字化けても行が残る方が良い。

### 追記の作法

- 新規なら親ディレクトリごと作り、**ヘッダを書いてから**1行目。BOM は先頭1回だけ
  （2行目以降は素の `utf-8` で追記するので BOM が行頭に挿さらない）。
- 既にファイルがあれば **既存ヘッダの列順に合わせて**書く。MapMaker 本体が作った
  台帳に whsim が列順違いの行を混ぜて壊すのを防ぐ（未知の列は空欄）。
- 書けない（権限・ディスク・文字コード）ときは **`False` を返すだけ**。
  記録の失敗が本体の仕事を止めてはいけない。

---

## 3. 動的系診断 — `diagnosis_md()` / `diagnosis_csv()`

MapMaker の**一括診断**（収納力・什器集計・面積・キューブ利用率・通路幅一覧・
棚別走行距離）は **器の診断**＝静的。whsim が足せるのは **動的系**＝人とモノが動いた
ときに何件捌けるか。2枚を並べて読めるようにするのがこの出力。

### 指標名は必ず `動的系:` を冠する

一括診断の語彙（収納力／キューブ利用率／面積／通路幅）と**同名衝突・意味衝突**を
起こさないため。Excel で片方の列だけコピーされても出所が分かる。

| 指標（CSV の `指標` 列 / MD の表） | 出所 | 単位 |
|---|---|---|
| `動的系:判定` | `analytic.estimate.overloaded` | ✓ 捌ける / ⚠ 捌けない |
| `動的系:ボトルネック` | `analytic.estimate.bottleneck_jp` | |
| `動的系:ピッカー稼働率` / `動的系:梱包稼働率` / `動的系:AGV稼働率` | `analytic.estimate` | % |
| `動的系:歩行距離` | `analytic.estimate.walk_m_per_order` | m/件 |
| `動的系:能力` / `動的系:需要` | `capacity_orders_per_hr` / `offered_orders_per_hr` | 件/h |
| `動的系:1トリップ件数` | `orders_per_trip` | 件 |
| `動的系:スループット(DES)` ほか `(DES)` 系 | `kpis.compute`（引数 `kpis` を渡したときだけ） | |

### 計算前提を必ず併記する（MapMaker と同じ流儀）

説明書:「計算前提（パレット寸法・天井有効高など）は結果にも**必ず併記**されるので、
数字だけが独り歩きしません」。ナレッジMDも「どの規約で数えたかが必ず本文に入る」。
これに合わせ、MD は `## 計算前提` 節、CSV は **同じ表の `区分=計算前提` 行**として出す
（別ファイルに切ると、数字だけコピーされて前提が置き去りになる）。

併記する前提: 歩行速度 / 梱包時間 / 作業方法（5軸＋導出名）/ 1トリップ集約 /
人員（ピッカー・梱包台）/ シミュレーション時間 / 需要（実オーダー or プロファイル）/
**距離の測り方**（経路グラフ or マンハッタン）/ ロケ数 / 面積 / 試行回数 /
指標の出所（解析のみ or ＋DES）/ **静的指標の扱い**（本表には含まない、一括診断が正）。

### CSV スキーマ

`区分,指標,値,単位` の4列。`区分` は `動的系` か `計算前提`。

---

## 4. 走行距離の突き合わせ — `travel_diff()`（幾何ゲート）

**幾何が食い違ったまま DES を回しても、出てくる数字は全部嘘。** だからこれは
動的シミュレーションの**前**に置くゲート。

- 入力: MapMaker の **棚別走行距離CSV**（説明書の列
  `フロア,ロケ,X_mm,Y_mm,走行距離_mm,走行距離_m,近い順位,ゾーン,距離種別`）。
- whsim 側の距離は**既存の距離計算をそのまま**使う ——
  `engine.graph.AisleGraph.from_model(model).distance(起点, 棚)`
  （壁・棚を避ける最短路。障害物ゼロのモデルでは同クラスが Manhattan に落ちるので、
  結果の `distance_source` で `"graph"` / `"manhattan"` が分かる）。
- 起点は `resources.stations[0]`（`analytic.estimate` と同じ選び方 ＝ MapMaker の
  「検品場／START 起点」に対応）。
- 突き合わせは**ロケ単位**。`ロケ` 列 → `Location.name` / `.address` / `.id` →
  `ShelfArea.name` の順に引き、見つからなければ `locmaster.normalize_loc()` で
  **棚粒度**（`AAA-00-02-3-08` → `AAA-00-02`）に落として再照合する。
  これは locmaster が実データで見つけた「図面は棚粒度、マスタは間口粒度」問題と
  同じ対処。

### 戻り値

```python
{"matched": int, "unmatched": int, "skipped_rows": int, "csv_rows": int,
 "mean_abs_diff_m": float, "median_abs_diff_m": float, "max_abs_diff_m": float,
 "mean_rel_diff_pct": float, "within_tol": int, "ok": bool, "tol_m": float,
 "distance_source": "graph" | "manhattan", "origin_m": (x, y),
 "top": [{"loc","mapmaker_m","whsim_m","diff_m","rel_pct"}, ...],   # 乖離降順
 "warnings": [str]}
```

`ok` は **突き合わせできた棚の 9 割が `tol_m` 以内**なら `True`。
`False` のときは「取込・原点・通路の抜けを確認してから DES を回せ」という警告が入る。

never blocks: ファイルが無い／空／列違い／行が壊れている、いずれも `warnings` に
積んで数えて落とす（例外は投げない）。

---

## 5. 仮定した列名・定義の一覧（**MapMaker 作者が答え合わせする用**）

`○` を付けるか、正しい値を右端に書いて返してもらえれば、そのまま直せる。

### 5.1 棚一覧CSV の列

| # | whsim が出す列名 | 確度 | 正しい列名は？ |
|---|---|---|---|
| C1 | `フロア` | 中（他CSVの先頭列と同じ語） | |
| C2 | `棚名` | 低（`ロケ` / `ロケ番号` / `名前` かも） | |
| C3 | `X_mm` / `Y_mm` | 高（実データのロケマスタと一致） | |
| C4 | `幅_mm` / `奥行_mm` | 低（`W_mm`/`D_mm`、`幅`/`奥行` かも） | |
| C5 | `左_mm` / `上_mm` / `右_mm` / `下_mm` | 低（保険列。内部 `left/top/right/bottom` に対応） | |
| C6 | `段数` / `間口数` | 中（機能名がその語） | |
| C7 | `什器種別` / `什器名` | 高（実データのロケマスタと一致） | |
| C8 | 列の**順序** | 低 | |
| C9 | ヘッダ行の**有無** | 中（「Excelで表を作ってそのまま流し込み」＝ヘッダ有りと解釈） | |

### 5.2 シナリオ台帳の列

| # | whsim が出す列名 | 確度 | 正しい列名は？ |
|---|---|---|---|
| L1 | `日時` `ファイル` `フロア数` `棚数` `有効ロケ数` `ネス基数` `面積` `操作種別` | 高（説明書の列挙そのまま） | |
| L2 | 列の**順序** = 上の並び | 中（説明書の読点順に従った） | |
| L3 | `日時` の書式 `YYYY-MM-DD HH:MM:SS` | 低（`yyyy/MM/dd HH:mm` かも） | |
| L4 | `面積` の単位 = **m²** | 中（`㎡` / `坪` / `_m2` 接尾辞かも） | |
| L5 | `ファイル` = ファイル名のみ / フルパス | 低 | |
| L6 | 文字コード = **BOM 付き UTF-8** | 中（CP932 の可能性あり → §2 の根拠） | |
| L7 | 改行 = CRLF | 中 | |

### 5.3 値の定義（whsim 側の当てはめ）

| # | 項目 | whsim の定義 | 確度 |
|---|---|---|---|
| A1 | 棚数 | 保管ゾーンの `ShelfArea` の数 | 高 |
| A2 | 有効ロケ数 | `len(model.locations)`。whsim に「未使用間口・段」の概念が無いので、materialize されたロケ＝有効ロケ | 中 |
| A3 | ネス基数 | ネステナー棚の Σ(段数 × 間口数)。説明書の検算式「有効ロケ − ネス基数 ＝ 間口数」から *1段=1基* と読んだ | **低** |
| A4 | 什器名 | racktypes の `label`（「中量棚」等）。MapMaker の什器マスタ登録名（「中量棚1800x600」等）とは**一致しない** | 低 |
| A5 | 間口数 | `round(棚の長辺 ÷ 間口ピッチ)`、最低1 | 中 |
| A6 | 段数 | racktypes プリセットの `levels`（棚ごとの上書きは未対応） | 中 |
| A7 | 走行距離の起点 | `resources.stations[0]`（＝検品場/START 相当） | 中 |
| A8 | 走行距離の種別 | 「距離種別」列は読むが**比較には使っていない**（経路距離のみ突合） | — |

---

## 6. CLI 配線の提案 diff（**未適用**）

`src/whsim/cli.py` は取込側エージェントの担当のため、このブランチでは**編集していない**。
以下は適用候補。`whsim mapmaker <project> --out DIR` の1コマンドで、
棚一覧CSV・動的診断MD/CSV を書き、シナリオ台帳に1行足し、（あれば）走行距離CSVと
突き合わせるところまでを一往復で回す。

```diff
--- a/src/whsim/cli.py
+++ b/src/whsim/cli.py
@@ 末尾の simulate() の後ろ、`if __name__ == "__main__":` の手前に追加
     out = render_png(model, heat, metrics, proj.load_provenance().summary(),
                      run_dir / "layout_heatmap.png")
     typer.echo("verdict: " + metrics["verdict"])
     typer.echo(f"png -> {out}")
+
+
+@app.command("mapmaker")
+def mapmaker(
+    name: str,
+    out: Path = typer.Option(Path("."), "--out", "-o",
+                             help="書出し先ディレクトリ"),
+    ledger: Path = typer.Option(None, "--ledger",
+                                help="シナリオ台帳 ledger.csv のパス（既定: 書かない）"),
+    travel_csv: Path = typer.Option(None, "--travel-csv",
+                                    help="MapMaker の棚別走行距離CSV（幾何ゲート）"),
+    tol_m: float = typer.Option(5.0, "--tol-m", help="幾何ゲートの許容差 (m)"),
+):
+    """MapMaker カスタム版 v5.1β へ書き出す（棚一覧CSV・動的診断・台帳・幾何ゲート）。
+
+    docs/mapmaker-v5-export.md 参照。列名は推定を含むので、MapMaker 側で
+    読めなかったら同ドキュメントの「仮定した列名の一覧」を突き合わせること。
+    """
+    from whsim import mapmaker_export as mx
+
+    proj = _open_project(name)
+    model = proj.load_model()
+    out.mkdir(parents=True, exist_ok=True)
+
+    # 0. 幾何ゲート — 図面が食い違ったまま動的な数字を出しても意味が無い
+    if travel_csv is not None:
+        diff = mx.travel_diff(model, str(travel_csv), tol_m=tol_m)
+        typer.echo(f"幾何ゲート: {'OK' if diff['ok'] else 'NG'} "
+                   f"(突合 {diff['matched']} 棚 / 平均乖離 {diff['mean_abs_diff_m']} m "
+                   f"/ 最大 {diff['max_abs_diff_m']} m / 距離={diff['distance_source']})")
+        for d in diff["top"][:5]:
+            typer.echo(f"  乖離 {d['diff_m']:+.1f} m  {d['loc']} "
+                       f"(MapMaker {d['mapmaker_m']} / whsim {d['whsim_m']})")
+        for w in diff["warnings"]:
+            typer.echo(f"  ! {w}")
+
+    # 1. 棚一覧CSV — MapMaker で編集可能な棚として開き直せる形
+    shelves = out / f"棚一覧_{name}.csv"
+    shelves.write_bytes(mx.shelves_csv(model).encode(mx.DEFAULT_ENCODING))
+    typer.echo(f"棚一覧CSV -> {shelves}")
+
+    # 2. 動的診断 — 一括診断の隣に置く1枚（計算前提を必ず併記）
+    kpis = None
+    run_dir = proj.latest_run_dir()
+    if run_dir is not None and (run_dir / "kpis.json").exists():
+        kpis = json.loads((run_dir / "kpis.json").read_text("utf-8"))
+    md = out / f"動的診断_{name}.md"
+    md.write_text(mx.diagnosis_md(model, kpis), "utf-8")
+    csv_out = out / f"動的診断_{name}.csv"
+    csv_out.write_bytes(mx.diagnosis_csv(model, kpis).encode(mx.DEFAULT_ENCODING))
+    typer.echo(f"動的診断 -> {md} / {csv_out}")
+
+    # 3. シナリオ台帳 — 「人が外に出すと決めた案」だけを1行残す
+    if ledger is not None:
+        for path_out, kind in ((shelves, mx.KIND_SHELVES_CSV),
+                               (md, mx.KIND_DIAGNOSIS)):
+            row = mx.ledger_row_from(model, kind, path_out.name)
+            if not mx.ledger_append(str(ledger), row):
+                typer.echo(f"  ! 台帳に書けませんでした: {ledger}", err=True)
+        typer.echo(f"シナリオ台帳 -> {ledger}")
 
 
 if __name__ == "__main__":
     app()
```

`Project.latest_run_dir()`（`src/whsim/project.py:232`）と `json` / `Path` / `typer` は
`cli.py` に既にあるので、追加 import は不要。`mapmaker_export` は関数内で遅延 import
しているので、CLI の起動コストにも影響しない。

Web 側に載せるなら `web/routes/` に新規モジュール（`exports_mapmaker.py` 等）を足し、
`GET /api/projects/{id}/mapmaker/shelves.csv` などを生やすのが素直
——`imports.py` は取込側の担当なので触らない。

---

## 7. テスト

`tests/test_mapmaker_export.py`（19 本）。**合成モデル＋合成CSVのみ**で、
実顧客データは1バイトも持ち込んでいない。

主な確認点:

- 棚一覧CSV: m→mm、ロケ名 verbatim、`右=左+幅`/`下=上+奥行` の整合、
  什器種別の写像、棚ゼロでもヘッダだけ返す、NaN 棚は数えて落とす、`origin_mm` 復元。
- 台帳: 説明書の列が揃う、BOM は先頭1回だけ、2回目はヘッダを重ねない、
  **他人（MapMaker本体）のヘッダに列順を合わせる**、書けなければ `False`、
  CP932 で表現できない字でも1行残る。
- 診断: `## 計算前提` が必ず出る、指標は全部 `動的系:` 冠、静的指標を指標として載せない、
  CSV も同じ表に前提を持つ、DES KPI を渡すと `(DES)` 行が増える。
- 幾何ゲート: 一致すれば `ok=True`／食い違えば `ok=False`、乖離上位は降順、
  棚粒度 join（`AAA-01-01-3-08` → `AAA-01-01`）、読めない行・未一致行を数える、
  CP932 かつ `走行距離_m` 列が無い CSV も読む、壊れた入力でも例外を投げない。
