# 採点表レール（Scorecard Rail）— データ契約 v1

設計の「従属変数（採点表）」を、編集のたび解析的に即時再計算して右ドックに
常設表示する機能。Claude Code風に折り畳み/分割できるサイドパネル。

思想: タイムチャート・原価・生産性・坪数・連鎖・判定は「工程（手順の置き場）」
ではなく「設計の採点表」。物量×レイアウト×作業方式×生産性ソースが変わるたび
揺れる従属変数なので、タブに閉じず常に見えるべき。これにより whsim は
ウィザード → モデリング環境に格上げされる。

Stage1 ✅実装済: レール常設＋編集/取込/実行のたび解析API群で即時再計算。
比較対象は「最後のDES実行」固定 → ▲▼デルタ表示。
Stage2 ✅実装済: 名前つきシナリオの保存＋プルダウン切替・差分(scenariostore.py)。
Stage1.5 ✅実装済: POST /scorecard で編集中(未保存)モデルをライブ採点。
Stage3（将来）: ⑤シナリオ比較をレールの全画面版に統合。

---

## エンドポイント（backend agent 所有）

`GET /api/projects/{name}/scorecard`

全行を解析的（DES不要・爆速）に1コールで返す。既存の純関数を合成:
- 判定/稼働率 ← `analytic.estimate(model)`（overloaded, picker_utilization,
  capacity_orders_per_hr, offered_orders_per_hr）
- 原価/人員 ← `cost.estimate_cost(model, {})`（total_yen_month, cost_per_order,
  mh_per_day, orders_per_month）。人員 = ceil(mh_per_day / 稼働時間/日)
- 生産性 ← `pickrate.estimate_pickrate(model, {})`（recommend_id, methods[].
  lines_per_hour）
- 坪数 ← `storage.estimate_storage(model, {})`（has_data, totals.tsubo_total,
  cost.total_yen）
- 連鎖 ← 工程↔エリア種別チェック（下記ルールをPythonで実装。JSの
  STAGE_ZONE_TYPES と一致させる）

連鎖ルール（designer constants.js の STAGE_ZONE_TYPES と同一）:
```
receive→[receiving]  putaway→[storage,staging]  pick→[storage,picking]
pack→[packing]       ship→[shipping,staging]
```
各 process.stage が zone を持ち、その zone.type が許可集合に含まれるか。
未割当 or 種別不一致を「問題」として数える。

### レスポンス JSON（厳守）

```json
{
  "source": "analytic",
  "has_layout": true,
  "rows": [
    {"id":"verdict","label":"判定","value":"✓ 捌ける","unit":"","sub":"容量120 > 需要90 件/h",
     "tone":"ok","view":"analysis"},
    {"id":"headcount","label":"人員","value":"12.3","unit":"人","sub":"172 人時/日",
     "tone":"neutral","view":"timetable","num":12.3},
    {"id":"cost","label":"原価","value":"¥712k","unit":"/月","sub":"¥516 /件",
     "tone":"neutral","view":"cost","num":712374,"per_order":516.4},
    {"id":"productivity","label":"生産性","value":"260","unit":"行/h","sub":"推奨: マルチ",
     "tone":"neutral","view":"pickrate","num":260},
    {"id":"tsubo","label":"坪数","value":"43.5","unit":"坪","sub":"保管 ¥199k/月",
     "tone":"neutral","view":"storage","num":43.5},
    {"id":"chain","label":"連鎖","value":"⚠ 1件","unit":"","sub":"ピッキング未割当",
     "tone":"warn","view":"design"}
  ],
  "run": {
    "exists": true,
    "verdict": "対応可能 — ピッキング工程の稼働率 4% で…",
    "cost_per_order": 516.4,
    "headcount": 9.0,
    "throughput_per_hr": 7.3,
    "measured_productivity": {"ピッキング": 69.8, "梱包": 90.0}
  }
}
```

ルール:
- `tone` ∈ {ok, warn, bad, neutral}（レールの色アクセント用）
- `view` = クリックでドリルダウンする先のビューID（frontがswitchViewに使う）
- `num`/`per_order` 等の生数値 = front がデルタ計算に使う（無い行はデルタ無し）
- `run` は完了済みDES実行がある時のみ `exists:true`。無ければ `{"exists":false}`
- 物量/レイアウトが無くても **never blocks**（has_data=false の行は value="—"、
  tone="neutral"）。例外を投げず常に200で全6行を返す
- 全工程: 既存の純関数はそのまま使い、合成のみ。新たな計算ロジックは連鎖チェック
  と人員換算（mh→人）だけ

### テスト（backend agent）
- 6行が常に揃う（テンプレ素モデル / 実データ入りモデル / レイアウト無しモデル）
- 連鎖の ✓/⚠（pick未割当で warn、全割当で ok）
- run無し→{exists:false}、run有り→verdict等が入る
- never-blocks（空モデルで200・例外なし）

---

## レールUI（frontend agent 所有）

ファイル: `src/whsim/web/static/js/scorecard.js`（新規・self-contained injectStyle、
プレフィックス `.sc-`）。`index.html` にドック土台、`app.js` にマウント＋イベント配線。

### 配置・挙動（Claude Code風）
- メイン作業画面の **右側に常設ドック**。②分析 / ③設計 / ④検証 フェーズで表示
  （①取込 / ⑤提案では非表示 = レールの対象は「設計の採点」だから）
- **折り畳み**: ヘッダの ‹ ボタンで細いストリップ（アイコン+値のみ、~44px）に収縮。
  完全に隠すトグルも。状態は localStorage（`whsim-rail-collapsed`）に永続
- **分割（リサイズ）**: 左境界をドラッグして幅可変（最小240 / 最大520px、
  localStorage `whsim-rail-width` に永続）。Claude Code のサイドパネルの手触り
- **③設計（designer）はdesignerが右パネルを使う**ため、そのビューではレールは
  自動で細ストリップ（アイコン+数値）に収縮 or オーバーレイにして、designerの
  編集領域を潰さないこと（重なり厳禁）。要 PDCA 検証
- レスポンシブ: 幅<1100pxでは既定で折り畳み

### 中身
- 上部: シナリオ行 `比較: [なし ▼]`（Stage1の選択肢は「なし」「最後の実行(DES)」
  の2つ。「最後の実行」を選ぶと各行に解析値 vs DES実測の ▲▼デルタを併記）
- 6行カード: ラベル / 大きな値+単位 / sub(小さい補足) / tone色の左罫。
  各行クリックで `whsim:nav` で該当 `view` へドリルダウン
- 「最後の実行」比較時: cost.per_order / headcount.num / productivity.num を
  run.cost_per_order / run.headcount / run.measured_productivity と比較し
  ▲(増)▼(減) を色つきで（原価・人員は減=緑、生産性は増=緑）
- フッタ: 「▶ DESで実測検証」(=実行) と最終更新時刻
- 値は**解析値（爆速）**。これは「実行前の当たり」で、DESは裏取りという二段構えの
  常設化

### 再計算トリガ（front 配線）
レールは次のイベントで GET /scorecard を**デバウンス(250ms)再取得**:
- プロジェクトを開いた時（openProject）
- `whsim:model-changed`（取込・適用）
- 設計保存後（designer save コールバック / app.js が既に openProjectQuiet 実行）
- 実行完了（doRun 成功）
- `whsim:design-dirty`（PM=私が designer に追加する「編集のたび」軽量シグナル。
  front は単にこのイベント名を購読しておけば良い。未発火でも動作）
- フェーズ/ビュー切替で②③④に入った時

### 検証（frontend agent・必須）
- playwright実機（/opt/pw-browsers/chromium-1194/chrome-linux/chrome、
  --no-sandbox --disable-dev-shm-usage、自前で uvicorn --port 起動・pkill禁止）
- localStorage whsim-onboarded-v1〜v4='1'、POST /api/projects/sample でプロジェクト
- ②③④でレール表示、①⑤で非表示 を assert
- 折り畳み→細ストリップ、再展開、幅ドラッグ→localStorage永続 をスクショ
- **③設計でdesignerの編集領域とレールが重ならない**ことを座標で検証
- 行クリック→該当ビューへ遷移、ダーク/ライト両テーマ、pageerror 0
- スクショ /tmp/shots-rail/ に保存・Read で目視（PDCA 2周以上）
