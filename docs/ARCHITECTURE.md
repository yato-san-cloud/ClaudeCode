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
5. **距離の解決順**：`World.dist` = 実測override(`distances.py`) > グラフDijkstra(`engine/graph.py`) > Manhattan。**解析側も同じ通路を歩く**：`analytic.py` は `rackgeom.aisle_detour`（描かれたラック矩形からの閉形式=通路離脱の期待距離 ℓ/3・2d(ℓ-d)/ℓ; 1点分は `aisle_escape_m`）で移動距離を通路経由に補正し、`workmethod.orders_per_trip`（＝エンジンと同一のバッチ規則）で1巡に按分する。**解析とDESが構造的に食い違ってはいけない**（「解析で当てる→DESで裏取り」）。グラフ探索は使わない＝爆速（ドラッグ中の再計算に耐える）。ラック無し＝補正なし＝従来のManhattan。
   一致は **全テンプレート** で測る（`tests/test_analytic_aisle_travel.py`：各 |Δ稼働率| < 0.08 ＋ カタログ平均 < 0.04）。2テンプレートだけ見ていた時、未検査の6つに構造的な穴が隠れていた（GTP +0.808 / ゾーン -0.153 / ウェーブ +0.140 / コンベア +0.090）。**作業方式を足したら、解析側にもその機構を入れる**：
   - **GTP(AGV)** — ピッカーは歩かない（歩行0・inline pack）。台車群は独立のM/M/cで、飽和すると ready_store が枯れてピッカーへの到着率を絞る。`agv_utilization`/`bottleneck` は additive（手動モデルでは `None`）。
   - **バッチ数** — 時間平均 Lq ではない。最初の1件を待たされた＝在庫は空だったので1件しか掃けない。`C(c,a)·rho(1-rho^(cap-1))/(1-rho)`。
   - **ウェーブ窓** — 他のピッカーも重なった窓で同じ到着を取り合うので自己制限的：`B = λ·W`。ゲート待ちは**エンジン側でも** picker busy（オーダーを掴んで拘束されている）。
   - **ゾーン** — 蛇行掃引は入った通路を端まで走るので、通路変更の追加は ℓ/3 ではなく走長 ℓ。
   - **コンベア** — トリップの2脚が非対称（往路=前回の払い出し点から／復路=最寄りベルトまで）。境界点ごとに通路脱出を計上。
6. **replay/render は層状契約（V1/V2/V3）**。keyframe・`shelves`・`navnet` の形は **2Dキャンバス(`app.js` `interp`)と3D(`view3d.js`)の両方**が消費する。コメント「**must match the 3D view**」は厳守。新フィールドは additive＋guard（無ければ legacy 描画にフォールバック）、**古い replay を壊さない**。
   **移動する agent は必ず実経路のキーフレームを出す**。2点だけ出すと viewer が線形補間して棚を突き抜ける——距離と時間が正しく通路経由で計算されていても、絵だけが嘘をつく。この穴は同じ形で4回出た（routing graph / navnet / 動線タブ / AGV）。タイミングを変えずに直せる：`kf()` は時刻を引数で取るので、`processes._route_keyframes` のように**角を後付けの時刻で流し込む**（`env.timeout` は1本のまま＝イベントログも乱数列も不変）。端点は `World.stand` の通路面に置く（ロケーションは棚の芯で採番されるため）。回帰は `tests/test_no_rack_penetration.py`（**ラックを描く全テンプレート**×全 agent 種別＝`workers/helpers/packers/inspectors/forklifts/agvs`）。
7. **ビルドレス / npm 無し / vendored**。フロントは素の ES modules（`<script type="module">` ＋ importmap）。three.js と ECharts は `static/vendor/`（importmap で `three`/`echarts`）。**バンドラや `package.json` を導入しない**。
8. **日本語＝ユーザー向け文字列、英語＝コード/識別子/コメント**。
9. **journey→view 規約**。パネルは `<div id="x" class="panel" role="tabpanel">`、ナビは `journey.js` が描く `.jn-sub[role="tab"]`、`switchView`(`app.js`) がステッパーとパネルを同期。**フラット `.tab` マークアップを復活させない**（CSSは削除済）。
10. **新テンプレ＝データのみ**。`templates/<id>/{template.json,manifest.json}` を足すだけ、**コード変更不要**。
11. **ミラー定数は parity を保つ**。Python↔JS のミラー（`timetable`）は parity テスト有り。新たなミラーも同様に守るか、**一つの源から配る**（例 `/api/racktypes` を fetch）。ハードコピー増殖は禁止。
12. **オプション依存**：web app は `[web]`（fastapi/uvicorn）、CAD/PPTX/PDF は `[docs]`（ezdxf/python-pptx/reportlab）。全部入りは `pip install -e ".[dev,web,docs]"`。
13. **業務フロー＝1つのグラフ (`flowgraph.py`)**。whsim は同じ倉庫を3回別々に記述していた: 工程DAG(`WorkProcess.depends`)・ステージ列(`Process.stages`)・物理設備(`Resources`)。①と②で**共有IDはゼロ**、どちらも③の設備を指せなかったので「梱包はこのベルトで受ける」の置き場が無く、エンジンは**幾何的に最寄りのベルト**を拾うしかなかった（＝フローで人手に変えてもベルトが使われ続けた）。`flowgraph.resolve(model)` が唯一の解決器: ノード=工程(`role`でエンジン挙動に写像、`zone`で床に紐付け)、エッジ=`Process.flow_edges`(`transport`＋`equipment_ref`＝どの実機で運ぶか＋`share`)。**エッジ未作成⇒`depends`が含意していたグラフに解決**するので既存プロジェクトは不変。**部分配線が正常系**: 1本だけ配線しても残りは工程順の派生エッジを保つ。エンジンは `conveyor_ids_in_use()` でベルトをゲートする（`None`=どの工程もコンベアで受けない⇒ベルトは動かさない）。描いただけの設備は「物理的事実」であって「設計の意思」ではない — 意思は `diagnose()` が警告で可視化する(never-blocks)。**設備を足したら、そのエッジ意味論もここに書く**。
14. **荷姿と滞留は解析レイヤ (`loadunit.py` / `wipcurve.py`)**。荷姿カタログは `capacity` の連鎖表現で、混載は**占有率の和** `Σ(count/capacity)`（seed 値では既存の平坦式「(OC＋ケース)÷14」と完全一致＝②基礎物量の数字は不動、テストで固定）。カタログは `catalog(model)` 経由で解決（既定同梱・使う辺でその場編集＝SLC型「資材マスタ先埋め」の逆）。滞留は累積フロー図 `WIP(t)=max(0, Σ上流out − Σ下流out)` を人員ソルバーの `headcount×生産性` から算出。上下流は単位が違う（行/h vs 件/h）ので**日量に対する進捗比**に正規化してから辺の荷姿へ換算する。台車は**共有プール**なので保有台数は各辺ピークの和ではなく**和のピーク**。DES はまだ台車を動かさない（明示的な拡張点）。`capacity` は**「何を」で引く辞書**（`{piece:30}` / `{orikon:14,case:14,tray:14}`）であってスカラーではない — 台車の入数は**その辺の容器で決まる**（「14 オリコン/カゴ台車」か「14 ケース/カゴ台車」か）。UI 側で 1 つの数として読むと 0 になり、1 つの数として書くと同じ台車の他の組が消える。読み書きは `js/materialflow/loadunits.js` の `capacityKey`/`capacityOf`/`withCapacity` に集約し、**換算式は JS で再実装せずサーバの `chain` 文字列をそのまま出す**。
15. **作業工程は単一の源 `staffing.process_master(model)`**。固定 `GENERIC_PROCESSES` を直接 import せず、必ず `process_master`/`process_deps` 経由（モデルの編集済 `process.work_processes` があればそれ、無ければ既定6工程）。これでソルバー/原価/生産性/BI/提案出力が**リネーム・追加・削除に一斉追従**する（完全フリー工程）。新規消費側も同規約を守る（直 import 禁止）。

---

## 2. モジュール地図

### データモデル（中核）
- `schema/model.py` — 正準 `WarehouseModel`。全フィールド default。**ここが土台**。

### 取込 / ETL（寛容）
- `importer.py` — ZIP→subtree deep-merge。`mapcsv.py` / `rmpm.py`（MapMaker地図CSV / ネイティブ.rmpm.json）/ `tabular.py`（汎用CSV/Excel）/ `cad.py`（DXF）。各々 `/api/.../import-*` ルート。
- `distances.py` — 実測 棚間距離行列（最大級ファイル；`engine/graph.py` と距離で概念重複）。
- `rackgeom.py` — **描かれたラック＝ジオメトリの唯一の真実**。`rack_rects`（描画と routing 障害物の共通元; `(x,y,w,h)` であって `(x0,y0,x1,y1)` ではない）＋`aisle_block`/`aisle_detour`/`aisle_escape_m`（通路travel の閉形式＝解析側の補正; `analytic.py` が消費。`aisle_escape_m` は1点分だけを再利用するための切り出し＝ベルト境界点ごとの評価に使う）。
- `provenance.py` — 出所追跡。

### エンジン（SimPy DES）
- `engine/`：`processes.py` / `graph.py`（壁考慮グリッド＋Dijkstra＝**timing権威**）/ `navnet.py`（MapMaker風 Delaunay waypoint網＝**viz層**、facing開放面ピック点）/ `build.py` / `run.py` / `routing.py` / `scenarios.py`（dotted-path what-if）。

### 設計 / 在庫
- `design.py`（`materialize_racks`：parametric/authored shelves→concrete locations、棚名→ロケ名伝播）/ `slotting.py`（ABC割付）/ `datagen.py`（不足生成）/ `racktypes.py`（9種プリセット＝**JS のミラー源**、`/api/racktypes`；台あたり間口/設備単価/償却月の unit economics 付き）。
- `storage.py` — **保管設備の試算**（物量→保管方法→間口/台数/坪数→参考保管費；LOGISTEED 設備費用算出ステップ）＋ `place_equipment`（試算結果を ShelfArea 列として保管ゾーンへ自動配置、`POST /storage/apply-layout`）。
- `layoutaudit.py` — **レイアウト診断**（作図中の設計時バリデーション、純関数・stateless）。`audit(width, depth, wall_segments, obstacles, graph=…)` が ①`unreachable`（開放面＝`navnet.NavNetwork._open_faces`〔`build=False` で Delaunay を建てずに幾何プローブだけ再利用〕が **主連結成分**に着地しない棚＝エンジンが経路を引けない棚と厳密に一致）②`components`（歩行可能床の連結成分。1超＝分断。1ノード島とMIN_POCKET_M2未満はラスタライズ副産物として除外）③`narrow`（棚矩形から**解析的に**測る通路幅。グリッド解像度に非依存。人 1.2m / フォークリフト 2.5m の2閾値・`seam_m` 未満は背中合わせクリアランス扱い・同幅同軸のスパンは1本にマージ）④`deadends`（通行可能隣接が1つだけの袋小路先端）⑤`pick_points`（到達可能な開放面＝人流アニメーションの目的地）＋ `summary`。API は `POST /api/routes/network` に `audit:true` を渡す**加算的**フラグ（AisleGraph の構築コストが支配的なので、通路網の描画とライブ診断で**同じグラフを1回**しか建てない）。retail_dc 規模で診断のみ ~94ms / 通路網込み ~157ms。→ ③設計「レイアウト」の 配置/動線 両タブに常設チップ（`designer/route.js` `_auditSoon`＝`_emitDirty` から 300ms デバウンス、**保存不要**）と canvas オーバレイ（`designer/render.js` `_drawAuditOverlay`）、動線タブの「人流アニメーション」（`_drawPeopleFlow`：入荷→ピック面→出荷を実経路で巡回、`prefers-reduced-motion` では静止プレビュー）。
- ※ `design`/`slotting`/`datagen` は小モジュール群。将来 `design/` パッケージへ統合候補。

### 分析 / BI（2系統）
- `bi.py`（DuckDB **物量集計**：`base_volumes(model, nonworking)` は稼働日で日平均化＝**稼働日カレンダ**（非稼働曜日の物量を稼働日へ振分け）＋`derive_volumes` 仮値派生：パレット/オリコン/カゴ台車の荷姿変換。`bi/apply`→`bi.json`→`timetable/from-bi` が **BI→タイムチャートの橋**）/ `analysis/`（WMSデータ分析：`analyses` `insights` `staffing` `data_io`〔`ITEM_FIELDS`含む〕 `report` `sample` ＋ `ingest.py`＝出荷CSV→model.orders の **ETL**＋`item_master`〔商品マスタ→入数/名前/ABC〕、`POST /import/shipments`〔mapping 返却〕）/ `analytic.py`（M/M/c oracle）/ `kpis.py`（イベント→KPI＋日本語verdict＋`_picker_breakdown` 要素作業分解）/ `timetable.py`（人員タイムチャート、**JSミラー parity test 有り**）/ `workmethod.py`（作業方式は4名統一：シングルオーダー/マルチオーダー/トータル/ゾーン（リレー）。ウェーブは廃し投入は「バッチ」）。
- `analysis/staffing.py` 追補：`process_master`/`process_deps`（編集可能工程の単一源）／`solve_staffing(... batches=)` の**バッチ投入ゲート**（区間先頭工程を着荷曲線で律速、窓外バッチは窓内クランプ＝never-blocks）＋`batch_arrival_curve`。`settings.batch_schedule`={section:[{hour,pct}]} に永続。API：`GET/POST /api/projects/{n}/work-processes`（工程CRUD、未知driverはout_lines矯正）／`GET /timetable/compare`（現在＋保存シナリオを同一物量で再解＝peak人数/総工数/終了/原価/方式の比較、行毎にsolveをガード）。
- `analysis/inventoryopt.py` — **在庫最適化**（安全在庫・発注点；在庫理論）。SKU別の日次需要（観測スパンの**需要ゼロ日を含める**＝σに効く）から μ_d/σ_d を実測から直接求め、正規近似 `SS=z·σ_d·√(LT+R)`／`ROP=μ_d·LT+SS`（定期発注は 目標在庫=μ_d·(LT+R)+SS）。低頻度品（λ=μ_d·(LT+R)<~10）は**ポアソン切替**＝反復 CDF で `S`（scipy不使用）→ SS=S−λ、各行に採用モデル（正規/ポアソン）を明示。合計は全SKU、返却は物量上位500＋`truncated`。`GET /api/projects/{n}/inventory-opt?lead_time=&review=&service_level=`（query のみ・スキーマ非保存・never-blocks）。②分析「物量サマリ」（`js/dataanalysis.js`）にカード。出力は**理論値の注記**（需要の独立性・定常性を仮定＝実績乖離あり）付き。

### レンダ
- `render/`：`replay.py`（**replay契約**）/ `png2d.py` / `shelves.py`（ロケ→棚ラン；authored shelf は1棚=1ラン、name/facing/cell sku-qty 付き）/ `anim2d.py` / `fonts.py` / `heatmap.py`。
- **コンベア作図**：`png2d.belt_points/belt_length/belt_at/belt_band/belt_specs` が帯の純幾何（直線頂点の統合・マイター外形・弧長サンプル）。提案PNGは実幅0.6mの帯＋ローラー刻み＋進行方向の矢羽（`points[0]→points[-1]`）＋排出端記号＋設備タグ（長さ・速度）、凡例「コンベア」と右パネル「搬送設備」に諸元。`anim2d.py` は同じ幾何で帯を静止描画し、replayに `totes` があるときだけ荷物を軌跡で動かす（無ければ従来と1バイト同一）。コンベア無し＝出力不変、退化コンベア（1点/長さ0/NaN）は描かない＝never-blocks。

### エクスポート / Web / 横断
- `export_doc.py`（PPTX+PDF）/ `web/app.py`（FastAPI ~50ルート、**最大ファイル**）/ `cli.py` / `project.py` / `notes.py` / `cody.py`。

### フロント（`app.js` から到達可能な ES modules）
- シェル：`app.js`（bootstrap・`switchView`・2Dキャンバス・mount配線）。抽出済：`state.js`（共有`S`シングルトン）・`imports.js`（取込ハンドラ）・`projectmenu.js`。共有：`util.js`（`$`/`api`/`esc`）・`constants.js`（ラベル/色マップ）。
- 動線：`journey.js`（5フェーズ stepper）・`phasehint.js`・`overview.js`（①取込ホーム＋取込/基本条件）・`onboarding.js`。
- 編集/3D：`designer.js`（ファサード）→`designer/`パッケージ（`core`=クラス本体/状態/座標/入力/undo/保存＋prototype合成、`library/place/render/shelf/flow/route/side`=ミックスインで機能別分割、`constants/geometry`=データ純関数）（ライブラリ&ホットバー型エディタ：配置/フロー/動線の3タブ。配置＝常設オブジェクトライブラリ（棚9種/ゾーン/マテハン設備/躯体のアイコンカード、クリック装備 or 床へD&D、実寸ゴースト、数字1-9はMapMaker互換）＋CAD流の信頼感（1m/5mグリッド・ステータスバー・エッジスナップ・Shift直交壁＋長さ表示・W×D表示・ドアは躯体エッジへ投影）＋統一選択/インスペクタ。動線＝経路ネットワーク自動生成：`POST /api/routes/network`（ステートレス、エンジンと同じ `engine.graph.AisleGraph` で壁・棚を迂回）で通路網表示・A→B計測・工程フロー動線の一括生成、手描きはフォールバック）・`view3d.js`（ファサード/シェル）→`view3d/{constants,geometry,scene,agents,overlay}.js`（three.js・rack_type別リアル形状・人型ピッカー・pick発光・ホバー/追従/選択・preset・ボトルネック強調。prototype合成で機能別分割）。
- 分析/BI：`bianalytics.js` `dataanalysis.js` `bi.js`（**ECharts**描画＝`vendor/echarts`、テーマ追従・toolbox・dispose）・`analysis.js`（KPI・判定）・`storage.js`（③設計「保管設計」：試算つまみ＋レイアウト配置CTA）・`pickrate.js`（③設計「生産性試算」：解析的な動作時間で移動vs仕分け散布図＋推奨、GET /pickrate）。`materialflow.js` は②分析に在籍（基礎物量＝物量作成）で、描画は**ECharts ではなく素の SVG ノードキャンバス**（`materialflow/` パッケージ；サンキーは廃止＝工程を編集できないため）。画面順は 操作バー→**キャンバス**→表→読み取り値（工程→エリア・KPI）→物量カード：キャンバスが主役なので、読み取り値を上に積むと 48vh のステージが折り返しの下へ落ちる。
- ジャーニー写像（SLC壁打ち）：①基礎物量(②分析: materialflow/bi)→②単機能生産性sim(③設計: pickrate=解析・動作時間)→③DES(④検証)。マテリアルフローの工程→エリアは `whsim:flow-changed` でdesigner↔materialflowをライブ同期。designerフロータブの「工程フローからエリアを配置」が工程連鎖を図面へ落とし込む（フロー順に左→右でゾーン自動配置＋割当）。
- **基礎物量チェーン**（②分析→③設計の背骨）：`bi.js` 仮値→`bi/apply`保存→`from-bi`→`whsim:load-timetable`（タイムチャート）；`materialflow.js` は「物量シミュの基礎物量を取込」で同じ from-bi を取り込む。モデル変更後は `whsim:model-changed` イベントで再オープン＋遷移。
- その他：`compare.js` `export.js` `timetable.js`(+`timetable_solver.js`：ソルバーUIに**バッチ投入エディタ**〔便数ステッパー＋比率スライダー＝合計100%自動調整〕・**工程依存DAG**・各工程の物量/生産性インライン＋クリックで設定へジャンプ・**シナリオ保存/比較**) `settings.js` `notes.js` `cody.js`(+`chat.js`)。`materialflow.js` には**完全フリー工程エディタ**（追加/リネーム/並べ替え/削除/依存チップ、`/work-processes` に保存）。

---

## 3. 主要データ契約

### replay（`render/replay.py` → 2D/3D）
- `shelves[]`：authored shelf は **1棚=1ラン** `{x,y0,y1,depth,pitch,rack_type,name,facing,rect,vertical,cells:[{y,abc,sku,qty,name}]}`（parametric は列再構成にフォールバック）。
- `workers[].keyframes`：`[t,x,y,state]`、pick 時のみ任意の5要素目 `hit={run_id,along,sku,qty}`（authored shelf モデルのみ）。**4要素 keyframe は常に有効**。
- `totes[]`：`{id, keyframes:[[t,x,y,state]…]}`＝**荷物そのものの軌跡**。`state ∈ {"carry"(ピッカーの手元)|"belt"(コンベア搬送中)|"pack"(荷降ろし・梱包)}`、丸めは `workers[].keyframes` と同一。コンベア搬送のみ生成（無ければ `[]`）、リプレイ窓内かつ最大 `MAX_TOTE_TRACKS=400` 本。曲がったコンベアは折れ点も keyframe に出るので、線形補間でベルトの経路をなぞれる。
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
