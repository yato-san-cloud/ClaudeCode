# M365 Copilot エージェントビルダー: 制約と事実（2026-07 時点の調査）

一次情報: Microsoft Learn（m365copilot-docs）。仕様は変わりうるので、
挙動が合わない場合はこのファイルの数値を疑い、最新ドキュメントを再確認すること。

## 指示欄（instructions）

- 上限 **8,000 文字**
- Markdown 推奨: `#`/`##` 見出し、並列は `-`、順序必須の手順のみ `1.`、
  重要事項は `**太字**`、ツール名・システム名はバッククォート
- 「何をすべきか」を具体的動詞（ask / search / send / check / use）で書く。
  禁止事項の羅列より肯定形を優先
- 複合タスクは原子的なステップに分解する
- トーン・冗長度・出力形式を明示しないと挙動が安定しない
- 複雑なシナリオには few-shot（例示）を複数入れる

### 公式の警告（重要）

> 指示を SharePoint 文書などのナレッジに逃がして 8,000 字制限を回避してはならない。
> ナレッジの内容は「信頼された作成者による指示」ではなく、クロスプロンプト
> インジェクション攻撃の対象になる。また参照文書の編集権限を持つ誰もが、
> マニフェストの作成・版管理・ガバナンスを迂回して実行時挙動を変更できてしまう。

→ 本スキルの方式（HTML＝参照資料、指示欄＝挙動定義）はこの警告と整合する設計。
HTML 文書は宣言的・記述的な文体で書き、命令文を置かない。

## ナレッジソースの種類と上限

| ソース | 上限 | 備考 |
|---|---|---|
| 公開 Web サイト | 4 URL | パス 2 階層まで、クエリパラメータ不可 |
| SharePoint ファイル | 100 | 既存の権限と秘密度ラベルを尊重 |
| SharePoint リスト | 1 | 20,000 項目 / 生テキスト 50 MB まで |
| OneDrive ファイル | 50 | 共有リンク形式が必要 |
| Teams チャット | 5 | Copilot アドオンライセンス必須 |
| Outlook メール | 全メール | スコープ指定不可、アドオンライセンス必須 |
| 埋め込みファイル（直接アップロード） | 20 | 下記の形式のみ |
| Copilot コネクタ | 可変 | 管理者が M365 管理センターで有効化 |

## ファイル形式

- 埋め込み（直接アップロード）: .doc/.docx/.pdf/.ppt/.pptx/.txt（各 512 MB）、
  .xls/.xlsx（30 MB）。**.html は不可**
- **.html は SharePoint 上のファイルとしてのみサポート**
- 暗号化・パスワード保護・二重キー暗号化・抽出権限制限つきファイルは不可
- グラウンディングに使われるのは**テキストのみ**（画像・CSS・JS は無視）
- アップロード後のインデックスに数分かかる

## エージェントビルダーでできないこと（注意点）

- 一般知識（Web 知識）での回答を完全には遮断できない。厳密な制御が必要なら
  Copilot Studio（有償）が必要
- 埋め込みファイルはテナントの SharePoint Embedded コンテナに保存される
  （管理者が SharePoint 管理センターから管理可能）
- Microsoft Purview Information Barriers は埋め込みファイルでは非サポート

## 出典

- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder-add-knowledge
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-instructions
- https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-best-practices
