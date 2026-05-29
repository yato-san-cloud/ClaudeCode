# おションション 📝

Notionみたいなイケてるメモアプリ。ビルド不要・依存ゼロのバニラ構成（HTML / CSS / JavaScript）で、ブラウザだけで動きます。データはすべて `localStorage` に自動保存されるので、サーバーもアカウントも不要です。

![おションション](https://img.shields.io/badge/build-none-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue)

## 使い方

`index.html` をブラウザで開くだけ。

```bash
# そのまま開く
open index.html        # macOS
xdg-open index.html    # Linux

# もしくは簡易サーバーで
python3 -m http.server 8000   # → http://localhost:8000
```

## できること

| 機能 | 説明 |
| --- | --- |
| 📄 複数ページ | サイドバーからページの作成・切り替え・削除 |
| 🧱 ブロックエディタ | 本文行で `/` を打つとブロックメニューが開く |
| ✍️ Markdown記法 | `# ` `## ` `### ` `- ` `1. ` `[] ` `> ` `--- ` を行頭で入力すると自動変換 |
| ✅ ブロックの種類 | テキスト / 見出し(H1〜H3) / ToDo / 箇条書き / 番号付き / 引用 / コールアウト / コード / 区切り線 |
| 🔀 並べ替え | 行左の `⠿` ハンドルをドラッグして移動 |
| 😀 アイコン | ページ見出しの絵文字をクリックして変更 |
| 🔍 検索 | サイドバーからタイトル・本文を横断検索 |
| 🌙 テーマ | ライト / ダークを切り替え |
| ⬇️ 書き出し | 現在のページをMarkdownファイルとしてダウンロード |
| 💾 自動保存 | 入力は自動で `localStorage` に保存（タブを閉じる直前にフラッシュ） |

## キーボードショートカット

| キー | 動作 |
| --- | --- |
| `Ctrl/Cmd + N` | 新しいページ |
| `Ctrl/Cmd + B` | サイドバー開閉 |
| `Ctrl/Cmd + F` | 検索にフォーカス |
| `/` | ブロックメニューを開く |
| `Enter` | ブロックを分割（リストは継続） |
| `Backspace`（行頭） | 前のブロックと結合 / スタイル解除 |
| `↑ / ↓` | 行端でブロック間を移動 |

## ファイル構成

```
index.html   マークアップとアプリの骨格
styles.css   Notion風のスタイル・ライト/ダークテーマ
app.js       状態管理・ブロックエディタ・永続化（依存なし）
```

## 技術メモ

- フレームワーク・ビルドツールなし。`app.js` は IIFE 1ファイルで完結。
- 各ページは `{ id, emoji, title, cover, blocks[] }`、ブロックは `{ id, type, text, checked }` という素直なデータ構造。
- `contenteditable` ベースのエディタ。キャレット位置の取得・復元、ブロックの分割／結合を自前で実装。
- `contenteditable` の末尾スペースが `&nbsp;` になる挙動を正規化してMarkdownショートカットを安定動作させています。
- 保存はデバウンスしつつ、`visibilitychange` / `pagehide` / `beforeunload` でフラッシュしてデータ消失を防止。
