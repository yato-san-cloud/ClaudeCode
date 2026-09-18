# MCP実験装置（whsim-lab）

whsim を **MCPサーバー**として公開し、LLMが道具越しに
「シナリオ実行 → 差分実験 → スイープ → ログ問い合わせ → 比較 → レポート」を
行える実験装置にする。

分業は1行で言える — **LLMは実験者、DESは装置**。物理・乱数・KPI集計は全て既存の
Python側（`whsim.engine` → `whsim.kpis` → `whsim.sim`）にあり、MCP層
（`src/whsim/mcp_server.py`）は**薄いラッパでシミュレーションロジックを一切
持たない**。全ての数値出力は `runs/<run_id>/` の成果物由来なので、
「その数字はどのrunのどのログから来たか」を後から誰でも追試できる。

- 実験の記録（実際のE2E）: [`docs/mcp-lab-e2e.md`](mcp-lab-e2e.md)
- 装置側の口: `src/whsim/sim.py`（ヘッドレス実行・run台帳）
- 実験ノート側: `src/whsim/lab_report.py`（比較表・レポート・照合関数）

## 導入

```bash
pip install -e ".[dev,web,docs,lab]"      # lab = MCP公式Python SDK
```

`lab` エクストラが足す依存は `mcp` 1つだけ。図は既存の matplotlib（Agg・
ヘッドレス）をそのまま使う。

## 起動（stdio）

```bash
python -m whsim.mcp_server
```

標準入出力で喋るので、単体で起動しても何も表示されない（正常）。疎通だけ
確かめたいときは E2E テストを回す:

```bash
.venv/bin/python -m pytest tests/test_mcp_lab.py -q
```

## Claude Code から接続する

```bash
# リポジトリのルートで（絶対パス推奨 — サーバーはどこからでも起動できる）
claude mcp add whsim-lab -- /abs/path/to/whsim/.venv/bin/python -m whsim.mcp_server
```

`runs/` の置き場を明示したいとき（既定はリポジトリ直下の `runs/`）:

```bash
claude mcp add whsim-lab \
  --env WHSIM_RUNS_DIR=/abs/path/to/whsim/runs \
  -- /abs/path/to/whsim/.venv/bin/python -m whsim.mcp_server
```

スコープはお好みで（`-s local`（既定・自分だけ） / `-s project`（`.mcp.json`
としてチームで共有） / `-s user`（全プロジェクト））:

```bash
claude mcp add whsim-lab -s user -- /abs/path/to/.venv/bin/python -m whsim.mcp_server
```

確認・削除:

```bash
claude mcp list
claude mcp get whsim-lab
claude mcp remove whsim-lab
```

セッション中は `/mcp` で接続状態とツール一覧が見られる。

設定ファイルに直接書く形（`.mcp.json` / 他のMCPホストの設定）なら:

```json
{
  "mcpServers": {
    "whsim-lab": {
      "command": "/abs/path/to/whsim/.venv/bin/python",
      "args": ["-m", "whsim.mcp_server"],
      "env": { "WHSIM_RUNS_DIR": "/abs/path/to/whsim/runs" }
    }
  }
}
```

## ツール

| ツール | 入力 | 返すもの |
|---|---|---|
| `run_scenario` | `scenario_path` か `scenario_json`、`seed?` | `run_id` / `seed` / `scenario_hash` / `summary`(KPI) / `artifacts_path` |
| `apply_diff_and_run` | `base_scenario`（パスかJSON）、`diff_json`（dotted-path編集）、`seed?` | 上と同じ＋適用後シナリオ・`applied_edits` / `unapplied_edits` |
| `compare_runs` | `run_ids[]`、`metrics?` | KPI差分表（絶対値・差・変化率・出所パス） |
| `sweep` | `base_scenario`、`param_grid`（スカラー軸／**連動軸**）、`seeds[]`、`metrics?` | `sweep_id` / `table_path` / ケース行 `rows`（params↔run_id↔KPI）/ 集計サマリ / `tied_axes` / `unapplied_edits` / `warnings` / エラー一覧 |
| `query_events` | `run_id`、`filter{type?,actor?,t_range?}`、`limit?`、`rep?` | 件数・時間範囲・type別内訳・数値フィールド集計＋先頭 `limit` 行 |
| `get_run_artifacts` | `run_id` | 成果物ファイルのパスとサイズ |
| `list_runs` | `limit?` | run台帳（新しい順） |
| `init_state_from_snapshot` | `state_json` | 初期状態として使える形かの検証結果（**I/Fと最小実装のみ**） |
| `generate_report` | `run_ids[]`、`out_dir?`、`metrics?` | Markdown＋PNG＋`numbers.json`＋自己照合結果 |
| `verify_report` | `report_dir` | レポートの機械照合（台帳↔成果物、本文↔台帳） |

シナリオJSONの形（全キー任意 — never-blocks）:

```json
{
  "name": "台数を1台減らす",
  "template": "ecommerce_small",
  "edits": {"resources.workers.0.count": 11, "simulation.aisle_interference": true},
  "seed": 7,
  "reps": 1,
  "duration_s": 3600.0
}
```

`template` の代わりに `"model": "path/to/model.json"` でもよい。`edits` は
`engine/scenarios.py` の dotted-path 編集そのもの。

### 掃引で見る KPI を名指しする（`sweep(metrics=…)`）

`compare_runs` / `generate_report` と同じ規約で、`metrics` 未指定＝既定の主要KPI。
**既定に入っていない読み出しは名指ししないと表に出ない** — ライン運用の3機構
（不変条件17）の答えはどれも既定の外にある:

```json
{"metrics": ["containers_in_use_peak", "container_pool_size",
             "container_wait_total_s", "conveyor_gate_stops",
             "conveyor_block_ratio", "completion_rate"]}
```

`containers_in_use_peak` は**必要保有数の下限**なので、`container_pool_size`
（設定値）と `container_wait_total_s` を並べて初めて読める — 一致していたら
「天井に当たった」であって答えではない。

### 連動軸 — 実験変数は1つ、編集はN本（`param_grid` の第2の形）

格子は既定では**直積**なので、「つまみ1つ＝編集1本」でない実験がそのまま書けない。
現場の実験変数はたいてい複数パスの編集になる:

- **引き込みあたりの梱包台** — 実ライン（引き込み5ヶ所×両側）で station **10本**、
- **停止線の位置** — 線の位置**と、そこに立つ人**の2本。片方だけ動かすと
  停止線は黙って作業者を失い、その荷は共有プールが拾ったことになる。

直積で回すと (1) 対角以外の無意味なケースを買わされ、(2) 実寸では
**3水準^10 × 4seed = 236,196ケース**で上限64に当たり、1本も走らずに断られる。

そこで軸の値を「値の並び」ではなく **水準（level）の並び**でも渡せる。
1水準＝**まとめて当てる編集の集合**:

```json
{"param_grid": {
  "台数±": {"levels": [
    {"name": "1台/引き込み", "edits": {"resources.stations.1.count": 0,
                                       "resources.stations.3.count": 0,
                                       "resources.stations.5.count": 0}},
    {"name": "2台/引き込み", "edits": {"resources.stations.1.count": 1,
                                       "resources.stations.3.count": 1,
                                       "resources.stations.5.count": 1}},
    {"name": "3台/引き込み", "edits": {"resources.stations.1.count": 2,
                                       "resources.stations.3.count": 2,
                                       "resources.stations.5.count": 2}}
  ]},
  "orders.profile.peak_factor": [1.0, 2.0]
}}
```

- キーは dotted-path ではなく**軸の名前**（表の列名・行の値になる）。
- **ケース数は水準数で数える** — 1水準の中に何本編集があっても1ケース。
  上の例は `3水準 × 2値 × seed数`。
- スカラー軸（`"dotted-path": [値, …]`）と**同じ格子に混ぜられる**。
  スカラー軸の綴りと応答は1バイトも変わっていない。
- `name` は省略可（編集から作る）。`{"edits": {…}}` を書かず、編集そのものを
  水準として渡してもよい（`{"name": …}` だけが予約語）。
- 2つの軸が同じパスを書くと**断る**（直積の中であとから来た軸が黙って勝つため）。
- 表（`rows` / `table.csv`）と応答には**水準名**が出る。水準の全量（編集の集合）は
  `table.json` の `rows[].tied` に残るので、出所は失われない。
- `unapplied_edits` は**水準の中のパス単位**で出る — 10本のうち1本の綴り違いが、
  残り9本が効いたことの陰に隠れない。

#### 以前は不可能だった 台数± の実例（`line_inspection`・引き込み5ヶ所×両側）

```python
BENCH = [f"resources.stations.{i}.count" for i in range(1, 20, 2)]   # 10本

# これは走らない: 3^10 × 4seed = 236,196 > 64
sweep(base, {p: [0, 1, 2] for p in BENCH}, seeds=[1, 2, 3, 4])

# 同じ実験を1つの軸として: 3水準 × 4seed = 12ケース
sweep(base,
      {"台数±": {"levels": [
          {"name": f"{n + 1}台/引き込み", "edits": {p: n for p in BENCH}}
          for n in (0, 1, 2)]}},
      seeds=[1, 2, 3, 4],
      metrics=["completion_rate", "packer_utilization", "conveyor_block_ratio"])
```

返る `rows` は12行で、`params` は `{"台数±": "2台/引き込み"}` のように読める。
実測（`duration_s=900`・需要3倍・seed 4本の平均）:

| 台数± | 完了率 | 梱包稼働率 |
|---|---|---|
| 1台/引き込み | 0.266 | 0.659 |
| 2台/引き込み | 0.486 | 0.603 |
| 3台/引き込み | 0.567 | 0.469 |

2台→3台で完了率の伸びが鈍り、梱包稼働率が落ちる＝**臨界点は2台と3台の間**。
この表は12本のDESで得られる — 直積のままなら236,196本、上限で断られていた。

#### 顧客の3掃引のケース数

| 掃引 | 連動するパス | 直積（従来） | 連動軸 |
|---|---|---|---|
| 台数±（3水準・seed4） | station 10本 | **236,196**（上限64で拒否） | **12** |
| 停止線位置±（3水準・seed4） | `stop_gate.at_m` ＋ 立つ人の `x` の2本 | 36（うち対角は12、24は捨てる） | **12** |
| オリコン数±（6水準・seed4） | `process.container_pool.count` 1本 | 24 | 24（**スカラー軸のまま・不変**） |

停止線位置± を線だけで掃くと答えが**甘い側に外れる**（完了率・同一モデル・
`seed=1`・`duration_s=600`）:

| 停止線の位置 | 線だけ動かした | 線＋人を連動 |
|---|---|---|
| 10m | 0.571 | 0.386 |
| 18m（基準＝人が既にそこに居る＝対照） | 0.314 | 0.314 |
| 26m | 0.714 | 0.229 |

梱包台の持ち主は幾何で決まるので、線だけ動かすと停止線は作業者を失い、その荷は
共有プール（この例では8台）が拾ったことになる。**「位置を変えても捌ける」と
読める表が出る**のが一番危ない。

### 掃引が黙って空振りしていないか

`apply_scenario` は解決できない dotted-path を**黙って捨てる**（`stop_gate` /
`container_pool` は既定 `None` なので、`…stop_gate.at_m` のような下位パスは
基準モデルにゲートが無ければ丸ごと落ちる）。1本なら `apply_diff_and_run` の
`unapplied_edits` に出るが、掃引だと「同じ数字が並んだ」だけが返り、
**「このつまみは効かない」と読み違える**。なので `sweep` も焼かれた
`model.json` を読み直し、

- `unapplied_edits` — 効かなかったパスと、その発生ケース番号、
- `warnings` — 上記＋「同一seedの全ケースでKPIが完全に一致した」注意

を返す。

### 自由 dict のキーの綴り違い（落ちたパスより悪い）

`Conveyor.stop_gate` / `Process.container_pool` / `release_schedule` /
`bench_staging` は**型を持たない dict**（手書きのモデルが入れ子スキーマ無しで
書けるための設計）。その代償として `container_pool.size` のような綴り違いは
**モデルに書けてしまい・読み戻せてしまう**ので、値の一致だけを見る検査は
「適用された」と報告してしまう — 落ちたパスより悪い（落ちたパスは黙るだけだが、
これは嘘をつく）。

`apply_diff_and_run` と `sweep` は、エンジンが実際に読むキーかどうかまで見る:

```json
{"path": "process.container_pool.size",
 "reason": "エンジンが読まないキーです（書けてしまいますが無視されます）: size — container_pool が読むのは count / return_belt / return_time_s",
 "unknown_keys": ["size"],
 "recognized_keys": ["count", "return_belt", "return_time_s"]}
```

dict 丸ごとの差し替え（`{"process.container_pool": {"size": 300}}`）でも同じ。
掃引では `warnings` に「自由 dict にエンジンが読まないキーを書いています」が
1行増える。

**認識キーの表はこの層に持っていない**（不変条件11 — ハードコピー増殖の禁止）。
対象フィールドはスキーマが `dict | None` と宣言しているもの、キーは
`engine/build.py` を構文木で読んで「そのフィールドを受けた変数から読まれている
文字列キー」を集めたもの。エンジンがキーを増やせばこちらも増える。
`tests/test_mcp_lab.py::test_the_recognized_keys_are_derived_from_the_engine_not_copied`
が「MCP層のコードにその文字列が1つも無いこと」で固定している。

## 成果物（数値の出所）

```
runs/
  index.jsonl                     run台帳（1行1run）
  <run_id>/
    scenario.json                 解決済みシナリオ（実験の宣言）
    model.json                    編集適用後の完全なモデル（これだけで追試できる）
    events.jsonl                  生イベントログ（rep0。events_repNN.jsonl で全rep）
    summary.json                  KPI＋run_id/seed/scenario_hash
  sweeps/<sweep_id>/              table.csv / table.json / index.jsonl / sweep.json
  reports/<report_id>/            report.md / numbers.json / kpi_bars.png / delta_pct.png
```

`WHSIM_RUNS_DIR` を立てるとこの木ごと移せる（テストは常に一時ディレクトリを
使うので、リポジトリの `runs/` を汚さない）。

## 捏造遮断（この装置の肝）

レポートは `NumberLedger` 越しにしか数字を書けない — `cite()` が成果物
ファイルを読んでその値を返すので、**成果物に無い数値はそもそも紙に載らない**。
載った数値は `numbers.json` に

```json
{"id": "n0007", "text": "444.943625", "value": 444.943625, "format": "num",
 "source": {"kind": "artifact", "run_id": "r…", "file": "summary.json",
            "path": ["kpis", "pick_wait_mean_s"]},
 "anchor": {"table": "KPI比較", "row": "ピッキング待ち平均（秒）", "col": "-f04f193f"}}
```

の形で並び、差・変化率は `{"kind": "arithmetic", "op": "pct_change",
"operands": [...]}` として**出所ごと**残る。`anchor` は「その数値が本文の
どのセルに居るべきか」（表の見出し × 行ラベル × 列。1セルに複数並ぶ列は
`part` で位置まで）。照合は3方向で見る:

1. 台帳 → 成果物（記録した値が本当にそのrunの値か、算術は本当に再計算できるか）
2. 本文 → 台帳（紙に載った数字が1つ残らず台帳にあるか）
3. 台帳 → 本文の**位置**（表のそのセルに、その出所の値が居るか）

3 が要るのは、2 が「数値トークンの集合所属」判定だから — 本文のある数値を
**レポート内の別の正当な数値**に入れ替える改竄（到着オーダー数のセルに seed の
値を置く）は、置いた数字も台帳に「居る」ので集合判定を素通りする。セル位置まで
見て初めて落ちる（`misplaced_numbers`）。表以外の本文数値は 2 の集合判定のまま。

```bash
python -c "import json,whsim.lab_report as L; \
print(json.dumps(L.verify_report('runs/reports/<report_id>'), ensure_ascii=False))"
```

`{"ok": true, "checked": 86, "anchored": 84, "mismatches": [],
"unbacked_numbers": [], "misplaced_numbers": []}` が通った状態。数字を1つ
書き換えれば必ず落ちる — `tests/test_mcp_lab.py` に故意に改竄した対照が
6種入っている（台帳の値／本文に無い数字を追記／run成果物の改竄／**別の正当な
数値へのすり替え**／2セルの入れ替え／行の削除）。

なお識別子・時刻・シナリオ名はコードスパン（`` ` ``）で表記し、照合対象は
本文の数値だけにしている。

## 既知の限界

- `init_state_from_snapshot` は**形の検証だけ**。DESにウォームスタートの口が
  無いので、この状態から実行することはまだできない（実WMS較正は別ラン）。
  応答は `engine_supported: false` と明示して返る。
- `sweep` の総ケース数は上限つき（既定 64）。1ケース＝1 DES なので、
  会話が返って来なくならないための歯止め。**連動軸は水準数で数える**ので、
  1つの実験変数がN本の編集でも上限の消費は1水準＝1。
- 自由 dict のキー検査が見るのは **`apply_diff_and_run` の差分 / `sweep` の格子**
  だけで、**基準シナリオの `edits`** は見ていない（そちらは検査の対象＝差分では
  なく前提なので、焼かれた `model.json` と突き合わせる相手が無い）。基準に書いた
  `container_pool.size` は今も黙って無視される — つまみは差分側に書くこと。
- 正しい直し方は**スキーマ側で認識キーを宣言する**こと（`schema/model.py` の
  `Field(json_schema_extra={"recognized_keys": [...]})` のような単一の源）。
  今は `engine/build.py` の構文木から導出しているので、エンジンが
  「`getattr` で受けた変数からキーを読む」書き方をやめた瞬間に**検査ごと黙って
  降りる**（`mechanism_keys()` が空 ⇒ 検査しない＝never-blocks）。導出が効いて
  いることはテストが固定しているが、根は `schema/` 側にある。
- ツール応答に生ログは載らない（`query_events` は要約＋先頭 `limit` 行）。
  全量は `get_run_artifacts` が返すパスの `events.jsonl` を直接読む。
- サーバーは同期実行（stdio・1クライアント想定）。長いシナリオはその間
  応答が返らないので、まず `duration_s` を短くして形を確かめるとよい。

## E2Eの記録を作り直す

```bash
WHSIM_MCP_E2E_DOC=1 .venv/bin/python -m pytest tests/test_mcp_lab.py -k e2e -q
```

`docs/mcp-lab-e2e.md` が上書きされる（フラグを立てない限り、通常の pytest は
リポジトリに何も書かない）。
