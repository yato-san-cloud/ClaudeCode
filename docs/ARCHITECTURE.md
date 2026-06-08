# whsim アーキテクチャ & 規約（ルールブック）

新しい貢献者（人間/AI）が**最初に読む**ドキュメント。`CLAUDE.md` は要点と作業ルール、本書は**全体地図・不変条件・データ契約・拡張点**を担う。10万行に向けてここを単一の真実とする。

---

## 0. 一枚で言うと

> **すべては唯一の契約 `whsim.schema.WarehouseModel` の上に乗る純関数。**
> 入力はゆるく（営業）、計算は重厚（SimPy DES）。どのモデルも常に valid で実行可能。

```
取込/編集 → WarehouseModel(JSON) → engine(DES) → RunResult → render(replay/png) → 提案
            ↑ schema = 単一契約          ↑ graph/navnet 経路        ↑ 2D/3D 共有契約
```

---

## 1. 不変条件（破ってはいけないルール）

1. **スキーマが唯一の契約**。全コンポーネントは `schema.WarehouseModel` 上の純関数。新しい状態はアドホックな dict でなく**スキーマに足す**（`schema/model.py`）。
2. **全フィールドにデフォルト＝"never blocks"**。どのモデルも常に valid・実行可能。新フィールドは**必ず default を持つ**。新エンドポイントは欠損/部分データで **500 を返さない**。
3. **取込は寛容**。壊れた/非JSONファイルはスキップ（致命的にしない）、部分取込OK。importer 系ルートは parse を `try/except … noqa: BLE001` で包み、フレンドリーな 400 を返す（`web/app.py`）。
4. **provenance は第一級**。各 subtree の出所（imported/interview/provisional/generated）を追跡し「実データN%」として表示（`provenance.py`）。モデル書込み時に飛ばさない。
5. **距離の解決順**：`World.dist` = 実測override(`distances.py`) > グラフDijkstra(`engine/graph.py`) > Manhattan。
6. **replay/render は層状契約（V1/V2/V3）**。keyframe・`shelves`・`navnet` の形は **2Dキャンバス(`app.js` `interp`)と3D(`view3d.js`)の両方**が消費する。コメント「**must match the 3D view**」は厳守。新フィールドは additive＋guard（無ければ legacy 描画にフォールバック）、**古い replay を壊さない**。
7. **ビルドレス / npm 無し / vendored**。フロントは素の ES modules（`<script type="module">` ＋ importmap）。three.js は `static/vendor/`。**バンドラや `package.json` を導入しない**。
8. **日本語＝ユーザー向け文字列、英語＝コード/識別子/コメント**。
9. **journey→view 規約**。パネルは `<div id="x" class="panel" role="tabpanel">`、ナビは `journey.js` が描く `.jn-sub[role="tab"]`、`switchView`(`app.js`) がステッパーとパネルを同期。**フラット `.tab` マークアップを復活させない**（CSSは削除済）。
10. **新テンプレ＝データのみ**。`templates/<id>/{template.json,manifest.json}` を足すだけ、**コード変更不要**。
11. **ミラー定数は parity を保つ**。Python↔JS のミラー（`timetable`）は parity テスト有り。新たなミラーも同様に守るか、**一つの源から配る**（例 `/api/racktypes` を fetch）。ハードコピー増殖は禁止。
12. **オプション依存**：web app は `[web]`（fastapi/uvicorn）、CAD/PPTX/PDF は `[docs]`（ezdxf/python-pptx/reportlab）。全部入りは `pip install -e ".[dev,web,docs]"`。

---

## 2. モジュール地図

### データモデル（中核）
- `schema/model.py` — 正準 `WarehouseModel`。全フィールド default。**ここが土台**。

### 取込 / ETL（寛容）
- `importer.py` — ZIP→subtree deep-merge。`mapcsv.py` / `rmpm.py`（MapMaker地図CSV / ネイティブ.rmpm.json）/ `tabular.py`（汎用CSV/Excel）/ `cad.py`（DXF）。各々 `/api/.../import-*` ルート。
- `distances.py` — 実測 棚間距離行列（最大級ファイル；`engine/graph.py` と距離で概念重複）。
- `provenance.py` — 出所追跡。

### エンジン（SimPy DES）
- `engine/`：`processes.py` / `graph.py`（壁考慮グリッド＋Dijkstra＝**timing権威**）/ `navnet.py`（MapMaker風 Delaunay waypoint網＝**viz層**、facing開放面ピック点）/ `build.py` / `run.py` / `routing.py` / `scenarios.py`（dotted-path what-if）。

### 設計 / 在庫
- `design.py`（`materialize_racks`：parametric/authored shelves→concrete locations、棚名→ロケ名伝播）/ `slotting.py`（ABC割付）/ `datagen.py`（不足生成）/ `racktypes.py`（6種プリセット＝**JS のミラー源**、`/api/racktypes`）。
- ※ `design`/`slotting`/`datagen` は小モジュール群。将来 `design/` パッケージへ統合候補。

### 分析 / BI（2系統）
- `bi.py`（DuckDB **物量集計**）/ `analysis/`（WMSデータ分析：`analyses` `insights` `staffing` `data_io` `report` `sample`）/ `analytic.py`（M/M/c oracle）/ `kpis.py`（イベント→KPI＋日本語verdict）/ `timetable.py`（人員タイムチャート、**JSミラー parity test 有り**）/ `workmethod.py`。

### レンダ
- `render/`：`replay.py`（**replay契約**）/ `png2d.py` / `shelves.py`（ロケ→棚ラン；authored shelf は1棚=1ラン、name/facing/cell sku-qty 付き）/ `anim2d.py` / `fonts.py` / `heatmap.py`。

### エクスポート / Web / 横断
- `export_doc.py`（PPTX+PDF）/ `web/app.py`（FastAPI ~50ルート、**最大ファイル**）/ `cli.py` / `project.py` / `notes.py` / `cody.py`。

### フロント（`app.js` から到達可能な ES modules）
- シェル：`app.js`（bootstrap・2Dキャンバス・`switchView`・全配線）。共有：`util.js`（`$`/`api`/`esc`）・`constants.js`（ラベル/色マップ）。
- 動線：`journey.js`（5フェーズ stepper）・`phasehint.js`・`overview.js`（①取込ホーム＋取込/基本条件）・`onboarding.js`。
- 編集/3D：`designer.js`（**最大**・MapMaker式棚編集＋設備パレット）・`view3d.js`（three.js・rack_type別リアル形状・人型ピッカー・pick発光）。
- 分析/BI：`analysis.js` `bianalytics.js` `dataanalysis.js` `bi.js` `materialflow.js`（**重複多いUI領域**）。
- その他：`compare.js` `export.js` `timetable.js`(+`timetable_solver.js`) `settings.js` `notes.js` `cody.js`(+`chat.js`)。

---

## 3. 主要データ契約

### replay（`render/replay.py` → 2D/3D）
- `shelves[]`：authored shelf は **1棚=1ラン** `{x,y0,y1,depth,pitch,rack_type,name,facing,rect,vertical,cells:[{y,abc,sku,qty,name}]}`（parametric は列再構成にフォールバック）。
- `workers[].keyframes`：`[t,x,y,state]`、pick 時のみ任意の5要素目 `hit={run_id,along,sku,qty}`（authored shelf モデルのみ）。**4要素 keyframe は常に有効**。
- `navnet`：`{waypoints:[[x,y]…], edges:[[i,j]…]}`（形は固定、点だけ改善）。
- 追加フィールドは additive＋guard（無→legacy描画）。

### MapMaker 写像（取込）
- `FreeShelfObject{x,y,w,h,name}` → `ShelfArea`（mm→m、原点平行移動、**Y反転しない**）。`START`/`END` 疑似棚は除外。`WallObject`矩形→中心線。棚名 verbatim 保持＝在庫slot の join キー。

### facing（間口）は「幾何」
- MapMaker は facing を持たない。**開放面＝通路が空いてる面**を幾何導出（`navnet.py`、4辺中点＋外向き0.5m、障害物に当たらない面のみ）。`ShelfArea.facing` は**補助**（一括生成の意図／多面開放時のヒント）。経路は幾何を優先。

---

## 4. 拡張点（足し方）

| やりたいこと | 足す場所 | コード変更 |
|---|---|---|
| 新テンプレ | `templates/<id>/{template,manifest}.json` | 不要 |
| 新しい取込形式 | `whsim/<fmt>.py`（`import_*_bytes`→`{bounds,zones,walls,…}`）＋ `web/app.py` に1ルート | 小 |
| 新しい保管設備 | `racktypes.py` に1エントリ（JSは`/api/racktypes`で自動）＋ `view3d.js` の形状レシピ | 中 |
| 新しいビュー/パネル | `index.html` に `<div id="x" class="panel" role="tabpanel">`＋`js/x.js`＋`journey.js`の PHASES／`switchView` 配線 | 中 |
| 新しい KPI | `kpis.py`（additive・default）＋ `app.js` の KPI 描画 | 小 |
| エンジン挙動 | `engine/processes.py`／`graph.py`。replay 契約を壊さない | 中 |

---

## 5. テスト / 品質

- `python -m pytest -q`（現在 **424 passed**）。`ruff check src`（clean）。フロントは `node --check <file>`（構文）。
- 薄い所：`tabular.py` / `datagen.py`。Python↔JS parity test は `timetable` のみ（他ミラーにも欲しい）。
- 大ファイルは段階的にモジュール分割（`designer.js`/`view3d.js`/`app.js`/`web/app.py`/`export_doc.py`）。**共有ユーティリティ抽出を先に**やってから分割する。

---

## 6. 参考ドキュメント
- `docs/mapmaker-witness-integration.md` — MapMaker×WITNESS統合の設計（M0–M4＋PDCA）。
- `reference/mapmaker/` — 研究用（**製品配布物に同梱しない / 公開リポジトリにしない**）。
