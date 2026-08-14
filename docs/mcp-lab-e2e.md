# MCP実験E2E — 「台数を1台減らすと待機時間はどうなる？」

`tests/test_mcp_lab.py::test_e2e_over_stdio_answers_how_one_fewer_picker_changes_waiting`
を `WHSIM_MCP_E2E_DOC=1` で実行した記録。MCPクライアント（`mcp` SDK）が
`python -m whsim.mcp_server` を stdio で起動し、initialize → tools/list →
`run_scenario` → `apply_diff_and_run` → `compare_runs` → `query_events` を
自動実行している。**以下の数値は全て run成果物からの転記**
（`/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/<run_id>/summary.json`・`events.jsonl`）。

最後の `query_events` は、比較表に出た待ちのKPIが
**イベントログのどの行から来たか**を件数と合計で示すためのもの
（`congestion_waits` = `aisle_wait` + `aisle_pass_forced` の行数、
`congestion_wait_total_s` = その `wait` の合計）。

再現:

```bash
WHSIM_MCP_E2E_DOC=1 .venv/bin/python -m pytest tests/test_mcp_lab.py -k e2e -q
```

## 1. 接続（initialize / tools_list）

リクエスト:

```json
{
  "tool": "initialize",
  "arguments": {}
}
```

レスポンス:

```json
{
  "server": "whsim-lab",
  "tools": [
    "apply_diff_and_run",
    "compare_runs",
    "generate_report",
    "get_run_artifacts",
    "init_state_from_snapshot",
    "list_runs",
    "query_events",
    "run_scenario",
    "sweep",
    "verify_report"
  ]
}
```

## 2. 基準シナリオを実行（通路干渉ON・ピッカー12名）

リクエスト:

```json
{
  "tool": "run_scenario",
  "arguments": {
    "scenario_json": {
      "name": "基準（通路干渉あり・ピッカー12名）",
      "template": "ecommerce_small",
      "seed": 7,
      "reps": 1,
      "duration_s": 3600.0,
      "edits": {
        "simulation.aisle_interference": true,
        "resources.workers.0.count": 12,
        "orders.profile.peak_factor": 3.0
      }
    }
  }
}
```

レスポンス:

```json
{
  "run_id": "r20260814-080130-2b28029f",
  "seed": 7,
  "scenario_hash": "2b28029fe8345077837cf10fcb39d320560c33de59f4421cf45a0d699b671871",
  "artifacts_path": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080130-2b28029f",
  "summary": {
    "run_id": "r20260814-080130-2b28029f",
    "seed": 7,
    "scenario_hash": "2b28029fe8345077837cf10fcb39d320560c33de59f4421cf45a0d699b671871",
    "name": "基準（通路干渉あり・ピッカー12名）",
    "started": "2026-08-14T08:01:28",
    "reps": 1,
    "duration_s": 3600.0,
    "artifacts_path": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080130-2b28029f",
    "kpis": {
      "orders_arrived": 320.0,
      "orders_completed": 236.0,
      "completion_rate": 0.7375,
      "throughput_per_hr": 236.0,
      "cycle_mean_s": 512.0642170544843,
      "pick_wait_mean_s": 354.79233153163693,
      "picker_utilization": 0.9569657149094412,
      "congestion_waits": 164.0,
      "congestion_wait_total_s": 13.022649149648377,
      "verdict": "要注意 — ピッキングがボトルネック（稼働率 96%）。オーダーの 74% しか出荷完了しません",
      "…": "（全KPIは summary.json）"
    }
  }
}
```

## 3. 台数を1台減らして実行（差分実験）

リクエスト:

```json
{
  "tool": "apply_diff_and_run",
  "arguments": {
    "base_scenario": {
      "name": "基準（通路干渉あり・ピッカー12名）",
      "template": "ecommerce_small",
      "seed": 7,
      "reps": 1,
      "duration_s": 3600.0,
      "edits": {
        "simulation.aisle_interference": true,
        "resources.workers.0.count": 12,
        "orders.profile.peak_factor": 3.0
      }
    },
    "diff_json": {
      "resources.workers.0.count": 11
    }
  }
}
```

レスポンス:

```json
{
  "run_id": "r20260814-080131-ffbd0ede",
  "seed": 7,
  "scenario_hash": "ffbd0ede0f88be2b04f247bcac770840f206b1dea7eff3379113fafa5a645753",
  "artifacts_path": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080131-ffbd0ede",
  "scenario": {
    "name": "基準（通路干渉あり・ピッカー12名） + diff",
    "template": "ecommerce_small",
    "seed": 7,
    "reps": 1,
    "duration_s": 3600.0,
    "edits": {
      "simulation.aisle_interference": true,
      "resources.workers.0.count": 11,
      "orders.profile.peak_factor": 3.0
    }
  },
  "diff": {
    "resources.workers.0.count": 11
  },
  "applied_edits": [
    "resources.workers.0.count"
  ],
  "unapplied_edits": [],
  "summary": {
    "run_id": "r20260814-080131-ffbd0ede",
    "seed": 7,
    "scenario_hash": "ffbd0ede0f88be2b04f247bcac770840f206b1dea7eff3379113fafa5a645753",
    "name": "基準（通路干渉あり・ピッカー12名） + diff",
    "started": "2026-08-14T08:01:30",
    "reps": 1,
    "duration_s": 3600.0,
    "artifacts_path": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080131-ffbd0ede",
    "kpis": {
      "orders_arrived": 320.0,
      "orders_completed": 219.0,
      "completion_rate": 0.684375,
      "throughput_per_hr": 219.0,
      "cycle_mean_s": 590.9103895938093,
      "pick_wait_mean_s": 444.94362510816404,
      "picker_utilization": 0.9544881260796174,
      "congestion_waits": 333.0,
      "congestion_wait_total_s": 19.956091601179086,
      "verdict": "要注意 — ピッキングがボトルネック（稼働率 95%）。オーダーの 68% しか出荷完了しません",
      "…": "（全KPIは summary.json）"
    }
  }
}
```

## 4. 2runのKPIを比較

リクエスト:

```json
{
  "tool": "compare_runs",
  "arguments": {
    "run_ids": [
      "r20260814-080130-2b28029f",
      "r20260814-080131-ffbd0ede"
    ],
    "metrics": [
      "pick_wait_mean_s",
      "cycle_mean_s",
      "congestion_waits",
      "congestion_wait_total_s",
      "completion_rate",
      "throughput_per_hr"
    ]
  }
}
```

レスポンス:

```json
{
  "run_ids": [
    "r20260814-080130-2b28029f",
    "r20260814-080131-ffbd0ede"
  ],
  "baseline": "r20260814-080130-2b28029f",
  "sources": {
    "r20260814-080130-2b28029f": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080130-2b28029f/summary.json",
    "r20260814-080131-ffbd0ede": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080131-ffbd0ede/summary.json"
  },
  "runs": [
    {
      "run_id": "r20260814-080130-2b28029f",
      "name": "基準（通路干渉あり・ピッカー12名）",
      "seed": 7,
      "reps": 1,
      "duration_s": 3600.0,
      "scenario_hash": "2b28029fe8345077837cf10fcb39d320560c33de59f4421cf45a0d699b671871",
      "started": "2026-08-14T08:01:28",
      "verdict": "要注意 — ピッキングがボトルネック（稼働率 96%）。オーダーの 74% しか出荷完了しません"
    },
    {
      "run_id": "r20260814-080131-ffbd0ede",
      "name": "基準（通路干渉あり・ピッカー12名） + diff",
      "seed": 7,
      "reps": 1,
      "duration_s": 3600.0,
      "scenario_hash": "ffbd0ede0f88be2b04f247bcac770840f206b1dea7eff3379113fafa5a645753",
      "started": "2026-08-14T08:01:30",
      "verdict": "要注意 — ピッキングがボトルネック（稼働率 95%）。オーダーの 68% しか出荷完了しません"
    }
  ],
  "metrics": [
    {
      "metric": "pick_wait_mean_s",
      "label": "ピッキング待ち平均（秒）",
      "values": {
        "r20260814-080130-2b28029f": 354.79233153163693,
        "r20260814-080131-ffbd0ede": 444.94362510816404
      },
      "baseline": 354.79233153163693,
      "delta": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffbd0ede": 90.15129357652711
      },
      "pct_change": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffbd0ede": 25.40959473034391
      }
    },
    {
      "metric": "cycle_mean_s",
      "label": "リードタイム平均（秒）",
      "values": {
        "r20260814-080130-2b28029f": 512.0642170544843,
        "r20260814-080131-ffbd0ede": 590.9103895938093
      },
      "baseline": 512.0642170544843,
      "delta": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffbd0ede": 78.84617253932504
      },
      "pct_change": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffbd0ede": 15.397711832485983
      }
    },
    {
      "metric": "congestion_waits",
      "label": "通路待ち回数",
      "values": {
        "r20260814-080130-2b28029f": 164.0,
        "r20260814-080131-ffbd0ede": 333.0
      },
      "baseline": 164.0,
      "delta": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffbd0ede": 169.0
      },
      "pct_change": {
        "r20260814-080130-2b28029f": 0.0,
        "r20260814-080131-ffb
…（省略。全量は成果物ファイル）
```

## 5. 根拠のイベントログを問い合わせ

リクエスト:

```json
{
  "tool": "query_events",
  "arguments": {
    "run_id": "r20260814-080130-2b28029f",
    "filter": {
      "type": [
        "aisle_wait",
        "aisle_pass_forced"
      ]
    },
    "limit": 2
  }
}
```

レスポンス:

```json
{
  "run_id": "r20260814-080130-2b28029f",
  "rep": 0,
  "source": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080130-2b28029f/events.jsonl",
  "total_events": 1678,
  "matched": 164,
  "t_min": 30.27648057768081,
  "t_max": 3588.234410095685,
  "by_type": {
    "aisle_wait": 164
  },
  "numeric_fields": {
    "wait": {
      "n": 164,
      "sum": 13.022649149648377,
      "mean": 0.07940639725395351
    }
  },
  "limit": 2,
  "sample": [
    {
      "t": 30.27648057768081,
      "event": "aisle_wait",
      "resource": "aisle",
      "worker": "picker-4",
      "cell": [
        12,
        15
      ],
      "dirn": "+x",
      "wait": 0.0072546089316816165
    },
    {
      "t": 31.144536133236368,
      "event": "aisle_wait",
      "resource": "aisle",
      "worker": "picker-4",
      "cell": [
        13,
        15
      ],
      "dirn": "+x",
      "wait": 0.013354700854701917
    }
  ],
  "truncated": true
}
```

リクエスト:

```json
{
  "tool": "query_events",
  "arguments": {
    "run_id": "r20260814-080131-ffbd0ede",
    "filter": {
      "type": [
        "aisle_wait",
        "aisle_pass_forced"
      ]
    },
    "limit": 2
  }
}
```

レスポンス:

```json
{
  "run_id": "r20260814-080131-ffbd0ede",
  "rep": 0,
  "source": "/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080131-ffbd0ede/events.jsonl",
  "total_events": 1762,
  "matched": 333,
  "t_min": 30.27648057768081,
  "t_max": 3528.8762235123545,
  "by_type": {
    "aisle_wait": 332,
    "aisle_pass_forced": 1
  },
  "numeric_fields": {
    "wait": {
      "n": 333,
      "sum": 19.956091601179086,
      "mean": 0.0599282030065438
    }
  },
  "limit": 2,
  "sample": [
    {
      "t": 30.27648057768081,
      "event": "aisle_wait",
      "resource": "aisle",
      "worker": "picker-4",
      "cell": [
        12,
        15
      ],
      "dirn": "+x",
      "wait": 0.0072546089316816165
    },
    {
      "t": 31.144536133236368,
      "event": "aisle_wait",
      "resource": "aisle",
      "worker": "picker-4",
      "cell": [
        13,
        15
      ],
      "dirn": "+x",
      "wait": 0.013354700854701917
    }
  ],
  "truncated": true
}
```

## 答え（run成果物からの転記）

| 指標 | 基準（12名） | 1台減（11名） | 差 |
|---|---|---|---|
| ピッキング待ち平均（秒） | 354.792332 | 444.943625 | 90.151294 |
| リードタイム平均（秒） | 512.064217 | 590.91039 | 78.846173 |
| 通路待ち回数 | 164 | 333 | 169 |
| 通路待ち合計（秒） | 13.022649 | 19.956092 | 6.933442 |
| 完了率 | 0.7375 | 0.684375 | -0.053125 |
| 処理能力（件/h） | 236 | 219 | -17 |

**待機時間は増える。** ピッキング待ちの平均は 354.792332 秒 → 444.943625 秒（90.151294 秒）、通路待ちは 164 回 → 333 回。処理能力は 236 → 219 件/h に落ちる（同一seed・同一シナリオで台数だけを変えた1本ずつの結果。ばらつきを見るなら `sweep` で seed を複数振る）。

出所: `/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080130-2b28029f/summary.json` と `/tmp/pytest-of-root/pytest-80/test_e2e_over_stdio_answers_ho0/runs/r20260814-080131-ffbd0ede/summary.json`（どちらも同ディレクトリの `events.jsonl` を `whsim.kpis` が集計したもの）。

