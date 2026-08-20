# warehouse-planner → Copilot Studio 移植メモ

移植元: `/root/.claude/skills/synced/warehouse-planner/SKILL.md`（単一ファイル）
移植先形式: `microsoft/skills-for-copilot-studio` が扱う `.mcs.yml`
作成日: 2026-08-20

## 成果物

| ファイル | 役割 |
|---|---|
| `agent.mcs.yml` | エージェント本体。instructions に判定ロジックと応答の型を格納 |
| `topics/Greeting.topic.mcs.yml` | 会話開始時のあいさつ。役割提示と、判定を早めるための3点の依頼 |
| `topics/ProblemClassification.topic.mcs.yml` | 判定フロー（Q1→Q2→Q3）の決定的実装 |
| `topics/ClaudeHandoff.topic.mcs.yml` | Claude Codeへの依頼文テンプレートの提示 |
| `knowledge/01-classification-guide.md` | 4分類の定義・典型例・ツール・早見表・ヒアリング項目 |
| `knowledge/02-implementation-patterns.md` | 3層構造・探索戦略・近似の対象・アンチパターン・次の一手 |
| `knowledge/03-response-templates.md` | 応答の型4ケース・依頼文の雛形・過去プロジェクトの分類 |

---

## ① 設計判断

### 1. 判定フローだけをトピック（決定的レイヤー）に降ろした

このスキルの中心的価値は「Q1 閉形式 → Q2 確率性 → Q3 最適化か評価か」という**順序のある判定**です。生成オーケストレーションは非決定的で、質問の順番が崩れたり Q2 を飛ばして結論を出したりする恐れがあります。そこで判定フローだけを `ProblemClassification.topic.mcs.yml` に降ろし、`Question` ノード3つ＋`ConditionGroup` で順序を保証しました。

分類が確定したブランチでは `EndDialog` で即座に打ち切り、以降の質問を実行しません。これによりネストを作らず、YAMLがフラットなまま「Q1でYesなら Q2 を聞かない」という分岐を実現しています（キャンバス描画が壊れにくい構成を優先しました）。

### 2. 逆に、対話の柔軟性が要る部分はすべて instructions + ナレッジに残した

ヒアリング、分類理由の言語化、実装戦略の具体化、依頼文の項目埋めは、決め打ちの分岐にすると硬すぎて使い物になりません。ここは instructions（2,047字。上限8,000字に対して十分短く、安定域）とナレッジ検索に任せています。

### 3. 判定に迷った時の既定値を安全側に固定した

Q1「判断できない」→ Q2へ進む（＝「閉形式で書けない」寄り）、Q2「わからない」→ Q3へ進む（＝「ばらつきが左右する」寄り）。ばらつきを無視して外すより、シミュレーション側に倒すほうが実務上の損害が小さい、という判断です。この既定値はトピック内のメッセージでユーザーにも明示しています。

### 4. 選択肢は `EmbeddedEntity` + `ClosedListEntity` のインライン定義にした

`ClosedListEntityReference` を使うと `<エージェントのschemaName>.entity.<名前>` という参照が必要になり、まだ存在しないテナント側のスキーマ名を先に決め打ちする必要が出ます。インラインの `EmbeddedEntity` なら参照が不要で、このリポジトリのYAML単体で自己完結します。

同じ理由で **グローバル変数を一切使っていません**（`Global.*` は `variables/*.variable.mcs.yml` に `schemaName` を書く必要があるため）。判定結果は `Topic.ClosedForm` / `Topic.Stochastic` / `Topic.Goal` というトピック変数に閉じています。

### 5. 選択肢の `id` と `displayName` を同一文字列に揃えた

条件式 `=Topic.ClosedForm = "書ける"` が、変数に入るのが `id` でも `displayName` でも同じように一致するようにするためです。加えて、どの `ConditionGroup` も一致しなければ「次の質問へ進む」だけで済むようにフォールスルー構成にしてあり、万一比較が外れても会話が行き止まりになりません（最終的にシミュレーション系へ倒れます）。

### 6. 採用したパターン / 見送ったパターン

- 採用: `line-breaks-in-messages`（すべてのメッセージで `|-` + `<br />`。日本語の長文が1行に潰れるのを防ぐため、ここは必須と判断）
- 見送り: `date-context` — 解法の分類判定に日付依存はなく、トークンとノイズが増えるだけのため
- 見送り: `jit-glossary` / `orchestrator-variables` — いずれも Global 変数と `schemaName` 参照が前提。上記4の理由で採用せず。将来 `AutomaticTaskInput` で分類を先読みさせる余地は残っています（④参照）

### 7. 出口を「実装依頼文」に固定した

Copilot Studio ではコードを実行できないため、Claude版の「実装まで伴走する」性格は成立しません。そこで出口を **推奨手法 + 実装方針 + Claude Codeへの依頼文テンプレート** の3点に固定し、instructions で「数値を断定しない」「式は示すが計算はしない」を明示しました。依頼文の雛形が欠けた形で渡るのを防ぐため、雛形の提示自体もトピック（決定的レイヤー）に置いています。

---

## ② Claude版との差分

### できないこと

| Claude版でできたこと | Copilot Studio版 |
|---|---|
| Python/Excelでの実際の試算・シミュレーション実行 | **不可**。式と手順を提示するのみ |
| SimPy / OR-Tools のコード生成と実行 | **不可**。依頼文テンプレートを渡してClaude Codeへ引き継ぐ |
| 結果テーブルの生成、HTML/StreamlitのUI作成 | **不可**。3層構造の「設計の提案」までが範囲 |
| ローカルファイル（出荷実績CSV等）の読み込み・分析 | **不可**。ファイル分析を使う場合は別途 `aISettings.isFileAnalysisEnabled` の検討が必要（本移植では未設定） |

### 簡略化したこと

- **応答の型4ケース**（能力値／詰まるか／最適な〜／曖昧）は、instructions に要約を置き、実文例はナレッジ `03-response-templates.md` に逃がしました。instructions を短く保つためです。
- **「近似の対象」の表**（数理最適化＝最適解、シミュレーション＝期待値、シミュレーション最適化＝両方）は instructions から外し、ナレッジのみに置きました。聞かれた時だけ答えれば足りる論点のためです。
- **営業・プランナー視点の補助線**（現場と手法の通訳としての立ち回り）は、エージェントの応答方針としては instructions の「手法の理論を長々と解説しない」に圧縮し、原文はナレッジに残しました。
- **判定フローの「わからない」分岐**は、Claude版には無い追加です。ボタン選択式にすると「該当なし」で詰まるため、Q1〜Q3すべてに明示的な受け皿を作りました（Q3は「わからない」の場合、過剰投資を避けるため安全側の【シミュレーション領域＝まず評価】に倒します）。
- **判定フロートピックは実質オプトイン**です。Q1→Q2→Q3のロジックはinstructionsにも要約されているため、ユーザーが普通に相談した場合はオーケストレーターがinstructionsだけで即答し、トピックは「判定フローを始めて」等の明示起動時のみ発火します。既定経路では非決定的判定のままである点に注意してください（決定的な判定を必須にしたい場合は、instructionsに判定フロートピックへの誘導文を足す改修が必要です）。

### ハイブリッド運用（Claude Code側に残す役割）

想定する運用は次の2段構えです。

```
[Copilot Studio]  現場・営業がその場で相談 → 問題タイプ判定 → 依頼文テンプレート受領
        ↓ 依頼文をコピー
[Claude Code]     warehouse-planner スキルで実装（SimPy / OR-Tools / 結果テーブル / UI）
```

依頼文テンプレートの冒頭を「warehouse-planner スキルを使ってください。」で始めているのは、Claude Code側で同名スキルが確実に起動するようにするためです。**Claude Code側のスキルは削除せず維持してください。** Copilot Studio版は入口（判定と要件整理）専用で、実装能力は移植していません。

---

## ③ テナントへのpush手順の注意

このディレクトリは **クローン済みエージェントのワークスペースではありません**。同梱の `settings.mcs.yml` は参照用（push対象外・他トラックと同じ位置づけ）で、`.mcs/conn.json` も含まれていないため、このままでは push できません。以下の順で進めてください。

1. **先にテナント側でエージェントの器を作る。** Copilot Studio のUIで新規エージェント（例: 倉庫・物流 解法判定アドバイザー）を作成します。
2. **クローンする。** VS Code の Copilot Studio 拡張、または `@copilot-studio:copilot-studio-manage clone` で、そのエージェントをローカルに落とします。`agent.mcs.yml` / `settings.mcs.yml` / `topics/` を含むフォルダができます。
3. **このリポジトリのファイルを重ねる。**
   - `agent.mcs.yml` の `instructions` / `conversationStarters` / `aISettings` を、クローン先の `agent.mcs.yml` にコピーします。**`mcs.metadata.componentName` と `displayName` はクローン先の既存値を優先してください**（テナント側のコンポーネント名と一致させる必要があります。ここに書いてある `WarehousePlanner` は仮の値です）。
   - **`Fallback` / `OnError` などのシステムトピックは同梱していません。** クローン先の既定トピックをそのまま使う前提です（生成オーケストレーション有効時は未知入力もオーケストレーターが処理するため、独自のフォールバックを足すと逆に横取りされます）。ファイルが足りないわけではありません。他の3トラックも同じ方針です。
   - クローン先に既定の Greeting トピックがある場合、`OnConversationStart` が二重にならないよう、置き換えるか既存側を削除してください。
   - `topics/*.topic.mcs.yml` はファイルごとクローン先の `topics/` に置きます。ノードIDはこのリポジトリ内で一意になるよう付番済みですが、**クローン先に既存トピックがある場合はID衝突がないか確認してください**（`sendMessage_wp7ka*` / `*_cl4a*` / `*_hd9b*` の3系統を使っています）。
4. **`settings.mcs.yml` の `GenerativeActionsEnabled` を確認する。** 生成オーケストレーションが有効であることが前提の設計です（トピックの `modelDescription` と `triggerQueries` の両方で選ばれることを想定しています）。無効の場合は `triggerQueries` のみで拾われるため、判定フローが起動しにくくなります。
5. **検証する。**
   ```bash
   node <plugin>/scripts/schema-lookup.bundle.js validate <file>
   node <plugin>/scripts/manage-agent.bundle.js validate --workspace <agent-folder> ...
   ```
   本移植では前者（スキーマ検証）は agent・topics 全4ファイルで pass 済みです。加えて `reference/bot.schema.yaml-authoring.json` に対する JSON Schema 検証も 3トピックすべて エラー0 で通しています。**後者（LSPによる Power Fx とクロスファイル参照の検証）はテナント接続が必要なため未実施です。push 前に必ず実行してください。**
6. **ナレッジは手動アップロードする。** `knowledge/` の3つのMarkdownは、Copilot Studio のUIで「ナレッジ」→ ファイルのアップロードから追加してください。YAMLのナレッジソース（`KnowledgeSourceConfiguration`）は公開Webサイトと SharePoint しかテンプレートが無く、ローカルファイルのアップロードはUI操作になります。
   - **`.md` はアップロード対象の拡張子として受け付けられない可能性があります。** その場合は中身はそのままで拡張子を `.txt` に変えるか、Word（.docx）/ PDF に変換してください（`.csv` は Copilot Studio が別扱いにするため使わないでください）。他トラック（fable5-optimizer / gyomu-flow）と共通の注意です。
   - アップロード後、instructions の「ナレッジの使い方」節が効くよう、`useModelKnowledge` は既定（false）のままを推奨します。分類名やツール名を創作させないためです。
   - アップロード後、「Excel領域とは」「3層構造」「依頼文の雛形」など代表的な質問を数本投げ、引けているか確認してください。1本通っただけでは足りません。
7. **push は下書き。** push 後に Copilot Studio のUIで **公開（Publish）** しないと反映されません。
8. **公開後にテストする。** 最低限、次の4本を通してください。
   - 「判定フローを始めて」→ Q1で「書ける」→ Excel領域で終了すること
   - 「判定フローを始めて」→ Q1「書けない」→ Q2「左右しない」→ 数理最適化領域で終了すること
   - Q1「書けない」→ Q2「左右する」→ Q3「評価だけ」→ シミュレーション領域＋3層構造が出ること
   - 「依頼文テンプレートをください」→ 項目が欠けずに雛形が出ること

---

## ④ 未解決の論点

1. **`ClosedListEntity` の値が条件式でどう比較されるか、実機未検証。**
   `=Topic.ClosedForm = "書ける"` が、選択肢の `id` と `displayName` を同一文字列に揃えたことで一致する想定ですが、変数がレコード型で返る場合は一致しない可能性があります。**上記③-8の4本のテストは、この検証も兼ねています。** 万一一致しなかった場合の代替案は次の2つです。
   - `entity: StringPrebuiltEntity` に変更し、選択肢を「1 / 2 / 3」と番号で提示して `=StartsWith(Topic.ClosedForm, "1")` で判定する（確実だがUXは劣る）
   - 条件式を `=Text(Topic.ClosedForm) = "書ける"` に変える
   なお現状でも、比較が外れた場合は次の質問へフォールスルーするだけなので、会話が壊れることはありません。

2. **`OnConversationStart` は M365 Copilot などのチャネル埋め込み面では発火しない。**
   Teams のチャットや Web チャットでは動きますが、M365 Copilot 内で使う予定がある場合、greeting は `OnActivity` (`type: Message`) + `condition: =IsBlank(...)` の形に組み替える必要があります。ただしその形はグローバル変数（＝`schemaName` 参照）を要するため、**利用チャネルを確定してから対応する**方針にしています。どのチャネルで使う想定か、発注者に確認が必要です。

3. **依頼文テンプレートのコピーしやすさ。**
   Markdownのコードブロック（``` ）で囲むと channel によっては改行が潰れるため、`<br />` を使った通常テキストで出力しています。Teams などターゲットチャネルでコードブロックが正しく描画されるなら、コードブロック化したほうが「一括コピー」ができて実務的です。**実チャネルでの描画確認後に切り替えを検討してください。**

4. **`modelNameHint: GPT5Chat` はテンプレートの既定値をそのまま使っている。**
   テナントで利用可能なモデルに合わせて変更が必要な可能性があります。判定ロジックは推論の重い処理ではないため、既定のままで十分と見ています。

5. **過去プロジェクト名（PickSim、DDC便ダイヤ、Neo Wing、DPL新富士）をナレッジに含めた。**
   固有名詞の社内共有範囲によっては、公開範囲を絞るか `03-response-templates.md` から削除する判断が必要です。**発注者の確認事項です。**

6. **ヒアリング項目の先読み（`AutomaticTaskInput`）は未実装。**
   `orchestrator-variables` パターンを使えば、ユーザーの最初の一言から分類の当たりを自動で付け、判定フローの質問数を3問から1〜2問に減らせます。ただし Global 変数と `schemaName` が絡むため、テナントに実物ができてから第2段階として入れるのが安全と判断しました。

7. **ナレッジ検索の効きは実データで要調整。**
   3ファイル構成にしてH2見出しごとに自己完結させ、チャンク分割に耐える形にしましたが、実際の検索品質はアップロード後の評価（Copilot Studio のEvaluate機能）で確認するのが確実です。分類名が答えに出てこない場合は、ファイル分割をさらに細かくする（分類ごとに1ファイル）ことを検討してください。
