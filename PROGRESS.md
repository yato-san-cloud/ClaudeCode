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
- [ ] Agent R/I 実装（並列中）
- [ ] 配線・統合・全テスト
- [ ] D単位コミット（D1: ルーティング, D2+D3: 干渉+ログ, D4+D5+D6: シナリオ/what-if/監査）
- [ ] fresh opus 監査 → 修正
- [ ] 最終サマリ（結果→DoD合否表→既知の制限）
