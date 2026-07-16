# カリキュラム仕様書(v5追加分)— 一般トラック: 全体概要/基礎/応用/Tips

v5でアプリは6トラック構成になる。このファイルは**新規の一般トラック(unit11〜unit22)**の仕様。
物流実践トラック(既存unit01〜unit10)は CURRICULUM.md を参照(変更なし・独立トラックとして残る)。

| トラック | track値 | ユニット(ファイルid) | 方針 |
|---|---|---|---|
| 📖 全体概要 | overview | unit11 | Power BIの全体像を俯瞰 |
| 🔰 基礎 | basic | unit12〜unit15 | M/DAXを一般例で**網羅的に** |
| 🧠 応用 | advanced | unit16〜unit20 | 上級機能+**2024〜2026最新機能** |
| 🛠️ 実務Tips | tips | unit21〜unit22 | モデリング/性能/品質/運用 |
| 🏭 実践基礎(物流) | practice-basic | unit01〜unit05 | 既存(変更なし) |
| 🚀 実践応用(物流) | practice-adv | unit06〜unit10 | 既存(変更なし) |

`no`(表示順)は unit11=1, unit12=2, … unit22=12, unit01=13, … unit10=22。
**ファイルidと表示順は一致しない**ので注意(idは不変・順序はnoが決める)。

## 一般トラック用サンプルモデル「販売サンプル」(unit12〜unit22で使用)
一般トラックは物流用語を使わず、誰にでも分かる販売データで教える(実践トラックとの差別化)。
- `売上`: [売上ID], [日付], [顧客ID], [商品ID], [数量], [金額]
- `商品`: [商品ID], [商品名], [カテゴリ], [単価], [原価]
- `顧客`: [顧客ID], [顧客名], [地域], [会員ランク]
- `'日付'`: [Date], [年], [月], [年月], [曜日]  ※マーク済み日付テーブル
- 標準メジャー(既出として参照可):
```
[売上合計] = SUM(売上[金額])
[販売数量] = SUM(売上[数量])
[顧客数]   = DISTINCTCOUNT(売上[顧客ID])
[粗利]     = SUMX(売上, 売上[数量] * (RELATED(商品[単価]) - RELATED(商品[原価])))
```
- 表記規約は CURRICULUM.md と同じ(メジャー[名前]/列は表名[列名]/'日付'[Date]のみクォート/演算子前後スペース)。

## リサーチ反映(必読)
- unit20 は spec/RESEARCH-updates.md を**必読**。構文・GA状況などの事実はリサーチ結果を正とする。リサーチで確認できない機能は出題しない(解説で「今後」扱いは可)。
- unit11 のライセンス/エコシステムの事実関係は RESEARCH-updates.md / RESEARCH-syllabus.md を参照。
- 全ユニット共通: RESEARCH-syllabus.md のチェックリストに載る基礎トピックの取りこぼしがないか、執筆後にセルフチェックすること。

---

## unit11 📖 Power BIの全体像(track: overview, no: 1, color: #546a7b)— 4レッスン
※overviewトラックはtype問題なしでよい(mc/fill中心)。fillは各レッスン1問以上必要。
1. **Power BIエコシステム** — Desktop(作る)/Service(共有する)/Mobile(見る)の三位一体。ワークスペース、アプリ、Fabricとの関係。ライセンス体系(Free/Pro/PPU/Fabric容量)の要点。
2. **レポートができるまで** — 接続→変換(Power Query)→モデリング→DAX→ビジュアル→発行→更新の一本道。接続モード(Import/DirectQuery/Direct Lake/複合)の使い分け初歩。ゲートウェイとは。
3. **MとDAXの役割分担** — 「どっちでやる?」問題。行レベルの整形はPower Query、集計・分析はDAX。計算列vsPQカスタム列vsメジャーの判断基準。
4. **データアナリストへの道** — PL-300資格、Microsoft Learn、コミュニティ、月次アップデートの追い方。このアプリの6トラックの歩き方(初心者は概要→基礎、経験者は実力診断でスキップ)。

## unit12 🔤 M言語基礎 I: 言語のしくみ(track: basic, no: 2, color: #b8860b)— 5レッスン
1. **let式と評価モデル** — let/in、ステップ=変数、遅延評価(使われないステップは評価されない)、詳細エディター、大文字小文字区別。
2. **プリミティブ型と演算子** — text/number/date/datetime/duration/logical/null。&連結、算術、比較、null合体演算子 ?? 。型の厳格さ(暗黙変換しない)。
3. **リスト徹底攻略** — {1..10}、アクセス{0}(0始まり!)、List.Count/Sum/Max/Transform/Select/Distinct/Sort。type例: `List.Transform({1..5}, each _ * 10)`
4. **レコードとテーブル** — [Name="A"]、アクセス[Name]、Record.AddField、#table構文、「テーブルの行=レコード、列=リスト」の対応関係。
5. **制御構造と関数値** — if/then/else(式であること)、each と (x)=>、関数もただの値、型注釈 as number。

## unit13 🧽 M言語基礎 II: 実戦の型(track: basic, no: 3, color: #c29343)— 5レッスン
1. **データソース接続の基礎** — Excel.Workbook/Csv.Document/Web.Contents/Sql.Database。資格情報とプライバシーレベル。ナビゲーション。
2. **行・列操作とUIの対応** — Table.SelectRows/RemoveColumns/SelectColumns/Sort/Distinct/FirstN。「UIで操作→数式バーで確認」の学習ループ。データプロファイリング(列の品質/列の分布/列のプロファイル、1000行制限)もここで扱う。
3. **テキスト関数大全** — Split/Combine/Replace/Contains/StartsWith/PadStart/Trim/Clean/Upper/Proper。区切り記号による列分割の裏側。type例: `Text.Combine({[姓], [名]}, " ")`
4. **日付・数値関数大全** — Date.Year/Month/AddDays/AddMonths/EndOfMonth/DayOfWeek、Duration、Number.Round(銀行家丸め!)/RoundUp/Mod。
5. **型変換とロケール** — Table.TransformColumnTypes、「使用するロケール」、日付の解釈(1/2/2026問題)、通貨記号・桁区切りの除去。

## unit14 📐 DAX基礎 I: 計算のことば(track: basic, no: 4, color: #2e7d32)— 5レッスン
1. **DAXの3つの置き場** — メジャー/計算列/計算テーブルの違いと使い分け。暗黙メジャーに頼らない理由。メジャーの作り方・書式設定。
2. **集計関数大全** — SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/COUNTROWS/COUNTBLANK/DISTINCTCOUNT。それぞれ何を数えるかの違い。type例: `顧客数 = DISTINCTCOUNT(売上[顧客ID])`
3. **論理と条件** — IF/SWITCH/SWITCH(TRUE())/AND/OR/NOT/COALESCE/ISBLANK。ネストIFをSWITCHに直す。
4. **テキスト・日付関数** — FORMAT(表示形式)、CONCATENATEX入口、YEAR/MONTH/EOMONTH/DATE/DATEDIFF/TODAY。
5. **DIVIDEと数値関数** — 0除算、ROUND/ROUNDUP/ROUNDDOWN/INT/MOD、パーセント表示はFORMATでなく書式設定で。

## unit15 🎯 DAX基礎 II: コンテキストの入口(track: basic, no: 5, color: #1f8a5c)— 5レッスン
1. **フィルターコンテキスト** — 「同じ式がセルごとに違う値になる」仕組み。スライサー/軸/凡例/他ビジュアル。
2. **行コンテキストとイテレーター** — SUMX/AVERAGEX/MAXX/COUNTX/CONCATENATEX。SUMとSUMXの違い。行コンテキストはフィルターしない。
3. **CALCULATE第一歩** — フィルター上書きの原理、ブールフィルター、複数条件(AND)。type例: `東京売上 = CALCULATE([売上合計], 顧客[地域] = "東京")`
4. **リレーションと参照関数** — 1対多、RELATED/RELATEDTABLE、リレーションが無いときのLOOKUPVALUE。
5. **日付テーブル入門** — CALENDARAUTO、マークする理由、TOTALYTD/SAMEPERIODLASTYEARの初体験(深掘りは応用で)。

## unit16 ⚙️ M応用 I: 変換の匠(track: advanced, no: 6, color: #7a5230)— 5レッスン
1. **カスタム関数と再利用** — (x as number) as number =>、optional、関数ドキュメント(メタデータ)、Table.AddColumnでの適用。
2. **ピボットとアンピボット** — 横持ち⇔縦持ち変換(Table.Pivot/Table.Unpivot/UnpivotOtherColumns)。「月が列に並んだExcel」を正規化する定番シナリオ。type例: `Table.UnpivotOtherColumns(ソース, {"商品ID"}, "年月", "数量")`
3. **マージ完全版** — 6種のJoinKind、複合キー、あいまい一致(Fuzzy)の使い所と危険性、結合前のキー整備(型/空白/大文字小文字)。
4. **グループ化の応用** — Table.Group、集計の複数指定、「すべての行」(部分テーブル)からのトップN抽出。
5. **List.Generate と List.Accumulate** — ループ的処理の書き方(条件を満たすまで生成/畳み込み)。実用例: 累積、連番展開、繰返しAPI呼び出しの考え方。

## unit17 🚀 M応用 II: 堅牢化と大規模データ(track: advanced, no: 7, color: #8a5a44)— 5レッスン
1. **クエリフォールディング詳説** — 原理、ネイティブクエリ表示、折りたたみを保つステップ順序、Value.NativeQueryとEnableFolding。
2. **エラー処理設計** — try...otherwise、エラーレコード(Reason/Message/Detail)、列単位のエラー検出、品質ゲート(error での意図的停止)。
3. **パラメータ設計とテンプレート** — 環境切替、パラメータの型、テンプレート(.pbit)化、「常に許可」の落とし穴。
4. **増分更新とデータフロー** — RangeStart/RangeEnd(datetime型必須)、増分更新ポリシー、データフロー(Gen2)で変換を共有する発想。
5. **パフォーマンス戦略** — 早期の列削減、Table.Buffer の光と影、クエリ診断(Query Diagnostics)、参照と評価回数。

## unit18 🧠 DAX応用 I: コンテキスト完全理解(track: advanced, no: 8, color: #2f6fd0)— 5レッスン
1. **コンテキスト遷移の原理** — 行コンテキスト×CALCULATE、メジャー参照=暗黙CALCULATE、重複行の罠、遷移のコスト。
2. **ALL族完全版** — ALL/ALLEXCEPT/ALLSELECTED/ALLNOBLANKROW/REMOVEFILTERS。「テーブル関数としてのALL」と「フィルター解除としてのALL」の二面性。type例: `全体比 = DIVIDE([売上合計], CALCULATE([売上合計], REMOVEFILTERS(商品)))`
3. **FILTER設計と性能** — FILTER(ALL(列), …)と列イテレート、KEEPFILTERS、ブールフィルターとの使い分け。
4. **テーブル関数ツールボックス** — VALUES/DISTINCT/SUMMARIZE/ADDCOLUMNS/SELECTCOLUMNS/CROSSJOIN/GENERATE/UNION。SUMMARIZECOLUMNSに触れる(メジャー内での制約)。
5. **変数とデバッグ術** — VARの1回評価、テーブル変数、CONCATENATEXで中身を見る、DAXクエリビューのEVALUATEでメジャーを試す。

## unit19 ⏳ DAX応用 II: 時間と関係の魔術(track: advanced, no: 9, color: #5561d6)— 5レッスン
1. **タイムインテリジェンス完全版** — DATESINPERIOD/DATESBETWEEN/PARALLELPERIOD/PREVIOUSMONTH/NEXTDAY系、会計年度(TOTALYTDの第3引数)、週の扱い(組込関数が苦手な領域)。
2. **半加法メジャー** — LASTDATE/LASTNONBLANK/FIRSTDATE、OPENINGBALANCEMONTH/CLOSINGBALANCEMONTH。残高系データの正しい集計。
3. **ランキング上級** — RANKX の全引数(値式/順序/ties)、コンテキスト復元、TOPN+「その他」パターン、動的N(パラメータ連動)。
4. **仮想リレーション** — TREATAS/CROSSFILTER/USERELATIONSHIP の使い分け、多対多の危険と対処、ブリッジテーブル。
5. **高度パターン** — 新規/リピート顧客(EXCEPT/INTERSECT)、同時購入(バスケット)、カスタム期間比較。type例: `新規顧客数 = COUNTROWS(EXCEPT(VALUES(売上[顧客ID]), CALCULATETABLE(VALUES(売上[顧客ID]), DATESBETWEEN('日付'[Date], BLANK(), MIN('日付'[Date]) - 1))))` ※長いのでfill化推奨

## unit20 ✨ モダンDAXと最新機能(track: advanced, no: 10, color: #8a4fd3)— 5レッスン
**spec/RESEARCH-updates.md を必読。事実(構文/GA状況/制約)はリサーチ結果を正とし、確認できない事項は出題しない。**
1. **ウィンドウ関数 I** — INDEX/OFFSET/ROWNUMBER、ORDERBY/PARTITIONBY の考え方。前の行との比較(前月差)をOFFSETで。
2. **ウィンドウ関数 II** — WINDOW/RANK、移動集計や累積をウィンドウで書く。従来手法(FILTER自己結合)との比較。
3. **ビジュアル計算** — Visual Calculations の何が革命か(ビジュアルの集計結果に対する計算)、RUNNINGSUM/MOVINGAVERAGE/PREVIOUS/PERCENTOFPARENT等、制約(エクスポート/再利用)。
4. **計算グループ** — Desktopでの作成、SELECTEDMEASURE、適用順(Precedence)、「前年比・YTD・構成比を全メジャーに一括適用」の威力。
5. **DAXクエリビューとINFO関数・Copilot** — EVALUATEの書き方、クイッククエリ、INFO関数群でモデルを棚卸し、Copilotとの付き合い方(生成→必ず検証)。

## unit21 🏗️ モデリング&性能Tips(track: tips, no: 11, color: #6d6a60)— 5レッスン
※tipsトラックはtype問題なしでもよい(mc/fill中心)。
1. **スタースキーマ設計原則** — ファクト/ディメンション、粒度の宣言、スノーフレークとの比較、1枚テーブルの限界。
2. **VertiPaqと軽量化** — 列指向・辞書圧縮、カーディナリティがサイズを決める、不要列/高カーディナリティ列の削減、自動日付テーブルをオフ。
3. **計測ツール大全** — パフォーマンスアナライザー→DAX Studio(サーバータイミング)→VertiPaq Analyzer、Best Practice Analyzer(Tabular Editor)、Bravo。
4. **リレーション設計の落とし穴** — 双方向フィルターの危険、多対多、非アクティブ活用、RLS(行レベルセキュリティ)基礎。
5. **モデルの整理とドキュメント** — 表示フォルダー、メジャーテーブル、説明欄、命名規約、フィールドの非表示戦略。

## unit22 🧰 実務効率化&品質Tips(track: tips, no: 12, color: #57534a)— 5レッスン
1. **きれいなDAXの作法** — 整形(DAX Formatter)、メジャー[名前]/列'表'[列]の慣例、コメント、長い式の分割(VAR)。
2. **Power Query整理術** — ステップ命名、参照vs複製、グループ化、読み込み無効、クエリのドキュメント化。
3. **トラブル事典(一般版)** — 循環依存、BLANK()=0問題、合計行が合わない、型エラー、更新失敗の切り分け(資格情報/ゲートウェイ/プライバシーレベル)。
4. **レポートデザイン原則** — 1画面1メッセージ、Zの視線、色は意味に使う、ツールチップ/ブックマーク/ドリルスルーの使い所、アクセシビリティ。
5. **共有と運用** — 発行、更新スケジュール、アプリ配布、RLSロール、バージョン管理の工夫(命名/OneDrive)、Copilot時代の品質担保。

## 執筆時の注意(全ユニット共通)
- SCHEMA.md の全ルール遵守(fill毎レッスン1問以上、basic/advancedトラックはtype毎レッスン1問以上。overview/tipsはtype任意)。
- 「現場の1シーン」導入は一般トラックでは会社の汎用シーン(営業会議、上司の依頼等)でよい。物流ネタは使わない(実践トラックとの差別化)。
- 各レッスンの最後の問題は少し背伸び。解説は「なぜ+実務でどう効くか」。
- v1/実践トラックと重複するテーマ(CALCULATE等)は、一般トラック側が「原理の正面解説」、実践側が「物流での運用」という役割分担。文章の使い回しは禁止。
