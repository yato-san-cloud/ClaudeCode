# WHSIM_CONTRACTS v1.0 — ツール群共通契約

このファイルはWHSiMエコシステム（本体・cad2loc・log-forge・chrono-lens）が共有するデータ契約。**各ランはこの契約に準拠する。契約の変更は禁止**。不備・不足を見つけたら PROGRESS.md に「契約v1.1への提案」として記録し、v1.0準拠のまま実装を回避策で進める。全ファイルはUTF-8。

## 座標系
- 平面直交座標・単位メートル・非地理（lon/latではない）。原点は図面左下、x右・y上。
- GeoJSONもこの座標系で使う（RFC 7946の地理座標規定は意図的に無視。`meta.crs: "local-meters"` を明記）。

## 1. レイアウト（layout.geojson）
FeatureCollection。各Featureは `properties.kind` で種別を持つ：
- `rack`：Polygon。`{kind:"rack", id, label?}`。搬送体が進入不可能な占有領域。
- `node`：Point。`{kind:"node", id}`。通路グラフの頂点。ロケーション（間口）もnodeとして表現し `{loc_id?}` を付与。
- `edge`：LineString。`{kind:"edge", id, from, to, width_m?}`。通路グラフの辺。**edgeはrackポリゴンと交差してはならない**（検証必須）。
- `zone`：Polygon。`{kind:"zone", id, label}`。任意（出荷バース等の意味領域）。

## 2. シナリオ（scenario.json）
```json
{
  "schema_version": "1.0",
  "layout": "layout.geojson",
  "actors": { "count": 5, "speed_mps": 1.4, "type": "picker" },
  "dispatch": "fifo",
  "orders": "orders.json",
  "duration_s": 28800,
  "seed": 42
}
```
- `orders` はファイル参照またはインライン配列。オーダー行：`{order_id, loc_id, qty, ready_t?}`。
- 介入変数（count / dispatch / layout / orders / seed）はすべてここに集約。コード変更で挙動を変えない。

## 3. イベントログ（events.jsonl）
1行1イベントのJSONL。
```json
{"t": 123.4, "type": "wait_start", "actorId": "P01", "from": "n12", "to": "n13", "meta": {}}
```
- `t`：ラン開始からの経過秒（number）。実データ由来の場合は壁時計→オフセット変換し、t0は meta.json に持つ。
- `type` コア集合：`task_assign, move_start, move_end, wait_start, wait_end, pick_start, pick_end, load, unload`。拡張typeは自由だがコア集合の意味を変えない。
- `from`/`to`：node id（typeにより省略可）。`meta`：自由領域。

## 4. 位置サンプル（positions.jsonl）
軌跡再生用。`{"t": 123.4, "actorId": "P01", "x": 12.3, "y": 45.6}`。サンプリング間隔は1秒以下推奨。

## 5. 実行成果物ディレクトリ（runs/<run_id>/）
```
scenario.json   … 実行時スナップショット（参照解決済み）
events.jsonl
positions.jsonl
summary.json    … KPI集計
meta.json       … {run_id, schema_version, seed, scenario_hash, t0?, created_at, generator}
```

## 6. KPIサマリ（summary.json）
```json
{
  "schema_version": "1.0",
  "rows_per_hour": 0.0,
  "total_distance_m": 0.0,
  "wait_time_s": { "mean": 0, "p50": 0, "p95": 0, "total": 0 },
  "utilization": { "P01": 0.0 }
}
```
- すべてevents.jsonl / positions.jsonlからの集計値であること。他経路で数値を作らない。

## 7. 検証
- 各ツールは自分が読む/書くファイルをJSON Schema（このドキュメントから起こす）でバリデーションする。
- 共通アサーション：軌跡・edgeとrackポリゴンの交差0件／t単調非減少（同一ファイル内）／wait_start と wait_end の対応。

## 8. 較正パラメータ（calibration.json）— log-forge出力、WHSiM入力
```json
{
  "schema_version": "1.0",
  "pick_time_s": { "dist": "lognorm", "params": {"s": 0.4, "scale": 12.0}, "n": 1520, "ks_p": 0.31 },
  "source": "fukuroi_202507", "fitted_at": "..." }
```
- 分布名はscipy.stats準拠。フィット元件数とGOF指標を必ず同梱（出所のない数字を作らない）。
