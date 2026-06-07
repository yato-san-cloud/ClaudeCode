# MapMaker × WITNESS 統合設計 — スーパーエディタ＆シミュレータ

**目的**: 倉庫レイアウトを MapMaker（日立）のように*サクサク*描き、それが**そのまま 2D / 3D / 動線シミュレーション**になる、WITNESS を超えるリアルな可視化を持つ統合ツールを whsim 上に作る。

このドキュメントは、デコンパイル済み MapMaker（`reference/mapmaker/`）と WITNESS/FlexSim/Emulate3D 調査から起こした実装仕様の蒸留版。詳細根拠は各リファレンス参照。

---

## 0. 確定した設計判断（プロダクトオーナー回答）

1. **ゾーン先決め → 保管ゾーン内に棚を自由配置**。出荷/入荷/仮置きゾーンは将来「荷物が溜まる描写」に使うため保持。
2. **`facing`（間口の向き）を持たせる**。ただし下記の通り *advisory*（経路は幾何から導出）。
3. **棚一括生成**（`ShelfArrayGenerator` 移植）＋ **面積指定オート生成**（新規）。
4. **ロケーション名の割付必須** — 在庫データが棚名で slot できるように、MapMaker の棚名（例 `100-01-09`）を端から端まで保持。
5. **3D は WITNESS を見て本物の保管設備オブジェクトに**。

## 1. いちばん大事な原則：**facing は「フィールド」でなく「幾何」**

MapMaker は棚に回転/向きを**持たない**（`AbstractRectangleObject` は `tl,br` のみ）。間口は経路生成時に**幾何から導出**する（`CartNetworkGenerator.setWaypointsForTargets`）:

> 各棚の **4 辺の中点**を外側に 500mm オフセットし、そのピック点が**他の障害物に当たらない辺だけ**を間口として採用。背中合わせの棚は内側が塞がれ、通路に面した外側だけがピック面になる。

→ whsim でも `ShelfArea.facing` は **advisory（一括生成の意図 + 多面開放時のヒント）** に留め、**経路は開放面を幾何導出**する（`navnet.py` に移植予定）。「描いた地図そのものが経路の真実」。

## 2. 統合データモデル（スキーマ）

| MapMaker | whsim schema | 備考 |
|---|---|---|
| `FreeShelfObject{x,y,w,h,name}` | `ShelfArea{id,name,x,y,w,h,rack_type,facing,cell_w,cell_d}` | ✅ `name`/`facing` 追加済 |
| `WallObject`(矩形) | `Wall{points,thickness}` | 矩形→長軸中心線＋厚み |
| `StationObject` | `resources.stations[]` / `Zone(packing)` | 検品/作業場 |
| `ConstrainedAreaObject` | （将来）`Layout.constraints[]` | 一方通行・キープレフト等 |
| `StairsObject`/`BeaconObject` | skip（警告） | 多階層/テレメトリは対象外 |
| `floor.bounds` mm | `Bounds{width,depth}` m | 単位 mm→m |
| 棚名 `100-01-09` | `Location.name` | ✅ 追加済。slot の join キー |

**単位/座標**: mm→m（×0.001）、原点はオブジェクト/floor.bounds の最小角へ平行移動、**Y 反転しない**（whsim はレンダ時のみ反転）。`START`/`END` 疑似棚は除外。

## 3. ロードマップ & 状態

| | 内容 | 状態 |
|---|---|---|
| **M0** | `name`/`facing`/Location.name 追加、`rmpm.py` ネイティブ取込、ロケ名伝播、UI/エンドポイント | ✅ 実装・テスト済（実 LW: 543棚/940ロケ/89.6×62.75m、sim 119.5件/h） |
| **M1** | 3D 棚リアル化（`shelf_runs`＋`rack_type`）、ピック対象可視化、突き抜け解消 | 次 |
| **M2** | MapMaker 編集（自由配置/エッジスナップ/Undo/スルスル pan-zoom）＋ 一括生成 ＋ 面積オート生成 | |
| **M3** | 3D 設備パレット（標準保管設備を選んで配置） | |
| **M4** | 経路精緻化（facing 幾何導出のピック点、棚間距離キャッシュ→`distance_overrides`） | |
| **PDCA** | UI/UX 専任と反復、最終調整 | 最後 |

## 4. M1 — WITNESS 超えの 3D 仕様（`view3d.js`）

**データ契約の橋渡し（先にやる）**:
- 真実源を `replay.shelves`（`render/shelves.py:shelf_runs()` の列ラン `{x,y0,y1,depth,pitch,rack_type,cells}`）に統一。`racks`(点) は fallback のみ。
- Python 側に最小追加: 各ラン `facing` と各 cell `sku`/`qty`。
- **ピックイベント可視化**: worker keyframe を `[t,x,y,state]` → 5要素目 `hit={run_id,along,sku,qty}`（pick/carry 時のみ）。`replay.py` がエンジンの pick イベント（訪問 `Location`）から付与。**「ピッカーが実 SKU ヒット箇所に歩いて取る」を見せる最重要データ**。

**rack_type 別ジオメトリ**（`racktypes.py` の bay×depth×levels を JS にミラー、`InstancedMesh` を piece×rack_type で 1 バッチ、ABC は `instanceColor`、<120 draw call / 700ラン）:
- light 軽量棚 H≈2.0m 5段 / medium 中量棚 H≈2.4m 4段 / **pallet パレットラック H≈5.6m（橙ビーム＋パレット荷）** / nestainer ネステナー段積み / **flow フローラック（傾斜ローラレーン）** / **asrs AS/RS H≈16m（クレーン）**。
- ラン矩形を bay ピッチで分割、`facing` で間口を通路へ向ける。
- エージェント: ピッカー＝人（~1.7m, 状態色のベスト, ピック時に腕リーチ＋トート）/ フォーク＝マスト＋フォーク（運搬時フォーク上昇＋荷）/ AGV＝低床＋状態ランプ。**人 1.7m < 棚 2.0–2.5m で突き抜け解消**。
- ピック可視化: 対象 cell を発光パルス＋手→cell の細線＋SKU/数量ラベル（プール、reduced-motion 配慮、FPS 自動デグレード）。
- プレミアム: 充填光、床の艶＋通路ライン塗装、ドック detail、AS/RS が霧に抜ける。preset は光/霧/露出/床艶/ライン透明度のみ調整（ジオメトリ不変）。

詳細根拠: WITNESS engineer spec（Lanner WITNESS Horizon / FlexSim rack types / Emulate3D / 実ラック寸法）。

## 5. M2 — MapMaker 編集 UX 移植（`designer.js`, Canvas2D）

- **操作モード（数字 1–9）**: 1編集 3棚 4壁 5検品場 6制約 9経路。
- **選択/コントロールポイント**: 8 ハンドルでリサイズ、基準角固定、複数選択は相対 0..1 でスケール。
- **エッジスナップ**: 固定グリッドでなく**他オブジェクトの辺にスナップ**（±10px、Ctrl で無効、緑ガイド線）。落下時に**重なり拒否**（接触は許可）。
- **棚一括生成**（`ShelfArrayGenerator`）: 間口向き/間口幅/奥行き/連結数/間隔/prefix → **間口に沿って一列**（奥行き方向に積まない）。`facing` を設定、名前は prefix+連番 or 名前リスト。
- **面積オート生成（新規）**: 矩形＋標準棚＋通路幅＋（背中合わせ可）→ 棚ラン帯と通路帯を交互にタイル、**間口を通路へ**、連番命名。facing 幾何導出が要求する「全棚が通路面を持つ」形を生成。
- **Undo/Redo**（スナップショット）、複製（+1000mm＋自動命名）、**スルスル pan/zoom**（rAF＋easing, 設計ノートの目玉）。`view{centerX,centerY,zoom}` を取込時に尊重。
- 棚名: MapMaker 文字列を verbatim 保持、ユニーク＋カンマ禁止を live 検証。

## 6. M4 — 経路（`navnet.py`/`graph.py`）

1. **facing 幾何導出のピック点**（最優先・正しさの核）: 各棚 4 辺中点＋外向き 0.5m、**開放面のみ**採用しネットへ接続。`facing` があれば優先。
2. 任意: waypoint を周長サンプル→Delaunay 外心（中心線）へ（より滑らかなアイル中心経路）。
3. 一方通行/制約エリア（`Layout.constraints` 時、有向辺）。
4. **棚間距離キャッシュ → `distance_overrides`**（全対最短路）。`World.dist`（実測 > graph > Manhattan）が真のアイル距離を使う。
- `graph.py`（占有格子＋access-node 集約）は whsim の強み、エンジンタイミングの権威として維持。

## 7. MapMaker の不便（真似しない） / 守る要点

- 真似しない: Ctrl+C が画面キャプチャ / 確認ダイアログ過多 / 起動毎リセット / 重なり完全禁止 / 回転なし。
- 守る: **棚名＝join キー**を端から端まで保持 / **開放面の幾何導出** / **エッジスナップ** / 一括生成は間口を空ける / **描いた障害物＝経路の障害物**（`zone.shelves`/`walls` を直読）/ 寛容な取込（未知はスキップ・致命的にしない）。

## 8. 主要リファレンス

- `reference/mapmaker/新アプリ_設計ノート.md`（意図）, `ANALYSIS.md`（解析）
- model: `decompiled/.../model/map/objects/*`, `model/picking/*`, `model/map/{ShelfNameManager,WaypointGraph}.java`
- routing: `decompiled/.../networkgenerator/{CartNetworkGenerator,WalkNetworkGenerator,RectGrid}.java`
- editor: `decompiled/.../panels/objecteditor/*`, `panels/inputs/MapInputHandler.java`, `editors/ShelfEditor.java`
- 一括生成: `src/.../ShelfArrayGenerator.java`、出力: `src/.../RmpmExport.java`
- 実データ: `reference/mapmaker/exported/*.rmpm.json`
- whsim 対象: `schema/model.py`, `rmpm.py`, `mapcsv.py`, `design.py`, `engine/{navnet,graph}.py`, `web/static/js/{view3d,designer}.js`, `render/{shelves,replay}.py`, `racktypes.py`
