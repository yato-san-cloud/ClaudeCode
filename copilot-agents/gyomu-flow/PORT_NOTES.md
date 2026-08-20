# PORT_NOTES — gyomu-flow の Copilot Studio 移植メモ

移植元: Claude Code スキル `gyomu-flow`（`/root/.claude/skills/synced/gyomu-flow/`）
移植先: Microsoft Copilot Studio エージェント（`.mcs.yml`、microsoft/skills-for-copilot-studio 形式）
作成日: 2026-08-20

## 0. 成果物の構成

```
copilot-agents/gyomu-flow/
  agent.mcs.yml                              エージェント本体（instructions は日本語・1,919字）
  settings.mcs.yml                           参照用。依存する設定値の記録（生成オーケストレーション有効・日本語）。push では clone 側が正
  topics/
    Greeting.topic.mcs.yml                   会話開始のあいさつ。進め方を最初に宣言する
    FlowSkeleton.topic.mcs.yml               骨格ヒアリング（決定的レイヤー・順序保証）
    HandoffToClaudeCode.topic.mcs.yml        清書の引き継ぎ手順（決定的レイヤー・固定文面）
  knowledge/
    flow-yaml-schema.md                      flow.yaml の全スキーマ（移植元 reference/ir-schema.md）
    intake-guide.md                          入力起点別の聞き取り方（移植元 reference/intake-patterns.md）
    flow-yaml-checklist.md                   validate.py 相当のセルフチェック＋レイアウト規約
    sample-and-mermaid.md                    実例 flow.yaml と Mermaid 変換ルール
  PORT_NOTES.md                              このファイル
```

`agent.mcs.yml` と `topics/*.yml` は公式の schema-lookup バリデータを通してあり、全ファイル 0 failures / 0 warnings です。

```
node <plugin>/scripts/schema-lookup.bundle.js validate <ファイル>
```

kind 名・キー名はすべて `templates/` と `reference/bot.schema.yaml-authoring.json` に実在するものだけを使い、発明していません。

---

## 1. 設計判断

### 1-1. ハイブリッドの線引き

移植元スキルは Python スクリプト7本に強く依存しており、Copilot Studio ではコード実行ができません。そこで、**「対話で決まること」を Copilot Studio、「計算とファイル生成」を Claude Code** で切りました。

| 工程 | 担当 | 理由 |
|---|---|---|
| 図の目的・レーン・列の決定 | Copilot Studio | 対話そのもの。営業・業務部門が触る場所 |
| ノードと接続の聞き取り | Copilot Studio | 同上 |
| flow.yaml の組み立て（テキスト） | Copilot Studio | テキスト生成なので可能 |
| Mermaid 下書きの出力 | Copilot Studio | 文字列変換なので可能 |
| 整合性チェック（validate.py） | Claude Code | セル衝突検出などの機械的判定。会話ではチェックリストで代替 |
| 配置確認SVG（preview.py） | Claude Code | 描画処理 |
| .drawio 生成（flow2drawio.py） | Claude Code | 納品物。XML生成 |
| 処理一覧Excel（flow2xlsx.py） | Claude Code | ファイル生成 |
| drawio 読み戻し（drawio2flow.py） | Claude Code | XMLパース |

境界は `topics/HandoffToClaudeCode.topic.mcs.yml` で利用者に明示され、`agent.mcs.yml` の instructions でも「できないことをできるかのように答えてはいけない」と明記しています。

### 1-2. スキルの中心的な主張は instructions の最上位に置いた

「**図を描く前に必ず中間表現(flow.yaml)を作る**」はこのスキルの主張そのものなので、instructions の「最重要のルール（絶対に崩さない）」節に置き、あわせて次を書きました。

- 「図だけ描いて」「Mermaid だけでいい」と言われても先に flow.yaml を作る（利用者からの押し戻しへの耐性）
- そうする理由3つ（決定論的レイアウト／図と表の整合／要件トレース）を、聞かれたら説明する
- Mermaid を出すときは必ず「下書きであって清書ではない」と添える

Greeting トピックでも会話の一言目で進め方を宣言しており、「図をすぐ出してもらうエージェント」という期待が最初に立たないようにしています。

### 1-3. 決定的レイヤーをトピック3本で組んだ

生成オーケストレーション（`GenerativeActionsEnabled: true`）は非決定的なので、順序と文言が崩れると困る2箇所だけをトピックに落としました。

**FlowSkeleton（骨格ヒアリング）** — 目的 → レーン → 始点終点 → 列 の順が崩れると、移植元スキルの主張（レーンと列を先に決める）が壊れます。プラグインの `new-topic` ガイドは生成オーケストレーション下では `AutomaticTaskInput` を推奨していますが、**入力の収集順はオーケストレーターが決める**ため「レーンより先にノードを聞く」が起こり得ます。ここでは順序保証が目的なので、意図的に `Question` ノードを直列に並べ、`alwaysPrompt: true` と `interruptionPolicy.allowInterruption: false` で割り込みも止めています。

このトピックは `outputType` で **収集したデータそのもの**（purpose / lanes / boundary / columns）を返します。同ガイドのシナリオ2（後続の処理にデータを渡すトピックは、確認メッセージではなくデータを出す）に該当するためで、「骨格を聞き終えました」という完了メッセージを返すとオーケストレーターが仕事は終わったと判断し、ノードの聞き取りに進まなくなります。

**HandoffToClaudeCode（引き継ぎ手順）** — スクリプト名・実行順・圧縮保存の落とし穴といった固定情報を生成に任せると、コマンド名の取り違えが起きます。`SendActivity` の固定文面にしました（`new-topic` ガイドが「精密な文言が必要な場合の例外」として認めている用途）。

**Greeting** — 必須の1本。`OnConversationStart`。

### 1-4. 採用したパターン

- **date-context**（`patterns/date-context.md`）: instructions 冒頭に `{Text(Today(),DateTimeFormat.LongDate)}` を置き、`meta.version` やファイル名の日付基準にしています。トークン増は数十トークンで、議事録の日付解釈と版数管理に効きます。
- **line-breaks-in-messages**（`patterns/line-breaks-in-messages.md`）: 引き継ぎ手順のような長文は `|-` ブロックスカラー＋`<br />` で段落を作っています。Teams でも Web チャットでも改行がつぶれません。
- **jit-glossary は不採用**: 用語集を Dataverse に置く必要があり、テナント側の前提が増えます。用語（レーン・列・ノード）は数が少ないので、instructions の「初めて使うときはひとこと説明を添える」で代替しました。

### 1-5. instructions で気をつけたこと

- `instructions` は Power Fx のテンプレート行なので、**波括弧が変数展開として解釈されます**。flow.yaml のインライン記法（`{id: cs, label: 受注担当}`）を instructions に書くと壊れるため、書式の例はすべてナレッジ側に逃がし、instructions には波括弧を `Today()` の1箇所しか置いていません。トピックの `activity` / `prompt` も同じ理由で波括弧を使っていません。
- 長さは1,919字。上限8,000字に対して十分短く、実用上安定する範囲です。移植元 SKILL.md の全文を写すのではなく、「毎回効かせたい判断」だけを instructions に、「引かれれば十分な資料」をナレッジに分けました。

### 1-6. ナレッジの分け方

`add-knowledge/knowledge-guide.md` の「1ソース1ドメイン、重複させない」に従って4本に割りました。移植元の `reference/` をそのまま貼らず、次の再構成をしています。

- 相互参照リンク（`→ reference/xxx.md`）を削除し、各ファイルが単独で読めるようにした（チャンク単位で検索されるため）
- 各節に文脈を書き足した（見出しだけでは何の表か分からないチャンクをなくす）
- 実行コマンドの記述は Claude Code 側の作業として言い換えた
- `drawio-shapes.md`（mxGraph のスタイル文字列）は**移植していません**。Copilot Studio 側で図を描かないため不要で、あるとかえって「スタイル文字列を出力できる」と誤解させます
- `layout-rules.md` は単独ファイルにせず、`flow-yaml-checklist.md` の後半に「崩れたときに触る順番」「線を綺麗に見せる」として統合しました
- `flow-yaml-checklist.md` は移植元にはない新規ファイルです。`validate.py` が機械的に出すエラー・警告を、会話で目視確認できるチェックリストに書き直したものです（コード実行ができない穴を、いちばん埋められる場所）

---

## 2. Claude 版との差分

### 2-1. できないこと（Copilot Studio 側では原理的に不可）

| できないこと | 移植元の該当機能 | 代替 |
|---|---|---|
| .drawio ファイルの生成 | `flow2drawio.py` | Claude Code に引き継ぐ |
| 処理一覧Excelの生成 | `flow2xlsx.py` | Claude Code に引き継ぐ |
| 配置確認SVGの生成 | `preview.py` | Mermaid 下書きで代替（位置は再現できない） |
| 既存 drawio の読み戻し | `drawio2flow.py` | Claude Code に引き継ぐ |
| 機械的な整合性チェック | `validate.py` | `knowledge/flow-yaml-checklist.md` による目視チェック |
| 要件トレースの網羅チェック | `validate.py --requirements` | Claude Code に引き継ぐ（reqs.txt を用意してもらう） |
| ファイルの保存・受け渡し | — | flow.yaml をチャットからコピーしてもらう |

### 2-2. 簡略化したこと

- **セル衝突・孤立ノード・ID重複の検出は「保証」から「チェックリスト」に落ちました。** validate.py は機械的に100%検出しますが、Copilot Studio 側は生成モデルがチェックリストを読んで確認するだけなので、見落としが起こります。**Claude Code 側で validate.py を必ず通す**ことが、この移植の前提です。引き継ぎトピックでも validate.py を最初に実行する手順として書いています。
- **レーン7本・列12本の上限は警告ではなく助言になりました。** instructions とナレッジに書いていますが、超過時に必ず止まる保証はありません。
- **要件トレース（`ref:`）は書式だけ移植しました。** ノードに `ref:` を書く指示は残していますが、未参照要件の検出は Claude Code 側です。
- **`meta.grid` の寸法チューニングは深追いしていません。** 情報密度が高い図の初期値（`lane_h: 150` / `node_h: 92` / `font_size: 10` / `node_w: 178`）と、decision ノードの寸法注意はナレッジに残しましたが、実際に崩れているかは図を見ないと分からないため、調整は Claude Code 側の工程です。
- **`slot` は残していますが積極的には勧めていません。** 移植元どおり「列を足すほうがたいてい正しい」を優先させています。

### 2-3. ハイブリッドとして Claude Code 側に残した工程と、引き継ぎ方法

利用者に案内する引き継ぎ手順（`topics/HandoffToClaudeCode.topic.mcs.yml` の文面と同内容）です。

1. Copilot Studio 上で確定した flow.yaml の全文をコピーし、`flow.yaml` として保存する
2. Claude Code を開き、そのフォルダで「この flow.yaml から業務フロー図を作って」と依頼する（`gyomu-flow` スキルが起動する）
3. Claude Code 側で次を実行する

```bash
S=<gyomu-flowスキルのパス>/scripts
python $S/validate.py    flow.yaml                  # まず最初に。ここを通してから図を出す
python $S/preview.py     flow.yaml -o p.svg         # 配置の目視確認
python $S/flow2drawio.py flow.yaml -o flow.drawio   # 清書（納品物）
python $S/flow2xlsx.py   flow.yaml -o 処理一覧.xlsx
```

4. 要件トレースを掛ける場合は、要件IDを1行1件で書いた `reqs.txt` を用意して `python $S/validate.py flow.yaml --requirements reqs.txt`
5. 人が draw.io で直した後は `python $S/drawio2flow.py 修正版.drawio -o flow.yaml` で戻し、**図を見比べるのではなく flow.yaml の差分を見る**

引き継ぎ時の落とし穴（トピックの文面にも入れてあります）:

- `.drawio` が圧縮保存されていると読み戻せない（draw.io の ファイル → プロパティ → 圧縮 をオフ）
- 箱を複製すると `ir_id` が重複する。`validate.py` が検出するので flow.yaml 側で振り直す
- 青帯（メタ担体）を消すと逆変換できない

**往復させる場合の注意**: Claude Code 側で更新した flow.yaml を Copilot Studio に貼り直すと、そこからさらに会話で編集できます。ただし Copilot Studio 側には flow.yaml の保管場所がないため、**正本は Claude Code 側（git 管理下）に置く**運用を推奨します。Copilot Studio は「初稿を作る場所」と「業務部門が下書きを直す場所」に位置づけるのが安全です。

---

## 3. テナントへ push するときの注意

VS Code の Copilot Studio 拡張 ＋ microsoft/skills-for-copilot-studio プラグインから push する前提です。

### 3-1. push 前に必ず確認する項目

| 項目 | ファイル | 注意 |
|---|---|---|
| `schemaName` | `settings.mcs.yml` | **同梱の `settings.mcs.yml` は参照用**で、`REPLACE_SCHEMA_PREFIX` というプレースホルダにしてあります。テナントで採番された実値（接頭辞は Dataverse ソリューションのパブリッシャープレフィックスに規定されます）を使う必要があるため、**clone / pull した側のファイルを正とし、同梱版で上書きしないでください。** 一度 push した後の変更もエージェントを壊します |
| `componentName` | `agent.mcs.yml` | `GyomuFlowIntakeAgent` は仮の値です。clone 側の `agent.mcs.yml` の値と異なる場合は **clone 側の値に書き換えてから** push してください（不一致だと別コンポーネント扱いになり得ます）。`displayName` は上書きして構いません |
| `language` | `settings.mcs.yml` | `1041`（ja-JP）にしています。環境が日本語ロケールに対応していない場合は push で弾かれます。その場合は `1033`（en-US）に落として、instructions とトピック文面は日本語のまま運用してください（応答言語は instructions で担保されます） |
| `modelNameHint` | `agent.mcs.yml` | `GPT5Chat` にしています。テナントで使えるモデルは `node <plugin>/scripts/schema-lookup.bundle.js models` で確認し、必要なら差し替えてください。**`aISettings.model` に `kind` を書いてはいけません**（agent 側スキーマは `CurrentModelsNoKind`） |
| `GenerativeActionsEnabled` | `settings.mcs.yml` | `true` が前提です。`false` にすると instructions がほぼ効かず、トピックがトリガーフレーズだけで動く古い挙動になり、この移植は成立しません |
| `authenticationMode` | `settings.mcs.yml` | `None` にしています。個人データを扱わないため十分ですが、Teams で社内配布する場合は `Integrated` を検討してください |
| `accessControlPolicy` | `settings.mcs.yml` | `ChatbotReaders`。公開範囲のポリシーは組織の標準に合わせてください |

### 3-2. push の手順

**このフォルダは clone 済みのワークスペースではありません**（`.mcs/conn.json` がありません）。push はこのフォルダから直接はできず、他の3トラックと同じく「テナント側に器を作る → clone/pull → 重ねる → push → 公開」の順になります。

1. **テナント側でエージェントの器を作る。** Copilot Studio の UI で新規エージェントを作成します（**言語は日本語を選択**。`language` は後から変えるとエージェントが壊れます）。
2. **clone する。** VS Code の Copilot Studio 拡張、または `@copilot-studio:copilot-studio-manage clone` でローカルに落とします（`.mcs/conn.json` を含む作業フォルダができます）。
3. **本ディレクトリのファイルを重ねる。** コピーするのは次の2種類だけです。
   - `agent.mcs.yml` の `instructions` / `conversationStarters` / `aISettings` / `displayName`（`mcs.metadata.componentName` は clone 側の値を優先）
   - `topics/*.topic.mcs.yml` の3本（clone 側に既存トピックがある場合、ノードIDの衝突がないか確認してください。本トラックは `*_3c8d` / `*_9f4a` / `*_5e07b` / `*_2a6cf` / `sendGreeting_a41f7c` / `sendHandoff_c62d` 系を使っています）
   - **`settings.mcs.yml` はコピーしない**（参照用。3-1 参照）。clone 側のファイルで `GenerativeActionsEnabled: true` と `recognizer.kind: GenerativeAIRecognizer` だけを確認します
   - clone 側に既定の Greeting トピックがある場合、`OnConversationStart` が二重にならないよう、置き換えるか既存側を削除します
4. push 前にスキーマ検証を通す

```bash
node <plugin>/scripts/schema-lookup.bundle.js validate agent.mcs.yml
node <plugin>/scripts/schema-lookup.bundle.js validate topics/Greeting.topic.mcs.yml
node <plugin>/scripts/schema-lookup.bundle.js validate topics/FlowSkeleton.topic.mcs.yml
node <plugin>/scripts/schema-lookup.bundle.js validate topics/HandoffToClaudeCode.topic.mcs.yml
```

`settings.mcs.yml` はこのバリデータに掛けないでください。ルート直下に `kind:` が無いファイル形式なので `[FAIL] No 'kind' property found at root level` が必ず出ます（公式の `evals/fixtures/basic-agent/settings.mcs.yml` も同じ結果になります）。バリデータ側の想定外であって、ファイルの誤りではありません。

5. 環境に接続済みなら LSP 検証も通す（Power Fx 式・ファイル間参照・環境固有ルールを見ます）

```bash
node <plugin>/scripts/manage-agent.bundle.js validate \
  --workspace <clone した作業フォルダ> --tenant-id <tenantId> \
  --environment-id <envId> --environment-url <envUrl> --agent-mgmt-url <mgmtUrl>
```

6. 拡張から push（**push の前に必ず `pull` する**。しないと `ConcurrencyVersionMismatch` が出ます）
7. **push は下書きです。** Copilot Studio の UI で**公開（Publish）**しないと、テストパネルにもチャネルにも反映されません
8. push 後、**ナレッジは別途 Web UI から手動アップロード**（次項）

### 3-3. ナレッジのアップロード（YAML では push されません）

`knowledge/*.md` は**ファイルアップロード型のナレッジ**なので、YAML には含められません。Copilot Studio の Web UI で エージェント → ナレッジ → ファイルを追加、から4本をアップロードしてください。

注意点:

- **`.md` はアップロード対象の拡張子として受け付けられない可能性があります。** その場合は拡張子を `.txt` に変えるか、Word（.docx）/ PDF に変換してからアップロードしてください（内容はそのままで構いません）。`.csv` は Copilot Studio が別扱いにするため使わないでください
- アップロード後、`agent.mcs.yml` の `aISettings.useModelKnowledge`（Web UI の「一般知識を使う」に相当。スキーマ上の既定は `false`）が**オフ**であることを確認してください。オンだと書式を勝手に発明する挙動が増えます
- アップロードしたら「flow.yaml の attach はどう書きますか」「emphasis に使える色は」など、代表的な質問を数本投げて引けているか確認してください。1本通っただけでは足りません
- ナレッジは4本とも表が多い構成です。ナレッジガイドは「表ばかりの資料は回答品質が落ちる」と言っているため、引きが悪い場合は表を箇条書きに崩す改稿を検討してください（→ 4章の未解決論点）

### 3-4. 動作確認の観点

push 後に最低限確認したいシナリオです。

1. 「業務フロー図を作りたい」→ FlowSkeleton トピックが起動し、**4問が 1/4 → 4/4 の順で**出るか
2. 骨格の4問が終わった後、オーケストレーターがノードの聞き取りに進むか（完了メッセージで止まってしまわないか）
3. 「Mermaid だけでいいので今すぐ図をください」→ flow.yaml を先に作るか（主張が守られるか）
4. 「drawio ファイルをください」→ HandoffToClaudeCode トピックの固定文面が出るか
5. 出力された flow.yaml をそのまま Claude Code の `validate.py` に通して 0 errors か（**これが実質的な最終テスト**）
6. Teams に埋め込む場合、Greeting（`OnConversationStart`）が発火するか（→ 4章）

---

## 4. 未解決の論点

1. **`OnConversationStart` が発火しないチャネルがある。** プラグインの jit-glossary パターンが指摘しているとおり、M365 Copilot などチャネル埋め込み型のサーフェスでは `OnConversationStart` が発火しません。Teams や M365 Copilot に載せる場合、Greeting トピックの「図の前に flow.yaml」という宣言が出ないことになります。対策として `OnActivity`（`type: Message`）＋ `IsBlank` ガードの初期化トピックに置き換える手がありますが、あいさつを毎回出さないための状態管理が必要で、今回は素直な `OnConversationStart` にしています。**配布チャネルが決まった時点で要判断です。**

2. **Mermaid がチャット上でレンダリングされない。** Copilot Studio の Web チャットや Teams は mermaid コードブロックを図として描画しないため、利用者にはコードのまま届きます。「mermaid.live などに貼って見てください」という案内を足すか、Adaptive Card で画像として出す（別途レンダリング手段が要る）か、あるいは Mermaid 出力自体をやめて「flow.yaml の要約テキスト」に置き換えるか。**現状は移植元どおり Mermaid を出す設計にしていますが、実利用者の反応を見て判断したい論点です。**

3. **flow.yaml の保存先がない。** 会話が終わると成果物が消えます。利用者が毎回コピーする運用は現実には守られにくいので、SharePoint / OneDrive に保存する Agent Flow を足すかどうか。ただしコネクタが増え、「外部API・プレミアムコネクタは使わない」という今回の前提から外れます。**運用が回りはじめてからの追加検討事項です。**

4. **骨格4問の摩擦。** 「議事録を貼るだけ」で来た利用者にも4問を順に聞くのは冗長です。議事録起点を別トピックに分けるか、FlowSkeleton の冒頭に `ConditionGroup` で「すでに材料がある場合はスキップ」を入れるか。ただし条件分岐を足すほど決定性が下がるので、**まずは4問固定で運用し、実際に摩擦が出るか観測したい**というのが現時点の判断です。

5. **`outputType` のプロパティ名と Topic 変数名の対応が実機で期待どおりか未検証。** `Topic.purpose` などの変数名を `outputType.properties` のキーと一致させていますが、実機での挙動（オーケストレーターが4つの値を後続の推論に確実に持ち越すか）はテナントでのテストが必要です。**もし持ち越されない場合は、4つを1つの Topic 変数に `SetTextVariable` で連結して単一の output にする案が代替です。**

6. **ナレッジのチャンク品質。** 4本とも表中心の構成です。ナレッジガイドは表ばかりの資料を避けるよう言っており、特に `flow-yaml-schema.md` の型一覧・emphasis一覧が、表の行だけ切り出されたチャンクになると意味を失う可能性があります。引きが悪ければ箇条書きへの書き換えが要りますが、**書き換えると人が読む資料としての一覧性が落ちる**というトレードオフがあります。

7. **要件トレースをどこまで Copilot Studio 側でやるか。** 現状は `ref:` を書く指示までで、網羅チェックは Claude Code 側です。要件一覧を1本のナレッジとして持たせて会話で突き合わせる案もありますが、要件一覧は案件ごとに変わるためエージェント固定のナレッジには向きません。**案件ごとにナレッジを差し替える運用にするか、Claude Code 側に寄せたままにするか、未決です。**

8. **`language: 1041` がテナントで通るか。** 検証環境がないため未確認です。弾かれた場合は `1033` に落とす前提で 3-1 に代替を書いてありますが、その場合に UI 表示や既定のシステムメッセージが英語になる範囲は実機で確認が必要です。
