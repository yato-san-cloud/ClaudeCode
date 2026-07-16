# UI/実装契約書 — Power BI 道場 v2

## 成果物とビルド構成
| ファイル | 担当 | 内容 |
|---|---|---|
| src/style.css | シェル | 全スタイル(トークン方式・両テーマ) |
| src/body.html | シェル | bodyの中身のみ(`<div id="app">`等。html/head/script タグ禁止) |
| src/app.js | シェル | 状態管理・全画面・ゲーミフィケーション |
| src/editor.js | エディター | ハイライター+エディター+判定 |
| src/units/unit01..10.js | コンテンツ | 教材データ |

`node build.js` が次の順で単一 index.html に結合する:
`<style>style.css</style>` → body.html → `<script>` editor.js → units(番号順) → app.js `</script>`
よって **app.js は window.DojoEditor と window.DOJO_UNITS の存在を前提にしてよい**。

禁止事項: 外部リソース参照(CDN/Webフォント/画像URL)、document.write、文字列中の `</script`。
必須対応: ライト/ダーク両テーマ(CSSカスタムプロパティをトークンにし、`@media (prefers-color-scheme: dark)` と `:root[data-theme="dark"]` / `:root[data-theme="light"]` の両方で上書き)、モバイル390px、`prefers-reduced-motion` 尊重、キーボードフォーカス可視。

## グローバル契約

### window.DOJO_UNITS
各unitファイルがpushする配列。スキーマは spec/SCHEMA.md。

### window.DojoEditor(editor.js が定義)
```js
DojoEditor.highlight(code, lang)  // -> HTML文字列。エスケープは内部で実施。
   // span class: tok-kw(キーワード) tok-fn(関数) tok-str(文字列) tok-num(数値) tok-com(コメント) tok-pun(記号)
   // lang: "m" | "dax"。M: let,in,each,if,then,else,try,otherwise,type,as,and,or,not,true,false,null,#date系。
   //        関数は Text.Upper / Table.SelectRows 等 `大文字始まり.名前(` パターン。
   // DAX: VAR,RETURN,TRUE,FALSE,BLANK,IN,NOT 等 + `大文字英字列(` を関数扱い。メジャー/列参照[...]は tok-fn 系の色でよい。
DojoEditor.mount(el, {lang, value = "", onInput})
   // -> { getValue(), setValue(v), focus(), el }
   // 実装: 透明textarea を ハイライト表示pre に重ねる方式。スクロール同期。
   // Tabキーで空白2つ挿入(フォーカストラップしない: Escで解除等の配慮)。入力のたび再ハイライト。
   // 自動高さ(最低3行)。日本語IME入力と全角文字で崩れないこと(等幅フォント+同一metrics)。
DojoEditor.normalize(code)
   // 全角英数記号→半角、全角スペース→半角、「”“』『」等の引用符→"、trim、連続空白圧縮、
   // ()[]{}=,*+-/<>&^ の前後空白除去、小文字化。改行は空白扱い。
DojoEditor.check(user, answer, accept = [])
   // -> { ok: boolean, closeness: 0..1 }  ok = normalize後にanswerまたはacceptのどれかと一致。
   // closeness はレーベンシュタイン距離ベース(1 - dist/maxLen)。
```

### window.Dojo(app.js が定義・テスト用フック)
最低限 `{ state, save(), startLesson(unitIdx, lessonIdx), startDaily(), startReview(), session, answerMC(i), submitFill(), submitType(), next(), goHome() }` を公開する(内部実装の呼び出しでよい)。

## 画面仕様(app.js)

### 1. パス画面(ホーム)
- 上部固定バー: 🔥ストリーク / ⭐XP / 帯 / デイリー目標の進捗リング(SVG円弧)。
- アクション行: 「⚔️ 今日の配送便」(デイリー5問・XP2倍・1日1回) / 「📝 弱点復習(n問)」/ 「👤 プロフィール」/ 「⚙️ 設定」。
- **Duolingo風スキルパス**: ユニットごとに色付きセクションヘッダー(unit.color使用)、その下にレッスンノード(大きな丸ボタン)を左右に蛇行配置(translateXを -60/0/+60px などで交互に)。
  - ノード状態: 🔒ロック / 挑戦可(パルスアニメ) / クリア済み(★1〜3を下に表示。正答率50%以上★1、80%以上★2、100%★3)。
  - 解放条件: 直前レッスン★1以上。ユニットも順に解放(前ユニット全レッスン★1以上)。
  - クリア済みレッスンは再挑戦可(★上書きはベスト値)。
- マスコット「ロジ柴」🐕‍🦺 がパス上部で一言(日替わり・状態に応じたセリフ)。

### 2. レッスン画面
解説doc(HTML描画)→「演習へ🎯」ボタン→演習セッション。

### 3. 演習セッション
- ヘッダー: 進捗バー、コンボ表示(🔥×n 連続正解)、中断ボタン(confirm)。
- **mc**: 4択ボタン。回答で正解緑/誤答赤+解説+「次へ」。
- **fill**: codeの【n】をスロット(点線枠チップ)としてコード内にインライン表示。下部にトークンバンク(チップボタン、シャッフル表示)。チップタップ→先頭の空きスロットへ。埋まったスロットタップ→バンクに戻す。全スロット充足で「答え合わせ」活性。判定後: 各スロット正誤色+解説。誤答時は正解コードを表示。
- **type**: 設問+DojoEditor.mount(scaffoldを初期値に)。ボタン: 「答え合わせ」「💡ヒント」(1回のみ。使うとこの問題のXP-5)「白旗🏳️」(答えを表示し不正解扱い)。
  - check().ok=false でも closeness >= 0.85 なら「おしい!タイプミスがないか確認」でノーペナルティ再挑戦(1回まで)。
  - 判定後は正解コードをhighlight表示。
- 正解: ✓ポップ+効果音+コンボ加算。不正解: シェイク+効果音+コンボリセット。解説は常に表示。
- 間違えた問題は弱点キューに登録(qidで管理)。

### 4. 結果画面
正答数、XP内訳(基本+コンボ+ボーナス、ヒント減算)、ストリーク表示、帯昇段演出(あれば)、canvas紙吹雪(reduced-motion時は無効)、ロジ柴の一言、クエスト進捗の更新通知(「🎯クエスト達成!」トースト)。

### 5. プロフィール画面
実績バッジグリッド(獲得はカラー+日付、未獲得はシルエット+条件文)、統計(総回答数・type正解数・パーフェクト数・ユニット別進捗バー)。

### 6. 設定
サウンドON/OFF、デイリー目標(30/60/100XP)、データリセット(confirm 2段階)。

## ゲーミフィケーション仕様
- XP: mc=10, fill=15, type=20。セッション内コンボ: 3連続正解以降1.5倍、5連続以降2倍(切り上げ)。ヒント使用は該当問題-5。
- ボーナス: レッスン初クリア+20 / セッション全問正解+15 / デイリーは全XP2倍+全問正解でさらに+30。
- 帯: 白0 → 黄150 → 橙400 → 緑800 → 青1400 → 紫2200 → 茶3200 → 赤4500 → 黒6000 → 師範8000。
- ストリーク: 学習日(XPを1以上獲得した日)が連続。**ストリークフリーズ**(最大2保持): 1日休んでもフリーズ自動消費で連続維持(消費ログを結果画面かパスで通知)。クエスト報酬で入手。
- **デイリークエスト**: 毎日3件。日付文字列の単純ハッシュでプールから決定的に選出。例プール: XP60稼ぐ/レッスン2つクリア/type3問正解/fill4問正解/コンボ5達成/復習1回/全問正解クリア1回。報酬XP+20〜40、一部クエストはフリーズ+1。3件コンプでさらに+30。パス画面に進捗表示。
- **実績バッジ**(16種以上、app.js内定義): 初レッスン / 7日連続 / 30日連続 / 100日連続 / type50問正解 / fill50問正解 / パーフェクト10回 / 1ユニット全★3 / 全ユニットクリア / 師範到達 / 深夜の修行(22時以降にセッション完了) / 朝練(7時前) / 週末戦士(土日両方学習) / 総回答500問 / デイリー30回 / v1引継ぎ「道場生え抜き」。
- **ロジ柴のセリフプール**(20本以上): 褒め・励まし・物流豆知識(「積載率が10%上がると便数は約1割減らせるぞ」等)を状況別(正解時/不正解時/結果/日替わり)に。
- 効果音: WebAudio APIで合成(正解=短い上昇2音、不正解=低い1音、レベルアップ/昇段=ファンファーレ、セッションクリア=ジングル)。初回ユーザー操作後にAudioContext生成。設定でミュート。
- 保存: localStorage key `pbdojo_v2`(JSON)。**v1移行**: 初回起動時に `pbdojo_v1` があれば xp を加算・streak/best を引継ぎ、バッジ「道場生え抜き」を授与し、移行済みフラグを立てる。

## デザイントークン(style.css)
世界観 =「道場 × 物流現場」。ライト: 生成り紙 `#f5f2ea` 地 / 墨 `#26241f` / アクセント=安全ベスト橙 `#e8641b` / サブ=フォークリフト黄 `#f2b705` / 成功 `#2f8f46` / 失敗 `#c2452d`。ダーク=夜間配送: `#15140f` 地、アクセントは輝度を上げて維持。
- ボタンはDuolingo風「押し込み」: `border-bottom: 4px solid 濃色` + `:active { transform: translateY(2px); border-bottom-width: 2px }`。角丸14px。主要CTAはアクセント塗り。
- レッスンノード: 直径64px前後の丸、unit.colorで塗り、下辺の濃色で立体感。ロックはグレー。
- コード表示: 地 `#14161c`、tok-kw `#7cb0ff` / tok-fn `#ffd479` / tok-str `#9ece6a` / tok-num `#f2955e` / tok-com `#6a7387` / tok-pun `#8b93a8`。ライトテーマでもコードブロックは濃色地のまま(可読性優先)。
- フォント: 和文システムスタック。コードは `ui-monospace, "SF Mono", Consolas, monospace`。
- 数値表示(XP等)は `font-variant-numeric: tabular-nums`。

## セキュリティ/品質
- 教材データ(q/c/bank/code等の生テキスト)をHTMLに入れる際は必ずエスケープ関数を通す(docフィールドのみ信頼済みHTMLとして直接描画可)。
- 起動時にDOJO_UNITSをno順ソート。ユニット欠落(10未満)でも壊れず動く。
- 例外で白画面にならないよう、起動処理をtry/catchし最低限のエラーメッセージを表示。
