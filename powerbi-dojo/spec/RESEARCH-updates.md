# Power BI 主要アップデート調査（2024年〜2026年7月）

本ドキュメントは、Power BI学習アプリの教材に反映すべき2024年〜2026年7月時点のアップデートをまとめたものです。各項目は「①それは何か ②いつから使えるか ③学習者が知るべき要点 ④コード例」の構成で記載しています。

---

## 1. DAXウィンドウ関数（Window Functions）

### 1.1 概要
①DAXにExcel/SQL的な「ウィンドウ関数」の概念が導入され、パーティション内での行の相対位置に基づく計算（前後の行参照、ランキング、連番）が、複雑なCALCULATE/FILTERの組み合わせなしで書けるようになった。

②2023年後半〜2024年にかけて順次GA。`RANK`/`ROWNUMBER`/`INDEX`/`OFFSET`/`WINDOW`本体と、それを支える`ORDERBY`/`PARTITIONBY`/`MATCHBY`のサブ関数がセットで提供される。`MATCHBY`は2024年5月のPower BI Desktop更新で追加。

③学習者が知るべき要点:
- **INDEX**: パーティション内のn番目の行を返す（絶対位置）。
- **OFFSET**: カレント行から相対的にn行前後の行を返す（前年同月比較などに便利）。
- **WINDOW**: 指定範囲（開始行〜終了行）の行集合を返す（移動平均などの土台）。
- **RANK**: 順位を返す。同順位（タイ）がある場合は同じ順位を複数行に付与する。
- **ROWNUMBER**: 一意な連番を返す。タイがあっても自動的に追加列で一意性を補って区別する点が`RANK`と異なる。
- **ORDERBY**: ウィンドウ関数内でのみ使用可能な並び替え指定のサブ関数。
- **PARTITIONBY**: ウィンドウ関数の計算をグループ（パーティション）単位に分割するサブ関数。
- **MATCHBY**: 計算列での自己参照エラー回避、キー列の明示、結合パフォーマンス改善のために追加された関数。全列ではなく指定列のみで行を一意に識別させることで、メモリ消費と実行時間を削減する。
- これらはこれまで「変数+FILTER+CALCULATE」で書いていたロジックを大幅に簡素化する。教材では「従来のDAXパターン → ウィンドウ関数での書き換え」の比較例を用意すると理解が深まる。

④コード例:
```dax
-- 前年同月売上との比較（OFFSET）
前月比較 =
VAR CurrentSales = [売上]
VAR PreviousSales =
    CALCULATE(
        [売上],
        OFFSET(
            -1,
            ORDERBY('日付'[年月])
        )
    )
RETURN CurrentSales - PreviousSales

-- カテゴリ内での売上ランキング（RANK + PARTITIONBY）
売上ランク =
RANK(
    DENSE,
    ALLSELECTED('製品'[製品名]),
    ORDERBY([売上], DESC),
    PARTITIONBY('製品'[カテゴリ])
)
```

Sources:
- [Introducing window functions in DAX - SQLBI](https://www.sqlbi.com/articles/introducing-window-functions-in-dax/)
- [Understanding ORDERBY, PARTITIONBY, and MATCHBY functions in DAX - Microsoft Learn](https://learn.microsoft.com/en-us/dax/best-practices/dax-understand-orderby)
- [WINDOW function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/window-function-dax)
- [Introducing MATCHBY for DAX Window Functions – pbidax](https://pbidax.wordpress.com/2023/05/25/introducing-matchby-for-dax-window-functions/)
- [RANK function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/rank-function-dax)
- [ROWNUMBER – DAX Guide](https://dax.guide/rownumber/)

---

## 2. INFO関数群（メタデータ関数）

①モデルのメタデータ（テーブル、列、メジャー、リレーションシップ、依存関係など）をDAXクエリ上でテーブルとして取得できる関数群。モデルの自己文書化やドキュメント生成の自動化に使える。

②2024年に14個の新しいINFO関数が追加された。DAXクエリビュー（後述）とセットで使うのが基本。

③学習者が知るべき要点:
- **INFO.VIEW系（4種）**: `INFO.VIEW.TABLES`、`INFO.VIEW.COLUMNS`、`INFO.VIEW.MEASURES`、`INFO.VIEW.RELATIONSHIPS`。IDではなく名前や値をそのまま返すため使いやすく、**計算テーブル・計算列・メジャー・DAXクエリのいずれでも使用可能**（唯一、通常のモデルオブジェクトにも埋め込める点が他のINFO関数と違う）。
- **その他10種**（DAXクエリでのみ使用可）: `INFO.CALCDEPENDENCY`（依存関係）、`INFO.CATALOGS`、`INFO.CHANGEDPROPERTIES`、`INFO.EXCLUDEDARTIFACTS`、`INFO.FUNCTIONS`、`INFO.LINGUISTICMETADATA`、`INFO.PROPERTIES`、`INFO.STORAGETABLECOLUMNS`、`INFO.STORAGETABLECOLUMNSEGMENTS`、`INFO.STORAGETABLES`（ストレージ内部構造の調査に使う）。
- 用途例: 日付テーブルの特定（`INFO.VIEW.TABLES`の`Data Category`が`Time`の行を抽出）、モデル内の全メジャーのDAX式一覧をエクスポートしてドキュメント化、など。

④コード例:
```dax
-- DAXクエリビューで実行: モデル内の全メジャーの一覧を取得
EVALUATE
INFO.VIEW.MEASURES()

-- 日付テーブルを特定する
EVALUATE
FILTER(
    INFO.VIEW.TABLES(),
    [Data Category] = "Time"
)
```

Sources:
- [INFO functions (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/info-functions-dax)
- [INFO.MEASURES function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/info-measures-function-dax)
- [What happened in the DAX world in 2024 - SQLBI](https://www.sqlbi.com/blog/marco/2024/12/30/what-happened-in-the-dax-world-in-2024/)
- [INFO.VIEW.MEASURES function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/info-view-measures-function-dax)

---

## 3. その他2024年以降に追加されたDAX関数

①ウィンドウ関数・INFO関数以外にも実務でよく使う新関数が追加された。

②2024年〜2025年にかけて順次リリース。

③学習者が知るべき要点:
- **NETWORKDAYS**: 開始日・終了日間の営業日数を計算（Excelの`NETWORKDAYS.INTL`相当）。週末指定・祝日リスト対応。プロジェクト管理や納期計算に便利。
  ```dax
  営業日数 = NETWORKDAYS('注文'[注文日], '注文'[出荷日], 1, '祝日'[日付])
  ```
- **EVALUATEANDLOG**: 第1引数の値をそのまま返しつつ、DAX Evaluation Logプロファイラーイベントとしてログ出力するデバッグ用関数。Power BI Desktopでのみ完全動作し、複雑な式の途中経過を可視化するのに使う。
- **ビジュアル計算専用関数（12種、通常のメジャー/計算列/計算テーブルでは使用不可）**: `COLLAPSE`、`COLLAPSEALL`、`EXPAND`、`EXPANDALL`、`FIRST`、`ISATLEVEL`、`LAST`、`MOVINGAVERAGE`、`NEXT`、`PREVIOUS`、`RANGE`、`RUNNINGSUM`。詳細は次項「ビジュアル計算」を参照。

④コード例:
```dax
-- デバッグ: 中間変数の値をログに残しながら計算
テスト =
EVALUATEANDLOG(
    SUMX('売上', '売上'[数量] * '売上'[単価])
)
```

Sources:
- [NETWORKDAYS function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/networkdays-function-dax)
- [EVALUATEANDLOG function (DAX) - Microsoft Learn](https://learn.microsoft.com/en-us/dax/evaluateandlog-function-dax)
- [New DAX functions for debugging data - Wise Owl](https://www.wiseowl.co.uk/power-bi/blogs/power-bi-desktop/power-bi-updates/dax-debugging-evaluateandlog/)
- [What happened in the DAX world in 2024 - SQLBI](https://www.sqlbi.com/blog/marco/2024/12/30/what-happened-in-the-dax-world-in-2024/)

---

## 4. ビジュアル計算（Visual Calculations）

①メジャーや計算列をモデル側に作らず、**ビジュアル（グラフ・テーブル）の上に直接DAXを書いて集計後の値を加工する**新しい計算方式。Excelのピボットテーブルの「集計フィールド」的な感覚に近い。既存の集計結果に対して「前月比」「累計」「ランキング」等を後付けできる。

②2024年後半にPower BI Desktopでプレビュー導入。**2026年5月更新でGA（一般提供開始）**。Power BI DesktopとPower BI Service both対応。

③学習者が知るべき要点:
- GA時点でサポートされるパターン/関数: `RUNNINGSUM`（累計）、`MOVINGAVERAGE`（移動平均）、`PERCENTOFPARENT`（親に対する比率）、`PERCENTOFPREVIOUSROW`（前行比）、`COLLAPSE`/`EXPAND`（階層の折りたたみ/展開単位での計算）、`INDEX`、`OFFSET`、`ORDERBY`、`PARTITIONBY`（ウィンドウ関数がそのままビジュアル計算でも使える）。
- 専用関数として`FIRST`/`LAST`/`NEXT`/`PREVIOUS`/`ISATLEVEL`/`RANGE`/`COLLAPSEALL`/`EXPANDALL`も利用可能。
- 2025年の拡張で、`RUNNINGSUM`/`MOVINGAVERAGE`/`PREVIOUS`など多くのビジュアル計算専用関数に**任意の`ORDERBY`引数**が追加され、明示的な並び替え指定ができるようになった。
- 制約: ビジュアル計算はそのビジュアルに閉じたローカルな計算であり、他のビジュアルやメジャーから再利用できない（再利用したい場合は結局メジャー化が必要）。モデルの再利用資産にはならない点を教材で明示すること。
- 教材の位置づけ: 「モデルに秘伝のメジャーを量産する前に、ビジュアル単体の一時的な分析ならビジュアル計算で十分」という使い分けの説明が有効。

④コード例（テーブルビジュアル上で入力するイメージ）:
```dax
累計売上 = RUNNINGSUM([売上])

移動平均_3ヶ月 = MOVINGAVERAGE([売上], 3)

前月比 = [売上] - PREVIOUS([売上])
```

Sources:
- [Visual Calculations Overview - Power BI - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-visual-calculations-overview)
- [Power BI Visual Calculations Are Now Generally Available - Magnetism Solutions](https://www.magnetismsolutions.com/news/power-bi-visual-calculations-are-now-generally-available)
- [Deep dive into visual calculations (Generally Available) - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Deep-dive-into-visual-calculations-Adding-calculations-directly/ba-p/5255359)
- [Power BI May 2026 Update: Visual Calculations GA - EPC Group](https://www.epcgroup.net/blog/power-bi-may-2026-visual-calculations-exploration-copilot-enterprise-guide)
- [What happened in the DAX world in 2024 - SQLBI](https://www.sqlbi.com/blog/marco/2024/12/30/what-happened-in-the-dax-world-in-2024/)

---

## 5. 計算グループのPower BI Desktop内編集

①従来はTabular Editorなど外部ツールが必須だった「計算グループ（Calculation Groups）」の作成・編集が、**Power BI Desktop純正のModel Explorer/Model view内で完結**するようになった。時間インテリジェンス（YTD/前年比など）や通貨変換の切り替えロジックを、メジャーを量産せず1つの計算グループで管理できる。

②Model Explorerでの計算グループ作成・編集機能がGA。2024年3月には**選択式（Selection Expressions）**が追加され、Power BI Service（Direct Lakeセマンティックモデル含む）でのModel Explorer編集も後に対応。

③学習者が知るべき要点:
- 操作手順: Model view（モデルビュー）でフィールドペインを右クリック → 「新しい計算グループ」、またはリボンから作成。
- **選択式（Selection Expressions）**: ユーザーが計算グループアイテムを複数選択した場合／何も選択しなかった場合の挙動を制御できる。例: 通貨切り替えスライサーで何も選ばれていない時は「デフォルト通貨（自国通貨）」に自動変換される、といった実装が可能。
- 計算グループはメジャーの重複乱立（「メジャークラッター」）を防ぐ王道パターンであることを教材で強調する。
- 外部ツール（Tabular Editor等）は依然としてより高度な編集（フォーマット文字列の詳細制御等）に有用だが、日常的な作成・保守はDesktop単体で完結できるようになった点が学習者への実務的価値。

④コード例（計算グループアイテムの式イメージ）:
```dax
-- 計算グループ「時間インテリジェンス」内のアイテム例
YTD = TOTALYTD(SELECTEDMEASURE(), '日付'[日付])
前年比 = CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR('日付'[日付]))

-- 選択式（複数選択/未選択時のデフォルト動作）
多重/未選択時の式 = SELECTEDMEASURE() -- 例: デフォルト通貨を強制適用する式に置き換え可能
```

Sources:
- [Create calculation groups in Power BI - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/transform-model/calculation-groups)
- [Deep dive into the Model Explorer with calculation group authoring - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/deep-dive-into-the-model-explorer-with-calculation-group-authoring-and-creating-relationships-in-the-properties-pane/)
- [Model explorer with calculation group authoring now in Power BI service - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/model-explorer-and-calculation-groups-authoring-is-now-available-in-power-bi-service-including-direct-lake-semantic-models/)
- [Power BI March 2024 Feature Summary](https://powerbi.microsoft.com/en-us/blog/power-bi-march-2024-feature-summary/)

---

## 6. DAXクエリビュー（DAX Query View / EVALUATE）

①Power BI Desktopの「4番目のビュー」として追加された、DAXクエリ（`EVALUATE`文）を直接実行・編集できる画面。モデルに対してSQL的な探索的クエリを書いたり、メジャーのデバッグ・編集ができる。

②2024年2月にプレビュー導入、**2024年5月更新でGA**。

③学習者が知るべき要点:
- **Quick Queries**: データペインのテーブル・列・メジューを右クリック →「クイッククエリ」で自動的にDAXクエリを生成（例: テーブルの上位100行取得、列の統計情報、メジューの式をそのまま評価）。
- メジューを右クリック →「評価」で、フィルターなしの生の計算結果を即座に確認できる（バグ調査に必須の機能）。
- **モデルに影響を与えずに**メジュー式を書き換えてテスト → 問題なければ「モデルを更新」で反映、という安全な編集フローが可能。
- コードエディタとしてIntelliSense、フォーマット、コメントアウト、正規表現対応の検索/置換など本格的な開発体験を提供。
- DirectQueryモデルでも利用可能。
- 前述のINFO関数群はこのビューで真価を発揮する（モデルのメタデータ調査）。

④コード例:
```dax
-- 特定メジューをフィルターなしで評価（クイッククエリ相当）
EVALUATE
ROW("結果", [売上総利益率])

-- テーブルの先頭100行を取得
EVALUATE
TOPN(100, '売上')
```

Sources:
- [DAX Query View - Power BI - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/transform-model/dax-query-view)
- [Power BI May 2024 Feature Summary](https://powerbi.microsoft.com/en-gb/blog/power-bi-may-2024-feature-summary/)
- [How To Use DAX Query View in Power BI Desktop - Pragmatic Works](https://pragmaticworks.com/blog/how-to-use-dax-query-view-in-power-bi-desktop)
- [Dive into DAX: Getting Started with DAX Query View - Ethan Guyant](https://ethanguyant.com/2024/12/13/dive-into-dax-getting-started-with-dax-query-view/)

---

## 7. TMDLビュー（Tabular Model Definition Language）

①セマンティックモデル（テーブル、列、メジュー、リレーションシップ等）を、GUIの代わりに**TMDL（YAML風の可読テキスト形式）で直接スクリプト編集**できるPower BI Desktopの新ビュー。Model.bimに代わる、より人間可読・Gitフレンドリーなモデル定義フォーマット。

②2025年1月にプレビュー導入、**2025年9月にGA**。

③学習者が知るべき要点:
- 有効化: オプション → プレビュー機能 →「TMDLビュー」にチェック → Power BI Desktop再起動。
- データペインからオブジェクト（テーブル・メジューなど）をドラッグ＆ドロップしてコードエディタに展開し、一括編集が可能。
- コード体験としてセマンティックハイライト、折りたたみ、エラー診断、オートコンプリート、検索置換、複数行編集をサポート。
- スクリプト実行前に**変更差分（TMDLコード diff）のプレビュー**が表示されるため、意図しない変更を事前確認できる。
- PBIP（Power BI プロジェクト）形式で保存すると、セマンティックモデル部分は`.SemanticModel`フォルダ内にTMDLファイル群として保存される → Gitでの差分管理・レビュー・CI/CDと相性が良い。
- 将来的にCopilotとの統合も計画されている（モデル変換・一括操作などの高度な対話操作）。
- 教材での位置づけ: 「大量の類似メジューを一括生成・一括リネームしたい」「Gitでモデルの変更履歴を追いたい」というシナリオでTMDLビューの価値を説明する。

④コード例（TMDLの記述イメージ）:
```
measure '売上合計' = SUM('売上'[金額])
    formatString: #,0

measure '前年比' = 
        CALCULATE([売上合計], SAMEPERIODLASTYEAR('日付'[日付]))
    formatString: 0.0%
```

Sources:
- [Use Tabular Model Definition Language (TMDL) view in Power BI - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-tmdl-view)
- [Deep dive into TMDL view for Power BI Desktop (Preview) - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/deep-dive-into-tmdl-view-for-power-bi-desktop-preview/)
- [TMDL view (Generally Available) - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/tmdl-view-generally-available/)
- [Microsoft Announces General Availability of TMDL View - Magnetism Solutions](https://www.magnetismsolutions.com/news/microsoft-announces-general-availability-of-tmdl-view-in-power-bi)

---

## 8. フィールドパラメーター（Field Parameters）

①ユーザーがスライサーやボタンで「表示するメジューや列そのもの」を動的に切り替えられる機能。「売上／利益／数量」を1つのビジュアルで切り替え表示する、といったUIを作れる。

②2022年5月にプレビュー導入。**2025年7月更新でGA**。GAと同時に、マトリックスビジュアルでフィールドパラメーター切り替え時に**階層の展開/折りたたみ状態を保持**する機能も追加された。

③学習者が知るべき要点:
- 典型ユースケース: エグゼクティブ向けKPIカードの指標切り替え、比較チャートでのユーザー選択式メジュー切り替え、トレンド分析での指標選択。
- **重要な制約**: フィールドパラメーターは「書式文字列の継承」をサポートしない。例えば「売上（通貨）」と「利益率（％）」を同じフィールドパラメーターで切り替えると、ビジュアルは片方の書式のまま切り替わらない。
- 回避策: `SELECTEDVALUE`パターンで書式文字列を切り替えるメジューを作る、条件付き書式を使う、または動的書式文字列（次項）や計算グループと組み合わせる。
- 教材では「フィールドパラメーター単体では書式が追従しない」という落とし穴を明示し、動的書式文字列との併用パターンを併記するとよい。

④コード例:
```dax
-- フィールドパラメーターの定義（DAX計算テーブルとして生成される）
指標選択 = {
    ("売上", NAMEOF('メジュー'[売上合計]), 0),
    ("利益率", NAMEOF('メジュー'[利益率]), 1)
}

-- 書式が追従するように補うメジュー例
選択中の値 =
VAR v = SELECTEDVALUE('指標選択'[指標選択])
RETURN
SWITCH(
    v,
    "売上", [売上合計],
    "利益率", [利益率]
)
```

Sources:
- [Power BI Blog: Field Parameters Finally Generally Available – SumProduct](https://sumproduct.com/blog/power-bi-blog-field-parameters-finally-generally-available/)
- [Field Parameters: Dynamic User-Selected Visuals - Power BI Consulting](https://powerbiconsulting.com/blog/power-bi-field-parameters-dynamic-visuals)
- [Power BI Field Parameters — A Quick way for Dynamic Visuals - Medium](https://amitchandak.medium.com/power-bi-field-parameters-a-quick-way-for-dynamic-visuals-fc4095ae9afd)

---

## 9. 動的書式文字列（Dynamic Format Strings）

①メジューの書式（表示形式）自体をDAX式で動的に決定できる機能。フィルターコンテキストや値によって「通貨」「％」「整数」などを切り替え表示できる。`FORMAT`関数と違い、**データ型（数値）を保ったまま**書式だけを変える点が重要。

②**2024年10月更新で機能拡充**（メジューへの動的書式文字列サポートの深掘り）。

③学習者が知るべき要点:
- `FORMAT`関数は数値を文字列に変換してしまうため、その後の集計・条件付き書式・ソートに支障が出る。動的書式文字列はこの問題を回避する正攻法。
- ユースケース: 「選択した通貨単位に応じて$/¥/€の書式を切り替える」「値の大きさに応じて千単位/百万単位表記を切り替える」「予実比較で正負に応じて％と実数を切り替える」など。
- フィールドパラメーターと組み合わせることで、前項の「書式が追従しない」問題を解決できる（メジュー側に動的書式文字列を仕込む）。
- 計算グループのアイテムにも動的書式文字列（Selection ExpressionのDynamic Format Expression）を設定できる。

④コード例:
```dax
売上表示 = SUM('売上'[金額])

売上表示 の書式文字列 =
VAR 単位 = SELECTEDVALUE('通貨'[通貨コード], "JPY")
RETURN
SWITCH(
    単位,
    "USD", "$#,0.00",
    "JPY", "¥#,0",
    "#,0"
)
```
（Power BI Desktopでは、メジューのプロパティペインで「書式文字列」の右にある fx ボタンからこのDAX式を設定する）

Sources:
- [Create dynamic format strings for measures - Power BI - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/create-reports/desktop-dynamic-format-strings)
- [Deep dive into the new Dynamic Format Strings for Measures! - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/deep-dive-into-the-new-dynamic-format-strings-for-measures/)
- [Power BI October 2024 Update: Dynamic Format Strings for Measures - Medium](https://medium.com/@cseprs_54978/power-bi-october-2024-update-dynamic-format-strings-for-measures-ef624977e2fb)

---

## 10. Power Query / データフローGen2 / Fabric統合

①データフローGen2は、Power QueryをFabric上でクラウド実行するETLサービス。旧データフロー（Gen1）の後継として位置づけられ、2025年に大幅な機能強化が行われた。

②2025年5月（Microsoft Build）に大規模刷新を発表、2025年秋にパフォーマンス関連の大型アップデート。

③学習者が知るべき要点:
- **Mapping Data Flow変換の実行（プレビュー）**: 低コードのビジュアルインターフェースのまま、裏側でSpark実行エンジンを使い大規模データに対応する新変換方式。
- **「プレビューでのみ有効化」オプション**: 各変換ステップを右クリックして「プレビューでのみ有効化」を選ぶと、より効率的な新エンジンでクエリパフォーマンスが向上する。
- **パーティション化された計算（Partitioned compute）**: あらかじめパーティション分割されたソースを自動検出し、並列評価することで大規模データ処理を高速化。
- **コスト削減**: 長時間実行プロセスで最大90%のキャパシティユニット(CU)コスト削減が報告されている。
- **Copilot支援によるオーサリング**: 自然言語の指示からPower Queryロジック（Mコード）を自動生成する機能が統合された。
- Gen1データフローは終了（サポート終了）に向かっており、Gen2への移行が推奨されている。
- 教材では「オンプレミス／Desktop中心のPower Query」から「Fabric上でスケールするデータフローGen2」への発展として位置づけると良い。

Sources:
- [Dataflow Gen2 and Power Query innovations at Microsoft Build - Fabric Community](https://community.fabric.microsoft.com/t5/Fabric-Updates-Blog/Dataflow-Gen2-and-Power-Query-innovations-at-Microsoft-Build-Low/ba-p/5189028)
- [Fabric Dataflows Gen2 Updates: Performance & Cost - DataBear](https://databear.com/fabric-dataflows-gen2-updates/)
- [Dataflows: Thank you for eight years of Gen1—and why Gen2 is the future - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Dataflows-Thank-you-for-eight-years-of-Gen1-and-why-Gen2-is-the/ba-p/5173910)

---

## 11. Direct Lake / セマンティックモデルの進化

①Direct LakeはFabricのOneLake上のDeltaテーブルを、データをインポート（コピー）せず直接読み込んでインメモリ並みの速度でクエリできるストレージモード。Import（完全コピー）とDirectQuery（都度クエリ）の「良いとこ取り」として設計されている。

②2025年3月、**Power BI Desktop上でDirect Lakeセマンティックモデルを直接作成する機能**がプレビュー公開。合わせて、Direct LakeテーブルとImportテーブルを混在させる「複合（コンポジット）セマンティックモデル」がプレビュー公開。

③学習者が知るべき要点:
- 従来はFabricサービス（Web）側でしかDirect Lakeモデルを作れなかったが、Power BI Desktop単体でDirect Lakeモデルの作成・編集が可能になった。
- **複合モデル（Direct Lake + Import混在）**: Direct Lakeテーブル（Fabricのlakehouse/warehouse/SQL database/ミラーリングDB由来）に加え、Power Query経由で数百種のコネクタからImportテーブルを追加できるようになった。
- 更新（リフレッシュ）の考え方: Importテーブルはデータ自体の更新が必要、Direct Lakeテーブルは「リフレーム（reframe）」でOneLakeの最新Deltaバージョンを参照し直す、という2つの更新概念がある。スキーマ同期（各データソースの最新列情報取得）も可能。
- パフォーマンス面: Direct Lakeはインポートモード相当の速度を、データコピーなしで実現するのが最大の売り。大規模データ×リアルタイム性が必要なケースでの第一選択肢になりつつある。
- 教材では「Import / DirectQuery / Direct Lake」の3モードの比較表を作ると理解しやすい。

Sources:
- [Direct Lake overview - Microsoft Fabric - Microsoft Learn](https://learn.microsoft.com/en-us/fabric/fundamentals/direct-lake-overview)
- [Deep dive into composite semantic models with Direct Lake and import tables - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/deep-dive-into-composite-semantic-models-with-direct-lake-and-import-tables/)
- [Deep dive into Direct Lake on OneLake and creating Direct Lake semantic models in Power BI Desktop - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Deep-dive-into-Direct-Lake-on-OneLake-and-creating-Direct-Lake/ba-p/5174203)

---

## 12. Copilot関連（DAX生成・説明など）

①Power BI Copilotは、自然言語からレポート作成、DAXクエリ・メジューの生成、既存メジューの説明文生成などを支援するAI機能群。DAX関連では特に「DAXクエリビュー」「メジュー編集」画面に統合されている。

②2023年〜2024年に順次導入され、2025年〜2026年にかけて機能拡張が継続中（TMDLビューへのCopilot統合は今後の計画）。

③学習者が知るべき要点:
- **DAXクエリビューでのCopilot**: 自然言語で「このメジューを説明して」「CALCULATE関数の使い方を教えて」等を質問し、DAXクエリ自体もCopilotに生成させられる。2026年更新で、モデルの説明・同義語・列のサンプル値をCopilotが参照してより精度の高い応答を返すようになった（説明文は先頭200文字までを参照）。
- **メジュー説明文の自動生成**: 既存メジューのDAX式からCopilotが自然言語の説明文を生成。式を更新した場合は再度ボタンを押すことで説明文を更新できる。
- **提案メジュー（Suggested measures）**: モデルを解析してCopilotが有用そうなメジューを提案してくれる機能。
- **前提条件**: テナント設定で「Copilotおよびその他のAzure OpenAIを利用する機能をユーザーが使用できるようにする」が有効になっている必要がある。
- **実務上の注意点（教材で強調すべき点）**: Copilotの生成結果は必ず検証してから公開すること。生成されたDAXが意図通りのフィルターコンテキストで動くか、実データで確認する習慣を教える。
- 2026年のWeb Modeling向けCopilot（自然言語でのテーブル名変更・リレーションシップ作成等）、Report Authoring Agent Skills（自然言語でのレポート設計・構築・検証・発行）など、モデリング/レポーティング全体へのAI統合が加速している。

Sources:
- [Write DAX queries with Copilot - Microsoft Learn](https://learn.microsoft.com/en-us/dax/dax-copilot)
- [Use Copilot to create measure descriptions - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/transform-model/desktop-measure-copilot-descriptions)
- [Microsoft Fabric Copilot to write DAX queries in Power BI update - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Microsoft-Fabric-Copilot-to-write-DAX-queries-in-Power-BI-update/ba-p/5174270)
- [Power BI Copilot, AI Instructions and DAX measure definitions - crossjoin.co.uk](https://blog.crossjoin.co.uk/2025/08/10/power-bi-copilot-ai-instructions-and-dax-measure-definitions/)

---

## 13. 2025年〜2026年前半：学習者への影響が大きい月次アップデート

①上記の各機能に加え、以下は学習者の日常的な作業フローに直結するため教材で言及する価値が高い。

②2025年7月〜2026年6月の範囲で発生。

③学習者が知るべき要点（トピック別）:

- **フィールドパラメーターGA（2025年7月）**: 前述の通りGA、マトリックス階層状態の保持が追加。
- **TMDLビューGA（2025年9月）**: モデル定義のコード編集が正式機能に。
- **PBIR（拡張レポート形式）がデフォルトに（2026年5月）**: 従来のバイナリPBIX/レガシーJSON形式に代わり、`.Report`フォルダ配下に人間可読なJSONでレポートを保存する形式がPower BI Desktopの新規保存時のデフォルトになった。PBIP（プロジェクト形式：TMDL＋PBIRのセット）でのGit管理・CI/CDが今後の標準ワークフローになる見込み。教材でも「PBIXだけでなくPBIP/PBIRの存在」に触れておくと実務接続が良い。
- **ビジュアル計算GA（2026年5月）**: 前述の通り。同時期に「Exploration（探索）パースペクティブ」やCopilot Summarize（要約機能）も追加。
- **日付ピッカースライサー（2026年6月）**: 相対日付のデフォルトや手動範囲指定ができる新スライサー。レポートメンテナンスの手間を削減。
- **Copilotナレーティブビジュアルのapp-owns-data対応（2026年5月）**: 組み込みアプリ（consumer がPower BIにサインインしない構成）でもCopilotナレーティブを埋め込めるようになった。開発者/組み込みシナリオの学習者向けに言及価値あり。
- **テキストボックスの箇条書き改善（2026年5月）**: Wordからの貼り付け時の書式保持など、地味だが日常作業に効く改善。

④教材構成への示唆:
- 「操作手順」を教えるレッスンでは、UIが月次更新で変わりうる（特にCopilot関連・スライサー関連）ことを前提に、スクリーンショット依存を減らし概念説明を厚くする設計が望ましい。
- バージョン依存の強い機能（TMDLビュー、DAXクエリビュー、ビジュアル計算）には「対応バージョン注記」を教材内に入れることを推奨。

Sources:
- [Power BI June 2026 Feature Summary - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Power-BI-June-2026-Feature-Summary/ba-p/5193264)
- [Power BI May 2026 Feature Summary - Fabric Community](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Power-BI-May-2026-Feature-Summary/ba-p/5182174)
- [PBIR will become the default Power BI Report Format - Power BI Blog](https://powerbi.microsoft.com/en-us/blog/pbir-will-become-the-default-power-bi-report-format-get-ready-for-the-transition/)
- [Power BI Desktop projects (PBIP) - Microsoft Learn](https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-overview)
- [Power BI May 2026 Update: Visual Calculations Now Live - Enterprise DNA](https://enterprisedna.co/resources/news/power-bi-may-2026-update-visual-calculations-pbir-copilot/)

---

## 教材化に向けたまとめ（優先度目安）

学習アプリのカリキュラムに組み込む際の優先度（筆者所感）:

1. **高優先度（初中級者にも必須）**: ウィンドウ関数（OFFSET/INDEX/RANK）、DAXクエリビュー、フィールドパラメーター、動的書式文字列、ビジュアル計算の基本パターン。
2. **中優先度（中級〜上級、モデル設計者向け）**: 計算グループのDesktop内編集、TMDLビュー、INFO関数群、Direct Lake/複合モデル。
3. **補足として触れる程度で良い**: データフローGen2の内部エンジン詳細、Copilotの内部実装、月次アップデートの細かい機能（日付ピッカー等）は「Power BIは毎月進化している」という文脈紹介に留める。
