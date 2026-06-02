# Claude Design 引き渡しパッケージ — 3PL 倉庫 物量分析ツール

このフォルダは、UI リニューアルを **Claude Design に依頼するための一式**です。
明日 PC で機能統合を進める前の「待ち時間」で、見た目を一段引き上げるのが目的。

## 中身

```
design_handoff/
├── README.md            ← これ（最初に渡す）
├── DESIGN_BRIEF.md      ← 本体。文脈・制約・画面別課題・依頼事項
└── screenshots/         ← 実機キャプチャ(サンプルデータ投入後の本物の画面)
    ├── 00_landing_sidebar.png   サイドバー＋着地
    ├── 01_summary.png           📊 サマリー
    ├── 02_trend.png             📈 物量推移
    ├── 03_abc.png               🏷️ ABC 分析
    ├── 04_peak.png              ⏰ ピーク分析
    ├── 05_inventory.png         🔄 在庫回転
    ├── 06_forecast.png          🔮 予測
    ├── 07_portfolio.png         🧬 SKUポートフォリオ
    ├── 08_compare.png           🔁 期間対比
    ├── m1_summary_mobile.png    スマホ：サマリー
    └── m2_peak_mobile.png       スマホ：ピーク分析
```

## Claude Design への渡し方（コピペ用）

> 添付の `DESIGN_BRIEF.md` と `screenshots/` を読んで、この Streamlit 製
> ダッシュボードの UI リニューアル案を作ってください。技術制約（§2）を守った
> 上で、§7 の成果物（デザインシステム＋主要画面のリデザイン案＋スマホ対応）を
> お願いします。まずサマリー画面（`01_summary.png`）から。

## 撮影条件（再現用）

- データ: サイドバー「▶ サンプルデータで試す」投入後
- デスクトップ: 1440×2200 / DPR2、モバイル: 390×844 / DPR3
- 撮影スクリプト: `scripts/_shoot_ui.py`, `scripts/_shoot_mobile.py`
  （`streamlit run app.py` を起動 → playwright で全タブを full-page 撮影）
