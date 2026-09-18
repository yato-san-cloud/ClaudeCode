# Handoff: whsim 倉庫シミュレータ UI（Notion風リデザイン）

## Overview
whsim は物流倉庫シミュレータです。コンセプトは「素人でもプロ並みの倉庫モデルが組めるハーネス＝**入力は簡単・計算は本格的**」。主対象は**非エンジニアの物流営業**で、**商談中にその場で操作**します。

本ハンドオフは、既存 whsim（機能は完成、見た目が未洗練）の **UI を Notion 風に再設計したもの**です。シミュレーションのロジック・語彙・データ構造は既存実装が「正」であり、本デザインはその上に被せる **表示層（プレゼンテーション層）の指定書**です。

設計の中心思想：
- **専門用語を前面に出さず、結論と信頼度を最初に見せる**（判定バナー＋安定度）。
- 数字には必ず **出どころ（プロベナンス）** を添える（「実データ N%」「仮値」）。
- 全文**日本語・丁寧簡潔**、アクセシブル（フォーカスリング・AAコントラスト・キーボード操作）。

## About the Design Files
このバンドルの中身は **HTML で作られたデザインリファレンス**です。意図した見た目と挙動を示すプロトタイプであり、**そのまま本番に貼り付けるコードではありません**。

タスクは、これらの HTML デザインを **対象コードベースの既存環境（React / Vue / Svelte 等）と既存パターンで作り直す**ことです。whsim に既存のフロント実装があるなら、その規約・状態管理・コンポーネント体系に合わせて移植してください。まだ環境が無い場合は、最適なフレームワークを選んで実装して構いません。

`whsim.html` は**単一の自己完結ファイル**（CSS・JSは全部インライン）です。ブラウザで直接開けばフル動作のプロトタイプを確認できます。`source/` には編集用に分割した元ソース（CSS / JSX）が入っています。

> プレビュー配信環境の都合で複数ファイルの同時読み込みが不安定だったため、配布版は1ファイルに束ねています。**実装の正本は `source/` 内の分割ファイル**を参照してください。

## Fidelity
**High-fidelity (hifi)** です。最終的な配色・タイポグラフィ・余白・角丸・影・状態（hover/active/focus）・主要インタラクションまで作り込んであります。ピクセル単位で再現しつつ、対象コードベースの既存ライブラリ/コンポーネントにマップしてください。

数値（件数・分・コスト等）は**デモ用シナリオの仮値**です。実際の値はシミュレーションエンジンの出力に差し替えます。語彙（ラベル文言）は既存 whsim に合わせてあるため**そのまま採用可**。

---

## 既存クラス/ID へのマッピング
本デザインは既存マークアップの命名に素直に乗るよう設計しています。実装時の対応表：

| デザイン上の役割 | クラス/ID |
|---|---|
| ヘッダー | `header` / `.header` |
| 左サイドバー | `.sidebar` |
| タブ列 / 各タブ | `.tabs` / `.tab` |
| タブ本文（スクロール領域） | `.panel` |
| 汎用カード | `.card` |
| 判定バナー | `.verdict`（`.verdict--ok/--warn/--bad`）|
| KPIバー / 各KPI | `.kpibar` / `.kpi` |
| 設計タブ | `#design` |
| 2Dアニメ | `#view2d` |
| 3D | `#view3d` |
| 比較 | `#compare` |
| エクスポート | `#export` |
| 再生バー | `.transport` |
| プロベナンス・チップ | `.prov`（`.prov--real/--est/--tmpl`）|
| 工程ストリップ | `.pstrip` / `.pstep` |
| ドロップゾーン | `.dropzone` |

---

## 画面構成（全体レイアウト）
固定2カラムのアプリシェル。スクロールするのは各領域内部のみ（アプリ全体はビューポート固定）。

```
┌───────────────┬─────────────────────────────────────────────┐
│               │  header (48px) … パンくず＋プロベナンス帯       │
│   .sidebar    ├─────────────────────────────────────────────┤
│   (264px)     │  .verdict  判定バナー（結果状態のみ）           │
│               ├─────────────────────────────────────────────┤
│  1 プロジェクト │  .tabs  設計/2Dアニメ/3D/提案PNG/比較/エクスポート│
│  2 取り込み    ├─────────────────────────────────────────────┤
│  3 キー項目×5  │  .panel  選択タブの本文（縦スクロール）          │
│  [反映]       │          max-width 1080px 中央寄せ            │
│               ├─────────────────────────────────────────────┤
│ ─────────────  │  .kpibar  KPIカード横並び（84px）              │
│ [シミュ実行]   ├─────────────────────────────────────────────┤
│  完了 run_0001 │  .transport  再生トランスポート（56px）         │
└───────────────┴─────────────────────────────────────────────┘
```

- グリッド: `.app { display:grid; grid-template-columns: 264px 1fr; height:100vh; overflow:hidden }`
- メイン: `.main { display:grid; grid-template-rows: 48px auto 1fr 84px 56px }`（header / verdict / content / kpibar / transport）
- 判定バナー・KPIバー・再生バーは **結果状態（results）でのみ**表示。空/実行中/エラー時はプレースホルダに差し替え。

---

## Screens / Views

### サイドバー（操作動線）`.sidebar`
背景 `--bg-sunken (#FBFBFA)`、右に極細境界 `--line-hair`。上から：
1. **ブランド**：`wh` マーク（22px角・near-black地に白文字）＋「whsim / 倉庫シミュレータ」
2. **セクション1 プロジェクト**：丸数字バッジ（near-black地に白）＋プロジェクト行（box アイコン・名称・chevron）
3. **セクション2 顧客データ取り込み（任意）**：
   - **ドロップゾーン** `.dropzone`：破線枠 `1.5px dashed --line-strong`、角丸8px。中身は archive アイコン＋「ZIP をドラッグ&ドロップ」＋ヒント「商品マスタ / 出荷 / 入荷 …（足りない分は仮値で補完）」。hover/dragover で枠が `--accent`・地が `--accent-tint` に。
   - 直下に **「CAD図面(DXF)を取込」** ゴーストボタン。
   - 取り込み後は緑チェック付きの `.import-file` 行に置換。
4. **セクション3 キー項目（5つ）**：各 `.field`。ラベル右に「仮値」タグ（橙）。
   - **ピッカー人数** … ステッパー（−/数値/＋）、単位「名」、初期 6
   - **出荷オーダー** … ステッパー、単位「件/時」、初期 120、step 10
   - **ピッキング方式** … セレクト（都度ピック / トータルピック / マルチオーダー / ゾーンピック）
   - **稼働時間** … ステッパー、単位「時間」、初期 8
   - **歩行速度** … ステッパー、単位「m/s」、初期 1.2、step 0.1（小数1桁）
   - 末尾に **「反映」** 小ゴーストボタン（refresh アイコン）
5. **フッター（固定）**：**「シミュレーション実行」** プライマリボタン（全幅40px、play アイコン、右端に `⌘↵` キーヒント）。下に実行メタ：結果状態では「✓ 完了 / run_0001」、それ以外は「所要 約8秒 / 50回試算」。

ステッパー `.stepper`：枠 `1px solid --line-strong`、focus-within で `--accent` 枠＋3px tint リング。数値は `tabular-nums` で桁揃え。

### ヘッダー `.header`
- 左：パンくず `フォルダ ▸ 新規倉庫プラン ▸ <現在タブ名>`（区切りは chevron、現在地のみ near-black 太字）。
- 右：**プロベナンス帯** `.provbar`（pill 枠、`--bg-sunken` 地）。3セグメントを縦線で区切り：
  1. `<.prov チップ> 実データ 0%`
  2. `取り込み済み **なし**`
  3. `テンプレ仮値 **10項目**`
- さらに右：「共有」ゴースト＋「提案PNG」プライマリ（小サイズ btn）。

### 判定バナー `.verdict`（最重要コンポーネント）
結論を最初に・大きく。状態3種：`ok`（緑）/`warn`（黄）/`bad`（赤）。
- 左：丸バッジ（38px、状態色地に白アイコン。ok=check-circle / warn=alert / bad=alert-circle）。
- 中央：**タイトル**（20px semibold、状態の濃色 ink）＋**説明**（14px secondary）。
  - 例：タイトル「対応可能」／説明「ピッキング工程の稼働率 45% で需要をさばけます。10回中10回が安定処理でした。」
- 右：**安定度メーター** … ラベル「安定度」＋5本の上り棒（高さ6→18px、点灯は状態色）＋値「100%」＋小注記「10回検証」。
- 地は状態の tint 色、枠は状態の line 色、角丸12px。`rise` アニメ（6px上げ＋フェード、420ms）。

### KPIバー `.kpibar` ＋ KPIカード `.kpi`
横並び（`grid-auto-flow:column; grid-auto-columns:1fr`）、各セルは縦線区切り。84px高。6枚：
| ラベル | 値 | 補足 |
|---|---|---|
| スループット | **120** 件/時 | p5–p95 帯（112–125）を下に描画 |
| 出荷完了 | **961** / 965 件 | 「達成率 99.6%」|
| ボトルネック | **ピッキング** 稼働45% | tone=warn（値が橙色）|
| 処理時間 中央値/最悪 | **2 / 4** 分 | |
| 1件あたり歩行 | **89** m | |
| 1件あたりコスト | **¥165.1** | |

- 数値は `--num` フォント＋`tabular-nums`、28px semibold、`letter-spacing:-0.02em`。単位は 13px tertiary。
- テキスト値（ボトルネック等）は `.kpi__val--text`（21px）に縮小。
- **p5–p95 帯**：高さ6px トラックに、両端8%インセットのグラデ帯＋中央値マーカー（2px縦線・accent）。下に `p5 / ぶれ幅(90%) / p95` のキャプション。
- 密度トグル：`:root[data-kpi-density="0"]` で帯とキャプションを非表示（ミニマル表示）。

### 再生トランスポート `.transport`
- 先頭へ / 再生・一時停止（near-black丸ボタン）/ 末尾へ。
- 時間表示：経過「分」（`tabular-nums`）。0→duration を 稼働8時間=480分 に換算して表示。
- スクラブバー `.tp-track`：6px トラック＋accent fill＋白丸ヘッド（13px）＋25/50/75% ティック。クリックでシーク、`role="slider"`、←/→キーで±10。
- 右：「速度」ラベル＋セグメント `1× / 10× / 60×`。
- 再生位置は `localStorage("whsim.t")` に保存し、リロードで復元。

### 設計タブ `#design`
- 上部に**サブツール**セグメント `.subtools`：レイアウト / 設備 / 躯体 / フロー / 動線（アイコン付き、選択は白地＋影＋semibold）。
- 2カラム（`1fr 280px`、1180px以下で1カラム）：
  - 左：**倉庫俯瞰キャンバス** `.wh-canvas`（16:10、28pxグリッド地）。ゾーン矩形（入荷=accent tint / 保管=sunken / ピッキング=warn tint / 梱包・出荷=ok tint）＋棚バー（ストライプ）。フロー/動線ツールでは動線（accent線＋ノード丸）を表示。下にタグ（保管4,800ロケ / ピッカー6名 / 1件あたり歩行89m）＋プロベナンス・チップ。
  - 右：選択ツールの設定 `.kv`（キー左・値右、値は `tabular-nums; white-space:nowrap`）＋「気づき」カード（sparkle アイコン、sunken地）。

### 2Dアニメ `#view2d`
- `.sim2d`（16:9、32pxグリッド）。ゾーン＋棚＋**ボトルネックのヒート**（blur円、warn色、ピッキング付近）。
- **エージェント** `.agent`（12px丸、白1.5px枠）。状態別カラー＝**凡例どおり**：
  - 待機 `--wait` グレー #9B9A95 / 移動 `--move` accent / ピック `--pick` ok緑 / 運搬 `--carry` パープル #6940A5 / 梱包 `--pack` bad赤
  - 位置は `left/top` を % で更新、`transition: left/top .25s linear` で補間。
- 下に凡例（5状態）＋注意タグ「色の濃い領域＝混雑ポイント」。
- さらに下に**工程ストリップ** `.pstrip`：入荷/格納/補充/ピッキング/仕分け/梱包/出荷。各 `.pstep` に稼働%メーター。ピッキングは `is-bottleneck`（warn色・「ボトルネック」注記）、再生位置の工程は `is-active`（accentアイコン）。

### 3D `#view3d`
- `.view3d-hero`（16:9、放射グラデ地）に**プレースホルダ**（cube アイコン＋「3D ウォークスルー（<表現>・レンダリング領域）」）。実装時は実3Dビューア（three.js 等）に差し替え。
- タブ列の右端に **「3D表現」セレクト**（ナチュラル / ワイヤー / ヒートマップ）。選択値はヒーロー左上タグに反映。
- 下に工程ストリップ。

### 提案PNG `#proposal`（商談用1枚）
- 2カラム（`1fr 300px`）。左に **A4比率のペーパー** `.proposal__paper`（白地・`--sh-lg` 影）：ロゴ＋タイトル「倉庫オペレーション提案」＋「対応可能」タグ → 判定バナー（コンパクト）→ KPI 2×2 グリッド → フッター（プロベナンス＋「whsim で作成・run_0001」）。
- 右：書き出しパネル（「PNG（商談用1枚）」プライマリ／「画像をコピー」／サイズ 16:9・A4・正方形のセグメント）＋「そのまま渡せます」案内カード。

### 比較タブ `#compare`（現行↔提案）
- 見出し「現行と提案の比較」＋サブ「緑＝改善する項目」＋右にプロベナンス・チップ。
- テーブル `.ctable`：列＝項目 / 現行 / 提案後 / 変化。数値列は右寄せ`tabular-nums`。各行ホバーで `--bg-sunken`。
- **デルタ・ピル** `.delta-pill`：改善=緑（`--good`）、悪化=赤（`--bad`）、横ばい=灰（`--flat`）。trend アイコンは負値で上下反転。定性項目（安定度）は「改善」ピル。
- データ：スループット +25% / 出荷完了率 +8% / 処理時間(中央値) −33% / 1件あたり歩行 −25% / 1件あたりコスト −17% / 安定度 中→高。

### エクスポート `#export`
- カードグリッド（`minmax(220px,1fr)`）：提案PNG / PDFレポート / 2D動画(MP4) / データ(CSV) / 共有リンク / 3Dシーン。各カードはアイコン＋タイトル＋説明＋「書き出す」リンク。hover で `--sh-md`＋1px浮き。

---

## States（空 / 実行中 / 結果 / エラー）
1状態を `status: 'empty' | 'running' | 'results' | 'error'` で管理。デモには右下に状態切替スイッチ（実装時は削除）。
- **empty** `.empty`：中央配置。box アイコン＋「倉庫モデルを組み立てましょう」＋3ステップ案内（取り込み(任意)→キー項目5つ→実行）＋「サンプルで試す」。判定/KPI/再生バーはプレースホルダ。
- **running** `.running`：スピナー＋「シミュレーション中…」＋プログレスバー＋ログ（仮値テンプレ読込→工程モデル構築→50回試算→ボトルネック判定→結果まとめ）。各行は done/active/未了で色分け。完了で `results` に遷移。
- **results**：全要素表示（既定）。
- **error** `.errbox`：赤バナー。タイトル「取り込んだデータに不足があります」＋詳細「『出荷日』列が読み取れません…」＋ファイル行（顧客データ_2025.zip／「列『出荷日』が空」タグ）＋アクション（「列を指定して再取り込み」／「仮値で進める」）。タブ列は維持。

---

## Interactions & Behavior
- **キーボード**：`⌘/Ctrl + Enter` でシミュレーション実行。`Space` で再生/一時停止（入力中は無効）。スクラブバーは ←/→ でシーク。
- **再生ループ**：`requestAnimationFrame` で `t` を進める。`speed × 14` で1日を圧縮。`duration` 到達で停止。`prefers-reduced-motion` でアニメ無効化。
- **実行/反映**：どちらも `running` 状態を挟んでから `results` に戻す（約90ms×刻みのダミープログレス。実装では実エンジン呼び出しに置換）。
- **取り込み**：ドロップ/クリックでファイル取り込み（デモはモック）。取り込み後はプロベナンス（実データ%）が上がる想定。
- **フォーカス**：全インタラクティブ要素に `:focus-visible { outline: 2px solid var(--line-focus); outline-offset:2px }`。

## State Management
```
status        : 'empty'|'running'|'results'|'error'
tab           : 'design'|'view2d'|'view3d'|'proposal'|'compare'|'export'
fields[5]     : { id, value }  // ピッカー人数/出荷オーダー/方式/稼働時間/歩行速度
file          : null | { name, rows }   // 取り込み結果
render3d      : 0..2                     // 3D表現プリセット
playing,t,speed : 再生トランスポート（t は localStorage 永続化）
progress      : running 中の進捗 0..100
```
タブ切替で `t` に応じた工程ハイライト（`activeStep`）を算出。

---

## Design Tokens
全トークンは `source/tokens.css`（CSS変数）に集約。**実装ではこれをそのまま採用可**（Tailwind なら `theme.extend` に転記）。主要値：

**Color · Surface** `--bg-app #FFFFFF` / `--bg-sunken #FBFBFA` / `--bg-panel #F7F6F3` / `--bg-hover #F1F0ED` / `--bg-active #EAE9E4`
**Color · Ink**（温かいニアブラック基準）`--ink-primary #37352F` / secondary `rgba(55,53,47,.65)` / tertiary `.45` / faint `.32`
**Color · Line** `--line-hair rgba(55,53,47,.09)` / `--line-strong .16` / `--line-focus #2383E2`
**Color · Accent**（Notionブルー）`--accent #2383E2` / hover `#1A73CE` / press `#1668BE` / tint `#E7F1FB` / tint-2 `#D3E5F7` / ink `#1A6BC0`
**Semantic** ok `#2E7D55`（tint `#EBF3EE`・line `#CBE3D5`・ink `#1E5C3D`）/ warn `#B7791F`（tint `#FBF3E4`・line `#EFDFBE`・ink `#8A5A12`）/ bad `#C4453F`（tint `#FBECEB`・line `#F0CFCC`・ink `#97322E`）
**Provenance** real `#2E7D55` / est（推定・仮値）`#B7791F`
**2D エージェント** 待機 `#9B9A95` / 移動 `#2383E2` / ピック `#2E7D55` / 運搬 `#6940A5` / 梱包 `#C4453F`

**Typography** sans=`Inter, "Noto Sans JP", system…` / mono=`Roboto Mono…` / num=`Inter, "Roboto Mono"`（数字は `tabular-nums`）
スケール：display 30/-0.02em・title 20/-0.012em・section 15・body 14・sm 13・xs 12・micro 11、metric 28（KPI大数字）。weight 400/500/600/700。

**Spacing**（4pxグリッド）4/8/12/16/20/24/32/40/48/64
**Radius** xs4 / sm6 / md8 / lg12 / xl16 / pill999
**Shadow** xs `0 1px 2px rgba(15,15,15,.04)` … lg `0 4px 12px / 0 12px 28px`（控えめ）
**Motion** ease `cubic-bezier(.2,0,0,1)` / ease-out `cubic-bezier(.16,1,.3,1)`、dur 90/160/240/420ms
**Layout** sidebar 264 / header 48 / kpibar 84 / transport 56 / content max-width 1080

## Tweaks（任意・調整用パラメータ）
プロトタイプにはデザイン調整用トグルあり（実装では不要、設計意図の参考に）：
- アクセント色（#2383E2 / #0B6E99 / #37352F / #6940A5）
- アクセントの使い方（ブルーのみ / 淡い面を活用）→ `--accent-tint(-2)` を中立化
- KPI情報量（ミニマル / 詳細）→ `data-kpi-density` 0/1

## Assets
- 画像アセットなし。アイコンは `source/lib.jsx` 内に **インラインSVG（Feather/Lucide系・stroke 1.6）** として定義。同等のアイコンライブラリ（lucide-react 等）で置換可。
- フォントは Google Fonts（Inter / Noto Sans JP / Roboto Mono）。
- 3D ビュー・提案PNG書き出し・各種エクスポートは**プレースホルダ**。実装で本機能（three.js、html-to-image/サーバ生成 等）に差し替え。

## Files
- `whsim.html` — 単一自己完結プロトタイプ（動作確認用の正本）
- `source/tokens.css` — デザイントークン（CSS変数）★最初に読む
- `source/app.css` — 全コンポーネントスタイル（クラス/ID は上記マッピング表に対応）
- `source/lib.jsx` — アイコン定義＋`SCENARIO` デモデータ（語彙・データ構造の参照元）
- `source/sidebar.jsx` — Header / Sidebar / ProvChip / Field / Stepper / DropZone
- `source/bars.jsx` — VerdictBanner / KpiBar / Kpi / Band / TransportBar / ProcessStrip
- `source/tabs1.jsx` — DesignTab / View2D / View3D
- `source/tabs2.jsx` — Proposal / Compare / Export ＋ Empty/Running/Error 状態
- `source/app.jsx` — アプリシェル＋状態マシン＋キーボード＋Tweaks 配線
- `source/tweaks-panel.jsx` — Tweaks パネル土台（実装では不要）
