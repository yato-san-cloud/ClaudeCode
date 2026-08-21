# cad2loc — 倉庫DXF図面 → layout.geojson

任意の倉庫DXF図面から、**WHSIM_CONTRACTS v1.0 §1 準拠の `layout.geojson`**
（ラック占有領域＋通路グラフ＋任意のゾーン）を作る単独CLI。図面ごとの取り決め
（レイヤ名・単位）は `mapping.yaml` に置き、コードには何もハードコードしない。

WHSiM本体（`whsim` パッケージ）には依存しない。依存は
**ezdxf / shapely / networkx / scikit-learn / pyyaml** の5つだけ。

## 使い方

```bash
# リポジトリのチェックアウトから直接（インストール不要）
.venv/bin/python tools/cad2loc/cad2loc.py input.dxf --config mapping.yaml -o layout.geojson

# 同じもの（tools/cad2loc をカレントにして）
cd tools/cad2loc && python -m cad2loc input.dxf -c mapping.example.yaml -o layout.geojson

# 設定なしでも動く（レイヤ名は既定のグロブ、単位は自動判定）
.venv/bin/python tools/cad2loc/cad2loc.py input.dxf -o layout.geojson
```

出力は2つ:

| ファイル | 内容 |
|---|---|
| `layout.geojson` | 契約準拠の FeatureCollection（`rack` / `node` / `edge` / `zone`） |
| `report.json` | 未分類図形・曖昧要素・孤立ノード・変換係数・アサーション結果 |

`report.json` の出力先は既定で `layout.geojson` と同じディレクトリ。`--report PATH` で変更。

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 成功（警告があっても0。警告は report.json） |
| 2 | 入力が扱えない（DWG・空図面・設定ファイル不備・ファイル無し） |
| 3 | 契約検証に不合格（JSON Schema or 共通アサーション） |
| 1 | 想定外の例外 |

### DWG について

**DWGは直接扱わない。** ODA File Converter 等で事前にDXF（R2010以降推奨）へ変換すること。
拡張子だけ `.dxf` に変えたDWGは先頭6バイト（`AC10xx`）で検出し、変換方法を添えて
終了コード2で止める（黙って空の図面を出さない）。

## mapping.yaml

`mapping.example.yaml` が全キーの説明付き雛形。未指定キーは既定値が使われるので、
**まず設定なしで流し、`report.json` の `unclassified` / `ambiguous` を見てレイヤ名を足す**
のが早い。主なキー:

- `units.scale_to_m` — 図面単位→メートル（mm図面なら `0.001`）。`"auto"` は
  図面の最大辺が `auto_mm_threshold` を超えたらmmとみなす。
- `layers.{rack,wall,zone,ignore}` — レイヤ名のグロブ（大小文字・全角半角を無視）。
  判定順は `ignore → rack → wall → zone`。どれにも当たらない図形は
  `report.unclassified` に出る（処理は止めない）。
- `rack_detect.*` — 面積フィルタとクラスタリングのつまみ。
- `aisle_graph.*` — 通路グリッド間隔・離隔・ノード数上限。

## アルゴリズム

### 1. 読み込み（`dxfread.py`）

`ezdxf.readfile` → 失敗したら `ezdxf.recover.readfile`（切り詰められた図面等はこれで通る）。
INSERT は最大3段まで展開するので、ブロック化されたラックも見える。
LWPOLYLINE / POLYLINE / LINE / SOLID / TRACE / 3DFACE を扱い、それ以外はレイヤ×種別で
数えて `report.unclassified` へ。読み終えた時点で **mm→m 換算と原点左下への平行移動**
を済ませる（以降すべてメートル・y上）。

### 2. ラック抽出（`racks.py`）— 2経路

- **閉図形経路**: rackレイヤの閉ポリライン/SOLIDは、その形のままラック占有領域。
  斜め配置はリングをそのまま使うので回転が保たれる。端点が
  `close_tolerance_m` 以内なら閉じているとみなす（`ambiguous` に記録）。
- **クラスタリング経路**: 閉図形が無く線分だけの図面向け。線分を
  `sample_step_m` 間隔でサンプリング → **DBSCAN**（ラック列は密、通路は空）→
  各クラスタの**最小回転矩形**。回転前提を置かないので斜めの列もそのまま復元できる。
  既存ラックに含まれる線分（筋交い等）は除外し、重なったクラスタは破棄する。

面積 `min_area_m2`〜`max_area_m2` の外、短辺 `min_width_m` 未満は捨てて理由を報告。

### 3. 通路グラフ（`aisles.py`）

1. **建屋外形**: 壁レイヤの線を `polygonize` して最大面積の閉領域を採用（L字も通る）。
   閉じなければラック外接矩形＋`envelope_margin_m`。
2. **自由空間** = 外形を `clearance_m` 内側に縮めたもの − ラック∪を `clearance_m` 膨らませたもの。
3. 自由空間を `grid_spacing_m` の一様グリッドで刺し、内部の点だけを **node** に。
4. 4近傍を結び、**自由空間に完全に含まれ、かつラックと交差しない**線分だけを **edge** に。
   `width_m` は辺中点から最寄りのラック／壁までの距離×2。
5. `networkx` で連結成分を取り、**主成分以外は出力せず `report.isolated_nodes` に載せる**
   （契約「全nodeが主成分」を出力自体の性質にする）。

通路中心線ではなくグリッドを使うのは、ラックの整列を仮定しないため。契約の
「edge×rack 交差0件」はヒューリスティックではなく**フィルタの性質**として保証される。
ノード数が `max_nodes` を超えるとグリッドを自動的に粗くし、その旨を report に書く。

### 4. 検証（`validate.py`）

- `schema/layout.schema.json` — 契約 §1 から起こした JSON Schema（draft 2020-12）。
- 自前バリデータ（`jsonschema` パッケージは使わない）。テストで
  `jsonschema` があれば結果を突き合わせる（無ければスキップ）。
- 共通アサーション（**出力したドキュメント自体に対して**実行）:
  edge×rack 交差0件 / 通路グラフの連結性 / edge の from・to が実在ノードを指すこと。

## 出力例

```json
{ "type": "FeatureCollection",
  "features": [
    {"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[5.0,4.0],[35.0,4.0],[35.0,5.2],[5.0,5.2],[5.0,4.0]]]},
     "properties":{"kind":"rack","id":"r0001","label":"RACK","source":"polyline"}},
    {"type":"Feature","geometry":{"type":"Point","coordinates":[0.85,0.85]},
     "properties":{"kind":"node","id":"n00001"}},
    {"type":"Feature","geometry":{"type":"LineString","coordinates":[[0.85,0.85],[1.85,0.85]]},
     "properties":{"kind":"edge","id":"e00001","from":"n00001","to":"n00002","width_m":1.7}}
  ],
  "meta": {"crs":"local-meters","generator":"cad2loc 0.1.0","units":{"scale_to_m":0.001,"offset_m":[0.0,0.0]}}
}
```

`properties.label` / `source` は契約が禁じていない追加情報（上位互換）。

## テスト

```bash
.venv/bin/python -m pytest tools/cad2loc/tests -q
```

ルートの `pytest` の収集対象外（`pyproject.toml` の `testpaths = ["tests"]`）なのは意図的。
単独ツールなので本体のテストとは独立に回す。

実図面はリポジトリに置かない。テストは `tests/synthetic.py` が **ezdxf でその場に生成する
既知レイアウト**（単純3通路型 / L字型 / 斜め配置 / 線分だけの図面 / ブロック＋SOLID）だけで
全受け入れ基準を検証する。各生成関数は正解のラック矩形を返すので、抽出結果と座標で突き合わせる。

## 既知の制限

- ARC / CIRCLE / SPLINE / HATCH はラック候補にしない（`report.unclassified` に出る）。
  曲線で描かれたラックは対象外。
- ラックの背中合わせ間隔が `cluster.eps_m` より狭い図面では、クラスタリング経路が
  2列を1つの矩形にまとめることがある（閉図形で描かれていれば影響しない）。
- ロケーション（間口）は生成しない。契約は node に `loc_id` を持てるが、DXFだけでは
  間口番号が分からないため、ロケーションマスタとの突合は別ツールの仕事。
- 通路グラフはグリッド由来なので、ノード座標は棚間口の正面に厳密には一致しない。
  `grid_spacing_m` を小さくすると密になるがノード数は二乗で増える。
- マルチフロアには未対応（モデル空間の2D投影のみ）。
