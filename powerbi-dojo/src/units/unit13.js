window.DOJO_UNITS = window.DOJO_UNITS || [];
window.DOJO_UNITS.push({
  id: "unit13",
  no: 3,
  track: "basic",
  icon: "🧽",
  name: "M言語基礎 II: 実戦の型",
  color: "#c29343",
  desc: "データ接続・行列操作・テキスト/日付/数値関数・型変換とロケールまで、「販売サンプル」モデルで実務のPower Queryを書けるようにする",
  lessons: [
    {
      title: "データソース接続の基礎",
      doc: `
<p>営業部のチームリーダーから「先月の売上データを、Excelブックと社内システムのCSVエクスポート、それに取引先が提供するWeb APIの3か所からまとめてほしい」と頼まれたとします。Power Queryは接続先ごとに専用の関数を用意しており、まずはその代表的な4つの顔ぶれと、それぞれが返す「生の形」を覚えるところから始めます。</p>
<p><b>Excel.Workbook</b>はExcelブックの中身(シートやテーブル、名前付き範囲)を一覧にしたテーブルとして返します。狙った1つのシートやテーブルにたどり着くには、この一覧から<b>ナビゲーション</b>(絞り込み)が必要です。<b>Csv.Document</b>はCSVファイルの中身を、区切り記号やエンコードを指定して表形式に解釈します。<b>Web.Contents</b>はWeb APIやWebページから<b>バイナリ</b>データを取得するだけの関数で、JSON形式のレスポンスを扱うにはさらに<code>Json.Document</code>で包む必要があります。<b>Sql.Database</b>はSQL Serverに接続してテーブルの一覧を返し、可能な操作はサーバー側で実行される(クエリフォールディング)ため大規模データでも高速です。</p>
<pre>let
    ソース = Excel.Workbook(File.Contents("C:\\Data\\売上.xlsx"), null, true),
    売上テーブル = ソース{[Item="売上", Kind="Table"]}[Data]
in
    売上テーブル

Csv.Document(File.Contents("C:\\Data\\売上.csv"), [Delimiter=",", Columns=6, Encoding=65001])

Json.Document(Web.Contents("https://api.example.com/sales"))

Sql.Database("dbserver01", "販売DB")</pre>
<p>これらの関数を初めて実行すると、多くの場合<b>資格情報(Credentials)</b>の入力を求められます。さらにWeb.ContentsやSql.Databaseのように社外・社内の別のシステムに触れる接続では、<b>プライバシーレベル</b>(Public/Organizational/Private)の設定も必要です。プライバシーレベルは「異なる信頼度のデータソースを1つのクエリの中で組み合わせてよいか」をPower Queryが判断するための情報で、設定を誤ると意図せず機密データが外部サービスに送られるのを防ぐ「Formula.Firewall」のブロックに遭遇することがあります。</p>
<p class="tip">💡 実務メモ: Excel.Workbookが返す一覧のうち、目的のテーブルへは{[Item="テーブル名", Kind="Table"]}[Data]という書き方でたどり着けます。UIでナビゲーターから選ぶだけでもこのコードは自動生成されるので、詳細エディターで実際の形を確認しておくと応用が利きます。</p>`,
      exercises: [
        {
          type: "mc",
          q: "Excel.Workbook(File.Contents(path), null, true) が返す値の説明として正しいものはどれですか?",
          c: ["ブック内のシート・テーブル・名前付き範囲などを一覧にしたテーブルで、目的のデータへはさらにナビゲーションが必要", "指定したシートの1行目だけを読み込んだテーブル", "ブック全体をそのままバイナリ値として返す(Csv.Documentと同じ挙動)", "ブックの中で最初に見つかったテーブルのデータをそのまま返す"],
          a: 0,
          e: "Excel.Workbookはブック内の要素一覧を返す関数で、{[Item=...,Kind=...]}[Data]のようなナビゲーションで目的のシートやテーブルのデータにたどり着く必要があります。この2段構えの構造を知らないと、狙った表がなかなか出てこず戸惑いがちです。"
        },
        {
          type: "mc",
          q: "Web.Contents(url) が返す値の型として正しいものはどれですか?",
          c: ["バイナリ値。JSON形式のレスポンスをテーブルとして扱うにはJson.Documentで変換する必要がある", "常にテキスト形式のCSVとして解釈済みのテーブル", "常にJSONとして自動解析された、そのまま使えるテーブル", "Excel.Workbookと同じ形式のシート一覧テーブル"],
          a: 0,
          e: "Web.Contentsが返すのはあくまでバイナリの生データで、JSON APIのレスポンスを構造化データとして扱うにはJson.Documentで包む必要があります。この一手間を忘れるとリストやレコードではなくバイナリのままエラーになります。"
        },
        {
          type: "mc",
          q: "Power Queryにおける「プライバシーレベル」(Public/Organizational/Private)の役割として正しいものはどれですか?",
          c: ["異なる信頼度のデータソースを1つのクエリの中で組み合わせてよいかをPower Queryが判断するための情報", "ファイルの文字コード(エンコード)を指定するための設定", "クエリの実行速度を高速化するためのキャッシュ設定", "レポートを閲覧できるユーザーを制限するアクセス権限の設定"],
          a: 0,
          e: "プライバシーレベルはデータソースの信頼度を分類し、機密度の異なるソースを不用意に1つのクエリで結合してデータが漏れることを防ぐための仕組みです。設定を誤るとFormula.Firewallのエラーに直面することがあります。"
        },
        {
          type: "fill",
          q: "Excel.Workbookでブックを開き、名前付きテーブル「売上」のデータ部分だけを取得するM式の空欄を埋めてください。",
          lang: "m",
          code: "let\n    【0】 = Excel.Workbook(File.Contents(\"売上.xlsx\"), null, true),\n    売上テーブル = ソース{[Item=\"売上\", Kind=\"Table\"]}【1】\nin\n    売上テーブル",
          bank: ["ソース", "[Data]", "データ", "Table"],
          answers: [0, 1],
          e: "letブロックの1つ目のステップ名(ここではソース)は後続ステップから参照する変数名なので、参照側と一致させる必要があります。{[Item=...,Kind=...]}[Data]はナビゲーション結果の「Data」フィールドだけを取り出す定番の書き方です。"
        },
        {
          type: "type",
          q: "ファイル「売上.xlsx」をExcel.Workbookで開き、その中の名前付きテーブル「売上」のデータ部分を取得する1行のM式を書いてください。",
          lang: "m",
          answer: "Excel.Workbook(File.Contents(\"売上.xlsx\"), null, true){[Item=\"売上\", Kind=\"Table\"]}[Data]",
          hint: "Excel.Workbook(...)の結果に対して{[Item=\"テーブル名\", Kind=\"Table\"]}[Data]でナビゲーションします。",
          e: "Excel.Workbookが返す一覧から、{[Item=\"売上\", Kind=\"Table\"]}でテーブルの行を選び、[Data]でその中のデータ部分だけを取り出します。この2段階の書き方はExcel系接続の基本パターンです。"
        }
      ]
    },
    {
      title: "行・列操作とUIの対応",
      doc: `
<p>Power Queryエディターで列見出しの▼をクリックして「テキストフィルター」や「数値フィルター」を選ぶと、リボンの見た目は変わっても、舞台裏では必ず特定のM関数が生成されています。UI操作と数式バーの対応関係を知っておくと、「UIにないニッチな条件」も自分で数式バーから直接書けるようになります。</p>
<p>行を絞り込む基本は<b>Table.SelectRows(テーブル, 条件関数)</b>です。第2引数には通常<code>each</code>で始まる条件式を渡し、trueを返す行だけが残ります。列については、いらない列を消す<b>Table.RemoveColumns</b>と、必要な列だけを残す<b>Table.SelectColumns</b>という正反対の関数が用意されており、最終的に残したい列が少ない場合はSelectColumnsのほうが意図がはっきりします。並べ替えは<b>Table.Sort</b>で、<code>Order.Ascending</code>/<code>Order.Descending</code>という列挙値を組み合わせます。重複行を取り除く<b>Table.Distinct</b>、先頭からN行だけを取る<b>Table.FirstN</b>も、UIの「行の保持」グループにあるボタンにそのまま対応しています。</p>
<pre>Table.SelectRows(売上, each [数量] > 10)
Table.RemoveColumns(売上, {"売上ID"})
Table.SelectColumns(売上, {"売上ID", "顧客ID", "金額"})
Table.Sort(売上, {{"金額", Order.Descending}})
Table.Distinct(顧客, {"顧客ID"})
Table.FirstN(売上, 10)</pre>
<p>もう1つ覚えておきたいのが<b>データプロファイリング</b>です。列見出しの下に表示される「列の品質」(有効/エラー/空の割合)、ヒストグラム状の「列の分布」、選択した列の詳細統計を表示する「列のプロファイル」の3つは、表示メニューからオン/オフを切り替えられます。ただしこれらは既定では<b>先頭1000行だけ</b>を対象に計算される軽量プレビューであり、全件を毎回スキャンしているわけではありません。データセット全体の傾向を確認したい場合は、ステータスバーの「列プロファイリングは最初の1000行に基づいています」というメッセージから「データセット全体に基づく列プロファイル」に切り替える必要があります。</p>
<p class="tip">💡 実務メモ: UIで何か操作したら、すぐに数式バーを確認する習慣をつけましょう。生成されたM関数の名前と引数の対応が体に入ると、「UIにこの操作はないけれど、この関数を直接書けば実現できる」という判断が早くなります。</p>`,
      exercises: [
        {
          type: "mc",
          q: "Table.RemoveColumnsとTable.SelectColumnsの違いとして正しいものはどれですか?",
          c: ["Table.RemoveColumnsは指定した列を除いた残りの列を、Table.SelectColumnsは指定した列だけを残す(正反対の関係)", "両方とも同じ結果になる同義語である", "Table.RemoveColumnsは行を削除し、Table.SelectColumnsは列を削除する", "Table.SelectColumnsは指定した列を削除し、Table.RemoveColumnsは指定した列だけを残す"],
          a: 0,
          e: "Table.RemoveColumnsは指定列を取り除いた残りを、Table.SelectColumnsは指定列だけを残した結果を返す、ちょうど逆の関数です。残したい列が少ないときはSelectColumnsのほうが意図が明確になります。"
        },
        {
          type: "mc",
          q: "Table.SelectRows(売上, each [数量] > 10) の働きとして正しいものはどれですか?",
          code: "Table.SelectRows(売上, each [数量] > 10)",
          lang: "m",
          c: ["数量列の値が10より大きい行だけを残した新しいテーブルを返す", "数量列の値を10倍した新しい列を追加する", "数量列を削除した新しいテーブルを返す", "テーブル全体を先頭10行に制限する"],
          a: 0,
          e: "Table.SelectRowsの第2引数の条件式(each以降)がtrueになる行だけが残ります。ここでは数量が10より大きい行だけが残るので、フィルターの働きをします。"
        },
        {
          type: "mc",
          q: "Power Queryのデータプロファイリング機能(列の品質・列の分布・列のプロファイル)は既定でどの範囲のデータを対象に計算されますか?",
          c: ["既定では先頭1000行のみを対象に計算され、必要なら「データセット全体に基づく列プロファイル」に切り替えられる", "常にデータソースの全行を対象に、表示するたびに全件計算される", "既定では末尾1000行のみを対象に計算される", "列のプロファイリングは常に手動でSQLを書いて確認する必要がある"],
          a: 0,
          e: "データプロファイリングは既定で先頭1000行のサンプルに基づく軽量なプレビューです。全件の傾向を確認したいときはステータスバーから「データセット全体に基づく列プロファイル」に切り替える必要があります。"
        },
        {
          type: "mc",
          q: "Table.Distinct(顧客, {\"顧客ID\"}) の働きとして正しいものはどれですか?",
          code: "Table.Distinct(顧客, {\"顧客ID\"})",
          lang: "m",
          c: ["顧客ID列の値が重複する行を取り除き、初出の行だけを残した新しいテーブルを返す", "顧客ID列の値を昇順に並べ替えるだけで行数は変わらない", "顧客ID列を削除した新しいテーブルを返す", "顧客ID列の合計値を計算する"],
          a: 0,
          e: "Table.Distinctに列を指定すると、その列の値が重複する行を取り除き、初出の行だけを残します。列を省略すると全列が完全一致する行だけを重複とみなします。"
        },
        {
          type: "fill",
          q: "「金額」列を降順で並べ替えるM式の空欄を埋めてください。",
          lang: "m",
          code: "Table.Sort(売上, {{\"金額\", 【0】}})",
          bank: ["Order.Descending", "Order.Ascending", "Sort.Descending", "\"Descending\""],
          answers: [0],
          e: "Table.Sortの並べ替え順は列挙値Order.AscendingまたはOrder.Descendingで指定します。降順で金額の大きい順に並べたい場合はOrder.Descendingを使います。"
        },
        {
          type: "type",
          q: "テーブル「売上」から数量が10より大きい行だけを残すM式を、Table.SelectRowsを使って書いてください。",
          lang: "m",
          answer: "Table.SelectRows(売上, each [数量] > 10)",
          hint: "Table.SelectRowsの第2引数にeachを使った条件式(比較演算子は>)を渡します。",
          e: "Table.SelectRows(テーブル, each 条件式)は条件式がtrueを返す行だけを残す、行フィルターの基本形です。UIの「数値フィルター」もこの形のコードを生成しています。"
        }
      ]
    },
    {
      title: "テキスト関数大全",
      doc: `
<p>顧客マスタを整備していると、「顧客名」列に"山田 太郎"のように姓と名がスペース区切りでまとめて入っていて、姓だけで並べ替えたい、といった場面によく出会います。M言語のテキスト関数群を知っておくと、こうした表記ゆれの直しや列の分割・結合を数式バーから自在にコントロールできます。</p>
<p>列を分割する操作は、UI上では「区切り記号による列の分割」ですが、裏側では<b>Table.SplitColumn</b>と、分割方法を表す<b>Splitter.SplitTextByDelimiter</b>という2つの関数が組み合わさっています。1つの文字列だけをリストに分割したいときは、より単純な<b>Text.Split(テキスト, 区切り記号)</b>を直接使うこともできます。逆に複数のテキストを1つにつなげたいときは<b>Text.Combine(テキストのリスト, 区切り記号)</b>を使います。</p>
<pre>Table.SplitColumn(顧客, "顧客名", Splitter.SplitTextByDelimiter(" "), {"姓", "名"})
Text.Split("山田 太郎", " ")               // {"山田", "太郎"}
Text.Combine({[姓], [名]}, " ")            // "山田 太郎"
Text.Replace([地域], "東京都", "")
Text.Contains([商品名], "限定")             // true / false
Text.StartsWith([顧客名], "山")             // true / false
Text.PadStart(Text.From([顧客ID]), 6, "0")  // "000123"
Text.Trim("  山田太郎  ")                   // "山田太郎"
Text.Clean([商品名])
Text.Upper("a001")                          // "A001"
Text.Proper("tokyo store")                  // "Tokyo Store"</pre>
<p>これらの関数のうち混同しやすいのが<b>Text.Contains</b>と<b>Text.StartsWith</b>です。前者は文字列の<b>どこかに</b>指定した部分文字列が含まれていればtrue、後者は文字列が<b>その部分文字列そのものから始まっている</b>場合だけtrueを返します。また<b>Text.PadStart</b>は指定した長さになるまで先頭に文字を詰め込む関数で、Excelで顧客IDを数値として扱ってしまい先頭のゼロが落ちた("123"→本来は"000123")ようなデータを復元するときの定番です。<b>Text.Trim</b>は前後の空白除去、<b>Text.Clean</b>は改行やタブなど画面に表示されない制御文字の除去と、似ているようで対象が違う点にも注意してください。</p>
<p class="tip">💡 実務メモ: Text.PadStartの第3引数(埋める文字)を省略すると半角スペースで埋められてしまうため、ゼロ埋めしたいときは必ず"0"を明示的に指定しましょう。</p>`,
      exercises: [
        {
          type: "mc",
          q: "Text.SplitとText.Combineの関係の説明として正しいものはどれですか?",
          c: ["Text.Splitは区切り記号でテキストをリストに分割し、Text.Combineはリストの要素を区切り記号でつないで1つのテキストに戻す、ほぼ逆の操作である", "どちらも同じ結果を返す同義語であり、書き方の好みで使い分けるだけである", "Text.Splitはテキストを結合し、Text.Combineはテキストを分割する(関数名と処理が逆になっている)", "Text.SplitとText.Combineはどちらも数値専用の関数であり、テキストには使えない"],
          a: 0,
          e: "Text.Splitはテキスト→リスト、Text.Combineはリスト→テキストという、ちょうど逆方向の変換を行う関数です。列の分割・結合はこの2つの組み合わせで理解すると迷いません。"
        },
        {
          type: "mc",
          q: "Text.Contains(\"東京都渋谷区\", \"渋谷\") と Text.StartsWith(\"東京都渋谷区\", \"渋谷\") を評価した結果の組み合わせとして正しいものはどれですか?",
          code: "Text.Contains(\"東京都渋谷区\", \"渋谷\")\nText.StartsWith(\"東京都渋谷区\", \"渋谷\")",
          lang: "m",
          c: ["Text.Containsはtrue(文字列の途中に含まれている)、Text.StartsWithはfalse(先頭からは始まっていない)", "両方ともtrueになる(どちらも「含まれるか」を判定する同じ処理のため)", "両方ともfalseになる", "Text.Containsはfalse、Text.StartsWithはtrueになる"],
          a: 0,
          e: "Text.Containsは文字列のどこかに部分文字列が含まれればtrue、Text.StartsWithは先頭から始まっている場合だけtrueです。「東京都渋谷区」は「渋谷」を含みますが、「渋谷」から始まってはいないため結果が分かれます。"
        },
        {
          type: "mc",
          q: "Text.PadStart(\"7\", 4, \"0\") を評価した結果として正しいものはどれですか?",
          code: "Text.PadStart(\"7\", 4, \"0\")",
          lang: "m",
          c: ["\"0007\"(4文字になるまで先頭を\"0\"で埋める)", "\"7000\"(4文字になるまで末尾を\"0\"で埋める)", "\"07\"(2文字の文字列になる)", "エラーになる(数字を含む文字列には使えない)"],
          a: 0,
          e: "Text.PadStartは指定した長さになるまで先頭に指定文字を詰めます。\"7\"を4文字にするには\"0\"を3個先頭に追加するので\"0007\"になります。ゼロ落ちしたID列の復元によく使われます。"
        },
        {
          type: "mc",
          q: "Text.Proper(\"tokyo store\") を評価した結果として正しいものはどれですか?",
          code: "Text.Proper(\"tokyo store\")",
          lang: "m",
          c: ["\"Tokyo Store\"(各単語の先頭文字だけを大文字にする)", "\"TOKYO STORE\"(すべて大文字にする)", "\"tokyo store\"(何も変化しない)", "\"Tokyo store\"(先頭の単語だけ大文字にする)"],
          a: 0,
          e: "Text.Properは各単語の先頭文字だけを大文字化する関数です。文字列全体を大文字化するText.Upperと混同しやすいので注意してください。"
        },
        {
          type: "fill",
          q: "「顧客名」列をスペース区切りで「姓」「名」の2列に分割するM式の空欄を埋めてください。",
          lang: "m",
          code: "Table.SplitColumn(顧客, \"顧客名\", 【0】(\" \"), {\"姓\", \"名\"})",
          bank: ["Splitter.SplitTextByDelimiter", "Text.Split", "Splitter.SplitTextByRepeatedLengths", "Combiner.CombineTextByDelimiter"],
          answers: [0],
          e: "Table.SplitColumnの第3引数には「どう分割するか」を表す分割用の関数を渡します。区切り記号で分割する場合はSplitter.SplitTextByDelimiterを使うのが定番です。"
        },
        {
          type: "type",
          q: "[姓]列と[名]列の値を半角スペースで連結した1つの文字列を作るM式を、Text.Combineを使って書いてください。",
          lang: "m",
          answer: "Text.Combine({[姓], [名]}, \" \")",
          hint: "Text.Combineの第1引数はテキストのリスト({}で囲む)、第2引数は区切り文字です。",
          e: "Text.Combineはリストの各要素を指定した区切り記号でつなげて1つの文字列にする関数です。姓と名を1つの氏名列にまとめる典型的な使い方です。"
        }
      ]
    },
    {
      title: "日付・数値関数大全",
      doc: `
<p>月次会議で「今月末まであと何日残っているか」「受注日から1か月後の締め日はいつか」といった日付計算や、「税抜金額を丸めたはずなのにExcelの検算と1円ズレる」という数値のズレに悩んだ経験はないでしょうか。M言語の日付・数値関数を体系的に押さえておくと、こうした計算を自信を持って書けるようになります。</p>
<p>日付関連では、年・月を取り出す<b>Date.Year</b>/<b>Date.Month</b>、日数や月数を加減算する<b>Date.AddDays</b>/<b>Date.AddMonths</b>、月末日を返す<b>Date.EndOfMonth</b>、曜日番号を返す<b>Date.DayOfWeek</b>がよく使われます。2つの日付を引き算すると<b>duration(期間)</b>という型の値になり、日数だけを整数として取り出すには<b>Duration.Days</b>を使います。</p>
<pre>Date.Year(#date(2026, 7, 16))            // 2026
Date.Month(#date(2026, 7, 16))           // 7
Date.AddDays(#date(2026, 7, 16), 10)     // #date(2026, 7, 26)
Date.AddMonths(#date(2026, 7, 16), 1)    // #date(2026, 8, 16)
Date.EndOfMonth(#date(2026, 7, 16))      // #date(2026, 7, 31)
Date.DayOfWeek(#date(2026, 7, 16), Day.Sunday)  // 4(Day.Sundayを指定したので日曜=0と数え、木曜は4)
Duration.Days(#date(2026, 7, 16) - #date(2026, 7, 1))  // 15

Number.Round(2.5, 0)                             // 2(銀行家丸め: 最も近い偶数へ)
Number.Round(2.5, 0, RoundingMode.AwayFromZero)  // 3(四捨五入相当)
Number.RoundUp(2.1, 0)                           // 3(正の無限大方向=大きい方への切り上げ。負数では-2.1→-2になる点に注意)
Number.Mod(7, 3)                                 // 1(割り算の余り)</pre>
<p>数値関数でとりわけつまずきやすいのが<b>Number.Round</b>の既定の丸め方です。Excelの<code>ROUND</code>関数は「0.5はすべて切り上げる四捨五入」ですが、M言語の<code>Number.Round</code>は既定で「0.5をちょうど中間としたとき、最も近い<b>偶数</b>に丸める」<b>銀行家丸め</b>を採用しています。そのため<code>Number.Round(2.5, 0)</code>は3ではなく2になり、<code>Number.Round(3.5, 0)</code>は4になります。Excelと同じ四捨五入の挙動にしたい場合は、第3引数に<code>RoundingMode.AwayFromZero</code>を明示的に指定する必要があります。この違いを知らずに金額を丸めると、Excelで作った検算資料と1円単位でズレる典型的な原因になります。</p>
<p class="tip">💡 実務メモ: Date.DayOfWeekの第2引数を省略したときの週の始まりの曜日は、実行環境のカルチャ(ロケール)設定に依存します(ja-JP/en-USでは既定で日曜=0)。Desktop/Serviceなど環境が変わると既定値が変わり得るため、事故を防ぐには第2引数でDay.SundayやDay.Mondayを常に明示するのが安全です。</p>`,
      exercises: [
        {
          type: "mc",
          q: "Number.Round(2.5, 0) を評価した結果として正しいものはどれですか?",
          code: "Number.Round(2.5, 0)",
          lang: "m",
          c: ["2(既定では0.5を四捨五入せず、最も近い偶数に丸める「銀行家丸め」のため)", "3(Excelと同じ四捨五入で切り上がるため)", "2.5(丸められず元の値のまま返る)", "エラーになる(桁数に0は指定できない)"],
          a: 0,
          e: "M言語のNumber.Roundは既定で銀行家丸め(最も近い偶数への丸め)を採用しており、2.5は3ではなく2になります。Excelと同じ四捨五入にしたい場合はRoundingMode.AwayFromZeroを明示する必要があります。"
        },
        {
          type: "mc",
          q: "Date.EndOfMonth(#date(2026, 7, 16)) を評価した結果として正しいものはどれですか?",
          code: "Date.EndOfMonth(#date(2026, 7, 16))",
          lang: "m",
          c: ["#date(2026, 7, 31)(渡した日付が属する月の末日)", "#date(2026, 8, 16)(1か月後の同じ日)", "#date(2026, 8, 1)(翌月の1日)", "#date(2026, 12, 31)(その年の最終日)"],
          a: 0,
          e: "Date.EndOfMonthは引数の日付が属する月の末日を返します。2026年7月は31日まであるため、結果は2026年7月31日になります。"
        },
        {
          type: "mc",
          q: "Date.DayOfWeek(#date(2026, 7, 16), Day.Sunday) の戻り値として正しいものはどれですか?(2026年7月16日は木曜日です)",
          code: "Date.DayOfWeek(#date(2026, 7, 16), Day.Sunday)",
          lang: "m",
          c: ["4(Day.Sundayを指定したので日曜日を0として数え、木曜日は4になる)", "3(Day.Sundayを指定したので月曜日を0として数え、木曜日は3になる)", "\"Thursday\"という曜日名の文字列", "1〜7の数値で表され、木曜日は5になる"],
          a: 0,
          e: "Date.DayOfWeekの第2引数にDay.Sundayを指定すると、日曜日を0として0〜6の数値を返します。2026年7月16日は木曜日なので、日=0, 月=1, 火=2, 水=3, 木=4と数えて4が返ります。第2引数を省略した場合の既定値は実行環境のカルチャに依存するため、環境差の事故を防ぐには常に明示するのが安全です。"
        },
        {
          type: "mc",
          q: "2つの日付の差(終了日 - 開始日)から、経過日数を整数として取り出すM式として正しいものはどれですか?",
          c: ["Duration.Days(終了日 - 開始日)", "Date.Days(終了日 - 開始日)", "Duration.TotalDays(終了日, 開始日)", "終了日 - 開始日 と書くだけで自動的に整数の日数になるため、これ以上の関数は不要である"],
          a: 0,
          e: "2つの日付を引き算するとduration型の値になり、その日数部分を整数として取り出すにはDuration.Daysを使います。受注日から納品日までの日数を求める計算の定番パターンです。"
        },
        {
          type: "fill",
          q: "次のM式の空欄を埋めて、切り上げと剰余(割り算の余り)を求める式を完成させてください。",
          lang: "m",
          code: "切り上げ = 【0】(2.1, 0)\n余り = 【1】(7, 3)",
          bank: ["Number.RoundUp", "Number.Mod", "Number.Round", "Number.RoundDown"],
          answers: [0, 1],
          e: "Number.RoundUpは正の無限大方向(大きい方)へ切り上げる関数で、負数では-2.1→-2のように0に近づく点に注意が必要です。Number.Modは割り算の余りを返す関数です。どちらも銀行家丸めのNumber.Roundとは異なる、明確なルールで丸める関数です。"
        },
        {
          type: "type",
          q: "日付 2026年7月16日 の1か月後の日付を求めるM式を、Date.AddMonthsを使って書いてください。",
          lang: "m",
          answer: "Date.AddMonths(#date(2026, 7, 16), 1)",
          hint: "Date.AddMonthsの第1引数に日付、第2引数に加算する月数を渡します。",
          e: "Date.AddMonthsは日付に指定した月数を加算(負数なら減算)する関数です。締め日や更新日など「1か月後」を求める計算の基本形です。"
        }
      ]
    },
    {
      title: "型変換とロケール",
      doc: `
<p>取引先から届いたCSVファイルを読み込んだら、日付列が文字列のまま残っていたり、"1/2/2026"という日付が思っていたのと違う月日に変換されていたりして、慌てて確認した経験はないでしょうか。原因の多くは、型変換に使われる<b>ロケール(文化圏)</b>の解釈違いにあります。</p>
<p>列の型を一括で変更するのは<b>Table.TransformColumnTypes(テーブル, {{列名, 型}, ...}, ロケール)</b>です。第3引数のロケール(例: <code>"en-US"</code>や<code>"ja-JP"</code>)は省略可能ですが、これを省略するとPCの既定設定(Windowsの地域設定)に従って日付や数値の文字列が解釈されます。<code>"1/2/2026"</code>という表記は、月/日/年の順で読む<code>"en-US"</code>では2026年1月2日、日/月/年の順で読むロケールでは2026年2月1日と、まったく別の日付になってしまいます。この曖昧さを解消するには、Table.TransformColumnTypesの第3引数でロケールを明示するか、UIの「データ型の変更」メニューから「ロケールを使用」を選んで変換します。</p>
<pre>Table.TransformColumnTypes(売上, {{"日付", type date}}, "en-US")
    // "1/2/2026" → #date(2026, 1, 2) と解釈(月/日/年の順)

Table.TransformColumnTypes(売上, {{"日付", type date}}, "ja-JP")
    // 日付の表記順の解釈がロケールごとに変わる

Table.TransformColumnTypes(売上, {{"数量", Int64.Type}, {"金額", type number}})</pre>
<p>型変換に失敗するケースにも注意が必要です。たとえば数量列に"N/A"のような数値化できない文字列が混じっていた場合、Table.TransformColumnTypesは<b>クエリ全体を止めてしまうわけではありません</b>。変換できなかったセルにだけError値が入り、他の行はそのまま正しく変換されます。エラーが入った行は、後で列見出しの「エラーの削除」やTable.SelectRowsで個別に対処できます。通貨記号(¥や$)や桁区切りのカンマが混じった文字列を数値に変換したいときも、まずTable.TransformColumnTypesで直接型変換を試み、失敗するようであればText.Replaceなどで記号を取り除いてから変換する、という2段構えが安全です。</p>
<p class="tip">💡 実務メモ: 海外の取引先データや、Windowsの地域設定が異なる同僚のPCで作ったクエリを開くと、日付の解釈が変わって列全体がエラーになることがあります。日付や数値のTable.TransformColumnTypesには、可能な限りロケールを明示しておくと事故を防げます。</p>`,
      exercises: [
        {
          type: "mc",
          q: "Table.TransformColumnTypes(売上, {{\"日付\", type date}}, \"en-US\") における第3引数 \"en-US\" の役割として正しいものはどれですか?",
          code: "Table.TransformColumnTypes(売上, {{\"日付\", type date}}, \"en-US\")",
          lang: "m",
          c: ["テキストを日付や数値に解釈する際の基準となるロケール(文化圏)を指定し、\"1/2\"のような曖昧な表記の解釈方法を決める", "変換後にレポート画面へ表示する言語をアプリ全体で切り替える", "この引数は列名を指定しており、実質\"en-US\"という名前の列を対象にしている", "この引数は無視され、常にPCの既定ロケールが優先される"],
          a: 0,
          e: "第3引数のロケールは、日付や数値の文字列表記(月日の順序、小数点記号など)をどの文化圏のルールで解釈するかを指定します。ロケールを省略するとPCの既定設定に依存してしまい、環境によって結果が変わる原因になります。"
        },
        {
          type: "mc",
          q: "テキスト \"1/2/2026\" を日付型に変換する際、ロケールによって解釈が異なる理由として正しいものはどれですか?",
          c: ["ロケールによって日付の並び順(月/日/年なのか、日/月/年なのか)の既定ルールが異なるため、同じ表記でも違う日付と解釈されうる", "ロケールは日付の解釈には一切影響せず、\"1/2/2026\"は常に同じ日付になる", "\"1/2/2026\"はどのロケールでも変換に失敗し、必ずエラーになる", "ロケールは通貨記号の表示だけに影響し、日付の解釈には無関係である"],
          a: 0,
          e: "月/日/年の順で読むロケールと日/月/年の順で読むロケールでは、\"1/2/2026\"がそれぞれ1月2日・2月1日という別の日付に解釈されます。この曖昧さこそが「1/2/2026問題」と呼ばれる典型的な落とし穴です。"
        },
        {
          type: "mc",
          q: "Table.TransformColumnTypesで数量列を数値型に変換しようとしたところ、一部の行に\"N/A\"のような変換できない値がありました。この場合の挙動として正しいものはどれですか?",
          c: ["変換できない行のセルにだけError値が入り、他の行はそのまま変換された値になる(クエリ全体が即座に失敗するわけではない)", "クエリ全体が即座に失敗し、テーブルのプレビューを一切開けなくなる", "変換できない値は自動的に0に置き換えられる", "変換できない値を含む列全体が自動的に削除される"],
          a: 0,
          e: "Table.TransformColumnTypesの変換エラーは行(セル)単位で発生し、他の行の変換結果には影響しません。エラーが入った行だけを見つけて個別に修正・除外できる設計になっています。"
        },
        {
          type: "fill",
          q: "「日付」列をロケール\"en-US\"を指定して日付型に変換するM式の空欄を埋めてください。",
          lang: "m",
          code: "Table.TransformColumnTypes(売上, {{\"日付\", 【0】}}, 【1】)",
          bank: ["type date", "\"en-US\"", "type text", "\"date\""],
          answers: [0, 1],
          e: "第2引数のリストには{{列名, 型}}という形で目的の型(ここではtype date)を指定し、第3引数にロケール文字列を渡します。型は文字列ではなくtype dateのようなキーワードで書く点に注意してください。"
        },
        {
          type: "type",
          q: "「数量」列を整数型(Int64.Type)に変換するM式を、Table.TransformColumnTypesを使って書いてください(対象テーブルは売上)。",
          lang: "m",
          answer: "Table.TransformColumnTypes(売上, {{\"数量\", Int64.Type}})",
          hint: "第2引数は{{列名, 型}}という形のリストです。整数型はInt64.Typeという定数で表します。",
          e: "Table.TransformColumnTypesの第2引数に{{\"数量\", Int64.Type}}を渡すことで、数量列を整数型に一括変換できます。Int64.Typeは型を表す定数で、文字列ではない点がポイントです。"
        }
      ]
    }
  ]
});
