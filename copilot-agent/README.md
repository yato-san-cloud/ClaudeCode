# LYNA配車アドバイザー — Microsoft 365 Copilot エージェント作成キット

LYNA自動配車クラウドの操作案内・トラブル対処・運用提案を行う Copilot エージェントを
作るための一式です。**推奨はA案(エージェントビルダー)。コード不要で約10分で作れます。**

## フォルダ構成

| ファイル | 用途 |
|---|---|
| `instructions.md` | エージェントの指示文(貼り付け用) |
| `knowledge/LYNAナレッジ01〜08.md` | ナレッジとしてアップロードするファイル(全8点、ユーザーガイド全137ページの要約) |
| `declarativeAgent.json` | 宣言型エージェントのマニフェスト(B案の開発者向け) |

---

## A案: Copilot エージェントビルダーで作る(推奨・ノーコード)

前提: Microsoft 365 Copilot ライセンス。

1. **M365 Copilot** (copilot.cloud.microsoft または Teams の Copilot) を開く
2. 右側の「**エージェントを作成する**」(Create agent) をクリック
3. 「**構成**」(Configure) タブに切り替えて手動設定にする
   - **名前**: `LYNA配車アドバイザー`
   - **説明**: LYNA自動配車クラウドの操作案内・トラブル対処・分析/運用提案を行うアシスタント
   - **指示**: `instructions.md` の「---」以降を全文貼り付け
4. **ナレッジ**: 「ファイルのアップロード」で `knowledge/` 内の8ファイルをすべてアップロード
   - ※SharePointにチームサイトがある場合は、8ファイルをサイトに置いてそのフォルダを
     ナレッジソースに指定する方法でもOK(更新が楽になります)
5. **機能**: Web検索は**オフ**推奨(ナレッジ外の推測回答を防ぐため)
6. 「**作成**」→ 動作テスト → 「**共有**」でチームメンバーへ配布

### 動作テストの例
- 「未配車で"距離制約"と出ています。どうすればいい？」
  → 車両の最大距離・訪問先の位置精度(誤位置)の確認を案内できればOK
- 「共通マスタを直したのに計画に反映されない」
  → 仕様(計画内マスタはコピー)と計画作り直しを案内できればOK
- 「ドライバーの稼働を平準化したい」
  → 配車設定の平準化機能(7.2.5.4)を提案できればOK

## B案: 宣言型エージェント(開発者向け・Teamsアプリとして配布)

組織全体に管理配布したい場合はこちら。

1. [Microsoft 365 Agents Toolkit](https://aka.ms/M365AgentsToolkit) (VS Code拡張)をインストール
2. 新規プロジェクト → 「Declarative Agent」を選択
3. 生成された `appPackage/declarativeAgent.json` を本フォルダの同名ファイルで置き換え、
   `instructions.md` を `appPackage/instructions.md` として配置
4. ナレッジは SharePoint サイトに `knowledge/` の8ファイルをアップロードし、
   `declarativeAgent.json` の `capabilities` に OneDriveAndSharePoint を追加:
   ```json
   "capabilities": [
     {
       "name": "OneDriveAndSharePoint",
       "items_by_url": [
         { "url": "https://<テナント>.sharepoint.com/sites/<サイト>/<ライブラリ>/LYNAナレッジ" }
       ]
     }
   ]
   ```
5. Toolkit の「Provision」でサイドロード → テスト → 管理者による組織配布

## メンテナンス

- **ナレッジの更新**: LYNAのバージョンアップ時は、Claude Code のこのリポジトリで
  ノート(`.claude/skills/lyna-advisor/references/`)を更新 → 本フォルダの knowledge/ にも
  反映 → エージェントのナレッジを差し替え
- **対象バージョン**: 現在 v2.22.1 (2026-02時点)。8.5「(計画)編集できること」のみ未収録
- 関連資産: 検索できる実務マニュアル(Artifact) / Claude Code スキル `lyna-advisor`
