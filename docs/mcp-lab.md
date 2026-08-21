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
| `sweep` | `base_scenario`、`param_grid`、`seeds[]`、`metrics?` | `sweep_id` / `table_path` / ケース行 `rows`（params↔run_id↔KPI）/ 集計サマリ / `unapplied_edits` / `warnings` / エラー一覧 |
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

### 掃引が黙って空振りしていないか

`apply_scenario` は解決できない dotted-path を**黙って捨てる**（`stop_gate` /
`container_pool` は既定 `None` なので、`…stop_gate.at_m` のような下位パスは
基準モデルにゲートが無ければ丸ごと落ちる）。1本なら `apply_diff_and_run` の
`unapplied_edits` に出るが、掃引だと「同じ数字が並んだ」だけが返り、
**「このつまみは効かない」と読み違える**。なので `sweep` も焼かれた
`model.json` を読み直し、

- `unapplied_edits` — 効かなかったパスと、その発生ケース番号、
- `warnings` — 上記＋「同一seedの全ケースでKPIが完全に一致した」注意

を返す。後者は自由 dict（`container_pool` / `stop_gate` は型が `dict`）に
**綴り違いのキーを書いた**ときの唯一の手がかりでもある — `container_pool.size`
は「適用された」ように見えて、エンジンは読まない。

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
  会話が返って来なくならないための歯止め。
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
