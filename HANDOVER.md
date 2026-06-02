# 3PL 倉庫 物量分析ツール — セッションハンドオーバー

## 🔗 リソース

| 項目 | URL / 値 |
| --- | --- |
| リポジトリ | `yato-san-cloud/ClaudeCode` |
| ブランチ | `claude/3pl-inventory-analysis-tool-S2xc6` |
| ブランチ URL | https://github.com/yato-san-cloud/ClaudeCode/tree/claude/3pl-inventory-analysis-tool-S2xc6 |
| 最新コミット | `0196ecb` (Add Keyence-style auto-insights …) |
| コミットログ URL | https://github.com/yato-san-cloud/ClaudeCode/commits/claude/3pl-inventory-analysis-tool-S2xc6 |

## 📋 これまでの開発履歴(6 コミット)

```
0196ecb  Add Keyence-style auto-insights, anomaly detection, forecast, and portfolio tabs
55551a5  Add summary dashboard tab with 3PL operational KPIs
a3bedae  Add DuckDB engine toggle for large datasets + mobile-responsive layout
9e75c16  Improve dashboard UX for intuitive operation
f0fab4a  Add 3PL warehouse volume analysis Streamlit dashboard
e7c2d3a  Add initial CLAUDE.md
```

## 🏗️ 現在の構成

```
ClaudeCode/
├── app.py                        # Streamlit エントリ(8タブ + エンジントグル + スマホ対応CSS)
├── requirements.txt              # streamlit / pandas / plotly / openpyxl / duckdb / pyarrow / pytest
├── src/
│   ├── data_io.py                # pandas: CSV/Excel ローダ + 列マッピング (FieldSpec)
│   ├── duck_io.py                # DuckDB: Catalog (register_path/register_dataframe/apply_mapping)
│   ├── analyses.py               # pandas 純粋関数 11 種(volume_trends, abc, peak, turnover,
│   │                             #   summary_kpis, daily_anomalies, period_compare,
│   │                             #   sku_lifecycle, partner_weekday_matrix, simple_forecast,
│   │                             #   sku_portfolio)
│   ├── sql_analyses.py           # SQL 版(同じ 8 種、forecast/lifecycle/portfolio は pandas 再利用)
│   ├── insights.py               # 自動インサイトエンジン(Insight + 9 detector + generate_insights)
│   └── charts.py                 # plotly チャート(11 種)
├── scripts/
│   └── generate_sample_data.py   # サンプル WMS データ生成(出荷/入荷/在庫 + 受注番号)
├── tests/
│   ├── test_analyses.py          # 17 件(基本 + 拡張分析 + insights)
│   └── test_sql_analyses.py      # 8 件(SQL/pandas パリティ + KPI)
├── README.md
└── CLAUDE.md                     # ビルド/実行/アーキ/規約
```

## ✅ 現在の機能(8タブ)

1. **📊 サマリー** — 自動インサイト(9 detector) + KPI 22 種 + ミニチャート + 上位リスト
2. **📈 物量推移** — 入出荷推移 + z-score 異常検知オーバーレイ
3. **🏷️ ABC 分析** — SKU/取引先 Pareto + ランク件数
4. **⏰ ピーク分析** — 曜日棒 + 時間棒 + 曜日×時間ヒート + 取引先×曜日マトリクス
5. **🔄 在庫回転** — SKU 別回転率 / 供給日数 / デッドストック判定
6. **🔮 予測** — 曜日季節性 + トレンドの簡易予測(95%バンド)
7. **🧬 SKU ポートフォリオ** — 回転率×在庫の 4 象限散布 + ライフサイクル分布
8. **🔁 期間対比** — 2 期間の寄与度分析(ウォーターフォール)

## ⚙️ エンジン

- **💨 pandas (標準)**: 〜数百MB
- **🦆 DuckDB (巨大データ)**: GB級 CSV/Parquet、glob、サーバパス指定対応

## 🧪 テスト

```bash
pytest -q   # 27/27 PASS (pandas 17 + SQL parity 8 + KPI 2)
```

## 🚀 起動

```bash
pip install -r requirements.txt
streamlit run app.py
# → サイドバー「▶ サンプルデータで試す」で即動作
```

## 📝 規約 (CLAUDE.md より)

- 論理項目は `src/data_io.py` の `*_FIELDS` で定義
- 分析関数は副作用なしの純粋関数を維持
- pandas 版を「正」とし、SQL 版は `tests/test_sql_analyses.py` でパリティ担保
- DuckDB 経路では生データを pandas に materialize しない(集計後のみ)
- アクティブブランチ: `claude/3pl-inventory-analysis-tool-S2xc6`
- push は `git push -u origin <branch>` を使い、ネットワークエラー時のみ最大4回指数バックオフ
- GitHub 操作は `mcp__github__*` のみ(`gh` CLI なし)

## 🎯 次セッションでの引き継ぎ方法

新しいセッションで以下を最初に貼ってください:

```
このリポジトリ yato-san-cloud/ClaudeCode のブランチ
claude/3pl-inventory-analysis-tool-S2xc6 で作業を続けます。
最新コミットは 0196ecb です。
構成と現状は /home/user/ClaudeCode/HANDOVER.md を参照してください。
```

または GitHub URL を直接共有:
**https://github.com/yato-san-cloud/ClaudeCode/tree/claude/3pl-inventory-analysis-tool-S2xc6**

## 🔮 未対応 / 検討中

- 実 WMS データでの実機検証(現状はサンプルデータのみで動作確認済)
- 予測モデルの高度化(Prophet / 外因変数の取込)
- アラートメール / Slack 通知連携
- ダッシュボードのスナップショット PDF エクスポート
- ユーザ権限・複数倉庫対応
