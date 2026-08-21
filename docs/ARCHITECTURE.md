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
   - **コンベア** — トリップの2脚が非対称（往路=前回の払い出し点から／復路=最寄りベルトまで）。境界点ごとに通路脱出を計上。**どのベルトが在るか**も一致していなければならない：エンジンは `flowgraph.conveyor_ids_in_use()` で絞り、解析は `resources.conveyors` を全部読むので、**引いたベルトは全部 `flow_edges` の `equipment_ref` で配線する**（片方にしか見えないベルトが最寄りになった瞬間、両者は別の倉庫を計算する）。
   - **コンベア連鎖（詰まり）** — flow_edges で src=pick のベルトが乗り口、dst=pack のベルトが引き込み。終端が次ベルト上（≤0.8m）なら直列接続、引き込みは**始端**が本線上なら分岐。スロット数 = `length / tote_pitch_m`（未指定は歴史既定 1個/m）。トートは hand-over-hand で乗り継ぎ（前進のみ取得＝デッドロックフリー）、分岐では**貪欲ディバート**（空きがあれば入る・無ければその場で本線スロットを保持して待ち、どこかの spur が空いたら再走査）＝仕事保存。引き込みスロットは梱包完了まで保持（引き込み＋台がトートの物理的な待機場所）。目標コミット方式（乗車時に spur を決めて固執）は**禁物**: 空き spur を素通りして最後の分岐でしか待てず、需要超過時に梱包稼働率が 0.62 まで落ちた（貪欲で 0.977、飽和スループットは閉形式能力 923/h の 2.5% 以内）。解析側の鏡: `capacity_line = min(段あたり Σ並列ベルトの v/pitch, μ_pack)`、λ 超過で `time_to_jam ≈ K/(λ−capacity)`（K=制約上流のスロット合計）＋ピッカー到着率を capacity で頭打ち（GTP と同型）。**貪欲ディバートそのものの鏡は `analytic._overflow_cascade`**（引き込みバンク＝順序付きハントグループ＋待ち行列縦続。分割推定は容量以下でしか上界でない — 不変条件17の該当項）。KPI は `conveyor_block_ratio`/`conveyor_time_to_first_block_s`/`kpis["conveyors"]`（ベルト別）。回帰: `tests/test_engine_conveyor_chain.py`（連鎖なしモデルはイベント列バイト同一）＋ `tests/test_analytic_conveyor_jam.py` ＋ `tests/test_analytic_spur_cascade.py`。
   - **梱包台数** — `n_packers`（`engine/build.py`）と `n_stations`（`analytic.py`）はどちらも**ステーション群の合計**。エディタは1台ずつ `Station`（`count:1`）を置くので、`stations[0]` だけを読むと20台の梱包ラインが1台になる。片方だけ直すと稼働率が構造的にずれる。
6. **replay/render は層状契約（V1/V2/V3）**。keyframe・`shelves`・`navnet` の形は **2Dキャンバス(`app.js` `interp`)と3D(`view3d.js`)の両方**が消費する。コメント「**must match the 3D view**」は厳守。新フィールドは additive＋guard（無ければ legacy 描画にフォールバック）、**古い replay を壊さない**。
   **移動する agent は必ず実経路のキーフレームを出す**。2点だけ出すと viewer が線形補間して棚を突き抜ける——距離と時間が正しく通路経由で計算されていても、絵だけが嘘をつく。この穴は同じ形で4回出た（routing graph / navnet / 動線タブ / AGV）。タイミングを変えずに直せる：`kf()` は時刻を引数で取るので、`processes._route_keyframes` のように**角を後付けの時刻で流し込む**（`env.timeout` は1本のまま＝イベントログも乱数列も不変）。端点は `World.stand` の通路面に置く（ロケーションは棚の芯で採番されるため）。回帰は `tests/test_no_rack_penetration.py`（**ラックを描く全テンプレート**×全 agent 種別＝`workers/helpers/packers/inspectors/forklifts/agvs`）。
7. **ビルドレス / npm 無し / vendored**。フロントは素の ES modules（`<script type="module">` ＋ importmap）。three.js と ECharts は `static/vendor/`（importmap で `three`/`echarts`）。**バンドラや `package.json` を導入しない**。
8. **日本語＝ユーザー向け文字列、英語＝コード/識別子/コメント**。
9. **journey→view 規約**。パネルは `<div id="x" class="panel" role="tabpanel">`、ナビは `journey.js` が描く `.jn-sub[role="tab"]`、`switchView`(`app.js`) がステッパーとパネルを同期。**フラット `.tab` マークアップを復活させない**（CSSは削除済）。
10. **新テンプレ＝データのみ**。`templates/<id>/{template.json,manifest.json}` を足すだけ、**コード変更不要**。
11. **ミラー定数は parity を保つ**。Python↔JS のミラー（`timetable`）は parity テスト有り。新たなミラーも同様に守るか、**一つの源から配る**（例 `/api/racktypes` を fetch）。ハードコピー増殖は禁止。**規則そのもの（定数ではなく計算）を写した場合、parity テストでは足りない**: エンジンと解析が各々持っていた「梱包台は誰のものか」は、片方だけが賢くなった瞬間に定数の一致を保ったまま食い違った（実図面で 4台 vs 2台）。**計算を写したくなったら関数を切り出して両者から呼ぶ**（`beltgeom.py` がその型）。
12. **オプション依存**：web app は `[web]`（fastapi/uvicorn）、CAD/PPTX/PDF は `[docs]`（ezdxf/python-pptx/reportlab）。全部入りは `pip install -e ".[dev,web,docs]"`。
13. **業務フロー＝1つのグラフ (`flowgraph.py`)**。whsim は同じ倉庫を3回別々に記述していた: 工程DAG(`WorkProcess.depends`)・ステージ列(`Process.stages`)・物理設備(`Resources`)。①と②で**共有IDはゼロ**、どちらも③の設備を指せなかったので「梱包はこのベルトで受ける」の置き場が無く、エンジンは**幾何的に最寄りのベルト**を拾うしかなかった（＝フローで人手に変えてもベルトが使われ続けた）。`flowgraph.resolve(model)` が唯一の解決器: ノード=工程(`role`でエンジン挙動に写像、`zone`で床に紐付け)、エッジ=`Process.flow_edges`(`transport`＋`equipment_ref`＝どの実機で運ぶか＋`share`)。**エッジ未作成⇒`depends`が含意していたグラフに解決**するので既存プロジェクトは不変。**部分配線が正常系**: 1本だけ配線しても残りは工程順の派生エッジを保つ。エンジンは `conveyor_ids_in_use()` でベルトをゲートする（`None`=どの工程もコンベアで受けない⇒ベルトは動かさない）。描いただけの設備は「物理的事実」であって「設計の意思」ではない — 意思は `diagnose()` が警告で可視化する(never-blocks)。**設備を足したら、そのエッジ意味論もここに書く**。
14. **荷姿と滞留は解析レイヤ (`loadunit.py` / `wipcurve.py`)**。荷姿カタログは `capacity` の連鎖表現で、混載は**占有率の和** `Σ(count/capacity)`（seed 値では既存の平坦式「(OC＋ケース)÷14」と完全一致＝②基礎物量の数字は不動、テストで固定）。カタログは `catalog(model)` 経由で解決（既定同梱・使う辺でその場編集＝SLC型「資材マスタ先埋め」の逆）。滞留は累積フロー図 `WIP(t)=max(0, Σ上流out − Σ下流out)` を人員ソルバーの `headcount×生産性` から算出。上下流は単位が違う（行/h vs 件/h）ので**日量に対する進捗比**に正規化してから辺の荷姿へ換算する。台車は**共有プール**なので保有台数は各辺ピークの和ではなく**和のピーク**。DES はまだ台車を動かさない（明示的な拡張点）。`capacity` は**「何を」で引く辞書**（`{piece:30}` / `{orikon:14,case:14,tray:14}`）であってスカラーではない — 台車の入数は**その辺の容器で決まる**（「14 オリコン/カゴ台車」か「14 ケース/カゴ台車」か）。UI 側で 1 つの数として読むと 0 になり、1 つの数として書くと同じ台車の他の組が消える。読み書きは `js/materialflow/loadunits.js` の `capacityKey`/`capacityOf`/`withCapacity` に集約し、**換算式は JS で再実装せずサーバの `chain` 文字列をそのまま出す**。
15. **作業工程は単一の源 `staffing.process_master(model)`**。固定 `GENERIC_PROCESSES` を直接 import せず、必ず `process_master`/`process_deps` 経由（モデルの編集済 `process.work_processes` があればそれ、無ければ既定6工程）。これでソルバー/原価/生産性/BI/提案出力が**リネーム・追加・削除に一斉追従**する（完全フリー工程）。新規消費側も同規約を守る（直 import 禁止）。
16. **概念シーンは「台本」であって走らせた結果ではない (`js/view3d/props.js`)**。提案の前段には、能力をまだ主張できないのに「新しいやり方がどう動くか」だけ見せたい場面がある。これを DES に通すと、絵を得るためだけに能力モデルを捏造することになる（「不一致だから停Bが開かない」はエンジンには無い事象だし、出てきた成果物は名前を変えても能力シミュレーションのままで、必ず「で、何件/hなの?」を呼ぶ）。なので生産者を差し替える: **replay ドキュメントを手で書き、レンダラ(`Scene3D`)はそのまま使う**。追加したのは汎用プリミティブ `replay.props[]` 1つだけ — 箱/円柱/平面＋任意のキーフレーム＋**名前付き状態**（材質の入れ替え）。状態が要（「蓋が閉まった」＝数字を出さずに何かが変わったと言う唯一の方法）で、**状態は補間しない**（蓋は開か閉で、40%閉まってはいない）。顧客・方式固有のものはここに書かず、そのシーンの JSON で props を組んで表現する。**`props` は最後の手段**。人・作業台・コンベア・荷物・ゾーンは replay 契約に既にあり、そちらで書く（`workers`＝人型ピッカーの歩容/リーチ/状態色、`stations`＝天板高さが `pack` トートの載る高さと一致する作業台、`conveyors`＝トレッドが流れるベルト、`totes`＝ハンドオフと接地影つきの箱、`zones`＝2Dキャンバスと提案PNGが同じものを描く床の塗り）。props に同じものを作り直すと、同じ倉庫を2回描くことになる。実際その順で作り直したとき、既存側にしか無い表現（ベルトのトレッド、人の歩容、箱→人への受け渡し）が全部落ちた。`meta` のスイッチも汎用: `studio`(躯体/グリッド/写実床を落とす＝概念モデルは建屋形状を主張できず、グリッドは実測値の含意)・`bare`(HUD/凡例/クリック吹き出し＝どれも測定値を画面に出す)・`hide_workers`(人を描かない)・`camera_track`(台本カメラ、ユーザが触った瞬間に譲る)・`title`/`watermark`。ホストは SPA ではなく単独ページ `static/concept.html`（`?scene=<url>`）で、時計をページが持つ＝`__conceptSeek(t)` で決定論的にコマ送りでき、収録が再現可能になる。**シーンの JSON は製品の static に置かない**（誰かのレイアウトであって製品資産ではない）。すべて additive で、`props` の無い replay は 1 バイトも挙動が変わらない。
17. **ライン運用の機構は「意思」であって幾何ではない**（`Conveyor.stop_gate`/`load_kind`、`Process.container_pool`、`Process.divert_policy`、`Process.release_schedule`、`Process.bench_staging`）。1本のベルトの上を2種類の荷が同時に流れ、容器は有限で循環し、引き込みは自動ではなく人が引き、末端のストッパーは選り分けずに全部止め、完成品は台の脇に溜めて周期的にまとめて流す——どれも**図面には描けない**（描けるのは線と箱だけ）。**全部 opt-in・既定オフで、同梱テンプレートは全部オフ**（HEAD の worktree に対してイベントログ/キーフレーム/replay/判定文までダイジェスト一致を確認済み。KPI が additive キーを増やすだけ）。
    - **選択停止**は「ゲートの手前でベルトが早く終わる」として実装する。荷は種別（乗ったベルトが押す `load_kind`）を持って運ばれ、止まる種別だけがゲート位置で降ろされ、**降りるまでスロットを保持する**。連鎖には既に「荷がベルトを降りる」規則が1つあるので、それを再利用すれば滞留と背圧はそのまま落ちてくる（2つ目の規則を作らない）。選択は3値で never-blocks: `stop_states` が勝つ／無ければ `pass_states` 以外が止まる／どちらも無ければゲートではない。停止線に**立っている梱包台**がそのゲートの台になる（引き込みの台と二重取りしない）。
    - **有限容器**は**投入時に確保する**（ベルトのスロットを取る前）。空なら投入が止まり、不足がピッキングまで遡る。人手/AGVの脚は自前の容器を持つので**ゲートしない**（有限なのはライン上の循環在庫）。空容器は還流ベルトを**幾何としてだけ**使う（スロットを取り合わない＝稼働線のコンベアKPIを薄めない）。読み出しは `containers_in_use_peak`＝**必要保有数の下限**。`peak == pool_size` は「天井に当たった」であって答えではない — **答えが信用できるかが同じ表から読める**のがこの機構の値打ち。
    - **pull型引き込み**では、荷は「通過する瞬間に台が空いている引き込み」にだけ入り、**空きが無ければ本線で待たずに通り過ぎる**（停止線/末端へ）。貪欲ディバートは人員に盲目で（台を3→1に減らしても分岐数は 74→74）、pull は素直に落ちる（72→40）。
    - **物理ストッパーは選択停止の反対**（`stop_gate` の `mode: "all"`、`build.Stopper`）。実案件で確定した運用は「停止線＝ただの物理ストッパー、荷がぶつかって止まるだけ」で、**選択性は無い**。選り分けているのは時間（下の時間分離）。すると末端の列は死荷物ではなく**取り置きバッファ**になる: 列は 1個/`tote_pitch_m` ずつ上流へ伸び（`Stopper.arc_of`）、**列の尻が自分の合流点まで戻ってきた引き込みの作業者は、流れている荷ではなく止まっている荷を引ける**（`Stopper.reach_index` / `processes._pull_from_stopper`、既定 `pullable` は `mode` に従う）。届く範囲は合流点に一番近い1個だけ——本線を歩いて拾いには行かない。停止線に梱包台が描かれていればその人も取る（`stopper_take`）が、**専任の番人は前提にしない**（描かれていなければ出口は「引き込みが引く」か「リリースで流す」の2つだけ）。
      **デッドロックしない理由を書いておく**（止まった荷が本線のスロットを持ち続けるのはバッファの実体なので、「本線が引けない荷で埋まる」形だけは構造的に潰しておく必要がある）: ①列の荷が待つのは**人の判断**であって上流が握る資源ではない。しかも**引く側がスロットを先に確保してから**列の荷を起こすので、列の荷が本線のスロットを握ったまま下流の待ち行列に並ぶことは無い＝待ちグラフは前向きのまま。②唯一の循環候補は staging 経由（梱包者が満杯の置き場を待つ→空けるのはリリース→リリースは本線のスロットが要る→そのスロットは列の荷が持っている）なので、**開放したら列は全部流す**し `auto` で分岐待ちに止まっている荷も同じ開放で叩き起こす（`Stopper.open_ev`）＝開いている間、本線のスロットは必ず有限時間で空く。③よって「列が届いている引き込みが1本でも人付きで開いている」限り、台が空くたびに列から1つ抜けて前へ詰まる。④どこにも届かずリリースも無い図面では線は**本当に止まる**——人を発明しないのが正しい答えで、`stopper_queue_peak` と判定文が原因と直し方を名指しする（`pack_unmanned` と同じ扱い）。
    - **時間分離は2モードの運用**（`Process.release_schedule`）。mode_A＝ストッパー閉・検品済みが流れて作業者が引く。`period_s` ごとに mode_B＝台の完成品をまとめて本線へ載せ、**ストッパーを開けて**カーブ→積み付けへ流す。開放中は本線が完成品に占有されるので**検品済みの投入は止まる**（`_induct_slot`。窓はスロットを待っている間に開くので、確保した後にもう一度見る——見ないと「開いた瞬間に入って、そのまま流れ出る」荷ができて時間分離が分離しない）。その保留秒数 `stopper_induction_hold_s` が**リリース周期の判断材料そのもの**（周期を伸ばせば滞留と必要置き場が増え、縮めれば干渉が増える）。開放は**前に居るものを全部**流すので、まだ梱包していない検品済みも出て行く: これは完了オーダーに数えず `stopper_leaks` として数える（未梱包の出荷を成果として売らない）。`window_s` 0 は「出し切るまで」だが `period_s` で頭打ち＝窓は必ず閉じる。積み付けは `stack_rate_per_hr`/`stackers`（未指定＝制約なし）、載せる手間は `board_time_s`（既定0＝測っていない秒数を推測しない）。
    - **完成品staging は背圧でしか測れない**（`Process.bench_staging`、`capacity` は**梱包台1台あたり**）。梱包の出口は次のリリースを待つ置き場で、満杯なら**梱包者が台とベルトのスロットを握ったまま止まる**。その背圧だけが「置き場を何台分取るか」を決めるので、`bench_staging_peak`（＋帯ごとの `conveyors[belt].staging_peak`）がそのまま提案に乗る。`bench_staging_peak == bench_staging_capacity` は天井に当たっただけ＝答えではない、が同じ表から読める（容器プールと同じ読み方）。**流す手段（リリース）が無いモデルでは不活性**: 出口の無いバッファはバッファではなく壁で、ラインを黙って止めるだけ。
    - **ピークは平均してはいけない**（`kpis._EXTREMUM_KEYS`）。`bench_staging_peak`/`stopper_queue_peak`/`stopper_trunk_occupancy_peak` は **max** 集約＋「いつ」はその回から（`_MOMENT_OF`）、帯ごとの `staging_peak` は `_PER_BELT_MAX_KEYS`。置き場の面積とレンタル数量は同じ性質の数字で、平均するとどの回でも観測されなかった小さい値を売ることになる。
    - ⚠️ **物理ストッパー / 時間分離リリース / 完成品staging に解析側の鏡は無い。`analytic` は名乗って降りる**（`_unmirrored_line_mechanics` → `conveyor.line_mechanics_mirrored: false` ＋ `unmirrored: [...]`）。降りる先は歴史的な連鎖の答え（`_conveyor_estimate`）で、**`linemech.gate` も `linemech.pull` も使わない**——どちらの導出もこの形の線では成り立たないから: pull は「引かれなかった荷は失われる」損失系だが**ストッパーはそれを待ち行列に戻す**（後で引ける・開放で流れる）し、停止線の式は**ゲートに立つ手をサーバに置く**が物理ストッパーに番人は居ない。**黙って別の機構の式を当てるのが一番悪い**ので、宣言して DES に渡す。宣言キーは**降りたときだけ**出る（何も書いていないモデルには出ない＝同梱カタログはバイト同一）。
      安い上界 `capacity × (1 − 窓の割合)` は**測った上で捨てた**: 「開放中は投入が止まるのだから能力はその分減る」は induction の話で throughput の話ではない——ストッパーの手前は数十スロットのバッファで、窓の間も梱包台はそこから食い続ける。合成ラインで 周期900s/窓300s（割合 1/3）のとき上界 80件/h に対し**実測 81.5件/h**＝甘い側に外れる上界は上界ではない。窓の割合は `release_window_share` として**開示だけ**する（能力には一切かけない）。再導入を防ぐ計測は `tests/test_line_stopper.py::test_the_cheap_window_share_bound_was_measured_and_is_not_a_bound` に残してある。
      解析の述語は `engine.build` の写しなので、**一致していることを `test_the_predicates_read_the_same_drawing_the_engine_wires` が固定する**（不変条件11）。ずれた瞬間、鏡の無い機構を鏡があるものとして価格してしまう。
    - **図面はゲートの「位置」までは言える**。停止線は流れを横切って引かれるので、`rmpm.resolve_stop_gates` が交差（と 1.5m 以内の近接）で解決する。受け渡し点では複数ベルトが数cm内にいるので、**「停止線は自分に向かってくる荷を止める」**（線がベルトの下流側にある）を条件にしないと、幾何的最近傍がカーブや還流ベルトを掴む。止める荷/通す荷は名前が書いていれば読む（`stop_rule_from_name`）、書いていなければ**何も止めないゲート**を置く。
    - **停止線は「通り過ぎる荷」を止める**。ゲートより下流で乗った（＝既に手前に居る）荷は無関係で、そのまま走り抜ける。`end_arc = min(gate.arc, length)` に下限が無かった間、そういう荷は**時間ゼロで後ろへ引き戻され**、間違った場所で梱包され、乗車位置とゲートの間の引き込みが分岐候補から消えていた。
    - **台数の話は3つとも「誰が居るか」に帰着する**（`beltgeom.bench_pools` の4値）。人の居ない引き込みが共有プールへ落ちると、pull では「**空いているか**」を床全体に尋ねることになり、**人が居ないほど強い引き込み**が生まれる（台0が53件、台1の隣が20件）。落ちる先は**誰の持ち物でもない余り台**（`World.spare_bench`）だけで、余りがゼロなら借りるものは無い＝その引き込みは動かない。
    - ✅ **解析側の鏡は `whsim.linemech`（機構ごとに1モジュール: `gate.py`/`container.py`/`pull.py`）**。`analytic.estimate` は**機構が書かれている時だけ**その枝に入り、モジュールは**その枝の中で遅延 import** する（同梱テンプレは3つとも書いていないので `whsim.linemech` を import すらしない＝カタログはバイト同一・爆速のまま。`tests/test_analytic_line_mechanics.py` が「入口関数が呼ばれないこと」で固定する — 出力の一致より強い）。図面の読み方は**一つ**: 連鎖は `analytic._belt_stages`（＝`build._wire_conveyor_chain` の答え、additive キーで entries/succ/spur_ids も返す）、幾何は `beltgeom`、**梱包台の持ち主と余り台と停止線の作業者**は `linemech.bench_ledger`、**引き込みの合流点**は `linemech.junctions` — 3機構が各々写しを持てば、一度ドリフトした規則がまた3つに分かれる。
      - **選択停止** `gate.gate_line_estimate` — 荷種別ごとの経路 × (梱包台のHall条件 / 蓄積 / 搬送) の最小。実測 |Δ梱包稼働率| 平均0.010・最大0.028（36構成、機構なしだと平均0.289・最大0.669）、`X_meas > 1.05×capacity` は0件。
      - **容器** `container.container_estimate` — 閉鎖型待ち行列＋Little。滞留 中央値0.4%、`binds` の境界は厳密、`required_pool` は20seed中19-20をカバー。**additive で headline を動かさない**（エンジンは投入待ちをピッカーの busy に数えないので、λ を絞ると解析だけ甘くなる＝不変条件5違反。実測 0.110 対 0.155）。答えは `conveyor.containers`（容器はベルト受け渡しでしか取られないので、ラインの答えにぶら下がる＝トップレベルのキーは1つも増えない）。
      - **pull型** `pull.estimate` — 引き込みは待ち行列でなく**損失系**（Erlang-B のオーバーフロー縦続）。引込率 rms 0.008（36構成）、梱包稼働率は 0/36 で甘い側なし。
      - ⚠️ **末端に人が居ないラインは「止まる」と読む**（`_bench_pool` が `None` を返す＝`pack_unmanned`）。閉形式は**トランクが埋まるまでの銀行の能力**で価格するので、走らせた地平線平均（＝止まった後も含む）より**最大 0.67 辛い**。安全側だが緩い。地平線平均に寄せると甘い側へ倒れるので、意図的にこの側に置いてある。
      - ⚠️ **停止線と pull を同時に書いた図面**はどちらの導出でも検証していない組み合わせ。`_line_estimate` は **pull を優先**する（分岐の規則の方が上流）。停止線の作業者は pull 側の末端プールとして数えるが、種別ごとに別のプールへ行く分割は見ていない。
      - ⚠️ **容器は「種別ごとに1本の代表経路」で価格する**。本線に**大きく違う位置で合流する2本の検品ライン**（遅い方はバンクを丸ごと通り越す）は、その荷を最後の引き込みが取ったものとして数えるので**甘い側**に出る（飽和時 滞留 179s 対 実測 500s。停止線の有無に依らないので停止線の問題ではない。同梱 `line_inspection` は弱くこの形で +17%＝辛い側）。`pull` 下では貪欲のカスケードを使うので +27〜31%（辛い側）。
    - ✅ **既定の `auto` は「逐次オーバーフローの待ち行列縦続」で価格する**（`analytic._overflow_cascade` と補助 `_spur_serve_s`/`_bank_rate_profile`/`_bank_chain`/`_queue_prefactor`/`_fill_share`/`_stage_room`/`_bank_of`。3機構と違い**既定経路なので `analytic.py` 内**に置く＝`linemech` を import しない）。以前は引き込みへ `lam/本数` を均等に配って各々の `_mmck_full` を平均していたが、貪欲ディバートは**空きのある最初の分岐**を取るので分割ではなく**順序付きハントグループ**（実測の前詰め: ρ_bank=1.0 で 236/229/189、1スロットずつなら 117/117/116）で、しかも溢れは**損失ではなく待ち行列**（どこにも入れない荷は本線のスロットを保持したまま止まる＝背圧そのもの）。導出は3段: 水詰め `_bank_rate_profile`（N個居るとき何台の梱包台が動くか＝**エンジンの充填順**であって下界ではない）→ 上流ベルトを待合室にした1本の生死過程 `_bank_chain` → 段ごとの水位は**累積**（引き込み ΣK → ＋本線 → ＋検品ライン）で**その順に埋まる**。段の答えは**3読みの最悪値**: 定常鎖（容量直下）/ 流体充填（容量直上。バッファ全体に**1回**の充填時間を課す旧式が、同梱 `line_inspection` 2倍需要を 0.00 と読んだ元凶——実際は引き込みが1.9h・本線が3.5h・検品ラインが6.2h で埋まる）/ **有限地平線のランダムウォーク** `_fill_share`。ρ=1 で待ち行列は**零再帰**＝定常解が無く、「何割詰まるか」は**シフト長の関数**になる（6引き込み ρ_bank=1.00 で 8h 0.25・18h 0.47、有限バッファ定常はどちらも 0.01）。⚠️ **3読みのどれも上界ではない**（`_fill_share` は重交通近似、分散率 `_FILL_VAR = 2.0` は**較正値**——バンクの処理率は占有率で変わるので定率拡散に無い押し上げがある。M/M/1 値だと臨界近傍の余裕がほぼ消え、実測 0.5833 対 0.5828 ＝甘い側へのコイントス）。したがって `max()` が誠実さの本体で、検証は**実測**でしかできない: 270構成8時間で甘い側 **202→2**（最悪 −0.815 → −0.001＝850回に1回のブロック＝走行ノイズ、しかも分割の方が勝つ行）、平均|誤差| 0.178→0.068、ρ_bank 0.85〜1.4 帯は**甘い側ゼロ**。`line_inspection` 2倍需要は 実測0.52 に対し 0.00 → **0.78**（辛い側）。**カタログはバイト同一**——全10テンプレは容量から十分遠く、縦続 (~1e-6) が歴史的な分割推定に負けるので `max()` は分割をそのまま返す（歴史的分割は**容量以下でのみ**上界なので `FLOOR` として残す）。実測値で `tests/test_analytic_spur_cascade.py` が固定。爆速も維持（最重 5.9ms／予算 50ms）。付随して**引き込みの乗り込み死に時間**（`_spur_serve_s`: `K ≤ c` は蓄積が無いので毎周期 ride を払う＝公称能力が出ない）と、**閉じた引き込み**（`_open_spurs` が `build` の2つ目の規則「`claimed` かつ `spare == 0` なら台を持たない引き込みは全部 `closed`」まで写す。以前は `NO_HANDS` しか見ておらず、人の居ないベルトの速度とスロットが段の算術に入っていた＝甘い側）も同じ枝で閉じた。⚠️ 停止線も `build` では梱包台を取る（`spare` が更に減る）が、停止線のある図面は `linemech.gate` が価格するのでこの枝からは届かない——ただし**甘い側の隙**なので明記しておく。
18. **MapMaker の意味は名前にしか無い**（`rmpm.classify_name` / `_NAME_RULES`）。形式には z 座標が無く、種別も3つ（棚/壁/作業台）しか無い。だから2段駆動コンベアの上下段は**同一XYの2オブジェクト**、停止線と仕切りは**WallObject だが障壁ではない**、人の立ち位置は**500mm角の作業台**として描かれる——形式に無い情報は、**作図者が名前に書く**しか置き場が無い。判定は**1つの表**に集約し、**名前が先・`type` が fallback**（規約語ゼロの図面はバイト同一）。以下は全部、実図面で外して初めて分かった規則:
    - **注記より先に頭を見る。しかも頭だけを見る**（全文へのフォールバックは無い）。注記は平気で他の設備を名指しするので（`検品者立ち位置マーカー(西・仕切り付近)` は人であって区画線ではない、`投入口(検品済オリコン→下段本線)` はシュートであって本線ではない）全文一致だと**人が1人消える**。そして頭が何も言わないとき全文へ落ちると、**WMSのロケ番地**（`100-01-09(検品者側)`）が注記に食われて**描かれた棚が0本**になる（保管ゾーンごと消える）。同じ理由で `_half_key`/`_belt_elevation_m`/`_belt_direction` も頭を読む——全文だと `本線コンベア(還流は西向き)` でベルトの向きが反転し、連鎖の位相が丸ごと裏返る。
    - **形式が種別を持つものは名前表に勝つ**。`FreeShelfObject` は「棚である」と形式が言っているので、名前が何であれ棚のまま（食い違いは警告で出す）。名前表が要るのは**形式が黙っている**もの（段・非障壁・人・搬送設備）だけ。
    - **種別は最後の名詞で決まる**（表の順ではなく右端の一致）。日本語の名前は修飾が前に来るので、`引き込み3-梱包台07` は梱包台、`仕切り側 引き込みコンベア2` はコンベア、`本線コンベア用 停止位置マーカー` はマーカー。表の順で決めると**描いた梱包台20台が幻の1.4mベルト20本**になり、しかも「搬送設備として取り込みました」と成功のように報告される。
    - **半分ずつ描かれたベルト**（`北半`/`南半`）は結合するが、**両方の名前が相方を名指しする**（`北半…｜南半と一体`）ので**全ての半語を消してから**キーを作る（1つだけ消すと永久に揃わない）。
    - **荷の種別 (`load_kind`) の作り手もここ**。停止線は種別で選り分けるのに、それを押すベルトが居なければゲートは**1件も止めない**（`pass_states` だけ書けば逆に全部止まる）——どちらも沈黙する。名前が `荷=…` と言っていればそれ、言っていなければ**ゲートへ荷を運ぶ上流のベルト**の種別として推定し、**推定したと明示する**。ゲートは*armed*（止められる）と*pending*（規則はあるが種別待ち）を区別して報告し、**モデルが未完成だからという理由で図面の規則を消さない**（取込の後で `load_kind` を入れる運用があるので、消すと 2倍の能力差が黙って出る）。
    - 1本のベルトに停止線が2本なら**上流側を採り、落とした方を名指しで警告**する（エンジンの `Conveyor.stop_gate` は1本しか持てない）。同距離の候補は **belt id** で決める（`beltgeom.attach` と同じ規則＝図面の並び順に依存しない）。
    - **インポータは `discharge_both` を決めない**。「無動力・両側から引く」と名前に書いてあっても設定しない——能力が倍になるつまみを図面の言い回しから推測させない（テストで固定）。
    **新しい語を足すなら、この表と `tests/test_rmpm_naming.py` の両方に足す**。

---

## 2. モジュール地図

### データモデル（中核）
- `schema/model.py` — 正準 `WarehouseModel`。全フィールド default。**ここが土台**。

### 取込 / ETL（寛容）
- `importer.py` — ZIP→subtree deep-merge。`mapcsv.py` / `rmpm.py`（MapMaker地図CSV / ネイティブ.rmpm.json）/ `tabular.py`（汎用CSV/Excel）/ `cad.py`（DXF）。各々 `/api/.../import-*` ルート。
- `mapmaker_kpi.py` — **MapMaker カスタム版 v4.5+ の 3D/KPI JSON**。実サンプルが無いので**意味ベースの別名表**（`FIELD_ALIASES`/`CONTAINER_ALIASES`）でキーを受け、当てられなかったキーを `probe` に全件列挙する（`?probe=true` / `whsim probe-kpi` は**書き込まずに**答え合わせだけ）。段数は **v4.9 統一規約**（段数=パレット段数、逆ネス 基数=段数−1、有効ロケ数=間口×段数）で、段×間口の展開規則は `locmaster`/`design.materialize_racks` と同一。段数が載っている以上 MapMaker の数え方が正なので `materialize_racks` では上書きしない。想定キー表は `docs/mapmaker-v5-import.md`。
- `locmaster.py` — ロケマスタ。図面の棚に載せる既定経路に加え、**MapMaker 出力列**（`エリア,列,棚,段,間口,フルロケ,X,Y,什器種別,什器名,面積[,ゾーン]`）を認識して **X/Y(mm) から直接配置**する経路（`build_layout` / `place=direct`）を持つ。「面積」「ゾーン」は部分一致で「エリア」に食われるため**先に確定**してから残りを解決する。
- `cad.py` — DXF。**CONVEYOR レイヤ→`resources.conveyors`（壁にはしない＝二重計上しない）**、**SHELF レイヤ→`zone.shelves`**、その他は従来どおり壁。
- `distances.py` — 実測 棚間距離行列（最大級ファイル；`engine/graph.py` と距離で概念重複）。
- `rackgeom.py` — **描かれたラック＝ジオメトリの唯一の真実**。`rack_rects`（描画と routing 障害物の共通元; `(x,y,w,h)` であって `(x0,y0,x1,y1)` ではない）＋`aisle_block`/`aisle_detour`/`aisle_escape_m`（通路travel の閉形式＝解析側の補正; `analytic.py` が消費。`aisle_escape_m` は1点分だけを再利用するための切り出し＝ベルト境界点ごとの評価に使う）。
- `beltgeom.py` — **引き込みの合流点・払い出し口・梱包台の持ち主＝唯一の規則**（純幾何・simpy非依存）。`engine/build.py` と `analytic.py` が**同じ関数を呼ぶ**（以前は各々が写しを持ち、エンジンだけが賢くなって実図面で **エンジン4台 / 解析2台**、共有台は**解析が両方に計上**＝人より多いサーバ数＝**DESより甘い**＝不変条件5が唯一禁じる向き）。`JOIN_TOL_M`/`BENCH_REACH_M` もここが源（両者は再エクスポート）。
  - `feed_point` — **どこで荷が入るか**。端が本線に載っていればそこ（従来どおり arc 0）、**載っていなければ2本の経路が最も近づく点**。これが無いと、本線を**真ん中で跨ぐ**引き込みは合流点を持てず、梱包台だけ持って**一荷も受け取らない死んだベルト**になる。オーダーは完走する（全部が末端の共有プールで梱包される）ので外からは正常に見え、図面の機構だけが丸ごと消える。
  - `discharge_ends` — **どこで荷が降りるか**。ベルトは一方向に走るので既定は `points[-1]` 側だけ＝反対側の台は**届かない**。`Conveyor.discharge_both`（＝無動力ローラを両端から人が引く）と図面が言ったときだけ両側。**図面は普通どちらとも書かない**ので既定は安全側。
  - `bench_pools` — **共有台は最寄りの引き込みのもの・二重に数えない**。4値: `n`／`CLOSED`=描かれているが人0／`LOST`=手は届くが隣が持っている／`UNSTAFFED`=誰も描かれていない→余り台へ。`LOST` を `UNSTAFFED` と混ぜると「**人が居ないほど強い引き込み**」が生まれる（pull で台0の引き込みが53件、台1の隣が20件）。
- `linemech/` — **ライン運用3機構の解析ミラー**（不変条件17）。`gate.py`（選択停止）/ `container.py`（有限容器循環）/ `pull.py`（pull型引き込み）＋パッケージ直下の共有層 `bench_ledger`（梱包台の持ち主・停止線の作業者・余り台＝`processes._bench_pool` の答え）と `junctions`（引き込みの合流点＝`build` の枝分かれ規則）と `resolve_gate`/`gate_stops`（＝`build._resolve_gate`）。連鎖そのものは持たず `analytic._belt_stages` を受け取る。**`analytic.estimate` からは機構が書かれている枝の中でのみ遅延 import**（既定オフ＝import すらされない）。
- `provenance.py` — 出所追跡。

### エンジン（SimPy DES）
- `engine/`：`processes.py` / `graph.py`（壁考慮グリッド＋Dijkstra＝**timing権威**）/ `navnet.py`（MapMaker風 Delaunay waypoint網＝**viz層**、facing開放面ピック点）/ `build.py` / `run.py` / `routing.py` / `pickroute.py`（S字/折り返し/最大ギャップの訪問順序＝純関数; `process.routing_policy` で切替、既定 nearest は不変。`routecompare.py` が4方式＋2-optの距離比較表） / `scenarios.py`（dotted-path what-if ＋ `whatif(base, edits)`=diff→ヘッドレス実行→サマリ）。
  **通路干渉**（`simulation.aisle_interference`, 既定 False=バイト同一）: 歩行レグをセル×進行方向の容量1リソースに分解し、同方向の2台目は**待つ**（`aisle_wait` イベント）。待機中は何も保持しない（ノードで待つ）＝循環待ちが構造的に不可能、それでも 3×通過時間で強制通過＋`aisle_pass_forced`（never-blocks）。KPI: `congestion_*`（待ち合計/共有率/p95/top_cells）、判定文は待ち共有率>15%で1文追加。集計器 `kpis.wait_stats` は M/M/1 の Lq=ρ²/(1−ρ) と±5%で突合済（`tests/test_aisle_interference.py`）。逆方向は独立（通路幅で離合可能の仮定）。
  **解析側の扱いは2つの機構で違う**（`tests/test_analytic_aisle_interference.py`）: **通路干渉は上界として映す**（`analytic._aisle_congestion`。セル1つ＝容量1のM/M/1、格子ピッチは約分で消えるので**歩行「時間」の倍率**であって距離は1mも動かさない。ρ は Little から `λ·travel/v ÷ 2·通路数·ℓ/g`、外周一周を下限に置く。同速の追従は自己消滅する—一度待てば以後は1セル後ろを付いて行くだけ—ので実測 9.1〜23.0倍 甘くない側に外れる。秒では緩いが真の効果が歩行時間の0.03〜0.17%なので**稼働率としては丁度**）。**非既定ルーティングは測った上で映さないと決めた**: DES自身の感度が9テンプレ中7で歩行の1.5%以下・稼働率で0.013以下（一致ピン0.08の6分の1）、エンジン自身の `route_order` から組んだ閉形式は**オラクルを悪化させ甘い側へ倒した**（平均 6.8%→10.0%、最大 15.5%→31.0%; `_batch_per_trip` のバッチ誤差を非線形に増幅し、同梱テンプレの出荷口が全部ラック帯の中ほどを向いているため）。代わりに `routing_policy`/`routing_policy_mirrored` を**名乗る**。⚠️ **`apparel` は s_shape、`food_chilled` は return を既に使っている** — 「既定nearestだから無害」は事実として誤り。AGV同士の干渉（`process.agv_interference`）は**まだ**未鏡写し。
  **実行時貫通検査**（常時）: 各 rep 後に replay キーフレーム×描かれたラック矩形の貫通を検査（`rackgeom.track_penetrations`）、`RunResult.path_violations`→KPI・判定文へ。**イベントログは run 成果物**（`events.jsonl`、`eventlog.py`; `GET …/runs/{run}/events.{jsonl|json|csv}`）。

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
- 編集/3D：`designer.js`（ファサード）→`designer/`パッケージ（`core`=クラス本体/状態/座標/入力/undo/保存＋prototype合成、`library/place/render/shelf/flow/route/side`=ミックスインで機能別分割、`constants/geometry`=データ純関数）（ライブラリ&ホットバー型エディタ：配置/フロー/動線の3タブ。配置＝常設オブジェクトライブラリ（棚9種/ゾーン/マテハン設備/躯体のアイコンカード、クリック装備 or 床へD&D、実寸ゴースト、数字1-9はMapMaker互換）＋CAD流の信頼感（1m/5mグリッド・ステータスバー・エッジスナップ・Shift直交壁＋長さ表示・W×D表示・ドアは躯体エッジへ投影）＋統一選択/インスペクタ。動線＝経路ネットワーク自動生成：`POST /api/routes/network`（ステートレス、エンジンと同じ `engine.graph.AisleGraph` で壁・棚を迂回）で通路網表示・A→B計測・工程フロー動線の一括生成、手描きはフォールバック）・`view3d.js`（ファサード/シェル）→`view3d/{constants,geometry,scene,agents,overlay,props}.js`（three.js・rack_type別リアル形状・人型ピッカー・pick発光・ホバー/追従/選択・preset・ボトルネック強調。prototype合成で機能別分割）。
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
- `props[]`（**概念シーン専用・任意**）：`{shape:"box"|"cyl"|"plane"|"label", x,y,z, w,h,d|r, ry, color, opacity, wireframe, parent, from,to, label, states:{name:{color,opacity,wireframe,emissive}}, state, keys:[[t,x,y,z,state]…]}`。`y` は**箱/円柱の底面**（床置きが `y:0`）。位置は補間、**`state` は補間しない**。`meta.camera_track:[{t,pos,look,cut}]` で台本カメラ、`meta.studio`/`bare`/`hide_workers`/`title`/`watermark` で概念モード。`render/replay.py` はこれを出さない — 手書きの台本 JSON だけが持つ（不変条件16）。
- `stations[].w` / `[].d`（任意）：作業台の平面外寸(m)。無ければ従来の固定 2.0×0.9。台の**長辺の向きが「誰がどこに立つか」を決める**ので、引き込みコンベアを挟んで向かい合う梱包台の列は、これが無いと全部横向きに描かれる。`Station.w`/`.d`（既定 `None`）から素通しし、**`None` の時はキーごと出さない**（`null` は 3D 側で 0 と読めてしまう）。2Dキャンバスと提案PNGは作業台を点で描くので不変。
- `conveyors[].elevation_m`（任意）：ベルトのトレッド高さ。既定は従来どおり 0.21。**2段駆動コンベア**（上段＝出、下段＝空容器の戻り）は実在のハードで、これが無いと上段の箱が下段を突き抜ける。**保存モデルからも書ける**：`Conveyor.elevation_m`（既定 `None`）を上と同じ規約（`None` はキーごと出さない）で素通しする — 1つの footprint に2枚のデッキが載るので、平面座標だけでは段を表現できない。`totes[].belt_id` を書くと、その箱は**そのベルトのデッキ**に載る（ベルトから離れている間は接地高さに戻る）。同じ平面位置に2段あるので、幾何だけでは段を選べない。`totes[].stack`（既定0）は容器の**段積み**: 同じ (x,z) を通る2本を stack 0/1 で書けばコンベア上で2段に積まれる（同じ搬送で倍運ぶのは普通の運用）。段は**キーフレームの5要素目**で上書きでき、状態と同じく補間しない — 積まれた荷は途中で人が降ろすものなので、段は一生ものではなくその時の状態。
- `totes[].keyframes` の state は `"<置き場>"` または `"<置き場>:<見た目>"`。置き場は既存語彙（`carry`/`pack`/`belt`）で**どこに在るか**、見た目（`sealed`/`open`/`hold`）は**どう見えるか**。両者は独立で、蓋が閉まっても箱は台の上のままである必要がある（動かして表現すると工程について嘘をつくことになる）。コロン無し＝従来の挙動。
- `zones[].opacity`（任意）：既定 0.22 は写実コンクリートの上の「ヒント」。床の色そのものが主張（位置＝状態）の場合だけ濃くする。
- 追加フィールドは additive＋guard（無→legacy描画）。

### ロケーションマスタ写像（取込）
- `フルロケ`（または エリア/列/棚）→ **エリア-列-棚** に正規化（各部2桁ゼロ詰め）。マスタはゼロ詰め・出荷履歴は非ゼロ詰めが普通なので、**正規化しないと実顧客の2ファイルは一致0件**になる。粒度も図面（MapMaker の棚名）に合わせる — 間口粒度では0%、棚粒度で実案件54%が解決した。
- 段の異なり数＝その棚の段数、`什器種別`→`racktypes` id。座標は**図面の棚の中心**を使う（マスタのX/Yではない。3Dの棚は図面から生えるので、数cmずれるだけで在庫が棚の脇に浮く）。
- 図面に無い棚は置かない。ただし黙って捨てず `in_layout:false` で返す（平置き・仮想エリアの存在は情報）。別サイトのマスタを食わせたら一致0件と言う＝寄せない。

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
