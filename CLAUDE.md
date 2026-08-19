# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: whsim (warehouse simulator)

A warehouse simulator whose thesis is to **decouple input difficulty from
computational accuracy**: a non-technical salesperson loosely models a warehouse
from a template, while a heavyweight discrete-event simulation (SimPy) runs
underneath and emits a proposal-grade 2D PNG. See `README.md` for the full pitch.

### Architecture (the load-bearing idea)

Everything hangs off **one contract: the canonical schema
`whsim.schema.WarehouseModel`** (`src/whsim/schema/model.py`). Every field has a
default, so any model is always valid and always runnable ("never blocks on
missing data"). Components are pure functions over that schema plus run
artifacts, so each is independently testable/replaceable. **See
`docs/ARCHITECTURE.md`** for the full module map, the 12 invariants, the
replay/MapMaker data contracts, and extension points — read it before a large change.

- `templates.py` — a template is a fully filled-in (provisional) `model.json`.
  同梱の **`line_inspection`（ライン検品・引き込み梱包ライン）** は「コンベア上で検品が完結する」
  出荷ラインの事例: 仕分けシュート下の無動力2列 → 2段駆動コンベアの下段本線 → 引き込み5ヶ所×両側
  → 縦長の梱包台20台 → 停止線/カーブ→積み付け（`scripts/gen_template_line_inspection.py` で再生成）。
  梱包台は**1台＝1 `Station`**（実寸 `w`/`d`・長辺が引き込みと平行＝作業者の立ち位置が決まる）で、
  ベルトは全本を `flow_edges` の `equipment_ref` で配線する — こうしないとエンジン
  (`conveyor_ids_in_use` が絞る) と解析 (`analytic._belt_access` は全部読む) が違うベルト集合を見る。
- `importer.py` — tolerant ZIP→subtree merge; broken/non-JSON files are skipped,
  never fatal; partial import is fine.
- `locmaster.py` — **WMS ロケーションマスタ取込**（エリア/列/棚/段/間口・X_mm/Y_mm・
  什器種別）。図面の棚に実ロケを載せる、取込チェーンの最後の一本。これが無い間、
  レイアウトを取り込んでも中身は空の家具だった（図面は `AAA-00-02` の位置を知り、
  出荷履歴は `AAA-00-02-3-01` から採ったことを知り、**同じ場所だと知る者が居なかった**）。
  肝は2つ: (1) マスタはゼロ詰め・履歴は非ゼロ詰めなので**そのまま突合すると一致0件**
  → 各部を2桁に正規化する。(2) 図面の粒度は **エリア-列-棚**（MapMaker の棚名）なので
  そこで結合する（間口粒度だと0%、棚粒度で実案件54%が解決）。座標は**図面の棚**から
  採る（マスタのX/Yを使うと3Dで在庫が棚の脇に浮く）。図面に無い棚は置かない・
  黙って消さず `in_layout:false` で残す。POST `/api/projects/{n}/import-locmaster`。
- `mapcsv.py` / `rmpm.py` — tolerant MapMaker importers (Hitachi WorldMap Map CSV /
  `.rmpm.json` export / **NATIVE `.rmpm`** = Java serialization, parsed via
  javaobj-py3 and validated byte-equal against the JSON-export oracle); shelves
  keep their MapMaker name (→ slottable location names), walls/stations mapped,
  mm→m. **名前規約の解釈** (`classify_name`/`_NAME_RULES`, 不変条件18): 形式に z 座標が
  無く種別も3つしか無いので、段(下段/上段→`elevation_m`・同一XYの2本を両方残す)・
  非障壁(停止線/仕切り→`non_barriers`, 壁にしない)・人マーカー(立ち位置→`markers`,
  什器にしない)・搬送設備(引き込み/本線/還流/フリー→`conveyors`)・作業台の実寸は
  **名前**にしか無い。判定は1つの表で**名前が先・`type` が fallback**(規約語ゼロの
  図面はバイト同一)。名前は「何であるか(どこに・どうする)」なので**注記より先に、
  しかも頭だけを見る**(全文フォールバック無し) — 全文だと
  `検品者立ち位置マーカー(西・仕切り付近)` が区画線になり、**WMSのロケ番地
  `100-01-09(検品者側)` が注記に食われて棚が0本**になる(保管ゾーンごと消える)。
  `_half_key`/`_belt_elevation_m`/`_belt_direction` も頭を読む(全文だと
  `本線コンベア(還流は西向き)` でベルトの向きが反転＝連鎖の位相が裏返る)。
  **形式が種別を持つ `FreeShelfObject` は名前表に勝つ**。**種別は最後の名詞**で
  決まる(右端一致; `引き込み3-梱包台07` は梱包台。表順だと**描いた梱包台20台が
  幻のベルト20本**になり成功として報告される)。`北半`/`南半` は結合するが両方が
  相方を名指しするので**全半語を消してから**キーを作る。
  **`load_kind` の作り手もここ** — 押すベルトが居なければゲートは1件も止めない
  (`pass_states` だけなら逆に全部止まる、どちらも沈黙)。名前が `荷=…` と言えばそれ、
  無ければ**ゲートへ運ぶ上流ベルト**の種別と推定し**明示する**。ゲートは
  *armed*/*pending* を区別し、**モデル未完成を理由に図面の規則を消さない**。
  停止線→ゲートは `resolve_stop_gates` (交差 or 1.5m 近接。受け渡し点では複数ベルトが
  数cm内にいるので**「線に向かってくるベルト」**でないとカーブを掴む。1本に2本なら
  上流を採り落とした方を名指しで警告、同距離は belt id で決める)。
  **インポータは `discharge_both` を決めない**(能力が倍になるつまみを名前から推測しない)。
  `racktypes.py` — 9 storage-equipment presets (incl. メザニン/移動ラック/
  ハンガー) with unit economics, served at `/api/racktypes` and mirrored into the
  JS editor/3D (keep in parity).
- `beltgeom.py` — **引き込みの合流点・払い出し口・梱包台の持ち主＝唯一の規則**（純幾何、
  simpy 非依存）。`engine/build.py` と `analytic.py` が同じ関数を呼ぶ:
  `feed_point`（端が本線に載っていればそこ、**載っていなければ経路が最も近づく点** —
  これが無いと本線を真ん中で跨ぐ引き込みは合流点を持てず、**梱包台だけ持って一荷も
  受け取らない死んだベルト**になる。全部末端の共有プールで梱包されるのでオーダーは
  完走し、外からは正常に見える）、`discharge_ends`（ベルトは一方向 ⇒ 既定は
  `points[-1]` 側の台だけ。`Conveyor.discharge_both`＝無動力を両端から人が引く、と
  図面が言ったときだけ両側。**図面は普通どちらとも書かない**ので既定は安全側）、
  `bench_pools`（**共有台は最寄りの引き込みのもの**、4値 `n`/`CLOSED`=人0/`LOST`=隣が
  持っている/`UNSTAFFED`=誰も描かれていない→余り台へ。`LOST` を `UNSTAFFED` に混ぜると
  **人が居ないほど強い引き込み**が生まれる: pull で台0が53件・台1の隣が20件）。
  以前は両者が写しを持ち、エンジンだけが学んで実図面で**エンジン4台 vs 解析2台**、
  共有台は**解析が両方に計上**（人より多いサーバ数＝DESより甘い＝不変条件5が唯一禁じる向き）。
  `JOIN_TOL_M`/`BENCH_REACH_M` の源。
- `analysis/data_io.py` — real-WMS-grade table loading: header-row auto-detect
  (タイトル行/メタ行 skip), 合計/小計 row drop, header NFKC fold so 半角カナ
  (商品ｺｰﾄﾞ/出荷ﾊﾞﾗ数) auto-map, ragged-CSV salvage, legacy `.xls` via xlrd
  (in deps). `cad.py` rejects DWG-mis-saved-as-DXF with a how-to-fix message and
  salvages malformed DXF via ezdxf.recover.
- `provenance.py` — tracks each subtree's source (imported/interview/provisional);
  surfaced in output as "N% your data". First-class, not bookkeeping.
- `project.py` — persists workspace under `projects/<name>/` (gitignored runtime
  data); the simulator is the source of truth, the analysis tool just supplies ZIPs.
- `engine/` — SimPy DES: `routing.py`, `build.py`, `processes.py`, `run.py`, `scenarios.py`,
  `graph.py` (wall-aware aisle grid + Dijkstra; `World.dist` = measured override > graph > Manhattan).
  `pickroute.py` — SPRP visit-order policies (s_shape/return/largest_gap; pure, rng-free)
  keyed off `process.routing_policy` (default nearest = byte-identical legacy);
  `routecompare.py` compares all 4 (+2-opt) as a closed-form distance table
  (`POST /routecompare`, `whsim routecompare`). **通路干渉** `simulation.aisle_interference`
  (default False = byte-identical): walk legs contend per cell×direction (capacity 1,
  same-direction), waiters hold nothing (deadlock-free by construction) + 3×crossing
  timeout force-pass; `aisle_wait` events → `congestion_*` KPIs; `kpis.wait_stats`
  validated vs M/M/1 Lq within ±5%. Runtime rack-penetration check every rep
  (`rackgeom.track_penetrations` → `path_violations` KPI + verdict). Event log is a
  run artifact (`events.jsonl` + `/runs/{run}/events.{jsonl,json,csv}`, `eventlog.py`);
  `scenarios.whatif(base, edits)` = diff→headless run→summary (D5 I/F).
  **解析側**: 通路干渉は**上界として鏡写し済**（`analytic._aisle_congestion`; 歩行
  「時間」の倍率で距離は不変、実測9.1〜23.0倍 甘くない側）。非既定ルーティングは
  **測った上で映さない**と決めた（DES感度が稼働率0.013以下＝ピンの1/6、閉形式は
  オラクルを悪化させ甘い側へ倒した）→ `routing_policy`/`routing_policy_mirrored` で
  名乗るだけ。⚠️ `apparel`=s_shape / `food_chilled`=return を**既に**使っている。
  AGV同士の干渉は未鏡写し。
- `distances.py` — tolerant import of a measured shelf-to-shelf distance matrix (CSV/JSON).
  Pickers and AGVs are individual agents (AGV mode is a pipeline: AGV agents fetch totes →
  ready queue → pickers handle), emitting trajectory keyframes for replay. Batch/zone/wave
  pull `batch_size` orders per trip; `peak_factor` scales demand. `scenarios.py` applies
  dotted-path edits for what-if comparison (+ `payback_months` from operating-cost savings).
- `kpis.py` includes cost: ¥/order, monthly_cost/opex, headcount, AGV utilisation.
- `analytic.py` — closed-form M/M/c estimate; also the engine's sanity oracle in tests.
  Travel is **aisle-routed like the DES**: `rackgeom.aisle_detour` charges the
  aisle-escape detour in closed form off the drawn rack rectangles (ℓ/3 per
  aisle-changing hop, 2d(ℓ-d)/ℓ per depot leg — no graph search, so it stays 爆速
  for drag-time re-estimation), and the trip is amortised over
  `workmethod.orders_per_trip` (the engine's own batch rule). No racking ⇒ the
  historical Manhattan behaviour (never-blocks). Every work method the engine has
  must have its mechanism here too, or the oracle silently tells a rosier story:
  **GTP(AGV)** (picker walks 0, the fleet is its own M/M/c and throttles the
  picker's arrival rate — `agv_utilization`/`bottleneck`, `None` when manual),
  **種まき(sort)** (the sweep stops once per DISTINCT SKU — batch-formation
  dependent, so measured over the engine's own FIFO windows when orders exist —
  and every line then costs `sort_time_s` at the wall),
  **batch** (orders on a trip = what is standing in the store, `C·ρ(1-ρ^(cap-1))/(1-ρ)`
  — NOT the time-average `Lq`), **wave** (the window scoop is self-limiting,
  `B = λ·W`; the gate hold is picker-busy on both sides), **zone** (a serpentine
  runs each aisle end to end ⇒ ℓ, not ℓ/3) and **conveyor** (asymmetric legs:
  out from the last hand-off, back only to the nearest belt; chained belts add
  詰まり — `capacity_line = min(Σ並列 v/pitch per stage, μ_pack)`, over-feed ⇒
  `time_to_jam ≈ K/(λ−capacity)` + picker throttled at capacity, GTP-style;
  engine side rides flow_edges-derived chains hand-over-hand with **greedy**
  junction diversion — target-commit starves benches, 0.62 vs 0.977 util at
  peak — and `Conveyor.tote_pitch_m` sets slot density, KPIs
  `conveyor_block_ratio`/`time_to_first_block`/per-belt `kpis["conveyors"]`,
  pinned by `tests/test_{engine_conveyor_chain,analytic_conveyor_jam}.py`
  with unchained models byte-identical). 解析↔DES agreement
  is pinned by `tests/test_analytic_aisle_travel.py` on **every** template
  (|Δutil| < 0.08 each, catalogue mean < 0.04) — it used to check two, and the
  six unchecked ones hid residuals up to 0.81.
  **ライン運用の3機構** (不変条件17・全部既定オフ＝同梱テンプレはバイト同一,
  `tests/test_line_mechanics.py`): **選択停止** `Conveyor.stop_gate`＋`load_kind`
  (1本のベルトを2種類の荷が同時に流れる — 検品済は停止線で止まって引き込みを待ち、
  完成品は通過してカーブへ。「止める種別にはベルトが早く終わる」として実装＝連鎖の
  既存規則1つを再利用するので滞留/背圧はそのまま落ちる。3値 never-blocks);
  **有限容器循環** `Process.container_pool`（**投入時に確保**するので空＝投入停止＝
  不足がピッキングへ遡る。空は還流ベルトを**幾何としてだけ**使う＝スロットを取り合わ
  ない。KPI `containers_in_use_peak`＝**必要保有数の下限**、`== pool_size` は天井に
  当たっただけ＝答えではない、が同じ表から読める。Little's law と ~2% 一致を検証);
  **pull型引き込み** `Process.divert_policy: "auto"|"pull"`（通過の瞬間に台が空いて
  いる引き込みにだけ入り、無ければ**本線で待たずに通り過ぎる**。貪欲は人員に盲目
  =台3→1で分岐 74→74、pull は 72→40）。
- `linemech/` — **その3機構の解析ミラー** (`gate.py`/`container.py`/`pull.py` ＋ 共有層
  `bench_ledger`（梱包台の持ち主・停止線の作業者・余り台）と `junctions`（引き込みの
  合流点））。図面の読み方を3つに増やさないため、連鎖は `analytic._belt_stages`・幾何は
  `beltgeom` から受け取り、自前では持たない。`analytic.estimate` は**機構が書かれている
  枝の中でだけ遅延 import** するので、同梱テンプレは `whsim.linemech` を import すら
  しない（カタログはSHA一致・爆速のまま。`tests/test_analytic_line_mechanics.py` が
  「入口が呼ばれないこと」で固定＝出力一致より強い）。実測: 選択停止 |Δ梱包稼働率|
  平均0.010/最大0.028（36構成・機構なしなら0.289/0.669）、pull 引込率 rms 0.008・
  梱包稼働率は甘い側0/36、容器 滞留 中央値0.4%。容器は **additive**（エンジンは投入待ちを
  ピッカーの busy に数えないので λ を絞ると解析だけ甘くなる）で `conveyor.containers` に
  ぶら下がる。⚠️ 末端に人が居ないラインは「止まる」と読む＝地平線平均より最大0.67辛い
  （安全側・意図的）、停止線と pull の同時指定は pull 優先（未検証の組み合わせ）。
- `kpis.py` — event log → KPIs + a plain-language (Japanese) verdict. Multi-rep runs
  add `kpis.ci` (95% t-CI per headline metric + n_recommended for a ±5% target);
  the KPI view shows 「±X (95%CI, n=N)」 and an honest n=1 disclosure.
  **レプリケーション集約はキーの意味ごと** (`_EXTREMUM_KEYS`/`_MOMENT_OF`): レート・
  合計・稼働率・件数は平均、**最大値は最大** (`containers_in_use_peak`＝レンタル数量の
  根拠, `wip_max`, ベルト別 `peak_occupancy`) — 5回のピーク [44,29,45,28,29] を平均した
  35 は**観測されたどの最大値より低い**＝甘い方向。「いつ」(`containers_in_use_peak_t`)
  は**そのピークを出した回から**採る（時刻の平均はどの run でも何も起きていない瞬間）。
  欠陥カウンタ (`path_violations`/`unroutable_legs`) も最大＝「5回中1回発生」を 0件 に
  丸めない。入れ子は専用マージ (`_merge_per_belt`/`_merge_congestion`/
  `_merge_measured_productivity`) — 汎用ループは rep#1 だけを残す。n>1 は
  `kpis.spread`（各回の 最小/最大/平均＋`_confidence_intervals` の 95%CI）を additive に
  出し、判定文が「N回中の最大」と明記する（**n=1 は 1バイトも変えない**＝既定の経路）。
  **ライン終端の無人** `pack_unmanned_loads`＋ベルト別 `unmanned`（`pack_unmanned`
  イベント）: 梱包台が全て引き込み/停止線のものだと、どの引き込みも引かなかった荷は
  末端で**誰にも取られず止まる**（エンジンは人を発明しない）。外からは説明のつかない
  スループット崩壊なので、判定文が**原因（図面に人が居ない）と直し方（停止線／終端に
  梱包台を描く）とベルト名**を言う。件数なので集約は平均だが、`spread.reps_nonzero` で
  「N回中M回で発生」を出し、平均 0.2 件を **0件 と書かない**（`_count`）。
- `asrs.py` — FEM 9.851 / Bozer-White クレーンサイクル解析 (E(SC)/E(DC) → cycles/h →
  必要クレーン台数). 保管設計 (`storage.py`) の自動倉庫サイジングと GET /storage payload
  の additive `asrs` ブロック; クレーンつまみは /api/racktypes 配信 (no hardcode).
- `analysis/inventoryopt.py` — 在庫最適化 (安全在庫・発注点). SKU別 日次需要 (需要ゼロ日
  含む) から μ/σ を実測で直接算出; SS = z·σ·√(LT+R), ROP = μ·LT+SS; 低頻度SKUは
  ポアソン切替 (scipy不使用). GET /inventory-opt → ②分析「物量サマリ」カード
  (`js/dataanalysis.js`); 理論値の注記付き (never oversell).
- `wording.py` — **提案書の用語ガード** (顧客ごとの禁止語・言い換え). `Settings.wording`
  が空＝**検査そのものが不活性**（既存の出力は不変）。肝は **`allow` が先に地面を押さえる**
  こと: 固有名詞は禁止語を含みうる（「停止」を禁じた案件で、設備名の**「停止線」**まで
  消える）ので、allow 語句の占有区間を先に確定し、そこに重なる禁止語ヒットは**最初から
  作らない**。ヒットは最長一致・非重複（「検品レス」があれば「検品」を出さない）＝
  そのまま `apply` の書換に使える。`lint_export` は提案書ペイロードを再帰走査して
  `insights.0.title` のようなパス付きで報告（`*_path`/`*_id`/`*_color` は走査しない）。
  POST `/api/projects/{n}/wording/check`、CLI `whsim wording <p>` は**検出で終了コード1**
  （CIゲート）。
- `analysis/demandshape.py` — **時間帯波形→需要投入**. 実務で最初に出てくるのは明細では
  なく「6時 97件, 7時 865件, …」の1枚。これを捨てて日量÷稼働時間（一様）で回すと、
  ピーク時間帯シェアが実測 13.6%（一様 6.2% の 2.17倍）の現場で**臨界点の判定が反転
  する**（20台/CT78: 一様なら794日中0日超過、波動なら18日）。`from_hourly` は比例配分＋
  時間帯内一様乱数（seed固定＝完全再現）、`total_orders` は最大剰余法で合計厳密一致、
  到着は**次の時間の直前でクランプ**（丸めで最終時間が翌日へ漏れると busiest-day
  collapse を誤発火させる）。`apply_to_model` は `simulation.duration_s` を**伸ばすだけ**
  （8時間窓のままだと夕方の山が窓外＝0件処理）。POST `/import/hourly-demand`。
- `export/` — brand theme: `Settings.brand` (宛先/自社名/accent/logo/footer, all
  defaulted) → PPTX/PDF 表紙とアクセント色に反映; POST /brand/logo でロゴ保存;
  設定タブ「ブランド」(js/settings.js). Default brand is colour-identical (no-op).
- `design.py` — design-side helpers: `materialize_racks` expands a storage zone's
  parametric rack params (or authored MapMaker-style shelves) into the concrete
  `locations` grid, propagating shelf names to location names and re-pegging SKUs.
- `storage.py` — 保管設備の試算 (demand → 保管方法 → 間口/台数/坪数; cost is 参考) +
  `place_equipment` authors the sized units into the storage zone (ピック面/バック
  2層・アイル向き; `POST /storage/apply-layout`); ③設計「保管設計」 (`js/storage.js`).
- `cost.py` — 解析的原価積み上げ (LOGISTEED 試算フロー 6費目; no sim, 爆速). Labour
  uses the **3-tier productivity**: 実測採用値(settings.productivity_overrides) >
  物流形態ベンチマーク(settings.benchmark_productivity) > エンジン既定. ⑤提案前の
  ③設計「原価試算」 (`js/cost.js`, GET /cost). Same 3-tier in `analysis/staffing.py`
  `resolve_productivity` so the 人員タイムチャート honours it too. ピッキングの既定層は
  作業方式連動 (pickrate の動作時間モデルから導出; override/benchmark があれば不変).
- `loadunit.py` — **荷姿 (容器・台車) カタログと換算**. `capacity` は連鎖表現
  (オリコン={piece:30}, カゴ台車={orikon:14, case:14, tray:14}), 混載は**占有率の和**
  `Σ(count/capacity)` で積む. 種類ごとに積載数が違う台車 (カゴ車=折コン12 or ケース20)
  を表現でき、かつ seed 値では既存の平坦式「(OC＋ケース)÷14」と**完全一致**するので
  ②基礎物量の数字は1つも動かない (テストで固定). SLC型の「資材マスタを先に全部埋めろ」
  の逆で、**既定カタログ同梱＋使う辺でその場編集**. `catalog(model)` 経由で解決
  (process_master と同じ単一源規約). GET/POST `/api/projects/{n}/loadunits`,
  GET `…/loadunits/convert` (`chain` に式を明示; JS側で式を再実装しない).
- `wipcurve.py` — **滞留 (累積フロー図)**. `WIP(t)=max(0, Σ上流out − Σ下流out)` を
  人員ソルバーの `headcount_by_hour × productivity` から解析で算出 (no DES, 爆速).
  上下流は単位が違う (行/h vs 件/h) ので**日量に対する進捗比**に正規化してから辺の
  荷姿へ換算する — 行−件 は無意味なので. ピーク台数→`footprint_m2 × AISLE_FACTOR`
  で仮置き坪. **台車は共有プール**なので保有台数は各辺ピークの和ではなく**和のピーク**.
  荷姿未指定の辺はピースで滞留を出すが「保有する物」ではないので fleet には出さない.
  GET `/api/projects/{n}/wip`.
- `flowgraph.py` — **業務フロー・設備接続・マテリアルフローを1つのグラフに**する解決器.
  ノード=工程(`role`=エンジン挙動への写像/`zone`), エッジ=`process.flow_edges`
  (`transport`＋`equipment_ref`＝どの実機で運ぶか＋`share`＋`container_ref`/`carrier_ref`＝荷姿). 以前は同じ倉庫を3回
  別々に記述していて①工程DAGと②stagesで共有IDがゼロ・どちらも③設備を指せず、
  エンジンは最寄りベルトを幾何で拾っていた(=フローで人手にしてもベルトが止まらない).
  **エッジ未作成⇒depends が含意していたグラフに解決**(既存不変), **部分配線が正常系**
  (1本配線しても残りは派生を保つ). エンジンは `conveyor_ids_in_use()` でゲート
  (`None`=誰もコンベアで受けない⇒ベルト停止). 描いただけの設備は物理的事実であって
  設計の意思ではなく、齟齬は `diagnose()` が警告で出す(never-blocks). GET/POST
  `/api/projects/{n}/flow`. UI は ③設計フロー(矢印クリック→設備クリックで配線・
  `designer/flowwire.js`) と ②マテリアルフロー(**編集可能なノードキャンバス**;
  サンキーは廃止) の2レンズで、`whsim:flow-changed` で相互ライブ反映.
- `web/static/js/materialflow/` — ②のノードキャンバス (`materialflow.js` は
  オーケストレータ; `canvas.js` 描画・操作 / `layout.js` 純関数の自動整列
  (最長経路レイヤリング＋重心スイープ、座標はメモリのみでスキーマに書かない) /
  `popover.js` 矢印＝1本の流れの吹き出し / `loadunits.js` 荷姿カタログのクライアント
  / `vocab.js` 語彙とCSS). **カードを別カードへドラッグ＝つなぐ** (ポート概念なし)、
  空白ダブルクリックで工程追加、矢印クリックで運び方と荷姿。矢印の太さ=物量・
  色=搬送手段・破線=派生/実線=authored。**荷姿の入数は `capacity` が「何を」で
  引く辞書** ({piece:30} / {orikon:14,case:14}) — スカラーとして読むと 0 になり、
  書くと同じ台車の他の組が消える。`loadunits.js` の `capacityKey`/`capacityOf`/
  `withCapacity` が唯一の読み書き口 (台車の入数は其の脚の容器で決まる＝
  「14 オリコン/カゴ台車」). 換算式はサーバの `chain` をそのまま出す (JS で再実装しない).
- `analysis/staffing.py` — 人員タイムチャートの解析ソルバー。工程は編集可能マスタ
  `process_master(model)` 経由 (完全フリー工程; GENERIC_PROCESSES を直接 import しない),
  バッチ投入ゲート (`settings.batch_schedule`, 窓外は窓内クランプ=never-blocks), 入荷の
  時間形状はタイムスタンプがあればデータ駆動 (無ければ従来の 8-16 固定窓と同一)。
  シナリオ保存 + GET /timetable/compare で 作業方式/バッチ別の比較。
- `benchmarks.py` — 生産性ベンチマークライブラリ (物流形態別 想定生産性プリセット;
  the company's 集合知の箱, seeds replaceable). GET /api/benchmarks, POST
  /benchmark/{id}/apply. The 想定 tier of the productivity stack.
- `workmethod.py` `METHOD_PRESETS` (都度/マルチ/ゾーン/種まき = 5軸の各点) +
  `recommend`; `POST /workmethod/compare` runs all 4 via DES (move-vs-sort
  trade-off) → ⑤提案「作業方法比較」 (`js/workcompare.js`: 散布図＋KPI表＋推奨＋採用).
- `pickrate.py` — 生産性試算: 解析的(動作時間)ピッキング生産性. 各作業方式を
  tour≈0.75·√(picks·面積)+2·(搬出距離+通路離脱)+通路変更×detour の動作時間モデルで
  即算出 (no sim, 爆速). BHH項だけだと「棚を斜めに突っ切る」自由移動の値になるので、
  `analytic.py` と同じ `rackgeom.aisle_detour` を課す (ゾーンは蛇行なので通路変更
  あたり ℓ/3 ではなく走長 ℓ). これが無いと retail_dc の移動を 127m/件 と出す
  (DES実測 945m/件) — 生産性試算はそのまま生産性スタックへ採用されるので、
  DESが裏取りできない生産性を売ってしまう. ラック無し＝補正なし (never-blocks).
  SLC流ステップ②: レイアウト幾何(MapMaker距離)×動作時間で オーダー/マルチ/トータル
  を DES 前に当てる. GET /pickrate → ③設計「生産性試算」 (`js/pickrate.js`:
  移動vs仕分け散布図＋KPI表＋推奨＋採用). 重厚なDESは④検証で裏取り.
- 生産性フィードバック: `kpis.measured_productivity` (実測) → ④検証で 想定vs実測 を
  並べ「実測を採用」→ settings.productivity_overrides → cost/timetable に波及.
- `scorecard.py` — 採点表レール: 設計の従属変数6行(判定/人員/原価/生産性/坪数/連鎖)を
  既存純関数(analytic/cost/pickrate/storage)の合成＋連鎖チェックで解析的に即算出.
  `GET /scorecard`(保存モデル) と `POST /scorecard`(編集中セクション上書き=ドラッグ中も
  ライブ再計算). never-blocks. `scenariostore.py` — 名前付きシナリオ(設計スナップ＋採点表)を
  `projects/<name>/scenarios/` に凍結, GET/POST/DELETE /scenarios. → 右常設ドック
  `js/scorecard.js`(Claude Code風 折畳/分割, ②③④表示・①⑤非表示, ③はdesignerと非重複で
  細ストリップ収縮, 比較=なし/最後の実行(DES)/保存シナリオ で▲▼デルタ). designerは
  `whsim:design-dirty`に編集中セクションを載せて発火→app.jsが250msデバウンスでライブPOST.
- `analysis/ingest.py` — ETL: uploaded shipments CSV → `model.orders.outbound`
  (`POST /import/shipments`); real calendar weekday/hour survive via `arrival_s`.
- `bi.py` `derive_volumes` — 仮値 荷姿変換 (パレット/オリコン/カゴ台車); the BI→
  タイムチャート bridge is `bi/apply` → `bi.json` → `timetable/from-bi` (the 物量シミュ
  CTA and マテリアルフロー「基礎物量を取込」 both consume it).
- `cad.py` — tolerant DXF import (ezdxf) → bounds/walls/zones in meters (unit auto-detect).
- `export_doc.py` — editable PPTX + PDF proposal (python-pptx / reportlab, CJK fonts).
- `render/replay.py` — replay contract consumed by both the 2D canvas and 3D (three.js) views.
- `web/static/js/view3d/props.js` + `web/static/concept.html` — **概念シーン**（提案前に
  「新しいやり方がどう動くか」だけを見せる台本）。DES を通さず replay を手書きし、
  レンダラだけ再利用する。追加は汎用プリミティブ `replay.props[]`（箱/円柱/平面＋
  キーフレーム＋**名前付き状態**＝材質入替）と `meta` の `studio`/`bare`/`hide_workers`/
  `camera_track`/`title`/`watermark` のみ。**状態は補間しない**（蓋は開か閉）。
  顧客・方式固有のものはコードに足さず、そのシーンの JSON で props を組む。
  **props は最後の手段**。人=`workers`(人型ピッカー)、作業台=`stations`、
  ベルト=`conveyors`、荷物=`totes`、床の塗り=`zones` は replay 契約に既にあり、
  そちらで書く（props に作り直すと同じ倉庫を2回描くことになる）。この用途で
  契約に足したのは3つだけ: `conveyors[].elevation_m`(2段駆動コンベア)、
  `totes[].belt_id`(どの段に載るか)、`totes[].stack`(容器の段積み)、
  `totes` の state `"<置き場>:<見た目>"`
  (`pack:sealed` 等。蓋が閉まっても箱は台の上＝置き場と見た目は独立)、
  `zones[].opacity`。
  ホストは SPA 外の単独ページ `concept.html?scene=<url>`（時計をページが持つので
  `__conceptSeek(t)` で決定論的コマ送り＝収録が再現可能）。シーン JSON は製品の
  static に置かない。`props` の無い replay は挙動不変（ARCHITECTURE 不変条件16）。
- `render/png2d.py` — proposal PNG (layout + congestion heatmap + verdict + provenance footer).
- `render/anim2d.py` — server-side animated 2D replay GIF (no browser needed).
- `web/` — FastAPI backend + single-page frontend (`static/`). `js/view3d.js` (three.js
  replay — realistic per-`rack_type` geometry, human pickers, pick-event glow) and
  `js/designer.js` (library-&-hotbar layout editor: 3 tabs 配置/フロー/動線. The 配置 tab
  has a persistent object LIBRARY — 棚9種/ゾーン/マテハン設備/躯体 as icon cards; click-to-arm
  or drag-onto-floor, ghost preview at real footprint, digits 1-9 MapMaker-compatible.
  CAD trust: 1m/5m grid, status bar, edge-snap, Shift-ortho walls with live lengths,
  W×D readouts, doors projected onto the envelope; unified select + object inspector,
  棚一括生成 / 面積オート生成, undo) are mounted by `app.js`. Shared frontend helpers
  live in `js/util.js` (`$`/`api`/`esc`) and `js/constants.js` (label/colour maps).
  three.js is vendored under `static/vendor/`.
  `js/progress.js` — 待ち表現: ▶実行/作業方法比較/シナリオ比較は SimPyの
  シミュ内時計(`GET /run/progress` を300msポーリング)を本物の進捗バー＋ETAにし、
  フォークリフトが荷物を運びながら走る(`startRunProgress`); 取込など短い同期処理は
  フォークリフト往復の不確定インジケータ(`forkliftBusy`)。
  The UI is a phase-driven journey (取込→分析→設計→検証→提案) rather than flat tabs:
  `js/journey.js` renders the 5-phase stepper + sub-tabs and drives view selection
  (`switchView` keeps it in sync), `js/overview.js` is the ①取込 landing dashboard
  (readiness checklist + next-step), and `js/phasehint.js` is the per-phase goal/CTA
  banner; Cody and 知見 (notes) are cross-cutting across all phases.
  `cody.py` picks a template by SCORING every manifest's own vocabulary (id/name/
  description, same-script runs, catalogue-wide df cut for boilerplate) — never a
  table keyed by template id, so dropping in `templates/<id>/` makes it reachable
  in chat with no code change (invariant 10). The default template carries a
  head-start so a specialist must clearly win, not merely win.
  The editor saves via `POST /design`; the engine honours per-stage method (manual vs AGV).

### Commands

- Remote access (self-hosted): `WHSIM_PASSWORD` gates **every** route (SPA + all
  `/api/*`) via a signed session cookie — `web/auth.py`, stdlib only, no accounts
  and no third-party IdP; data never leaves `projects/`. Unset ⇒ gate inert (local
  use + tests unchanged), so the fail-safe lives at the bind site: `whsim serve`
  REFUSES a non-loopback host without a password. Intended deployment is loopback
  + Cloudflare Tunnel — see `docs/REMOTE_ACCESS.md`. The KDF is memoised
  (`_key_cache`): deriving per request put 200k PBKDF2 rounds on all ~80 assets of
  a page load and stalled the boot splash.
- Install: `pip install -e ".[dev]"`; web app adds `,web`; CAD/PPTX/PDF add `,docs` —
  everything: `pip install -e ".[dev,web,docs]"`
- Flow: `whsim new <name> -t ecommerce_small` → `whsim import <name> <zip>` →
  `whsim run <name>` → `whsim render <name>` (or `whsim simulate <name>` for run+render);
  `whsim estimate <name>` for the instant analytic estimate; `whsim animate <name>` for a
  replay GIF; `whsim serve` for the web app at http://127.0.0.1:8000.
- Tests: `pytest -q`; single test e.g. `pytest tests/test_engine.py::test_kpis_are_sane`
- Lint: `ruff check src`
- Regenerate template / sample data: `python scripts/gen_template_ecommerce.py`,
  `python scripts/gen_sample_data.py`
- **UI screenshot PDCA (headless)**: playwright is installed and an existing
  chromium lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  (`p.chromium.launch(executable_path=...)`, args `--no-sandbox
  --disable-dev-shm-usage`; add `--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader` for WebGL/3D). Pattern: start uvicorn on a spare
  port → create the sample project (`POST /api/projects/sample`) → optionally
  import `reference/mapmaker/exported/LW.rmpm.json` → drive the UI by clicking
  `.jn-pill[data-phase=…]` / `.jn-sub[data-view=…]` and `#runBtn` (wait for
  `#status` to contain 完了) → screenshot per view. Pre-set localStorage
  `whsim-onboarded-v*='1'` so coachmarks don't cover shots. See the transcript
  scripts in `/tmp/shoot_whsim.py` style; verify shots by Reading the PNGs
  before shipping UI changes.

### Conventions

- Python ≥3.10, pydantic v2, SimPy 4, NumPy, Matplotlib (Agg, headless), Typer.
- Code identifiers/comments in English; user-facing strings and docs in Japanese.
- Add a new template = add `templates/<id>/{template.json,manifest.json}`; no code change.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/warehouse-simulator-qBrf0`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
