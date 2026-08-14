# log-forge — WMS実績 → 契約準拠の入力群

WMS の実績表（Excel/CSV）を、**WHSIM_CONTRACTS v1.0** に準拠した3点セットに変換する単独CLI。

| 出力 | 契約 | 中身 |
| --- | --- | --- |
| `orders.json` | §2 | `{order_id, loc_id, qty, ready_t?}` の配列（オーダーセット） |
| `events.jsonl` | §3 | 1行1イベント。**実データから復元できる type だけ**（下の「制限」） |
| `calibration.json` | §8 | 作業時間の分布フィット結果（`dist` / `params` / `n` / `ks_p`） |
| `meta.json` | §5 | `run_id` / `t0` / 入力のSHA256 / 件数 / 注記 |
| `error_table.csv` | — | 隔離した行と理由（log-forge 独自。契約は規定していない） |

設計方針は2つだけ。

1. **出所のない数字を作らない。** 分布は必ず件数(n)とGOF(ks_p)と負けた候補ごと出す。
   マスタに無いコードは推測しない。復元できないイベントtypeは出さない。
2. **止まらない。** 壊れた行は `error_table.csv` に隔離して次の行へ進む。
   致命的なのは「入力が開けない」「mapping.yaml が壊れている」の2つだけ。

WHSiM本体（`whsim` パッケージ）は import しない。依存は pandas / openpyxl / scipy / pyyaml。

---

## 使い方

```bash
# 1) 合成サンプルを作る（実データ不要。既知の真値から生成される）
.venv/bin/python tools/logforge/logforge.py synth -o tools/logforge/samples --dirty

# 2) 変換する（これが本体）
.venv/bin/python tools/logforge/logforge.py convert \
    tools/logforge/samples/wms_picklog.xlsx \
    --mapping tools/logforge/mapping.example.yaml \
    -o /tmp/lf_out

# 3) 出来上がりを契約スキーマで検証する（convert も最後に自動で実行している）
.venv/bin/python tools/logforge/logforge.py validate /tmp/lf_out
```

> `samples/` はリポジトリ全体の `.gitignore`（`samples/`）で追跡対象外。**まず 1) を実行して
> 生成する**。生成物は全て合成データで、シードを固定すれば内容は再現する。

`convert` の出力例（合成サンプル 1200行）:

```
入力 1200 行 → 採用 1200 行 / 隔離 0 行
orders.json      : 1200 行
events.jsonl     : 3600 件 {'pick_end': 1200, 'pick_start': 1200, 'task_assign': 1200}
  復元不能なtype : ['load', 'move_end', 'move_start', 'unload', 'wait_end', 'wait_start']
calibration      : pick_time_s = lognorm {'s': 0.400176, 'loc': 0.0, 'scale': 12.001061} (n=1200, ks_p=0.657)
error_table.csv  : 0 行
t0               : 2025-07-01 07:56:05.075000
契約スキーマ検証: OK
```

終了コード: `0` 正常（隔離行があっても0）/ `1` 入力かmappingが致命的 / `3` 自分の出力が契約スキーマに不合格。

---

## mapping.yaml — 入力の差はここだけで吸収する

列名・シート名・桁数・時刻書式は**コードに一切書かれていない**。別フォーマットの実績表は
YAML を1本足すだけで取り込める。全項目の説明つきの実例は
[`mapping.example.yaml`](mapping.example.yaml)。

吸収できる差:

| 実データでよくある差 | mapping.yaml の対応 |
| --- | --- |
| タイトル行・出力日時行が見出しの上にある | `input.header_row: auto`（mappingの列名が最も多く並ぶ行を見出しとみなす。数値で固定も可） |
| 列名の表記ゆれ（伝票番号／オーダーNo／受注番号） | `columns.<field>` に候補を並べる（先に当たったもの勝ち） |
| 半角カナ見出し（商品ｺｰﾄﾞ・出荷ﾊﾞﾗ数） | 照合時に NFKC 畳み込み＋空白除去＋大小無視。全角で書いても当たる |
| シートが複数ある | `input.sheet`（名前 or 0始まりの番号） |
| CSV が cp932 / タブ区切り | `input.csv.encoding` / `delimiter`（読めなければ utf-8-sig → cp932 で自動リトライ） |
| マスタはゼロ詰め・履歴は非ゼロ詰め（`A-01-02` vs `A-1-2`） | `normalize.<field>.segment_sep` ＋ `pad_segments: [0,2,2]`（**段ごと**に桁指定。0＝触らない＝英字エリアを壊さない） |
| Excel がコードを数値化して先頭ゼロを食った（`000123` → `123`） | `normalize.<field>.zero_pad: 6`（数字だけの文字列にのみ適用） |
| 全角数字・余分な空白・小文字 | `nfkc` / `trim` / `upper` / `lower` / `remove_chars` / `prefix` / `suffix` |
| ロケーションマスタと突合したい | `masters.<field>`（`normalize_key: true` で**マスタ側にも同じ正規化**。片側だけ整えると一致率0%になる） |
| 不明コードの扱いを変えたい | `masters.<field>.on_unknown: error_table`（隔離して継続）/ `keep`（通す）/ `drop`（捨てる） |
| 時刻書式（`2025/07/01 8:00`・ミリ秒つき・Excelシリアル値） | `time.formats` に上から試す順で列挙。Excelの日時セル/シリアル値は書式不要 |
| ラン開始時刻を固定したい | `time.t0: fixed` ＋ `t0_fixed`（既定は `auto_min` ＝ 全時刻の最小値が t=0） |
| 所要時間が「開始/終了の2列」ではなく「作業分」1列 | `calibration.series.<name>.column` ＋ `unit: s\|min\|h` |
| 出したいイベントtypeが違う | `events.emit` に `{type, time}` を並べる（time は `columns:` のキー） |

**キー名を打ち間違えると即エラー**にしている（`normalise:` や `zeropad:`）。黙って無視すると
正規化が効かないまま「成功」して、一致率0%の原因を後から探す羽目になるため。
同じ理由で、`columns:` に無いフィールドを他所から参照した場合もロード時に落とす。

---

## 制限（読む前に知っておくこと）

### 復元できないイベントtypeは出さない

契約 §3 のコア集合のうち、行単位の出荷実績から**素直に復元できるのは3つだけ**:

| type | 出す条件 |
| --- | --- |
| `task_assign` | 指示日時の列があるとき |
| `pick_start` | 作業開始日時の列があるとき |
| `pick_end` | 作業終了日時の列があるとき |

`move_start` / `move_end` / `wait_start` / `wait_end` / `load` / `unload` は**出さない**。
出そうとすると「前の作業終了から次の作業開始までは移動していたはず」「その差が長ければ待ちだったはず」
という**推測**を1つ挟むことになり、その瞬間にイベントログは実績ではなく仮説になる。
反実仮想分析の土台としてそれは致命的なので、`meta.json.events.not_restorable` に
「出さなかったtype」として明示するに留める。ハンディの打刻ログ等、移動/待ちの実打刻が
ある入力なら `events.emit` に足すだけで出せる（コード変更不要）。

`positions.jsonl`（契約 §4）も同じ理由で出さない — 行単位の実績に座標は無い。

### `from` / `to` は既定で出さない

契約の `from`/`to` は**通路グラフの node id**。ロケーションIDと node id が同じ体系だと
分かっているときだけ `events.loc_as_node: true` にすると `to` に入る。既定では
`meta.loc_id` に入れる（node を捏造しない）。

### ks_p は「候補間の比較スコア」であって合格証ではない

パラメータを同じ標本から推定した上で KS 検定にかけているので、p値は理論値より**楽観的**
（本来は Lilliefors 等が要る）。`calibration.json` の `method` にもその旨を書いてある。
負けた候補も `candidates` に全部残してあるので、採用の妥当性は自分で見比べられる。

もう一つ実務上の注意: 打刻が秒単位に丸められている実データでは同値が大量に出るため、
KS 統計量が悪化し ks_p はほぼ0になる。分布の形（params）は依然として使えるが、
「ks_p が低い＝丸めのせいか、分布が違うのか」を `sample` の分位と合わせて判断すること。

### 件数が足りなければ「出さない」

`calibration.min_samples`（既定20）未満の系列はフィットせず、`calibration.json` から
その系列ごと落として `meta.notes` と `error_table.csv` に理由を残す。
n=3 の lognorm を売らないため。

### 必須列そのものが無い場合

その列を使う全行が隔離されるので、`error_table.csv` は入力行数ぶん膨らむ（先頭に
列レベルのエラーが1行）。出力は「空だが契約準拠」になり、終了コードは0。
落とさないのは、他の列だけ先に確認したい場面があるため。

---

## 決定性（DoD 5）

同じ入力＋同じ mapping なら、**`meta.json` 以外の全ファイルがバイト一致**する。

* 変換時刻を書くのは `meta.json.created_at` だけ。`--created-at` で固定すれば `meta.json` も含めて完全一致する。
* 契約 §8 の `fitted_at` は**データ窓の終端**（入力に含まれる最後の壁時計）を入れている。
  ここに変換時刻を入れると出力が毎回変わるため。→ 契約v1.1への提案（下）。
* `run_id` は `sha256(入力のSHA256 + mappingのSHA256)` から作る（時刻を使わない）。
* イベントは `(t, typeの契約順, actorId, order_id, 入力行順)` で安定ソートする（契約 §7 の t 単調非減少を満たすため）。
* 経過秒は `time.ndigits`（既定3桁）で丸める。フィット結果は有効9桁で丸める。
* `meta.json.inputs` にはファイル名とSHA256だけを書く（絶対パスは書かない）。

---

## 合成サンプル（DoD 6・7）

`logforge.py synth` は**既知の真値**からサンプルを生成する。実在の拠点名・個人名・実データは
リポジトリに一切入っていない。

* 作業時間の真値: `lognorm(s=0.4, scale=12.0)` 秒 — `samples/truth.json` に書き出す
* 実データの嫌な性質を再現: 見出しの上にタイトル行2行 / 半角カナ見出し / 履歴は非ゼロ詰め・
  マスタはゼロ詰め / 拠点コードが数値化されて先頭ゼロ消失
* `--dirty` で不正行5種を混入: 必須項目が空 / 数量が非数値（`－`）/ 壊れた時刻（`2025/13/32 99:99`）/
  マスタに無いコード / 終了が開始より前

生成物: `wms_picklog.xlsx`・`wms_picklog.csv`・`loc_master.csv`・`truth.json`
（`--dirty` 時は `wms_picklog_dirty.*`・`truth_dirty.json`）。
xlsx の**内容**はシード固定で再現するが、zip コンテナが持つ更新時刻のためファイルの
バイト列までは一致しない（変換出力のバイト一致には影響しない）。

---

## error_table.csv

列: `row, stage, field, column, value, reason, action, detail`
（`row` は入力ファイル上の行番号＝Excelの行番号。`detail` は日本語の説明）

| reason | action | 意味 |
| --- | --- | --- |
| `required_column_missing` | row_quarantined / field_dropped / series_omitted | 必須列が入力に無い |
| `required_value_empty` | row_quarantined | 必須項目が空 |
| `qty_not_numeric` | row_quarantined | 数量が数値として読めない |
| `unknown_code` | row_quarantined | マスタに無いコード（`value` は正規化後のキー） |
| `unparseable_timestamp` | field_dropped | 時刻として読めない（その時刻だけ落とし、行は残す） |
| `t_before_t0` | field_dropped | `t0: fixed` より前の打刻（経過秒が負） |
| `negative_duration` | sample_dropped | 終了が開始より前（較正の標本からのみ除外） |
| `duration_out_of_range` | sample_dropped | `min_s`/`max_s` の外 |
| `insufficient_samples` | series_omitted | 件数不足でフィットしない |
| `fit_failed` | series_omitted | 全候補のフィットに失敗 |
| `no_timestamps` | events_omitted | 時刻が1件も読めずイベントを出せない |

---

## テスト

```bash
.venv/bin/python -m pytest tools/logforge/tests -q
ruff check tools/logforge
```

* `test_fit_recovery.py` — 既知の真値（lognorm s=0.4, scale=12）を許容誤差内で回収するか。
  パイプライン全体（xlsx → calibration.json）でも回収を確認する
* `test_dirty_input.py` — 不正5種が全部 error_table に落ちて処理が継続するか。
  ゼロ詰めを外すと一致率が崩壊することも固定（正規化が効いている証拠）
* `test_determinism.py` — 2回実行のバイト一致（ライブラリ経由・CLI経由の両方）
* `test_schema.py` — 契約スキーマ合格＋壊れた文書を確かに落とすか。
  `jsonschema` が入っている環境では参照実装と突き合わせる（無ければ skip。依存には足さない）
* `test_mapping.py` — mapping の打ち間違いを落とすか、xlsx と CSV が同じ結果になるか、
  別形式（所要時間1列・t0固定・別シート）を吸収できるか
* `test_units.py` — 正規化と時刻解釈の単体

---

## 契約 v1.1 への提案（v1.0 準拠のまま回避してある）

1. **§8 `fitted_at` と決定性が衝突する。** 変換時刻を入れると同一入力でも出力が毎回変わる。
   log-forge は「データ窓の終端」を入れて回避した。v1.1 では
   「`fitted_at` はデータ由来の値でよい」と明記するか、`data_window_end` に改名したい。
2. **§8 の系列名とパラメータ名の規約が未定義。** 例に `pick_time_s` があるだけ。
   log-forge は「`<名前>_s`（単位付き）」「`params` は scipy のパラメータ名そのまま
   （`loc` を含む＝`scipy.stats.<dist>(**params)` がそのまま動く）」を採用した。明文化を提案。
3. **§3 の拡張typeに名前空間規約が無い。** 例えば独自 `pick` はコア集合の意味と衝突する。
   `x_` 接頭辞を必須にすることを提案（log-forge は自分のスキーマで既に強制している）。
4. **§3 にイベントとオーダーを結ぶキーが無い。** log-forge は `meta.order_id` / `meta.loc_id` /
   `meta.sku` を使っている。`meta` の予約キーとして明文化すれば、下流が推測せずに join できる。
5. **§7 の「t単調非減少」に同値のタイブレークが無い。** 同一 t の `pick_end` と次の `pick_start`
   の順序が処理系依存になる。「t → コア集合の宣言順 → actorId」等の規約を提案
   （log-forge はこの順で安定ソートしている）。
6. **§5 `t0` の書式・タイムゾーン規約が無い。** log-forge は ISO 8601 のナイーブ壁時計
   （`YYYY-MM-DD HH:MM:SS[.ffffff]`）で書いている。明文化を提案。
7. **取り込み時に落とした行を記録する場所が無い。** log-forge は `error_table.csv` と
   `meta.json.counts` を独自に足した。データ欠損が下流から見えないと KPI が静かに歪むので、
   §5 に任意ファイルとして載せることを提案。
8. **§2 `qty` の単位が未定義**（ピース/ケース/行）。log-forge は入力の単位をそのまま通し、
   採用した列名を `meta.json` に残している。単位の明示を提案。
