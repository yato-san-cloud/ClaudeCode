# Copilot エージェント移植ポートフォリオ

Claude Code で運用しているスキル群を、Microsoft Copilot Studio のエージェント（YAML定義）として移植したもの。
YAML形式は Microsoft 公式プラグイン [microsoft/skills-for-copilot-studio](https://github.com/microsoft/skills-for-copilot-studio) の `.mcs.yml` に準拠し、
全ファイルが同プラグイン同梱のスキーマバリデータで **0 failures** を確認済み（2026-08-20時点）。

## エージェント一覧

| ディレクトリ | エージェント名 | 役割 | 移植元 | ナレッジ |
|---|---|---|---|---|
| `visit-prep/` | 訪問準備エージェント | workIQ訪問予定の名寄せ → スピーダ検索キット → 訪問前ブリーフ生成（3ステップ） | `poc/`（貼り付け版PoC） | なし（貼り付けデータのみで動作） |
| `fable5-optimizer/` | Fable 5 プロンプト最適化アドバイザー | Claudeのプロンプト最適化・トークン/コスト削減の相談窓口 | fable5-optimizer スキル | 2本（**UI手動アップロード必須**） |
| `gyomu-flow/` | 業務フローヒアリング（flow.yaml作成） | 業務フローの聞き取り → flow.yaml 中間表現の作成 → Claude Codeへ引き継ぎ | gyomu-flow スキル | 4本（**UI手動アップロード必須**） |
| `warehouse-planner/` | 倉庫・物流 解法判定アドバイザー | 物流課題を4分類（算数/数理最適化/シミュレーション/シミュ最適化）に判定し実装方針を提案 | warehouse-planner スキル | 3本（**UI手動アップロード必須**・連番は読む順） |

各ディレクトリの構成は共通: `agent.mcs.yml`（本体・push対象）、`topics/*.topic.mcs.yml`（push対象）、
`settings.mcs.yml`（**参照用・push禁止**）、`knowledge/`（UIから手動アップロード）、`PORT_NOTES.md`（設計判断と手順の詳細）。

## 設計の共通原則

- **ハイブリッド分担**: Copilot Studio 側は「入口」（相談・判定・整理・引き継ぎ文の生成）。コード実行・ファイル生成
  （SimPy実装、draw.io/Excel生成、実測など）は Claude Code 側のスキルに残す。**Claude Code側のスキルは削除しない**こと。
- 外部API・プレミアムコネクタは使わない。instructions は全トラック2,000〜3,200字（上限8,000字）。
- kind・キー名はプラグインのテンプレート/スキーマに実在するものだけを使用（発明なし）。
- 捏造防止（ナレッジ・貼り付け情報の外を推測で答えない）と確認の型を全エージェントの instructions に内蔵。

## テナントへの push 手順（全トラック共通）

前提: VS Code + Copilot Studio 拡張 + 本プラグイン（`/plugin install copilot-studio@skills-for-copilot-studio`）。
詳細は各トラックの `PORT_NOTES.md` ③を参照。

1. Copilot Studio の UI で**先に空のエージェントを作る**（言語: 日本語）。エージェントの「説明」もUIで設定（YAMLには持てない）
2. VS Code 拡張でそのエージェントを **clone（pull）** する
3. clone した作業フォルダに、**`agent.mcs.yml` の中身（instructions / conversationStarters / aISettings / displayName）と `topics/*.topic.mcs.yml` だけ**を重ねる
   - **`settings.mcs.yml` はコピー禁止**（clone側が正。`schemaName` を壊すとエージェントが壊れる）
   - `mcs.metadata.componentName` は clone 側の値を優先（同梱値は仮）
   - clone 側に既定の Greeting トピックがある場合、OnConversationStart の二重化に注意
4. スキーマ検証: `node <plugin>/scripts/schema-lookup.bundle.js validate <file>` を agent と全トピックに実行
   （settings.mcs.yml はこのバリデータの対象外。掛けると必ず FAIL が出るが公式フィクスチャでも同じ）
5. **pull してから push**（ConcurrencyVersionMismatch 回避）
6. push は**下書き**。UIで **公開（Publish）** して初めてテストパネル・チャネルに反映される
7. `knowledge/` のファイルを UI から手動アップロード（.md が弾かれる場合は .txt / .docx に変換）し、
   代表質問で検索が効くか確認
8. 各 PORT_NOTES 記載の受入テストを実施

## 初回 push 時にテナントで確認すること（ポートフォリオ共通の未検証事項）

最初に push する1体（visit-prep 推奨）で以下を実機確認し、結果を全トラックに反映する。

| # | 確認事項 | 影響 |
|---|---|---|
| 1 | `agent.mcs.yml` の `aISettings.useModelKnowledge` / `isFileAnalysisEnabled` が実際にUIトグルへ反映されるか | 反映されない場合、設定はUIで行う運用に全トラック統一 |
| 2 | ClosedListEntity の回答が `=Topic.X = "選択肢"` の文字列比較で一致するか | 不一致なら `=Text(Topic.X) = "..."` か番号選択に切替 |
| 3 | OnConversationStart が M365 Copilot 埋め込み面で発火するか | Teams以外に配る場合はグリーティング方式の見直し |
| 4 | ナレッジの .md 拡張子が受け付けられるか | 弾かれたら .txt / .docx へ変換 |
| 5 | `modelNameHint: GPT5Chat` がテナントで利用可能か | 不可なら `aISettings.model` ブロックを削除して既定に委ねる |
| 6 | `language: 1041 (ja-JP)` が通るか | 弾かれたら 1033 に落とし影響範囲を確認 |
| 7 | ユーザーメッセージの文字数上限（約8,000字は二次情報） | 分割貼り付けの目安を実測で決める |

## 発注者の確認事項（push 前）

- **warehouse-planner**: `knowledge/03-response-templates.md` に過去プロジェクトの固有名詞
  （PickSim / DDC便ダイヤ / Neo Wing / DPL新富士）が含まれる。エージェントの共有範囲でそのまま載せてよいか
- **表示名の統一**: 現状「〜エージェント」「〜アドバイザー」等で語尾が不揃い。テナントの一覧に4体並ぶため、
  シリーズと分かる命名（共通接頭辞など）にするか
- **認証モード**: 参照用 settings は visit-prep / fable5-optimizer / warehouse-planner = Integrated、
  gyomu-flow = None（個人データを扱わないため。理由は同トラックPORT_NOTES）。Teams社内配布に統一するなら Integrated に揃える
- **visit-prep の持ち越し課題**: workIQ の正体（Microsoft Work IQ = Outlook予定表か）、スピーダ検索結果の
  社内AIエージェントへの貼り付けが契約範囲内か（`poc/README.md` §6 参照）

## リポジトリ内の関連資料

- `poc/` — visit-prep の前身（instructions貼り付け版PoC）。テストデータ `poc/sample-data/test-data.md` は
  visit-prep の回帰テストにそのまま使う
- 各トラックの `PORT_NOTES.md` — 設計判断・Claude版との差分・push手順・未解決論点の一次資料
