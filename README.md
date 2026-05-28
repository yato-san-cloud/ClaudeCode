# 3PL 倉庫 物量分析ツール

3PL(物流)倉庫の WMS 出力データを取り込み、ブラウザ上で **物量推移 / ABC / ピーク / 在庫回転** を対話的に分析する Streamlit アプリ。

## 機能

- 📈 **物量推移**: 入出荷の日次/週次/月次トレンド
- 🏷️ **ABC 分析**: SKU 別・取引先別 Pareto / 累積構成比
- ⏰ **ピーク分析**: 曜日別棒グラフ + 曜日 × 時間帯ヒートマップ
- 🔄 **在庫回転**: SKU 別回転率 / 滞留日数 / デッドストック判定
- CSV (UTF-8 / CP932) と Excel (`.xlsx` / `.xls`) の両対応
- アップロード後に **論理項目 ↔ 実カラムを UI で対話的にマッピング**(ヒューリスティック自動推定付き)

## セットアップ

```bash
pip install -r requirements.txt
```

## 起動

```bash
streamlit run app.py
```

起動後、サイドバーの **「▶ サンプルデータで試す」** を押せば、ファイル不要で全機能をすぐ体験できる。実データを使う場合は出荷明細・入荷明細・在庫スナップショットをアップロードし、表示される項目マッピングで列を割り当てる(自動推定あり)。

## サンプルデータの生成

```bash
python scripts/generate_sample_data.py --out sample_data --days 90
```

`sample_data/` に `shipments.csv` / `inbound.csv` / `inventory.csv` と統合 Excel `warehouse_data.xlsx` が生成される。

## データ要件(論理項目)

| 種別 | 必須 | 任意 |
| --- | --- | --- |
| 出荷明細 | 出荷日 / SKU / 出荷数量 | 出荷日時(時刻ピーク分析に使用) / 取引先 |
| 入荷明細 | 入荷日 / SKU / 入荷数量 | 仕入先 |
| 在庫スナップショット | SKU / 在庫数量 | 基準日 / ロケーション |

入力ファイルのカラム名は何でも構わない。アップロード後、サイドバーの選択メニューで論理項目に紐付ける。

## テスト

```bash
pytest -q
```

## 構成

```
app.py                       Streamlit エントリポイント(タブ UI)
src/data_io.py               ファイル読込 + 列マッピング
src/analyses.py              4 分析の純粋関数(DataFrame in/out)
src/charts.py                plotly チャート
scripts/generate_sample_data.py  サンプル生成
tests/test_analyses.py       ユニットテスト
```

## ライセンス

社内利用想定の参考実装。
