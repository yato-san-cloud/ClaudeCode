# リサーチ: 網羅的なPower BI学習カリキュラムに必須のトピックチェックリスト

調査日: 2026-07-16
調査対象:
- Microsoft PL-300 (Power BI Data Analyst) 試験 公式スキルアウトライン
- Microsoft Learn Power BI ラーニングパス群
- SQLBI (Mastering DAX / DAX Patterns / Optimizing DAX)
- DataCamp「Data Analyst in Power BI」キャリアトラック
- Coursera「Microsoft Power BI Data Analyst Professional Certificate」
- Udemy人気講座(Power BI Desktop for BI、Power BI Masterclass 等)

## 0. 試験配点サマリ(PL-300, 2025年4月更新版アウトライン基準)

| ドメイン | 配点 |
|---|---|
| データの準備(Prepare the data) | 25–30% |
| データのモデル化(Model the data) | 25–30% |
| データの視覚化と分析(Visualize and analyze the data) | 25–30% |
| Power BIの管理と保護(Manage and secure Power BI) | 15–20% |

出典: [Microsoft Learn PL-300スタディガイド](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-300)

---

## ① データ取得・変換(Power Query/M)

| トピック | レベル | 優先度 |
|---|---|---|
| 各種データソース接続(CSV/Excel/Web/フォルダー/DB/Fabric) | 基礎 | 高 |
| クエリエディタのUI操作(ステップ、適用したステップ一覧) | 基礎 | 高 |
| ヘッダー昇格・データ型変更の定番3点セット | 基礎 | 高 |
| let/in構文とステップ=変数の理解 | 基礎 | 高 |
| データプロファイリング(列の品質/分布/統計) | 基礎 | 高 |
| Null・欠損値・不整合値の検出と解消 | 基礎 | 高 |
| テキストのクレンジング(Trim/Clean/Upper/PadStart等) | 基礎 | 高 |
| 型変換の落とし穴(全角数字、単位付き文字列、ロケール) | 基礎 | 高 |
| 行/列のフィルタリング、不要列の削除 | 基礎 | 高 |
| each構文とカスタム関数の基礎 | 応用 | 中 |
| マージ(結合)とJoinKindの使い分け(Left Outer/Anti等) | 応用 | 高 |
| 追加(Append)によるユニオン | 基礎 | 高 |
| Table.Groupによるグループ集計 | 応用 | 中 |
| フォルダー一括取込・サンプルファイル変換関数 | 応用 | 中 |
| パラメーターの作成と活用(環境切替、動的パス) | 応用 | 中 |
| カスタム関数の定義と呼び出し | 応用 | 低 |
| try...otherwiseによるエラー処理 | 応用 | 中 |
| データ品質ゲート(異常時に更新を意図的に失敗させる) | 実践 | 中 |
| クエリフォールディング(Query Folding)の原理と確認方法 | 応用 | 中 |
| 大量データ時のパフォーマンス最適化(列削減、フィルター順序、Table.Buffer) | 実践 | 中 |
| データ分類・機密ラベルの基本(PL-300範囲) | 応用 | 低 |
| キー(結合キー)の適切な選定 | 応用 | 高 |

---

## ② モデリング

| トピック | レベル | 優先度 |
|---|---|---|
| スタースキーマ設計の基本(ファクト/ディメンション) | 基礎 | 高 |
| 1対多リレーションシップとカーディナリティ | 基礎 | 高 |
| クロスフィルター方向(単一方向/双方向)の使い分け | 応用 | 高 |
| 日付テーブルの作成と「日付テーブルとしてマーク」 | 基礎 | 高 |
| スノーフレークスキーマとの比較、正規化/非正規化判断 | 応用 | 中 |
| 多対多リレーションシップとブリッジテーブル | 応用 | 中 |
| 複数ファクトテーブルの統合設計 | 応用 | 中 |
| 階層(Hierarchy)の作成 | 基礎 | 中 |
| 計算列 vs メジャーの使い分け | 基礎 | 高 |
| 計算テーブルの作成 | 応用 | 中 |
| データ型・書式設定・非表示フィールドの整理 | 基礎 | 中 |
| モデルパフォーマンス最適化(不要列/行の削減、集計テーブル) | 実践 | 中 |
| RLS用ロールをモデル内に設計(ロジック含む) | 応用 | 高 |
| インクリメンタルリフレッシュの設計 | 実践 | 低 |
| Power BIサービスでの認定/プロモート済みデータセット運用 | 実践 | 低 |
| 複合モデル(DirectQuery + Import) | 実践 | 低 |

---

## ③ DAX

| トピック | レベル | 優先度 |
|---|---|---|
| 基本集計関数(SUM/AVERAGE/COUNT/DISTINCTCOUNT等) | 基礎 | 高 |
| 計算列と計算メジャーの構文の違い | 基礎 | 高 |
| 行コンテキストとフィルターコンテキストの違い | 基礎 | 高 |
| CALCULATE関数とフィルター変更の仕組み | 応用 | 高 |
| コンテキスト転移(Context Transition) | 応用 | 高 |
| イテレーター関数(SUMX/AVERAGEX/FILTERX等) | 応用 | 高 |
| 変数(VAR/RETURN)によるコードの可読性・パフォーマンス改善 | 応用 | 高 |
| RELATED / RELATEDTABLE によるテーブル間参照 | 基礎 | 高 |
| 時間インテリジェンス関数(YTD/前年同期比/移動平均等) | 応用 | 高 |
| ランキング(RANKX等)パターン | 応用 | 中 |
| 累計・移動平均・累積構成比パターン | 応用 | 中 |
| ABC分析・パレート分析パターン | 実践 | 低 |
| 新規/離脱/継続顧客分析パターン | 実践 | 低 |
| 予実比較(Budget vs Actual)パターン | 実践 | 中 |
| 親子階層(Parent-Child Hierarchy)パターン | 実践 | 低 |
| 静的/動的セグメンテーション | 実践 | 中 |
| 多対多(Many-to-Many)集計パターン | 実践 | 低 |
| DIVIDE関数によるゼロ除算対策 | 基礎 | 高 |
| DAXのパフォーマンス最適化(ストレージエンジン/フォーミュラエンジン、変数活用) | 実践 | 低 |
| ウィンドウ関数・ビジュアル計算(新機能、2024年以降) | 応用 | 低 |
| ユーザー定義関数(DAX UDF、2025年以降の新機能) | 実践 | 低 |
| KPI・目標値との比較指標設計 | 応用 | 中 |

---

## ④ ビジュアル・レポート

| トピック | レベル | 優先度 |
|---|---|---|
| 基本ビジュアルの選択(棒/折れ線/円/カード/テーブル/マトリックス) | 基礎 | 高 |
| ビジュアルの書式設定(軸、凡例、色、データラベル) | 基礎 | 高 |
| スライサーとクロスフィルタリング/クロスハイライト | 基礎 | 高 |
| レポートページの設計原則(レイアウト、余白、視線誘導) | 応用 | 高 |
| ドリルダウン/ドリルスルー/ツールヒントページ | 応用 | 中 |
| ブックマークとページナビゲーション | 応用 | 中 |
| 条件付き書式(データバー、色スケール、アイコン) | 応用 | 中 |
| KPIビジュアル・カード・ゲージ | 基礎 | 中 |
| AI機能ビジュアル(主要影響要因、分解ツリー、Q&A、スマートナラティブ) | 応用 | 中 |
| 傾向線・予測(Forecasting)・クラスタリングなどの分析機能 | 応用 | 中 |
| カスタムビジュアルの導入(AppSource/Marketplace) | 応用 | 低 |
| モバイルレイアウトの最適化 | 応用 | 低 |
| アクセシビリティ対応(代替テキスト、コントラスト、タブ順序) | 応用 | 中 |
| データストーリーテリングの原則(問いから逆算する設計) | 実践 | 高 |
| ダッシュボード vs レポートの使い分け | 基礎 | 中 |
| Power BIテーマ・企業ブランディングの統一 | 応用 | 低 |

---

## ⑤ 運用・共有・管理

| トピック | レベル | 優先度 |
|---|---|---|
| ワークスペースの作成と役割(Admin/Member/Contributor/Viewer) | 基礎 | 高 |
| 発行とPower BIサービスへの共有 | 基礎 | 高 |
| アプリ(App)の作成と配布 | 応用 | 中 |
| 行レベルセキュリティ(RLS)の実装とテスト(ビューとして表示) | 応用 | 高 |
| オブジェクトレベルセキュリティ(OLS) | 応用 | 中 |
| スケジュール更新とオンプレミスデータゲートウェイ | 応用 | 中 |
| デプロイパイプライン(開発/テスト/本番) | 実践 | 中 |
| 機密ラベル(Sensitivity Label)とデータ損失防止(DLP) | 応用 | 低 |
| 使用状況メトリクス(Usage Metrics)の確認 | 応用 | 低 |
| 監査ログとガバナンス | 実践 | 低 |
| データセット/セマンティックモデルの認定・プロモート運用 | 応用 | 低 |
| Power BI管理ポータルの基本(テナント設定) | 実践 | 低 |
| バージョン管理・Gitとの連携(Power BI Projects/PBIP) | 実践 | 低 |
| PL-300受験対策(模擬問題・ケーススタディ形式) | 実践 | 中 |

---

## 参考ソース

- [Study guide for Exam PL-300](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/pl-300)
- [Microsoft Certified: Power BI Data Analyst Associate](https://learn.microsoft.com/en-us/credentials/certifications/data-analyst-associate/)
- [Training for Power BI | Microsoft Learn](https://learn.microsoft.com/en-us/training/powerplatform/power-bi)
- [Prepare data for analysis with Power BI](https://learn.microsoft.com/en-us/training/paths/prepare-data-power-bi/)
- [Model Data with Power BI](https://learn.microsoft.com/en-us/training/paths/model-data-power-bi/)
- [Design effective reports in Power BI](https://learn.microsoft.com/en-us/training/paths/power-bi-effective/)
- [Dashboard in a Day](https://learn.microsoft.com/en-us/training/paths/dashboard-in-a-day/)
- [SQLBI - Mastering DAX Video Course](https://www.sqlbi.com/p/mastering-dax-video-course/)
- [SQLBI - DAX Patterns collection](https://www.sqlbi.com/p/dax-patterns/)
- [DataCamp - Data Analyst in Power BI track](https://www.datacamp.com/tracks/data-analyst-in-power-bi)
- [Coursera - Microsoft Power BI Data Analyst Professional Certificate](https://www.coursera.org/professional-certificates/microsoft-power-bi-data-analyst)
- [Coursera - Data Modeling in Power BI](https://www.coursera.org/learn/data-modeling-in-power-bi)
- [Coursera - Data Analysis and Visualization with Power BI](https://www.coursera.org/learn/data-analysis-and-visualization-with-power-bi)
- [Row-level security (RLS) with Power BI - Microsoft Fabric](https://learn.microsoft.com/en-us/fabric/security/service-admin-row-level-security)
- Udemy人気講座(Power BI Desktop for Business Intelligence、Power BI Masterclass: From Beginner to DAX Expert 等)のカリキュラム構成調査結果

---

## カバー必須トピック上位15個(初心者向け学習アプリ最優先)

1. スタースキーマ設計の基本(ファクト/ディメンション)
2. 1対多リレーションシップとカーディナリティ
3. データプロファイリングとNull・不整合値の解消(Power Query)
4. Null/型変換の落とし穴とテキストクレンジング
5. マージ(結合)とJoinKindの使い分け
6. 計算列 vs メジャーの使い分け
7. 行コンテキストとフィルターコンテキストの違い
8. CALCULATE関数とフィルター変更の仕組み
9. イテレーター関数(SUMX等)
10. 時間インテリジエンス関数(YTD/前年同期比等)
11. DIVIDE関数によるゼロ除算対策
12. 基本ビジュアルの選択と書式設定
13. スライサーとクロスフィルタリング
14. データストーリーテリングの原則(問いから逆算する設計)
15. 行レベルセキュリティ(RLS)の実装とテスト
