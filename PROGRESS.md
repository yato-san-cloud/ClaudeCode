# WHSiM 格上げラン PROGRESS

元指示: WHSIM_UPGRADE_PROMPT.md（アップロード）。受け入れ基準(DoD)1〜6を満たす。
コンテキストが切れたらまずこれを読む。

## 前提の齟齬（最初に確定した判断）

指示書は React＋純TS＋GeoJSON を前提に書かれているが、**このリポジトリは
Python/SimPy エンジン＋FastAPI＋ビルドレス vanilla JS**（ARCHITECTURE 不変条件7:
npm/バンドラ禁止）。指示書自身が「フレームワーク移行はスコープ外」「既存資産を
流用し壊さない」「リポジトリを調査し実体を特定してから着手」と言っているので、
**受け入れ基準1〜6（全てスタック非依存の挙動）を実スタックで満たす**。
「純TSモジュール/Web Worker」は満たさない（＝フレームワーク移行そのもの）。
最終サマリに明記する。

## 既存資産と DoD の対応（調査済み・証拠つき）

| DoD | 既存 | ギャップ |
|---|---|---|
| 1 経路拘束 | engine/graph.py（壁・棚を避ける通路グラフ+Dijkstra）、tests/test_no_rack_penetration.py（全テンプレ×全agent種でキーフレーム貫通0） | 実行時常時アサーション（run_replications 内）が無い |
| 2 干渉 | **無し**（搬送体はすり抜ける） | 通路セル=容量付きリソース、待機イベント、待機時間KPI |
| 3 ログ由来KPI | kpis.py が res.events の集計のみ（表示JSはAPIの値を出すだけ） | イベントの CSV/JSON エクスポートが無い。表示リテラルの機械監査が無い |
| 4 ルーティング比較 | nearest(NN) と optimized(picktour 2-opt) は実装済。zone は蛇行 | **s_shape / return は Literal だけで実装ゼロ。largest_gap は不存在**。4方式比較表も無い |
| 5 再現性 | simulation.random_seed、rep毎に固定シード | 「同一seed→イベント列完全一致」の直接テストが無い |
| 6 シナリオJSON | engine/scenarios.py apply_scenario（dotted-path編集）+ run_scenario | 台数/ルーティング/干渉/レイアウトの切替をシナリオだけで行うテストが無い |

D5(what-if I/F): scenarios.run_scenario がほぼ該当。diff→実行→サマリの薄い関数を確認/追加。

## 実装分担（opus5 サブエージェント、ファイル所有分離）

- **Agent R**: `src/whsim/engine/pickroute.py`（新規: s_shape/return/largest_gap の
  訪問順序、純関数）+ `src/whsim/routecompare.py`（新規: 同一オーダーセット×4方式の
  距離比較表）+ `tests/test_pickroute_policies.py`（手計算一致）。
  契約: `pickroute.route_order(policy: str, start: (x,y), pts: [(x,y)]) -> list[int]`
  （通路構造は pts の x クラスタから導出。rack 依存なし）。
- **Agent I**: 通路干渉（`simulation.aisle_interference` フラグ、既定 False=バイト同一）
  processes.py/_walk セル毎の方向つき容量1リソース・待機イベント `aisle_wait`・
  タイムアウト脱出（デッドロック不可能化）・kpis.py 渋滞ブロック・
  run.py 実行時貫通アサーション（常時）＋ events.jsonl 保存＋CSV/JSONエクスポート・
  `tests/test_aisle_interference.py`（2台1セル wait>0、M/M/1 Lq 突合、既定OFFバイト同一）。
- **統合(私)**: schema（RoutingPolicy に largest_gap/optimized 追加、
  Simulation.aisle_interference）、processes._route_order のディスパッチ配線、
  シナリオ切替テスト、再現性テスト、what-if I/F、表示リテラル監査、docs、
  D単位コミット、**fresh opus 監査（DoD1〜6のみ渡す）→不合格修正**、最終サマリ。

## 決定事項

- 干渉は**既定OFF**（既存モデル・カタログpinはバイト同一を維持）。ONはシナリオJSONで。
- 干渉の待機は「同一セル同一方向」の容量1（離合は通路幅で可能と仮定）。
  待ちすぎ（3×通過時間）で強制通過＋ログ（never-blocks、リングのグリッドロック回避）。
- 解析オラクルは干渉・非既定ルーティングを**まだ映さない**（既定が不変なので
  カタログpinは不変）。既知の制限として最終サマリに書く。
- ルーティング比較表そのものが閉形式の距離出力（比較はDES不要で爆速）。

## 残タスク

- [x] 統合側の独立分: schema配線（RoutingPolicy拡張・aisle_interference）、
  build の model→World ルーティング配線（test_picktour 更新済 10 passed）、
  scenarios.whatif（D5）、tests/test_scenario_reproducibility.py（DoD5/6, 6 passed）、
  tests/test_display_kpi_literals.py（DoD3機械監査, 2 passed — 実リテラル0件、
  仕込み違反の検出対照つき）
- [x] Agent R 実装完了: pickroute/routecompare/17テスト（手計算一致:
  S字70m・折返し102m・最大ギャップ70m・2-opt66m）
- [x] Agent I 実装完了: 干渉（OFFバイト同一をリテラル固定・M/M/1 Lq誤差1.3%・
  4台リング追走で完走）・実行時貫通検査（12〜16万kfで0.3s未満）・events.jsonl/CSV
- [x] 配線・統合: /routecompare・/runs/{run}/events.{jsonl,json,csv}・
  whsim routecompare・E2E確認（TestClient）。干渉のシナリオdiff起動を実測
  （待機237回・top_cells出力）
- [x] 全テスト 1117 passed。lint: 新規ファイル0件・変更ファイル正味削減
  （残りはzip慣用句=家風とHEAD既存分）
- [x] コミット: 26d6485 (D1-D3), e82238e (D4-D6) — push済み
- [x] fresh opus 監査 完了。判定: 基準2/4/5 合格、6 合格(AGV除く)、1 条件付き、
  3 留保つき。特筆: 監査官が Held-Karp 厳密DPで 2-opt の66mが真の最適と独立確認。
- [x] 監査指摘の修正（エンジン側）:
  1. unroutable_legs を rep 単位で RunResult→KPI→判定文へ（縮退した移動は
     もう黙らない）。「構造的に不可能」の主張は「グラフ由来の脚は構成上エッジ上
     ＋縮退はKPIで開示＋録画分は貫通検査＋全テンプレのオフラインpin」の4点で担保。
  2. eventlog.dump_all: 全レプリケーションのログを保存（events.jsonl=rep0 名は
     不変、events_repNN.jsonl 追加）→ 出荷KPI(平均)が出荷ログから再導出可能に。
  3. AGV が routing_policy に追従（明示 policy のみ分岐・既定はNNバイト同一、
     spy テストで固定）。tests/test_audit_fixups.py 4 passed。
- [x] 監査指摘の修正（UI側）: ④検証「通路の混雑」セクション（待ち合計/共有率/
  p95/回数/強制通過＋最混雑通路トップ3を床座標で）、path_violations/unroutable の
  危険コールアウト、工程別平均待ちの実測表示（値ゼロ時は1px も変えない —
  ヘッドレスで実証）。ピック順序ビューに「経路方式比較」テーブル＋採用ボタン
  （既存 /apply 経路で process.routing_policy に1フィールド書込み）。
- [x] コミット c5126ad（修正一式、1121 passed）
- [x] 再監査完了: **全6基準合格**。監査官は本物の縮退レイアウト（床を仕切る壁）を
  自作して delta の正しさまで確認（3repで[20,10,10]、累積でない）、AGVは全方式で
  走行距離・稼働率が動くことまで実測。
- [x] 再監査の残留3件のうち2件を即修正: 強制通過カードの丸め矛盾（端数は1桁表示）、
  per-rep ログの API 配信（events.{fmt}?rep=N、存在しないrepは404）。
- [x] 残る既知の制限（受け入れ可否に影響しないと監査官判定）:
  1. 「グラフが棚を見ていない」失敗経路の貫通検査は録画窓サンプリングのまま
     （縮退経路は100%検出に昇格済み。全テンプレはオフラインpinで全量検査）。
  2. 解析オラクルは干渉・非既定ルーティングを映さない（既定OFF/nearest のため
     カタログpin不変。閉形式の比較表 routecompare が距離側の答えを担う）。
  3. 指示書の「純TSモジュール/Web Worker」は実装しない（前提の齟齬の節を参照 —
     実体はPython/SimPy。受け入れ基準は全てスタック非依存で、全て満たした）。

## 完了。受け入れ基準 合否表（fresh監査官の最終判定）

| # | 基準 | 判定 |
|---|---|---|
| 1 | 経路拘束 | 合格（被覆の限界を明記） |
| 2 | 干渉 | 合格 |
| 3 | ログ由来KPI | 合格 |
| 4 | ルーティング比較 | 合格（Held-Karp厳密DPで2-optの66mが真の最適と独立確認） |
| 5 | 再現性 | 合格 |
| 6 | シナリオ差し替え | 合格 |


---

# 第2ラン: GeoJSON/Deneb ＋ MCP実験装置（進行中）

元指示3点: ①縛り理解した版 UPGRADE_PROMPT（既にDoD1〜6全合格 — 唯一の未充足
だった `python -m whsim.sim scenario.json` ヘッドレスCLIを ba7dceb で実装済み）、
②GeoJSONエクスポート層（AC-1〜4、段の扱いはOPEN ISSUE=決めずに両案実装して提示）、
③PBI Deneb ビジュアル対応、④Phase2: MCPサーバー化（DoD1〜7）。

## 決定事項

- runs/<run_id>/ は repo 直下 runs/（gitignore済）。台帳 index.jsonl。
  run_id = r<時刻>-<scenario_hash先頭8>。scenario_hash = 解決済シナリオの正準JSON sha256。
- pip 追加は `mcp`（公式SDK・stdioサーバーの一次実装）のみ。optional group [lab]。
- GeoJSON: 段の扱いは per-level（案A・既定）/ grouped（案B）の両実装 —
  最終選択は人間（トレードオフ表を最終サマリに）。
- Deneb は「実PBIでの動作は未検証」と明示（この環境にPBIが無い）。

## 分担

- 私: whsim.sim（済・ba7dceb）、統合、fresh監査（Phase2 DoD1〜7＋GeoJSON AC1〜4）、最終サマリ
- Agent G: geoexport.py（GeoJSON両モード＋layout.csv）、Deneb spec＋docs、AC1〜4テスト
- Agent M: mcp_server.py（8ツール契約）＋lab_report.py（比較・レポート・捏造遮断照合）＋E2E

## 第2ラン実装完了（監査待ち）

- [x] Agent G: geoexport.py（GeoJSON per-level/grouped＋layout.csv＋attach_metrics）、
  Deneb spec＋docs、AC1〜4テスト24本。座標系はコードの事実で決着（モデルは
  y上向き左下原点＝GeoJSON無変換。CSV経路 reflectY不要／geoshape経路のみ必要）。
- [x] Agent M: mcp_server.py（10ツール・stdio・mcp 1.x/2.x両対応）、
  lab_report.py（NumberLedger 捏造遮断・両方向照合・改竄3種の検出対照）、
  E2E「台数1台減→ピッキング待ち+90秒・通路待ち164→333回」を成果物と件数照合。
  62テスト。pip追加は mcp のみ（optional [lab]）。
- [x] 統合: grouped/metrics クエリを bool 化（?grouped=true の422罠を除去）、
  全体 1214 passed、コミット 53f0742（GeoJSON/Deneb）・5643cb9（MCP lab）。
- [x] fresh監査完了: **全11項目合格**（A1〜A7・B1〜B4）。監査官は自前MCP
  クライアントで stdio 接続、KPI 10項目をイベントログから素で再計算して一致、
  RFC7946 バリデータを新規に書いて12種の破壊で武装確認、AST走査で
  「数値生成ロジックの不在」まで検証。
- [x] 監査の改善提案2件を即修正:
  1. verify_report に指標ラベル単位の位置照合（「別の正当な数値への入替」改竄を
     検出 — 監査官の実測ケースを回帰テスト化、mcp 62→66テスト）
  2. grouped の多段フィクスチャ（5段ラックで 30間口→6Feature・levels合計30を
     固定 — 退行しても緑のままだった穴を閉鎖、geo 24→25テスト）
- [x] 残る既知の制限: init_state_from_snapshot は形式検証のみのスタブ
  （engine_supported:false を明示・実WMS較正は別ラン）、Power BI 実機は未検証、
  ruff の repo 全体192件は既存ベースライン（本納品5ファイルは0件）。

# 第2ラン 完了（受け入れ判定: 全11項目合格）


## 仕上げラン（全てやり切る）

- [x] Deneb 実レンダ検証: vl-convert（Deneb と同じ Vega-Lite エンジン、venv のみの
  検証ツール — pyproject には足さない）で layout.csv 実データを描画。
  **罠を発見して修正**: Vega-Lite は color=null の行をマークごと落とす
  → mark.invalid:null ＋ 条件色（未計測=灰色）で「床は常に全部見える」に。
  レイアウトのみ（全灰）とヒートマップ（実測色＋灰混在）の両面を目視確認。
- [x] Power BI スタースキーマ: runs.csv（次元）＋ kpi_facts.csv（long format、
  転記のみ・入れ子は dotted key）。GET /runs.csv・/kpi-facts.csv。
- [x] MCP 実デモ（ライン検品 950件/h・「梱包台20→16に減らすと？」）:
  apply_diff→run→compare→report を MCP クライアント越しに実走。
  **デモがエンジンの実バグを発見**: 引き込みの全ベンチを count=0 で閉めると
  共有プールへ落ちて容量が二重計上（稼働率1.28・詰まり消滅という物理破綻）。
  修正: ベンチが描かれていて全て count=0 の引き込みは「閉鎖」— ダイバートから
  外れる（描かれていない場合の共有プールfallbackは half-drawn 用として維持）。
  修正後: 16台 → 722件/h・完了率74%・block 0.864・初詰まり69秒早い、
  稼働率≤1。回帰テストで固定（物理不変条件: 台数減で詰まりは軽くならない）。
  なお unapplied_edits ガードがデモ中に実際に誤diffを1回捕まえた（設計の実証）。
