# PORT_NOTES — 訪問準備エージェント（workIQ × スピーダ）YAML版

PoC の「Copilot Studio の指示欄に貼り付ける運用」を、`.mcs.yml`（Microsoft 公式プラグイン
`microsoft/skills-for-copilot-studio` が扱う形式）のエージェント定義に格上げしたもの。
移植元は本リポジトリの `poc/`（`poc/copilot-studio/instructions.md` が指示本文、`poc/README.md` が設計判断、
`poc/copilot-studio/setup-guide.md` がセットアップ手順、`poc/sample-data/test-data.md` がテストデータ）。
※ `poc/` はブランチ `claude/copilot-workiq-visit-info-xh37q1` にある。

## 0. 成果物

| ファイル | 役割 |
|---|---|
| `agent.mcs.yml` | エージェント本体。`instructions`（日本語・3,148字）、会話スターター3件、AI設定 |
| `topics/Greeting.topic.mcs.yml` | 会話開始時のあいさつ（`OnConversationStart`） |
| `topics/PasteTemplate.topic.mcs.yml` | 貼り戻しテンプレートと分割貼り付けルールを固定文面で返す（`OnRecognizedIntent`） |
| `settings.mcs.yml` | **参照用**。このエージェントが依存する設定値の記録。push では clone 側が正（§2.2、§3-3） |

`knowledge/` は作っていない（このエージェントは貼り付けデータだけで動き、参照すべき静的資料を持たないため）。
テストは `poc/sample-data/test-data.md` のダミーデータ（訪問予定CSV／スピーダ結果の一括・分割貼り付け例／
期待ブリーフ出力例／評価チェックリスト）をそのまま使う。移植後もこのテストデータで回帰確認すること。

`agent.mcs.yml` と `topics/` の2本は
`node scripts/schema-lookup.bundle.js validate <file>`（プラグイン同梱のスキーマ検証）で
failure 0・warning 0 を確認済み。
`settings.mcs.yml` だけは同検証で `No 'kind' property found at root level` が1件出るが、これは
**検証ツールが settings ファイルに対応していないため**で、Microsoft 公式のサンプル
（`evals/fixtures/basic-agent/settings.mcs.yml`）でも同じ結果になる。異常ではない。

---

## 1. 設計判断

### 1.1 3ステップは instructions ベースのまま、トピック化しなかった

PoC の中核設計「貼られた入力の内容からステップを判定する」を維持した。理由:

- Copilot Studio の生成オーケストレーションは非決定的だが、**このワークフローは順序を強制する必要が薄い**。
  ユーザーが順不同で貼っても動くこと（例: 検索キットを使わずスピーダ結果だけ貼る）が PoC の要件だった。
- 3ステップをトピック化すると、長文の貼り付け本文でトリガーフレーズを一致させる設計になり、
  かえって誤発火・不発が増える。テンプレートで確実に表現できる範囲を超える。
- ステップ間の状態（名寄せ確定結果、分割貼り付けの累積テキスト）はグローバル変数に持たせる必要があり、
  貼り付けテキストをそのまま変数に積む実装は複雑さの割に壊れやすい。

**トピック化した方がよい兆候**（この時が切り替えどき。移行の指針として残す）:
① ステップ2を飛ばしてブリーフが作られる事故が出る、
② 分割貼り付けの終了合図を待たずに処理が始まる事故が繰り返される、
③ 名寄せ確認の一括回答が拾われずステップ1をやり直す。
その場合はまず「分割貼り付けの受け口」だけをトピック＋グローバル変数に切り出すのが投資対効果が高い。

### 1.2 決定的レイヤーに置いたのは「あいさつ」と「貼り戻しテンプレート案内」の2本だけ

- **Greeting**: `setup-guide.md` §2 手順8 の文面をそのまま `OnConversationStart` トピックに載せた。
  UI の「最初のメッセージ」欄に手で入れる運用をやめ、YAML で版管理できるようにした。
- **PasteTemplate**: 貼り戻し書式（`【企業名】／【調べた日】／【メモ: …】`）と分割プロトコル
  （連番＋終了合図 `【以上】`）は**一字一句ぶれてはいけない契約**。生成に任せると
  「【以上】」が「以上」に化けるなど合図が崩れ、分割貼り付けが機能しなくなる。
  ここだけ固定文面のトピックにした。ユーザーが書式だけを聞いた時の受け皿にもなる。
  なお instructions のステップ2内にも同じテンプレートを残してある（キット生成の流れの中で提示する必要があるため）。
  **文面を変えるときは2箇所同時に直すこと。**

### 1.3 改行は `<br />` を明示

トピックのメッセージは `patterns/line-breaks-in-messages.md` に従い、`|-` ブロックスカラー＋`<br />` で書いた。
素の YAML 改行は多くのチャネルで空白に潰れ、あいさつが壁のような一段落になるため。

### 1.4 日付コンテキストを追加（PoC からの改善）

`patterns/date-context.md` を採用し、instructions 冒頭に
`本日は {Text(Today(),DateTimeFormat.LongDate)} です。` を入れた。
ブリーフの「情報の出典と鮮度」「直近トピック」「訪問日時順の並べ替え」が相対日付に依存するのに、
PoC の指示本文には現在日付の基準がなかった。追加コストは会話あたり数トークン。

### 1.5 instructions への追記（PoC からの改善、3箇所）

いずれも PoC の中核設計は変えず、`skills/edit-agent/instructions-guide.md` の推奨に沿って補強した。

1. **グラウンディング強化**: 「企業・業績・人事などをモデルの一般知識で補わない」を捏造禁止条項に追記
   （`useModelKnowledge: false` と併せて二重に効かせる）。
2. **スコープ強制**: 訪問準備以外の依頼を本来の用途に案内する一文を追加（オフトピック入力は
   `setup-guide.md` §5 のテスト項目でもある）。
3. **入力形式の明示**: 「ファイル添付を前提とした案内はしない」を追加。PoC が
   「チャネル依存が大きいのでテキスト貼り付け」と判断した理由を、エージェント自身の振る舞いに落とした。
   加えて、分割貼り付けの終了合図後に「それまでのブロックをすべて1つの入力として統合する」ことを明文化した
   （PoC の指示では暗黙だった）。

### 1.6 会話スターター

`setup-guide.md` 手順8 が挙げる2つ（訪問予定を貼る／スピーダ結果を貼り戻す）に加え、
PasteTemplate トピックへの入口として「貼り付け方を確認する」を足して3件にした。
`conversationStarters` はテンプレート・スキーマとも `{title, text}` の配列として実在するキー。

### 1.7 `aISettings` の2つのフラグ

- `useModelKnowledge: false` — 捏造禁止の設計をモデル設定側でも担保する。
- `isFileAnalysisEnabled: false` — ファイル添付を使わない設計を明示する。

いずれもスキーマ（`AISettingsNoKind`）に実在する。ただし **push するとテナント側の現在値を上書きする**ので、
既存エージェントの設定を尊重したい場合はこの2行を消してから push してよい（設計意図は instructions 側にも書いてある）。

---

## 2. PoC 貼り付け版との差分

### 2.1 できないこと（Copilot Studio 側の制約として残る）

| 項目 | 状況 |
|---|---|
| 件数突合の厳密性 | コード実行（Python等）が使えないため、貼り付け行数と解析件数の突合は**モデルの数え上げ**に留まる。行数が多いほど信用度が落ちる。指示では「一致しない場合は明記」までしか担保できない |
| CSV パースの厳密性 | 区切り文字推定・セル内改行による行割れの検出も、パーサではなくモデルの読み取り。Excel からのタブ区切りコピーは崩れうる（`setup-guide.md` 付録の対処が引き続き必要） |
| 分割貼り付けの累積 | 会話履歴に依存する。履歴が長くなると古いブロックが落ちる可能性があり、**分割は2〜3ブロックまでを推奨**（PoC のサンプルも2分割） |
| 外部API・プレミアムコネクタ | 使わない前提を維持。workIQ / スピーダとも人手コピペ（規約・技術の両面での PoC の判断をそのまま踏襲） |
| 順序保証 | 1.1 の通り。instructions ベースのため、生成オーケストレーションの気まぐれは残る |

### 2.2 簡略化したこと

- ステップ1〜3をトピックに分解しなかった（1.1）。順序保証は instructions のステップ判定に委ねている。
- フォールバック（`OnUnknownIntent`）トピックは作らなかった。生成オーケストレーション有効時は
  オーケストレーターが未知入力も処理するため、フォールバックを足すと逆に横取りされる。
  代わりに instructions のステップ判定末尾で「どれとも判定できない → 何を貼るのか尋ねる」を担保している。
- `settings.mcs.yml` は**参照用として同梱するだけ**で、push の対象にはしない。
  `schemaName` は `REPLACE_SCHEMA_PREFIX` のままにしてあり、`language` ともどもテナント固有の値なので、
  推測値を push するとエージェントが壊れる（`skills/edit-agent/SKILL.md` の「Fields to NEVER Modify」）。
  同梱の狙いは「このエージェントは `GenerativeActionsEnabled: true` と日本語(1041)に依存する」という
  仕様を残すこと。実際の push では clone 側のファイルを使い、この2点だけ突き合わせる（§3-3）。

### 2.3 ハイブリッド（Claude Code 側に残す作業）

Copilot Studio に持っていかず、Claude Code / このリポジトリ側で回し続けるもの:

- **instructions の版管理と回帰テスト**: 変更のたびに `poc/sample-data/test-data.md` の
  同じ3ステップを通す（`setup-guide.md` §5）。この回帰の実施と差分レビューはリポジトリ側の仕事。
- **テストデータの生成・拡充**: 名寄せの罠（前株/後株・カナ/英字・同名法人）を仕込んだダミーCSVの作成。
- **ブリーフの二次加工**: 生成されたブリーフを Word / PowerPoint / Excel に落とす、複数社を束ねて
  週次の訪問計画にする、といった加工は Copilot Studio 側ではできない。必要ならブリーフ本文を
  Claude Code に渡して処理する。
- **設計判断の記録**: 本ファイルと `poc/README.md`。

---

## 3. テナントへの push 手順の注意

前提: ローカルの VS Code Copilot Studio 拡張（LSP バイナリを提供）＋ `microsoft/skills-for-copilot-studio` プラグイン。
このセッションからは push できないため、以下は発注者側の手順。

1. **先に clone する。** `@copilot-studio:copilot-studio-manage clone` で対象エージェントを取得し、
   その作業フォルダに本ディレクトリの `agent.mcs.yml` と `topics/*.topic.mcs.yml` を**重ねる**。
   まっさらな状態からの push は想定していない（`settings.mcs.yml` が無いため）。
   **本ディレクトリを丸ごとコピーしないこと。** 同名の `settings.mcs.yml`（`schemaName` がプレースホルダのまま）が
   clone 側の実ファイルを上書きし、エージェントが壊れる。コピーするのは上記2種類のファイルだけ。
2. **`mcs.metadata.componentName` を合わせる。** 本ファイルは `VisitPrepAgent` を仮置きしている。
   clone した `agent.mcs.yml` の `componentName` と異なる場合は、**clone 側の値に書き換えてから** push する
   （不一致だと別コンポーネント扱いになり得る）。`displayName`（訪問準備エージェント）は上書きしてよい。
   **説明 (Description) は YAML に持てない。** 公式テンプレート（`templates/agents/agent.mcs.yml`）にも
   スキーマの `GptComponentMetadata` にもエージェントの説明フィールドが無いため、
   `setup-guide.md` §2 手順5 の説明文（「workIQ の訪問予定貼り付けから訪問先企業を特定し、
   スピーダ検索キットを生成し、貼り戻された検索結果から訪問前ブリーフを整形する営業支援エージェント」）は
   push 後に Copilot Studio UI の説明欄へ手で設定する。オーケストレーターは名前と説明で経路を判断するため、
   空のままにしないこと（PoC からこの1項目だけ YAML に載せられずに残っている）。
3. **`settings.mcs.yml` は同梱版を push しない**（`schemaName` がプレースホルダのまま壊れる）。
   clone 側のファイルをそのまま使い、同梱版と次の2点だけ突き合わせる:
   - `configuration.settings.GenerativeActionsEnabled: true`
     （**必須**。ステップ判定を生成オーケストレーションに任せる設計のため。false だとトピックしか動かない）
   - `language` が日本語（1041）であること。違う場合は**編集せず**、日本語で新規作成し直す
     （`language` は変更するとエージェントが壊れるフィールド）。
4. **既存の Greeting トピックと衝突しないか確認する。** clone 側に既定のあいさつトピックがある場合、
   `OnConversationStart` が二重になるとあいさつが2回出る。既存ファイルを本ファイルで置き換えるか、
   既存側を削除する。
5. **push 前に検証する。**
   ```
   node <plugin>/scripts/schema-lookup.bundle.js validate <各ファイル>
   ```
   さらに `.mcs/conn.json` がある環境では
   `node <plugin>/scripts/manage-agent.bundle.js validate --workspace <agent-folder> ...`
   （Power Fx 式・ファイル間参照の検証）も通す。
6. **push は下書き。** `@copilot-studio:copilot-studio-manage push` の後、
   Copilot Studio UI で **公開（Publish）** しないとテストにも反映されない。
   チャネル追加（Teams + Microsoft 365）の前にも最低1回の公開が必要。
7. **`ConcurrencyVersionMismatch` が出たら**、先に `pull` してから push し直す。
8. **push 後に必ず通しテスト。** `poc/sample-data/test-data.md` のセクション1 → 2.1 → 2.2（分割）を
   テストパネルで実行し、セクション3の期待出力・セクション4のチェックリストと突き合わせる。
   特に確認するのは、①件数突合の表示、②曖昧な企業だけが1つの確認表にまとまること、
   ③分割時に【以上】まで「続きをどうぞ」で待つこと、④ブリーフ末尾のドラフト注記。
9. **`modelNameHint: GPT5Chat` が使えない環境では**、`aISettings.model` ブロックごと削除して
   既定モデルに任せる（テンプレート由来の値であり、この用途に必須のモデルではない）。
10. **原本の一本化。** 移植後は `agent.mcs.yml` の `instructions` が唯一の原本になる。
    `poc/copilot-studio/instructions.md` は貼り付け運用時代の原本なので、
    参照用に格下げする旨を明記するか、`agent.mcs.yml` を指すよう書き換えること。
    **二重管理のまま放置すると、どちらが本番か分からなくなる。**

---

## 4. 未解決の論点

1. **`PasteTemplate` トピックの発火精度（要実機確認）。** 日本語のトリガーフレーズが
   生成オーケストレーションでどれだけ正確に選ばれるか、また**訪問予定やスピーダ結果を貼った時に
   誤発火しないか**は実機でしか分からない。誤発火するようなら `modelDescription` の
   「訪問予定やスピーダ結果そのものが貼り付けられた場合には使わない」をさらに具体化する。
2. **`Today()` のタイムゾーン。** サーバーのタイムゾーンで評価されるため、JST と1日ずれる可能性がある
   （`patterns/date-context.md` の既知の落とし穴）。訪問日の判定に効くので、実機で日付を確認し、
   ずれるようなら instructions 側で「表示される日付は UTC 基準の可能性がある」旨を補う。
3. **instructions の上限8,000字**は2026年8月時点の調査値。仕様変更があり得るので導入時に再確認する
   （現在3,148字なので当面の余裕は大きい）。
4. **分割貼り付けの上限。** 会話履歴に頼る設計のため、何ブロックまで統合できるかは実測が必要。
   ユーザーメッセージ約8,000字という上限も二次情報で未確認（`poc/README.md` §6）。
5. **順序保証の切り替え判断。** 1.1 の3兆候が出たらトピック化に着手する、という基準は決めたが、
   その閾値（何回起きたら、か）は運用開始後に決める。
6. **`aISettings` の2フラグ（置き場所と実効性、要実機確認）。**
   - テナント側の既存値を上書きするため、既存エージェントに重ねる場合は発注者の判断が要る（§1.7）。
   - **置き場所**: スキーマ上 `agent.mcs.yml` の `aISettings`（`AISettingsNoKind`）に両フラグは実在するが、
     `skills/edit-agent/SKILL.md` の一覧は `agent.mcs.yml` 側を `aISettings.model.*` のみとし、
     AI 機能のブール値は `settings.mcs.yml` の `configuration.aISettings.*` に置くと書いている。
     push 後に UI 側のトグル（一般知識の利用／ファイル分析）が実際に反映されたかを必ず確認し、
     反映されないなら `settings.mcs.yml` 側（＝clone 側ファイル）か UI で設定し直す。
     反映されないまま放置すると、捏造禁止の担保が instructions だけになる。
   - **`useModelKnowledge: false` の副作用**: このエージェントはナレッジソースを1つも持たない。
     一般知識を切った状態で「ナレッジに無い」と判断され、貼り付けテキストの整形・ブリーフ生成まで
     拒否されないかを §3-8 の通しテストで必ず確認する。拒否されるようなら当該2行を削除して再テストする。
7. **PoC から持ち越しの未解決**（いずれも本移植では解消していない）:
   - **workIQ の正体が未確定**（Microsoft Work IQ = Outlook 予定表なのか、社内ツールか）。
     これが決まると Phase 2 の自動化パス（標準コネクタでの予定取得）が開ける。
   - **スピーダの契約条件**。検索結果テキストを社内 AI エージェントへ貼り付ける行為の契約上の扱いは未確認。
     導入前にユーザベース社と確認すること。
   - **Speeda MCP 連携**（2026年9月1日 正式提供予定）。Copilot Studio は MCP 接続に対応しているため、
     正式提供後はステップ2〜3の人手貼り戻しを公式経路で置き換えられる可能性がある。
     その場合、本 YAML には `actions/` 配下に MCP アクションが加わり、instructions のステップ2〜3を
     書き換えることになる（テンプレート `templates/actions/mcp-action.mcs.yml` が使える）。
