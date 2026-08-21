# 倉庫の作業設計：基本要素の一般化と「最小限の共通設定項目」

> ディープリサーチ（学術＋実務）→ 一般化 → 非専門家が直感で設計できる設定軸、の設計メモ。
> whsim（営業が商談中に直感操作、裏で重厚DES）の設定項目に直接落とすことが目的。

## 0. 結論（先に要点）

世の中の「ピッキング方式」は **12種類くらいの名前**で語られる（シングル/バッチ/マルチオーダー/
ゾーン/ウェーブ/クラスタ/トータル(種まき)/摘み取り/goods-to-person/pick-to-light/voice/カート…）。
しかし学術的にはこれらは**独立した別物ではなく、少数の“直交する設計軸”の組合せ**にすぎない
（de Koster らの order picking 分類）。

→ **だから、whsimは「方式名のドロップダウン」をやめ、5つの直感的な軸で設計させ、
組合せから方式名を“逆引き表示”する**のが正解。これが「最小公倍数の設定項目」。

---

## 1. リサーチ要約（根拠）

### 工程の基本要素
入荷 → 格納(putaway) → 保管 → 補充(replenishment) → ピッキング → 流通加工 → 梱包 → 出荷。
生産性・精度・コストを左右する基本設計要素は概ね次：高回転SKUを出荷/梱包の近くに置く前方ピック、
工程を直列配置して交差動線を減らす、需要・サイズ・賞味期限での格納先決定、シフト数、季節波動への
モジュール性。([Tompkins], [ISM], [Hopstack])

### ピッキングの労力比重
オーダーピッキングは倉庫で最も労働集約的で、**運営費の約55%**を占めるとされる
（de Koster, Le-Duc, Roodbergen のレビュー）。だから「採り方の設計」が中身の本丸。([Optioryx])

### 方式分類と適用条件
- **シングル/摘み取り(piece/order picking)**：1オーダーずつ棚を回って採る。多品種・少量・出荷先が多い
  ／急なオーダーにも即対応。最も単純だが移動が多い。([Kaizen Base], [富士電機], [Kardex])
- **バッチ/マルチオーダー(cluster)**：1人が複数オーダーを同時に回収。移動を共有して効率化。
- **ゾーン**：フロアを担当領域に分け、各ゾーンで採って中央で統合。逐次(pick-and-pass)／並列がある。
  大量オーダー・大規模向き。各人の移動を削減。([Omniful])
- **ウェーブ**：出荷便・締め単位でオーダーをまとめて時間投入。スケジューリング最適化。
- **トータル(種まき)**：受注をアイテム単位に集約して総量を採り、後で納品先ごとに仕分け(put wall/DAS)。
  **少品種・大量・出荷先が少ない**場合に有利。摘み取りの逆。([Kaizen Base], [LPlanners], [富士電機])
- **goods-to-person**：人は動かず、物(AGV/AMR/AS-RS/シャトル)が来る。高SKU・省人・高密度。
  AMRは高SKU低スループット・低CAPEX、AS-RS/シャトルは高スループット・高密度・高CAPEX。
  ([PeakLogix], [PrecisionWarehouseDesign], [SmartLoadingHub])
- **pick-to-light / voice**：採り方そのものでなく“指示手段”（精度・速度の補助）。直交概念。

### スロッティング／ルーティング／指標
- **スロッティング**：固定(dedicated, 回転率/ピック頻度=ABC順) vs フリー(random)。良い設計で
  **歩行距離を15〜30%削減**、保管効率20〜40%改善とされる。最大級のレバー。([Optioryx slotting], [ResearchGate])
- **ルーティング**：S字(traversal)/リターン/最短(optimal)/midpoint/largest gap。([MDPI])
- **指標**：UPH(人時生産性)、稼働率、坪効率、保管効率、出荷波動への追従。

---

## 2. 一般化：「方式」＝5つの直交軸の組合せ（最小限の共通設定項目）

| 軸 | 平易な問い | 値（連続/選択） | 既存 whsim |
|---|---|---|---|
| **A. 搬送主体** | 誰が動く？ | 人が歩く ↔ 物が来る(AGV/コンベア/自動倉庫) | `pick_method`（あり）|
| **B. まとめ度** | 1回で何オーダー？ | 1 ↔ 数件 ↔ 多数（=batch_size） | `batch_size`（あり）|
| **C. ゾーン分担** | エリアを分けて並列？ | 全域1人 ↔ ゾーン分担（逐次/並列） | 一部（zone戦略のみ）|
| **D. 採り方** | オーダー別 or 総量→仕分け？ | **摘み取り ↔ 種まき(put wall/DAS)** | **無し（最重要欠落）** |
| **E. 投入** | いつ流す？ | 連続 ↔ ウェーブ（締め単位） | 一部（wave戦略） |

**名前は組合せから決まる（逆引き）**：

| 設定（A/B/C/D/E） | 一般的な呼び名 |
|---|---|
| 人・1・全域・摘み取り・連続 | シングルオーダー（摘み取り都度） |
| 人・数件・全域・摘み取り・連続 | マルチオーダー（カートピッキング） |
| 人・多数・全域・**種まき**・ウェーブ | **トータルピッキング（種まき）** |
| 人・数件・**ゾーン**・摘み取り・連続 | ゾーンピッキング（pick-and-pass） |
| **物が来る**・1〜数件・—・摘み取り・連続 | goods-to-person（AGV/AMR/自動倉庫） |

→ **5軸＝最小公倍数**。これだけで上記すべての“方式”を表現できる。

---

## 3. 直感で設計させるUX（水平思考）

1. **「方式名の選択」をやめ、5枚の絵カード（A〜E）を選ぶ**。専門語(zone/wave)は小さく副表示。
2. 選んだ瞬間に **「これは＝マルチオーダーピッキング相当です」と方式名を逆引き表示**。
   素人は迷わず選べ、専門家は自分の用語で確認でき、しかも“学べる”。
3. **おすすめ提案**：取り込んだオーダープロファイル（1オーダーの平均行数、SKU数、出荷先数、波動）から、
   研究の適用条件で**向いている方式をハイライト**（例：少品種・大量・出荷先少→「種まきが有利」）。
   これが「直感で設計」の核。根拠も一言添える（例：「出荷先が少なく大量なので種まき向き」）。
4. **常に動く**：どの組合せでも必ずDESが回り、KPI（UPH・歩行・稼働率・坪効率・コスト）と
   安定度（モンテカルロ）で“良し悪し”を返す。ユーザーは軸をいじって即比較できる。

---

## 4. whsim 実装プラン（設定項目→エンジン→UI）

### スキーマ（process を5軸に再編・後方互換）
```
process.method = {
  transport: "manual" | "agv" | "conveyor" | "asrs",   # A
  orders_per_trip: int,                                  # B（=batch_size 一般化）
  zoning: "none" | "sequential" | "parallel",           # C
  consolidation: "pick" | "sort"                         # D 摘み取り/種まき(put wall)
  release: "continuous" | "wave", wave_interval_s        # E
}
```
既存 `pick_strategy/batch_size/pick_method/stages` は上記へマップ（互換維持）。

### エンジン（DES）の追加
- **D 種まき(consolidation=sort)**：アイテム総量を採る → **put wall/仕分けステージ**（容量つき資源）で
  納品先ごとに仕分け（仕分け時間＋待ち行列）。摘み取りとKPIが質的に変わる。
- **C 並列ゾーン**：ピッカーをゾーンに割当て、オーダーをゾーン別サブタスクに分割→各ゾーン並列ピック→
  集約（join）。ゾーンピッキングの“本来の価値（並列・無干渉）”を表現（積み残しP1の本実装）。
- **E ウェーブ**：締め単位での投入（既存の簡易版を release として一般化）。
- A・B は既存を一般化して接続。

### UX
- 設計タブに **「作業方式」カード（5軸）＋方式名の逆引き＋推奨ハイライト**。
- オーダープロファイル要約（行数/SKU/出荷先/波動）をサイドに表示し、推奨の根拠を一言。

### 検証順序（提案）
1. D（摘み取り/種まき＋put wall）— 最重要欠落・差別化の中身
2. C（並列ゾーン）— 積み残しP1
3. 5軸スキーマ＋逆引き＋推奨UX — 「直感で設計」の核
4. A/B/E の一般化接続

---

## 参考（検索ソース）
- de Koster, Le-Duc, Roodbergen "Design and control of warehouse order picking" 系レビュー（55% opex, 方式分類）— via [Optioryx](https://www.optioryx.com/blog/warehouse-order-picking-methods), [Kardex](https://www.kardex.com/en-us/blog/warehouse-picking-methods)
- 摘み取り/種まき・適用条件 — [Kaizen Base](https://kaizen-base.com/column/31325/), [物流倉庫プランナーズ](https://lplanners.jp/blog/picking-comparison/), [富士電機](https://www.fujielectric.co.jp/products/logistics/basic/picking/)
- ゾーン/バッチ/ウェーブ — [Omniful](https://www.omniful.ai/blog/warehouse-picking-methods-zone-batch-wave-strategies)
- 倉庫設計プロセス/設計判断 — [Tompkins](https://www.tompkinsinc.com/post/warehouse-design-7-essential-steps-for-designing-a-new-distribution-center), [ISM](https://www.ism.ws/logistics/warehouse-layout/), [Hopstack](https://www.hopstack.io/blog/warehouse-processes)
- スロッティング(15-30%削減)/ルーティング — [Optioryx slotting](https://www.optioryx.com/blog/warehouse-slotting-optimization-guide), [ResearchGate order-oriented slotting](https://www.researchgate.net/publication/5171307_Order_oriented_slotting_A_new_assignment_strategy_for_warehouses), [MDPI routing](https://www.mdpi.com/2227-7390/10/17/3149)
- goods-to-person/自動化の選定 — [PeakLogix](https://peaklogix.com/amr-vs-agv-vs-as-rs-a-plain-language-guide-for-warehouse-decision-makers/), [PrecisionWarehouseDesign](https://precisionwarehousedesign.com/blog/goods-to-person-automation-guide/), [SmartLoadingHub](https://www.smartloadinghub.com/insights/conveyor-sort/comparing-dock-to-stock-automation-shuttles-goods-to-person-amrs/)

> 確度メモ：方式が少数の直交軸に分解できる点・摘み取り/種まきの適用条件は学術＋実務で一致（高）。
> 具体数値（55%、15-30%）は広く引用される代表値（中）。
