# レイアウトの GeoJSON / CSV エクスポート（レンダラ非依存の中間形式）

`src/whsim/geoexport.py` — 図面（間口＝`model.locations`）を **ID＋座標＋属性** の形で
外へ出す層。可視化の行き先（Power BI Deneb の2Dヒートマップ / 自作 three.js /
Collada 経由の3D BI）はどれも結局この3点に帰着するので、**共通の中間形式を1つ**持って
出力先の決定を後ろ倒しにする。

計算には一切触れない **additive な出口**：この関数を呼んでもモデルは1バイトも変わらず、
DES のイベント列も完全に同一（`tests/test_geoexport.py::test_ac4_...` で固定）。

---

## 1. 出し方

| 経路 | コマンド / URL |
|---|---|
| CLI | `whsim export-geojson <project> [-o out.geojson] [--grouped] [--csv out.csv] [--no-metrics]` |
| Web | `GET /api/projects/{name}/layout.geojson?grouped=0&metrics=1` |
| Web | `GET /api/projects/{name}/layout.csv?metrics=1` |
| Python | `geoexport.to_geojson(model)` / `to_layout_csv(model)` / `attach_metrics(fc, table)` |

never-blocks：ロケーション0件のプロジェクトでも **空の valid な FeatureCollection**／
**ヘッダのみの CSV** を返す（エラーにしない）。

---

## 2. GeoJSON の形（RFC 7946）

```jsonc
{
  "type": "FeatureCollection",
  "bbox": [15.25, 1.5, 56.75, 28.5],
  "features": [
    {
      "type": "Feature",
      "geometry": {                       // 矩形＝4隅＋始点repeat（閉じたリング）
        "type": "Polygon",
        "coordinates": [[[2.0,1.0],[2.6,1.0],[2.6,2.2],[2.0,2.2],[2.0,1.0]]]
      },
      "properties": {
        "location_id": "L0007",           // 間口コード（一意）
        "level": 1,                       // 段（1始まり）
        "area": "AAA",                    // エリア
        "rack_no": "AAA-01-02",           // 棚（棚名 or エリア-列-棚）
        "aisle": "01",                    // 通路（列 or 図面の x バンド）
        "zone": "storage",                // 以下 whsim の語彙（additive）
        "name": "AAA-01-02-1-01",
        "rack_type": "medium",
        "metrics": {                      // 数値属性スロット＝穴を掘ってある
          "lines": 128, "picks": 341, "stock": 80
        }
      }
    }
  ],
  "whsim": {                              // RFC 7946 §6.1 が認める foreign member
    "schema_version": 1, "level_mode": "per-level",
    "units": "m", "origin": "bottom-left", "y_axis": "up",
    "crs_note": "local warehouse metres (not WGS84)",
    "metric_slots": ["lines","picks","stock"],
    "feature_count": 165, "location_count": 165,
    "bounds": {"width": 48.0, "depth": 30.0}
  }
}
```

* リングは **CCW（右手系・RFC 7946 §3.1.6 の SHOULD）**。
* top-level `crs` メンバは**出さない**（RFC 7946 で廃止）。座標系の自己記述は
  foreign member `whsim` が担う。
* 妥当性はテスト内の自前バリデータ（依存追加なし）で全 Feature を検査している。

### CSV（`layout.csv`）

```
location_id,x,y,w,d,level,area,rack_no,aisle,lines,picks,stock
L0000,9.015,12.25,1.47,1.0,1,storage,C03-27,C03,,,
```

* **BOM 付き UTF-8**（日本語Windows の Excel / Power BI が CP932 と誤読しないため）。改行 CRLF。
* `x`,`y` は **矩形の左下角(m)**、`w`,`d` を足すと右上角。GeoJSON のポリゴンと
  **同じ `geoexport._rows` から**出るので、2つの表現は構造的に食い違わない
  （テスト `test_csv_and_geojson_describe_the_same_rectangles` で固定）。
* 数値属性が未取込のセルは**空欄**（0 と「未取込」を混同しない）。

---

## 3. 座標系：y は上向き・原点は倉庫の左下（**変換不要**）

whsim のモデル座標は **メートル・原点は倉庫左下・y 上向き**。緯度経度には変換しない。
根拠は推測ではなく**コードの事実**：

| 場所 | 事実 |
|---|---|
| `render/png2d.py` | `ax.set_ylim(ey0-pad, ey1+pad)`（昇順）＋ `imshow(..., origin="lower")`。matplotlib 既定は y 上向き＝提案PNGは y が大きいほど上 |
| `web/static/js/render2d.js` | `const Y = (y) => h - oy - y * sc; // flip y` — **canvas の y が下向きなので明示的に反転している**＝モデルは y 上向き |
| `web/static/js/designer/core.js` | `_Y(y) { return this._view.h - this._view.oy - y * this._view.sc; } // flip y`（同上） |
| `web/static/js/view3d/geometry.js` | `z0 = r.y`（符号反転なし）でモデル y をそのまま three.js の z へ |
| `docs/ARCHITECTURE.md §3` | MapMaker 取込は「原点平行移動、**Y反転しない**」 |

したがって **エクスポート側で座標変換は行わない**（そのまま出す）。消費側の作法だけ違う：

| 消費のしかた | reflectY / reverse |
|---|---|
| Vega-Lite の **linear（quantitative）スケール**に x/x2・y/y2 を載せる（＝`layout.csv` 経路、同梱 spec） | **不要**。quantitative y の range は既定で `[height, 0]`＝値が大きいほど上 |
| Vega-Lite の **geoshape ＋ `projection: {"type": "identity"}`**（＝`layout.geojson` を直接） | **`"reflectY": true` が必要**。identity 投影は data y をそのまま画面 y（下向き）に写すため |
| three.js | 既存 `view3d` と同じ（model y → world z、反転なし） |

---

## 4. OPEN ISSUE：段（level）の扱い ― 案A / 案B を**両方**実装した

`to_geojson(model, level_mode=...)` のパラメタで切替。**既定は案A（`"per-level"`）**。
最終判断は人間がする。

| | **案A `per-level`（既定）** | **案B `grouped`** |
|---|---|---|
| 1 Feature | **間口1つ** | **棚の1間口列（bay）**。段は畳む |
| Feature 数 | `len(model.locations)`（＝間口総数） | 間口列の数（＝間口総数 ÷ 段数） |
| ジオメトリ | 同一ポリゴンが段数分**重複**する | 重複なし |
| 段の持ち方 | `level: 3` | `level: null` ＋ `levels: [1,2,3,4]`, `level_count: 4`, `location_ids: [...]` |
| 2D 集計 | **素直**（`sum` / `filter(level=…)` がそのまま効く） | 段別に見たいときは自前で展開が要る |
| 2D 描画 | 同じ矩形を段数分**重ね描き**する（半透明・stroke だと濃くなる／集計マークなら無害） | 重ね描きが消える＝**見た目が正しい** |
| 3D 押し出し | `level × 棚段高さ` で**そのまま積める** | 自前で `levels` を展開する必要あり |
| ファイル/行数 | 段数倍（PBI の 30,000 行上限に当たりやすい） | 段数分の1（**大規模倉庫で有利**） |
| `location_id` | 間口コードそのもの（一意） | その列の**最下段のID**（一意は保つ）＋ 全段は `location_ids` |
| 数値属性 | 間口ごとの実測値 | `attach_metrics` が **段を合算**して列の値にする |

判断材料（whsim 側の事実）：

* 同梱テンプレートは全て段数1なので、**現状はどちらでも Feature 数が同じ**。差が出るのは
  `materialize_racks` が `rack_type.levels`（中量棚=4段、AS/RS=12段）で段を生む
  authored shelf のモデル、および locmaster 取込（段の異なり数＝その棚の段数）。
* Deneb（Power BI custom visual）のデータ点上限は既定 **30,000 行**。
  中量棚4段で 7,500 間口列を超えると案Aは上限に当たるが、案Bなら 30,000 列まで持つ。
* 逆に「段別ヒートマップ（下段だけ重い等）」を出したい場合、案Bは PBI 側で
  `levels` 配列を展開できない（Deneb は行を受けるので、展開は取込側の仕事になる）。

**推奨（決定ではない）**：2D BI が主目的なら案A（既定）のまま、段の重複描画は
Vega-Lite 側の集計（`aggregate: "sum"` ＋ 間口列で group）か `filter(level=1)` で処理する。
3D／大規模（>3万行）が主目的なら案B。

---

## 5. 数値属性スロット（`metrics`）

「後から差し替え可能な穴」を **最初から掘っておく**のがこの層の要点：

```python
fc = geoexport.to_geojson(model)                  # metrics は全部 null（穴）
table = geoexport.metrics_from_orders(model)      # {loc_id: {"lines":…, "picks":…, "stock":…}}
fc2 = geoexport.attach_metrics(fc, table)         # 非破壊：新しい dict を返す
fc3 = geoexport.attach_metrics(fc2, {"L0007": {"abc_rank": 1.5}})   # 新スロットも追加可
```

* `attach_metrics` は **入力を変更しない**（deep copy）。渡されなかったスロットは
  `null` のまま残る＝「まだ取り込んでいない」と「ゼロだった」を混同しない。
* grouped モードの Feature は `location_ids` を持つので、段別の実績を**列へ合算**する。
* `metrics_from_orders` は `orders.outbound` の**出荷行数**（`lines`）と**ピース数**
  （`picks`）、`Location.qty` の**在庫**（`stock`）を実測する。SKU→間口の写像は
  `Location.sku`（棚割りの実体）優先、無ければ `Item.default_location` で補う。
  出荷実績が無ければそのスロットは**出さない**（穴のまま）。
* Web/CLI は既定で `metrics_from_orders` を通す（`?metrics=0` / `--no-metrics` で穴のまま）。

---

## 6. 矩形はどこから来るのか（同じ倉庫を2回描かないための約束）

`Location` はスキーマ上 **中心点しか持たない**。矩形は「その間口を生んだ棚」から切り出す：

1. **authored shelf がある場合** — `design._shelf_slots(shelf)` を**前向きに**回して
   間口セルの中心列を得る（`design.materialize_racks` がロケーションを生成したときに
   使ったのと同じ関数）。ピッチはその中心列から幾何的に逆算する
   （`_pitch_from_centers`）ので、rack_type / `cell_w` / `cell_d` の解決規則を
   **ここに書き写さない** ＝ design 側が変わればこちらも自動で追随する。
2. **authored shelf が無い場合**（テンプレートの `RackFill` 全面展開・取込点群）—
   `render/shelves.py` の `_reconstructed_runs` と**同じ規則**でピッチを測る
   （`_min_gap` を共有インポート）。結果の矩形は提案PNG が実際に描く矩形
   （`png2d._draw_racks`：run は `x - depth/2` 起点、セルは `cy ± pitch/2`）と一致する。
   テスト `test_the_exported_rectangles_agree_with_what_the_renderer_draws` で固定。

`area` / `rack_no` / `aisle` の解決順も「**図面が勝つ**」：
authored shelf の名前 → WMS ロケ名（`AAA-01-02-3-01`、`locmaster.normalize_loc` で判定）
→ ゾーンID＋`Location.address`（無ければ `design._address` が同じ x バンド規則で生成）。
`materialize_racks` は棚名に bay/段を**後置**する（`A-01` → `A-01-03-2`）ので、
ロケ名を先に解析すると **bay を棚として報告してしまう** — だから棚が先。

---

## 7. 制限・未検証

* **Power BI 実機では未検証**（この環境に Power BI が無い）。同梱の Vega-Lite spec は
  JSON妥当性・`$schema`・列参照の機械チェックのみ（`docs/powerbi-deneb.md` に明記）。
* 座標は**倉庫ローカル**。GIS ツールに読ませると経緯度として解釈され地球のどこか
  （ギニア湾沖）に落ちる。`projection: identity` 系で受けること。
* 重なった authored shelf が同じセル中心を生む病的ケースは**先勝ち**で解決する
  （決定的だが、図面としてはそもそも直すべき状態）。
* 出力は間口の**平面矩形**のみ。段の高さ（3D の押し出し量）は持たない
  — `rack_type` を鍵に `/api/racktypes` から引くこと（高さをここに複製しない）。
