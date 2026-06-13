# whsim 競合ベンチマーク — 倉庫設計インテリジェンス（2024–2026）

> 目的：whsim が「市販品を超える」ために、各カテゴリの実力と**埋めるべきギャップ**を事実ベースで把握する。
> 調査は Web 検索＋一次/三次ソースで実施（多くのベンダー公式は 403 のため、公式スニペット＋独立レビュー＋査読論文で裏取り）。出典は各節末。確度は明記。

## 0. 要約（whsim の勝ち筋）

調査した**どの市販ツールも、whsim が狙う一点を満たさない**：

> **「非技術者がテンプレからゆるく入力 → 裏で重厚DES → スロッティング/ピック方式を内蔵最適化 → 提案グレードのワンショット成果物」**

- **汎用DES（Witness / Simio / FlexSim / AnyLogic）** … 計算精度は最強クラス。だが **スロッティング最適化は内蔵ゼロ**、ピッキング方式（バッチ/ゾーン/ウェーブ/トータル）も**作り込み前提**、操作は**シミュ技術者**、提案書は手作業。
- **WMS/スロッティング系（Manhattan / Blue Yonder / Körber-Infios / Made4net）** … スロッティングは強いが**稼働中倉庫の運用最適化**。提案段階のグリーンフィールドDESではない。「デジタルツイン」も**稼働実データの可視化**。
- **スロッティング専用（Optricity OptiSlot DC / Slot3D）** … 設計時の what-if に最も近いが、**解析的移動モデル**であってDESではなく、**コンサル/専門家運用**。

→ whsim の差別化は **「入力容易性 × 本物のDES × 内蔵スロッティング/ピック最適化 × 提案出力」の同時成立**。これは未踏地。

---

## 1. 横断結論：3カテゴリの構造的な穴

| カテゴリ | 提案設計のDES | スロッティング最適化 | ピック方式 | 操作者 | 提案成果物 |
|---|---|---|---|---|---|
| 汎用DES (Witness/Simio/FlexSim/AnyLogic) | ◎（最強） | **✕ 内蔵なし**（ABC配置ルールのみ） | △ 作り込み | シミュ技術者 | ✕ 手作業 |
| WMS/スロッティング (Manhattan/BY/Körber/Made4net) | ✕（稼働運用） | ◎（ただし運用・実データ前提） | ◎（稼働WMS内） | IT/運用 | ✕ |
| スロッティング専用 (Optricity/Slot3D) | △（解析的what-if） | ◎（最も深い） | ○ | コンサル/専門家 | ○（移動リスト/ROI） |
| **whsim（目標）** | **◎ SimPy DES** | **◎ 内蔵・設計時** | **◎ 内蔵比較** | **営業/非技術者** | **◎ ワンショットPNG/PPTX/PDF＋来歴** |

---

## 2. ツール別サマリ

### 汎用DES

**Witness（Twinn Witness / Lanner→Royal HaskoningDHV）**
- 強み：豊富な要素ライブラリ（Conveyor/Labor/Vehicle）、**WITNESS Optimizer**（焼きなまし＋タブー、OptQuest級）、**多重レプリケーション＋信頼区間**（Experimenter/Scenario Manager、SQL保存）、検証実績（BAE）。
- 穴：**倉庫セマンティクスが非内蔵**（ピッキング/バッチ/AS-RS/AGVは全て手作り）、**スロッティングは皆無（Lokad明言）**、技術者運用で構築は数日〜数週、3D/VR・CADは一部アドオン（Virtalis）、出力は工学レポート（提案デッキ自動生成なし）。

**Simio**
- 強み：OO「intelligent objects」、多パラダイム、**OptQuest**、実験で**95%信頼区間半値幅＋精度達成まで自動追加レプリ**、**RPS（リスクベース計画）**、**ノーコード・ニューラルネット/ONNX/DRL内蔵（2024–26）**、デジタルツイン計画、3D＋リソース/オーダーGantt＋Power BI/Tableau出力。
- 穴：**スロッティング内蔵なし**（Bosch論文は自作C#アドオンが必要）、ピック方式は作り込み、**急な学習曲線・技術者ツール**、テンプレ高速入力なし、ワンクリック提案PNGなし。

**FlexSim（※所有は Autodesk。Siemens ではない）**
- 強み：エージェント級DES、**A\*ナビ＋AGVネットワーク（加減速/相互排他/先読み衝突回避）**、Conveyor/FloWorks、Time Tables（シフト/MTBF）、**Experimenter（精度達成/信頼分離で停止）＋OptQuest（別ライセンス）＋RL**、強力なCAD（.dwg）/3D。
- 穴：**スロッティング最適化なし**（ABCペイント/配置ルールのみ）、ピック方式は Process Flow で**自作**、混雑/衝突は専門チューニング前提、**高い入力難度**、提案書は手作業。

**AnyLogic**
- 強み：**マルチメソッド（DES＋ABM＋SD）**、Material Handling Library（**AGV衝突/デッドロック解決**・コンベヤ網・AS/RS）、**Pedestrian Library（社会力・密度ヒートマップ）**、ResourcePool（シフト/休憩/ダウンタイム）、OptQuest/Monte Carlo/Parameter Variation、AnyLogic Cloud。
- 穴：**スロッティング・ソルバ内蔵なし**、バッチ/ゾーン/ウェーブは**ブロック＋Javaで自作**、**急峻な学習曲線・Java必須・高価**（Pro ~$12k–19k）、ワンクリック提案静的成果物なし。

**Emulate3D / Demo3D（Rockwell Automation、2019買収・FactoryTalk Design Suite）**
- 強み：**物理ベースの最高峰3D**（リアルフットプリント・コンベヤ/AS-RS/AGV/ロボの巨大カタログ）、**バーチャルコミッショニング（実PLCをHIL接続：Studio 5000/PLCSIM、OPC UA/MQTT）で設置・立上げ最大50%短縮**、2025年 **Emulate3D Factory Test（NVIDIA Omniverse/OpenUSD・自動テスト）**。**Demonstrate モードは"営業提案用"そのもの**（自動セールス動画・CADレイアウト・自動BoM）。
- 穴：**スロッティング内蔵なし**（高確度）、ピッキングは設備/フロー層で**自作**（バッチ/ゾーン/ウェーブの一次オブジェクトなし）、操作は**制御/SIエンジニア（C#/Visual Studio/PLC）**、労務はシフト計画というより設備従属。
- whsim視点：**提案出力という whsim の堀に最も近い競合**。ただし「制御エンジニアが作り込む高忠実度」側で、whsim の「非技術者がゆるく入力」とは正反対。スロッティング/オーダーロジックは持たない。

### WMS / スロッティング・スイート（運用系）

- **Manhattan Active**：AI スロッティング最適化（需要・季節・寸法、**slotting⇄pick を統合**）、**Engineered Labor Standards**＋ゲーミフィケーション、デジタルツイン＝**稼働倉庫の可視化**。Tier-1 で IT/運用運転。提案成果物なし。
- **Blue Yonder（旧JDA）**：**継続的・自動・先回り**の Advanced Slotting（bin単位まで）、Luminate（Azure SaaS、AIオーケストレーション）。**運用最適化**でDES設計ではない。
- **Körber→Infios（旧HighJump）**：**ルール/設定駆動**のスロッティング/リスロット、労務（設定が重い）。運用系。
- **Made4net**：WMS機能としてのスロッティング＋インターリーブ、**ピッカー移動15–25%削減**を謳う。アルゴリズム深度は専用ツールに劣る。運用系。

### スロッティング専用（設計隣接）

- **Optricity OptiSlot DC（FORTNA、2022買収）**：最もアルゴリズム集約。寸法/重量/速度/MHE/季節/**アフィニティ（小売グルーピング）**。**複数 what-if を財務リターン込みで横並び比較**、数分で**数千手の移動計画**。ただし**解析的**であってDESではなく、**コンサル運用**・既存施設プロファイル前提。
- **Slot3D（WMS非依存・AutoCAD統合）**：3D視覚スロッティング、**移動シミュレーション・エンジン（解析的travel計算）**、低速SKU検出、再スロット。専門家運用・詳細データ前提。

---

## 3. 軸別ギャップ（whsim 現状 → 超えるために）

| 軸 | 市販の実力 | whsim 現状 | 超えるための追加 |
|---|---|---|---|
| **スロッティング最適化** | 専用系=◎（速度/キューブ/アフィニティ/季節）、DES系=✕ | ABC割付あり（slotting.py） | **速度×距離最適化・ゴールデンゾーン・段(level)・リザーブ+アクティブ・アフィニティ**（→ 実装中） |
| **ピック順序最適化** | DES系=自作、専用系=解析 | 貪欲NN（engine内蔵） | **2-opt/Or-opt・オーダー/マルチ/トータル比較・削減率提示**（→ 実装中） |
| **保管戦略** | WMS=運用ルール | 固定割付 | **フリーロケ vs 固定(ダブルトランザクション/補充)推奨＋反映**（→ 実装中） |
| **DES忠実度** | ◎ 衝突回避AGV/コンベヤ網/AS-RS | SimPyエージェント・混雑ヒート・AGV/フォーク | △ AGV相互排他/先読み衝突、AS-RSサイクルタイム |
| **統計的厳密性** | ◎ 信頼区間・精度達成自動レプリ・OptQuest | レプリケーションあり | **信頼区間の提示／自動最適化(OptQuest相当の探索)** |
| **入力容易性** | ✕ 技術者/コンサル | ◎ テンプレ＋ゆるい入力 | 維持・強化（whsim の堀） |
| **提案出力** | ✕ 手作業 | ◎ PNG/PPTX/PDF＋「N%実データ」来歴 | 維持・強化（whsim の堀） |

## 4. 「市販品を超える」優先ロードマップ

1. **スロッティング最適化（速度×距離＋段＋ゴールデンゾーン）** ＋ **棚番号採番** — 専用ツール級の中核（実装中）。
2. **ピック順序最適化（2-opt、オーダー/マルチ/トータル）** — DES系の「自作」を内蔵で上回る（実装中）。
3. **保管戦略（フリー vs リザーブ+アクティブ／補充工数）** — WMS運用知見を設計段階に前倒し（実装中）。
4. **最適化結果→DES→ピック効率デルタ** — 「解析で当てる→DESで裏取り」の二段で、専用ツール(解析のみ)とDES系(設計時最適化なし)の**両方の穴を同時に塞ぐ**。
5. **統計的厳密性の可視化** — 信頼区間/必要レプリ数の提示で、Witness/Simio級の「数字を信じてもらえる」域へ。
6. **（中期）自動最適化探索** — 人員/間口/方式を OptQuest 的に自動掃引。
7. **（中期）AGV相互排他・先読み衝突** — FlexSim/AnyLogic 級の搬送忠実度。
8. **アフィニティ（併買/同梱）スロッティング・季節性** — Optricity が持つ深さに追随。

**結論**：1–4 で「設計時にスロッティング/ピックを内蔵最適化し、DESで裏取りし、営業が提案を出す」という**誰も同時に満たしていない組合せ**を完成させるのが最短の「超え方」。5–8 は計算忠実度で老舗に並ぶための継続投資。

---

## 出典（Web取得・実在URL）
**Witness**: royalhaskoningdhv.com/twinn (403); lokad.com/review-of-lanner-com; capterra.co.uk/reviews/126389/witness; informs-sim.org/wsc11papers/212.pdf; virtalis.com/blogs/visionary-render-for-witness-launched.
**Simio**: simio.com/whitepapers/intelligent-objects; simio.com/case-studies/optimization-of-storage-allocation...; textbook.simio.com; simio.com/neural-networks-digital-twin; simio.com/about-simio/why-simio/simio-RPS...; FME Transactions 2015 (Vieira et al.).
**FlexSim**: flexsim.com/news/autodesk-...-acquire-flexsim; docs.flexsim.com (AStar, AGVNetworks, StorageSystem, Experimenter); flexsim.com/optquest; answers.flexsim.com (slot assignment, picking).
**AnyLogic**: anylogic.com/features/libraries/material-handling-library; .../pedestrian-library; anylogic.help (resourcepool, optimization, custom-routing, cad); anylogic.com case studies (DHL/Intel/cold-store); gartner.com reviews (pricing).
**WMS/Slotting**: manh.com/products/manhattan-active-slotting-optimization; blueyonder.com/solutions/warehouse-management/advanced-slotting; softwareconnect.com/reviews/infios-korber-wms; made4net.com; 4sight.cloud/offerings/optislot-dc; optricity.com; slot3d.com.

*確度メモ：ベンダー公式の多くが 403 のため、機能の「存在」は高確度（複数ソース横断）、細部の文言・無機能の断定・構築時間は中確度。Made4net↔EPG と "SlotIQ" は本調査で未検証（訓練知識・低確度）。FlexSim=Autodesk所有（高確度、複数ソース）。*
