# PORT_NOTES — fable5-optimizer の Copilot Studio 移植メモ

移植元: `/root/.claude/skills/synced/fable5-optimizer/`（SKILL.md ＋ references 2本）
移植先: Microsoft Copilot Studio エージェント（`.mcs.yml`、VS Code Copilot Studio 拡張 ＋ microsoft/skills-for-copilot-studio プラグインで push）
想定利用者: 日本の営業・業務部門（Teams から相談）
作成日: 2026-08-20

---

## 0. 成果物の一覧

| ファイル | 役割 |
|---|---|
| `agent.mcs.yml` | エージェント本体。instructions（日本語、2,058字）、会話スターター、モデル指定 |
| `settings.mcs.yml` | 生成オーケストレーションの有効化、言語、認証。**schemaName はプレースホルダ**（後述） |
| `topics/Greeting.topic.mcs.yml` | 会話開始時のあいさつ。答え方の型を最初に宣言する |
| `topics/ClassifyConsultation.topic.mcs.yml` | **中核**。相談を3レイヤーに分類し、宣言してから回答に入る決定的トピック |
| `topics/EffortAdvisor.topic.mcs.yml` | タスク像から推奨 effort と一行理由を決定的に返す |
| `knowledge/fable5-prompt-optimization.md` | references/fable5-prompting.md をナレッジ検索向けに再構成 |
| `knowledge/token-cost-optimization.md` | references/token-optimization.md をナレッジ検索向けに再構成 |

YAML 4本は、プラグイン同梱の検証コマンドで検証済みです。

```bash
cd /workspace/microsoft/skills-for-copilot-studio
node scripts/schema-lookup.bundle.js validate <ファイル>
```

結果は `agent.mcs.yml` が 8 PASS / 0 FAIL、トピック3本が 11〜12 PASS / 0 FAIL でした
（`kind` の実在、必須プロパティ、ノード ID の一意性、`inputs` と `inputType.properties` の整合、
Power Fx の接頭辞、変数スコープ、`_REPLACE` の残りをすべてチェック）。

`settings.mcs.yml` だけは `[FAIL] No 'kind' property found at root level` が出ますが、
**これは検証コマンドの既知の癖**です。プラグイン自身の評価用フィクスチャ
（`evals/fixtures/basic-agent/settings.mcs.yml` など）も同じ FAIL を出します。
settings ファイルはルートに `kind` を持たないのが正しい形なので、この FAIL は無視してください。

---

## 1. 設計判断

### 1-1. スキルの「型」をどう保証したか — 決定的レイヤーに逃がした

元スキルの中心は「**状況を分類してから、根拠つきで具体的な貼れる文言を出す**」という動き方です。
Copilot Studio の生成オーケストレーションは非決定的なので、これを instructions だけに書くと守られない回が出ます。
そこで型を二重化しました。

- **決定的レイヤー（トピック）**: `ClassifyConsultation` が分類を担当します。
  `AutomaticTaskInput`（patterns/orchestrator-variables.md の手法）でオーケストレーターに
  `Prompt` / `Api` / `ClaudeCode` / `Unknown` の4値を埋めさせ、`ConditionGroup` で分岐し、
  「このご相談は◯◯として扱います」＋そのレイヤーの上位レバーを**必ず送信**します。
  分類は既存のオーケストレーター呼び出しに相乗りするので、追加コストもレイテンシもありません。
  `Unknown` のときだけ `Question` ノードで2点確認します（元スキルのケースD をそのまま移植）。
- **生成レイヤー（instructions）**: 分類の宣言後、レバーの根拠づけと「貼れる文言」の生成を担当します。
  instructions 冒頭に「応答の型（必ずこの順で守る）」として4ステップを固定しました。

`EffortAdvisor` も同じ考え方です。元スキルには「プロンプトや設定を提案するときは必ず推奨 effort と
一行理由を添える」という強い約束があり、生成任せだと落ちやすいので、
タスク像 → 推奨 effort ＋ 理由 の対応表をトピックの分岐として固定しました。

### 1-2. Claude 固有である点をどう扱ったか — 「主軸は維持、汎用部分だけ明示的に開放」

**判断: Claude / Fable 5 利用者向けアドバイザーとして、対象を一般化せずそのまま出す。**
理由は、このスキルの価値の大半（effort の段数、`budget_tokens` が 400 エラーになること、
プロンプトキャッシュの並び順、`/context` や `/compact` の使いどき、`reasoning_extraction` の
拒否応答）が **Claude 固有の挙動と課金構造に強く結びついている**ためです。
「LLM 一般のプロンプト最適化」に薄めると、助言が「短く書きましょう」レベルに落ちて元スキルの強みが消えます。

ただし、Teams で使わせる以上「Copilot Studio のエージェント指示文も直してほしい」という相談は必ず来ます。
そこで instructions に一節だけ追加しました。

- 「過剰指示を削る」「短い一文で方向づける」「変わらない情報を前に置く」という**考え方の部分は
  Copilot Studio の指示文設計にも転用してよい**、と明示的に許可する。
- ただし **effort 設定・プロンプトキャッシュ・`/context` は Claude 固有の機能で
  Copilot Studio には存在しないことを必ず言う**、と義務づける（誤適用の防止がここでの本題）。

### 1-3. ナレッジ資料の再構成方針

`skills/add-knowledge/knowledge-guide.md` の指針（意味検索でチャンクに切られる／見出しが引用の単位になる／
表ばかりの文書は回答品質が落ちる）に合わせて、reference 2本を次のように書き換えました。

- **大きな表を見出し付きの節に展開**しました。特に「トークンキラー」の8行表は
  `### 4-1. CLAUDE.md の肥大`〜`### 4-9.` の症状／対策形式に分解しています。表のままだとチャンクが壊れて引けません。
- **各節を自己完結**させました。冒頭に「要点:」を置き、上位見出しの文脈が失われても意味が通るようにしています。
- **見出しに検索語を入れました**（effort、プロンプトキャッシュ、CLAUDE.md、拒否応答、/compact など）。
- 元資料の英語混じり・記号圧縮（矢印つなぎ、`→`、箇条書きの断片）を**平文の日本語**に開きました。
  営業・業務部門が読む前提であり、かつ元スキル自身が「最終メッセージは矢印チェーンを使わず完全な文で」と
  説いているので、その原則を資料自体にも適用しています。
- 「貼れる文言」のコードブロックは**そのまま残しました**。ここが成果物の実体なので削っていません。

### 1-4. instructions の分量

`skills/edit-agent/instructions-guide.md` に沿い、役割・応答の型・早見・アンチパターン・
根拠と限界（グラウンディング、断言しない、見つからないときの案内）の構成にしました。
**2,058字**で、上限8,000字に対して十分に短く保っています。
詳細は全部ナレッジ側に逃がしています（元スキルが progressive disclosure でやっていたことの再現）。

`patterns/date-context.md` を採用し、`{Text(Today(),DateTimeFormat.LongDate)}` を入れました。
このスキルは「料金や閾値は陳腐化するので断言せず公式を見よ」と言うのが仕事なので、
今日の日付を持っている方が注意喚起の精度が上がります。

---

## 2. Claude 版との差分

### 2-1. できないこと（Copilot Studio の制約）

| 元スキルの動き | Copilot Studio 上では |
|---|---|
| `/context` `/usage` `/memory` を実行して内訳を見る | **できない**。エージェントは「実行して結果を貼ってください」と案内するだけ。instructions にその案内を明記済み |
| リポジトリを grep して `reasoning_extraction` を誘発する表現を探す | **できない**。コード実行不可。監査は Claude Code 側に残す |
| CLAUDE.md や Skill ファイルを実際に読んで書き換える | **できない**。利用者が本文を貼り付ける前提。貼られたテキストへの助言はできる |
| `ccusage` で消費内訳を出す | **できない**。コマンドの案内のみ |
| 参照ファイルへ誘導する（progressive disclosure） | 形が変わる。ナレッジ検索が自動で該当チャンクを引くので「ファイルを読みに行け」という誘導は消し、instructions を早見表に寄せた |

### 2-2. 簡略化したこと

- **応答テンプレ（ケースA〜D）を instructions の「応答の型」4ステップに圧縮**しました。
  テンプレ4本をそのまま入れると instructions が長くなり、かつ生成の自由度を削って不自然になります。
  ケースD（曖昧なとき2点確認）だけは重要なので、テキストを `ClassifyConsultation` の
  `Question` ノードに移し、決定的に実行されるようにしました。
- **判定フロー図（ASCII の分岐図）を落としました**。分岐そのものはトピックの `ConditionGroup` になったので、
  図で説明する必要がなくなっています。
- **`Global` 変数による分類の会話跨ぎ保持を見送りました**（理由は 4-1 の論点1）。
  現状は分類結果を会話ログ上のメッセージとして残す形で代替しています。
  オーケストレーターは会話履歴を読むので、実用上は枠組みが維持されます。
- **ボタン UI（選択肢つき質問）にしませんでした**。確認質問は `StringPrebuiltEntity` の自由入力です。
  閉じたリスト（`ClosedListEntity`）にすると Teams でボタンが出て親切ですが、
  選択値の比較式（表示名で比較するのか、レコードのプロパティで比較するのか）が
  テンプレートからは確定できませんでした。実機で確認できてからの改善項目とします（4-2）。

### 2-3. ハイブリッドで Claude Code 側に残すもの

Copilot Studio エージェントは「相談窓口・判断の入口」に徹し、**手を動かす作業は Claude Code 側に残す**構成です。

- 既存 Skill / システムプロンプトの**実ファイル監査と書き換え**（fable5-optimizer スキル本体の仕事）
- `/context` `/usage` の**実行と、その結果に基づく実際の削減作業**
- `.claudeignore` の作成、CLAUDE.md の分割と Skill 化
- API 実装での `cache_control` の実配置とヒット率の計測

Teams のエージェントは、この作業の**前段（どのレバーを引くべきかの判断）と、貼れる文言の供給**を担当します。
運用としては「Teams で方針と文言をもらう → Claude Code で当てる」という往復を想定しています。

---

## 3. テナントへ push するときの注意

### 3-1. 推奨手順

1. **Copilot Studio の UI で先にエージェントを新規作成**します（言語は**日本語**を選択）。
   YAML から新規作成するのではなく、既存エージェントに差分を当てる形が安全です。
2. VS Code の Copilot Studio 拡張でそのエージェントを **pull** し、ローカルにフォルダを作ります。
3. pull したフォルダに、本ディレクトリの内容を次のように反映します。
   - `agent.mcs.yml` の `instructions` / `conversationStarters` / `displayName` を差し替え
   - `mcs.metadata.componentName`（本ファイルの `Fable5PromptAdvisor` は仮の値）は **pull 側の値を優先**する
     （不一致だと別コンポーネント扱いになり得ます）
   - `topics/` の3ファイルをコピー（pull 側に既定の Greeting トピックがある場合、`OnConversationStart` が
     二重にならないよう置き換えるか既存側を削除する）
   - `settings.mcs.yml` は**丸ごと上書きしない**。pull した側の `schemaName` と `language` を正とし、
     `configuration.settings.GenerativeActionsEnabled: true` と
     `configuration.recognizer.kind: GenerativeAIRecognizer` だけを合わせます。
4. **ナレッジ2本を UI から手動アップロード**します（YAML では作れません。3-3 参照）。
5. push します（**push の前に必ず `pull` する**。しないと `ConcurrencyVersionMismatch` が出ます）。
6. **push は下書きです。** Copilot Studio の UI で**公開（Publish）**しないと、テストパネルにもチャネルにも
   反映されません。公開してからテストパネルで 3-4 の観点を確認します。
7. Teams チャネルへ公開します（チャネル追加の前にも最低1回の公開が必要です）。

### 3-2. `settings.mcs.yml` の `REPLACE_SCHEMA_PREFIX` は必ず置換すること

`schemaName` は Power Platform の内部識別子で、**テナント側で採番された実際の値**でなければなりません。
本ファイルの `REPLACE_SCHEMA_PREFIX` はプレースホルダです。pull したファイルの値をそのまま使ってください。
プラグインの `skills/edit-agent` にも「`schemaName` は変更するとエージェントが壊れる」と明記されています。

`language: 1041`（日本語）も同様で、**UI で作成したエージェントの言語と一致していなければなりません**。
言語の変更はエージェントを壊しうるので、作成時に日本語を選んでおくのが前提です。

### 3-3. ナレッジのアップロード

- `knowledge/*.md` は **UI の「ナレッジ」からファイルアップロード**します（アップロードファイル形式は YAML で定義できず、UI 専用です）。
- **`.md` 拡張子は受け付けられない可能性があります。** 中身は Markdown のまま、
  **`.txt` にリネームしてアップロード**するのが安全です
  （プラグインの jit-glossary パターンにも「CSV は `.txt` として保存する」という同種の注意があります）。
  `.docx` に変換しても構いません。その場合は見出しレベルを保ってください（引用の単位が見出しなので）。
- 2本は**内容が重複しないように分けてあります**。同じ話題を両方に入れると関連度のランキングが壊れます。
- アップロード後、**代表的な質問で検索できるか必ず確認**してください。例:
  「effort はどれにすべき」「プロンプトキャッシュの並び順」「CLAUDE.md が重い」
  「reasoning_extraction」「/compact はいつ使う」

### 3-4. push 後に確認すること

1. `ClassifyConsultation` が**呼ばれるか**。「トークンを減らしたい」「この指示文を直したい」など
   複数の言い回しで、冒頭に分類の宣言が出るか確認します。
   呼ばれない場合は `modelDescription` に利用者の実際の言い回しを足してください。
2. `AutomaticTaskInput` の**分類精度**。`Unknown` に落ちすぎる場合は、`inputs` と `inputType.properties`
   両方の `description` を同じ内容で直します（片方だけ直すと不整合になります）。
3. `EffortAdvisor` と `ClassifyConsultation` が**取り合いにならないか**。
   effort の質問で分類トピックが出るようなら、`modelDescription` の書き分けを強めます。
4. `Greeting`（`OnConversationStart`）は、**M365 Copilot など一部の埋め込み面では発火しません**。
   Teams では通常発火しますが、発火しない面では `conversationStarters` が入口になります。
5. 生成オーケストレーションが**オンになっているか**（`GenerativeActionsEnabled: true`）。
   オフだと `intent: {}` のトピックはどちらも呼ばれません。ここが最も詰まりやすい箇所です。

### 3-5. モデルと認証

- `aISettings.model.modelNameHint` は `GPT5Chat`（テンプレート既定）にしてあります。
  テナントで Anthropic モデルが選べるなら、`modelNameHint: Sonnet46` ＋ `provider: Anthropic` に
  変更する選択肢があります。**`model` ブロックに `kind` を書かないこと**（プラグインの edit-agent に明記あり）。
- `authenticationMode: Integrated` にしてあります。社内限定利用を想定した既定です。
  このエージェントはコネクタを一切呼ばず利用者情報も読まないので、
  テナントの公開フローで支障が出るなら `None` でも動作します。

---

## 4. 未解決の論点

### 4-1. 分類結果をグローバル変数で会話跨ぎに保持するか

`patterns/orchestrator-variables.md` の手本では分類結果を `Global.<名前>` に入れ、
instructions から `{Global.<名前>}` で参照して枠組みを維持しています。これは本来やりたい形です。
ただし **グローバル変数コンポーネントのファイル形式が、プラグインのテンプレートとスキーマで食い違います**。

- `templates/variables/global-variable.variable.mcs.yml` と `skills/add-global-variable/SKILL.md`:
  フラット形式（`name` / `aIVisibility` / `scope` / `defaultValue` をトップレベルに置く）
- `reference/bot.schema.yaml-authoring.json` の `GlobalVariableComponent`:
  `variable` オブジェクトのネストを要求し、`name` や `aIVisibility` などのトップレベル指定を拒否する

どちらが VS Code 拡張の受け付ける形か、この環境では確定できませんでした。
また `schemaName` にテナント固有のプレフィックスが必要で、置換漏れの事故要因にもなります。
**今回は採用を見送り**、分類結果はトピック内の `Topic.SoudanLayer` と、送信済みメッセージ（会話履歴）で保持しています。
実機で正しい形式が確認できたら、以下を足すのが改善案です。

- `variables/SoudanLayer.variable.mcs.yml`（`aIVisibility: UseInAIContext`）
- `ClassifyConsultation` に `SetVariable`（`Global.SoudanLayer`）を追加
- instructions に `{Global.SoudanLayer}` を**1箇所だけ**参照（複数箇所に書くと毎回のオーケストレーター呼び出しに
  値が重複して載り、トークンが増えます。jit-glossary パターンの注意点）

### 4-2. 確認質問をボタン UI にするか

現在は自由入力です。Teams の業務部門利用者には選択肢ボタンの方が親切なので、
`EmbeddedEntity` ＋ `ClosedListEntity`（スキーマ上は妥当）への変更が候補です。
ただし選択後の分岐条件の書き方（表示名の文字列比較でよいのか）がテンプレートからは確定できませんでした。
実機で1本試してから広げるのが安全です。

### 4-3. ナレッジを引かせるタイミングを固定するか

現在は自動検索（オーケストレーター任せ）です。
「レバーの根拠が毎回ナレッジから引かれること」を保証したいなら、
`ClassifyConsultation` の中で `SearchAndSummarizeContent` を明示的に呼び、
分類に応じて検索対象のナレッジソースを絞る手があります（`patterns/orchestrator-variables.md` の
知識ルーティング）。ただし確認質問を挟んだ経路では検索クエリに何を渡すべきかが自明でないため、
今回は入れていません。**まず自動検索で運用し、引きの精度が悪いときに検討**する順序を推奨します。

### 4-4. 元スキルの陳腐化への追随

元スキル自身が「料金・キャッシュ最小長・effort 段数は変わる」と宣言しています。
ナレッジ2本には**料金やキャッシュ最小長といった陳腐化しやすい数値を意図的に入れていません**
（`200行未満`、`40〜50% で /compact`、`breakpoint は最大4つ` のような、判断基準として安定している目安は残しています）が、それでも
「思考は出力トークンとして課金される」「`budget_tokens` は 400 エラー」といった
**構造的な事実**は変わりうります。Claude 側のモデル更新時にナレッジを見直す運用ルールが要ります。
更新の入口を Claude Code 側の fable5-optimizer スキルに一本化し、
そこが変わったらこのナレッジも差し替える、という運用を推奨します。

### 4-5. Teams 公開後の利用状況の測り方

このエージェントの成果は「Claude 側のトークン削減」に出ますが、その効果測定は
Copilot Studio の分析画面には現れません（別システムの数値のため）。
効果を見るなら、Claude Code 側で `ccusage` や `/usage` の推移を別途取る必要があります。
測定の枠組みは未設計です。
