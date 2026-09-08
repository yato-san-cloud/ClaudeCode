# 現場マニュアルツール群

スマホで**写真を撮りながら、その場で作業手順書が作れる**オフラインツール群。サーバー不要・インストール不要・費用ゼロ。

| ツール | 役割 |
|---|---|
| **planner.html 作業計画ウィザード** | やりたいことを一言書く→作業タイプ別テンプレートから**手順の骨格・業務フロー・撮影指示書**を生成。「⚡すぐ作る」なら3クリックで簡易版（空欄は【要記入】表示）。骨格(.json)はそのままindex.htmlに取り込める。AI用プロンプトのコピーにも対応 |
| **index.html マニュアル作成ツール** | 撮影→注釈→手順化→品質チェック→承認欄つきA4様式のHTML/PDF書き出し |
| **Copilot 365 エージェント版（任意）** | 同じ計画機能をMicrosoft 365 Copilotのエージェント／エージェントスキル（SKILL.md）として提供。貼り付け用定義は [docs/copilot-planner-agent.md](docs/copilot-planner-agent.md)、スキル本体は `copilot/skills/genba-work-planner/` |

**基本の流れ**：planner.htmlで計画（1分）→ 指示書を作業者に渡す → 作業者が実施・撮影 → 骨格(.json)をindex.htmlに取り込み → 写真を当てはめて完成 → 台帳へ提出。計画はCopilotエージェント経由でも可（出力契約が同じため合流する）。

## 使い方（index.html）

1. `index.html` をスマホ／PCのブラウザで開く
2. 「＋ 新規作成」→「＋ 手順を追加」でカメラ起動 → 撮る → 説明を書く、の繰り返し（アルバムからの選択も可）
3. 撮った写真をタップすると **赤丸・矢印・番号スタンプ・文字** を書き込める
4. 手順ごとに「手順／⚠注意／☑点検」を選べる（点検はチェックリストになる）。似た手順は⧉で複製。手順ごとに🎓教育・引継ぎメモ（目安時間・完了条件・よくあるミス・報告基準）も書ける
5. 「✅ 提出前チェック」で品質スコア（100点満点）と不足項目を確認、承認前チェック7項目・改善効果（削減h/月）を記録。台帳JSON/CSVも出力可能（kintone/Teams Lists・RK連携用）
6. 「⬇ HTML書き出し」で完成品を1ファイル保存 → Teams/Kintone/メールで共有。書き出し後に編集すると一覧に「✎ 未提出の変更」が表示され、提出忘れを防げる
7. 本数が増えたら一覧上部の検索でタイトル・設備名から絞り込み。カードの品質ランク（A〜D）で見直し対象も一目で分かる

## 書き出したマニュアルでできること

- **▶ 現場モード**: 1手順ずつ大きく表示（スマホ向け）。写真はタップで全画面拡大
- **☑ チェックリスト**: 点検の実施記録（実施者・日付つき、印刷可）。「記録をコピー」でTeams/Kintoneへ報告
- **📢 フィードバック**: 「実際と違う」をその場で記録→コピーしてTeams/Kintoneへ貼るだけ
- **⚠ 期限切れ警告**: 次回見直し日を過ぎると、マニュアル自身が警告を表示
- **再取り込み**: 書き出したHTMLをツールに読み戻して改訂できる（版数管理つき）
- **🖨 印刷 / PDF**: 承認欄（作成・確認・承認）つきの様式で出力

## データの保存について

- 入力内容は**端末のブラウザ内**（IndexedDB）に自動保存。オフラインでも消えない
- 端末をまたぐ共有は「HTML書き出し」または「全データをバックアップ(.json)」で
- バックアップは週1回、共有場所（Teams/Kintone）への保存を推奨
- Copilot「作業指示書ジェネレーター」の指示書（.md/.txt）も「取り込み」可能。【撮影】ブロックから手順の骨格（対象＝タイトル、合格条件＝完了条件）が自動生成され、写真を撮って埋めるだけでマニュアルになる

## 運用設計・仕様書

- **詳細仕様書（全体アーキテクチャ／キーエンスRK連携／ロードマップ）**: [docs/spec.html](docs/spec.html) — ブラウザで開く・A4印刷対応
- 運用設計の背景・Teams/Kintone比較の詳細: [docs/operations-design.md](docs/operations-design.md)
- RK連携のデータ契約（埋め込みJSON・台帳CSVスキーマ・作業指示書取込）: [docs/rk-interface-spec.md](docs/rk-interface-spec.md)
- 市販ツール（Teachme Biz / tebiki 等）調査と設計判断・乗り換え条件: [docs/market-research.md](docs/market-research.md)
- Copilot 365 エージェント版のビルド手順・受け入れテスト・費用: [docs/copilot-planner-agent.md](docs/copilot-planner-agent.md)
- 引き継ぎ資料（正本の所在・凍結契約・設計判断ログ・フェーズ2計画）: [docs/HANDOVER.md](docs/HANDOVER.md) ／ 過去マニュアル評価メモ: [docs/lumen-manual-review.md](docs/lumen-manual-review.md)

## 開発

- 依存なしの素のHTML+CSS+JS（オフライン要件のため外部CDN禁止）
- テスト: `node tests/smoke.js`（エディタ・ビューア） / `node tests/planner-smoke.js`（ウィザード＋クロス連携） / `node tests/copilot-agent-contract.js`（Copilotエージェント出力契約）
