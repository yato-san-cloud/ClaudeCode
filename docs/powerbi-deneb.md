# Power BI（Deneb / Vega-Lite）でレイアウト・ヒートマップを出す

whsim の図面を **Power BI 上の2Dヒートマップ**にする手順。データは
`GET /api/projects/{name}/layout.csv`（間口1行）、描画は Deneb に貼る Vega-Lite spec
`templates/deneb/warehouse_heatmap.vl.json`。

> **未検証の明示**：この手順は **実際の Power BI Desktop では検証していない**
> （開発環境に Power BI が無い）。spec は JSON妥当性・`$schema`・列参照の整合を
> 自動テスト（`tests/test_geoexport.py`）で機械確認しているだけなので、初回は
> 「1. 取込 → 2. 列の型 → 3. 貼付」を1つずつ確認しながら進めること。

---

## 0. なぜ CSV が入口なのか

Deneb は Power BI の **custom visual** で、**PBI のデータモデルの行**を受け取り
`dataset` という名前のデータセットとして Vega-Lite に渡す。GeoJSON をそのまま食わせる
経路（`data.url`）は PBI のサンドボックス外の取得になるため実務では使わない。
したがって **CSV が入口**、GeoJSON は three.js / Collada / GIS 系のための出口。

---

## 1. layout.csv を取り込む

```
GET http://127.0.0.1:8000/api/projects/<プロジェクト名>/layout.csv
```

（CLI なら `whsim export-geojson <project> --csv layout.csv`。`WHSIM_PASSWORD` を
設定して公開している場合はブラウザでログインしてから保存するのが早い。）

Power BI Desktop → **データを取得 → テキスト/CSV** → 保存した `layout.csv`。

* ファイルは **BOM 付き UTF-8**（`65001: Unicode (UTF-8)`）。日本語の棚名が
  文字化けする場合はエンコードが CP932 になっていないか確認する。
* 列と型（**ここが一番の躓きどころ**）:

| 列 | 型 | 意味 |
|---|---|---|
| `location_id` | テキスト | 間口コード（一意） |
| `x`, `y` | **10進数** | 矩形の**左下角**（m） |
| `w`, `d` | **10進数** | 幅・奥行（m） |
| `level` | 整数 | 段（1始まり） |
| `area`, `rack_no`, `aisle` | テキスト | エリア / 棚 / 通路 |
| `lines`, `picks`, `stock` | **10進数**（空欄可） | 数値属性スロット |

`x` / `y` / `w` / `d` が**テキスト型のままだと矩形が潰れる**。Power Query の
「データ型の変更」で 10進数 にしておくこと（spec 側も `toNumber()` で保険をかけてある）。

> 実績値を PBI 側の別テーブル（出荷明細など）から持ってくる場合は、
> `location_id`（または `rack_no`）でリレーションを張ってメジャーを作り、
> それを spec の `color` に差し替える。**結合は PBI 側の仕事**で、whsim は
> 「穴の空いた器」（`lines`/`picks`/`stock` 列）を出すだけ。

---

## 2. Deneb ビジュアルを追加する

1. 視覚化ペイン → **…（詳細） → 追加のビジュアルを取得** → AppSource で **Deneb** を検索
   → 追加（Microsoft **認定ビジュアル**なので、組織のテナント設定で custom visual が
   許可されていれば使える。禁止されている環境では管理者に許可申請が必要）。
2. レポートに Deneb ビジュアルを配置。
3. **Values** フィールドに `layout.csv` の列をドラッグ：
   `location_id`, `x`, `y`, `w`, `d`, `level`, `area`, `rack_no`, `aisle`, `lines`
   （必要なら `picks` / `stock` も）。
   * 数値列は**「集計しない」**（既定の「合計」のままだと1行に畳まれる）。
     フィールド右クリック → **集計しない**。
   * `location_id` を入れておくと行が間口単位のままになる。

---

## 3. spec を貼る

1. Deneb の **Edit**（鉛筆アイコン）→ 新規仕様 → プロバイダ **Vega-Lite**。
2. `templates/deneb/warehouse_heatmap.vl.json` の中身を **Specification** ペインに貼り付け
   （`config` ブロックは Deneb の Config ペインに分けても良い）。
3. **Apply**。間口の矩形が敷き詰まったヒートマップが出れば成功。

### 中身の要点

* `"data": {"name": "dataset"}` — Deneb が渡すデータセット名（既定）。変更しない。
* `transform` で `x2 = x + w` / `y2 = y + d` を計算し、`rect` マークの
  `x`/`x2`/`y`/`y2` に載せる（＝実寸の矩形）。
* `color` は `lines`（出荷行数）。**stock や picks に変えるとき**は
  `transform` の最後の `{"calculate": "toNumber(datum.lines)", "as": "metric"}` の
  `datum.lines` と、凡例／tooltip のタイトルを差し替える（`metric` という中間名に
  寄せてあるので1箇所で済む）。
* `tooltip` は 間口 / 段 / エリア / 棚 / 通路 / 数値。

---

## 4. Y軸の向き（つまずきポイント）

whsim のモデル座標は **メートル・原点は倉庫の左下・y は上向き**
（根拠は `docs/geojson-export.md` §3 のコード事実表）。

* この spec のように **quantitative（linear）スケール**へ `y`/`y2` を載せる場合、
  Vega-Lite の既定 range は `[height, 0]`＝**値が大きいほど上**。
  したがって **`reverse` も `reflectY` も不要**で、提案PNG・3Dビューと同じ向きになる。
* もし `layout.geojson` を **geoshape ＋ `projection: {"type": "identity"}`** で描くなら、
  identity 投影は data y をそのまま画面 y（下向き）に写すので
  **`"reflectY": true` を付ける**（付けないと上下反転した倉庫になる）。

図面が上下逆に見えたら、まずこの2つのどちらの経路を使っているかを確認すること。

---

## 5. 制約

* **行数上限**：Deneb（PBI custom visual）のデータ点上限は既定 **30,000 行**。
  間口がこれを超える倉庫では、
  (a) `layout.geojson` の **grouped モード**相当（段を畳む）でエクスポートする、
  (b) エリア／通路でフィルタしてから渡す、
  (c) PBI 側で集計する、のいずれかが必要。
  段（`level`）を分けたまま出すと行数は段数倍になる（`docs/geojson-export.md` §4 の
  トレードオフ表を参照）。
* **認定ビジュアル**：Deneb は Microsoft 認定だが、テナントで custom visual が
  禁止されていると追加できない。
* **縦横比**：Vega-Lite にアスペクト固定は無い。`width` / `height` を倉庫の
  `bounds`（width : depth）の比に合わせて手で調整する（既定は 760×380）。
* **データの結合は PBI 側**：whsim は「間口の器＋空の数値スロット」を出すだけ。
  実績値との突合（`location_id` / `rack_no` キー）は Power BI のリレーションで行う。
* **座標は倉庫ローカル**（緯度経度ではない）。地図ビジュアルには載らない。


## 実レンダリング検証（vl-convert）

Power BI 実機は未検証だが、Deneb が内蔵するのと同じ Vega-Lite エンジン
（vl-convert）で `layout.csv` の実データを流し込み、レンダリングを確認済み:

- 全間口が矩形として描画される（レイアウトのみ＝メトリクス未取込でも、
  全間口が**灰色**で描かれる — 床の形は常に見える）
- メトリクスを流すとヒートマップ（yelloworangered）になり、未計測の間口は
  灰色のまま区別される（実測0とは色が違う）

この検証で見つけて直した罠が1つ: Vega-Lite は color が不正（null）の行を
**マークごと落とす**（mark-level invalid filtering）。素朴な spec だと
メトリクス未取込のレイアウトが真っ白になる。同梱 spec は
`mark.invalid: null` ＋ `color.condition`（null→#d9d9d9）で回避している —
Deneb に自作 spec を書くときも同じ罠に注意。
