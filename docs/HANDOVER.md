# ハンドオーバー：現場マニュアルツール群（フェーズ1完了 → フェーズ2「本格業務への適用検討」）

作成日：2026-09-08 ／ 対象：本件を引き継ぐ次セッション（Claude Code）および関係者
状態：**フェーズ1「簡易ツール群の作成」完了。フェーズ2「本格業務への適用に向けた検討」を開始する段階。**

---

## 0. 正本の所在（どれが本物か）

| 場所 | 内容 | 備考 |
|---|---|---|
| **GitHub `yato-san-cloud/ClaudeCode` ブランチ `claude/field-manual-tool-hgcc93`** | **正本**。全ソース・全ドキュメント・テスト | PRは未作成（指示があるまで作らない）。mainには未マージ |
| Box フォルダ「現場マニュアル作成ツール」（folder_id 397430162319） | 完成品の写し（planner.html / index.html / docs 各種） | Boxは写し。GitHubより古い可能性があるので、疑ったらGitHubを正とする |
| ハンドオーバーZIP（本書同梱） | 上記スナップショット＋サンプル成果物＋画面キャプチャ | 次セッションの初期投入用 |

Box file_id：index.html 2331676388824 ／ planner.html 2407369504390 ／ spec.html 2331672275916 ／ README.md 2331672253462 ／
operations-design.md 2331682170619 ／ rk-interface-spec.md 2346280866250 ／ market-research.md 2407373747476 ／
copilot-planner-agent.md 2407396244486 ／ genba-work-planner-SKILL.md 2407399470188

---

## 1. 成果物一覧

| ファイル | 役割 | 状態 |
|---|---|---|
| `index.html`（約1,430行） | **マニュアル作成ツール本体**。撮影→注釈（丸・矢印・四角・ペン・番号・文字）→手順化→品質スコア（100点・A〜D）→承認前チェック7項目→改善効果→承認欄つきA4様式HTML書き出し／再取り込み。IndexedDB保存（localStorageフォールバック） | 完成・テスト34項目PASS |
| `planner.html`（約500行） | **作業計画ウィザード**。作業タイプ8種のテンプレートから、業務フロー・手順骨格・作業指示書（【撮影】ブロック入り）・骨格.json・AI用プロンプトを生成。「⚡すぐ作る」で簡易版即出力（未記入は【要記入】） | 完成・テスト16項目PASS |
| `docs/spec.html`（v1.2） | 詳細仕様書：4層アーキ、RKシナリオRK-01〜05、運用ルール、KPI、ネクストアクション、90日ロードマップ。A4印刷対応 | 完成 |
| `docs/rk-interface-spec.md` | **凍結データ契約**（埋め込みJSON・台帳CSV・【撮影】ブロック取込）。RK（キーエンスRPA）連携の唯一のインターフェース仕様 | 凍結 |
| `docs/operations-design.md` | 運用設計：Teams／Kintone比較、形骸化防止ループ、役割 | 完成 |
| `docs/market-research.md` | 市販ツール調査（Teachme Biz／tebiki 等）、機能対応表、乗り換え条件 | 完成 |
| `docs/copilot-planner-agent.md` | Copilot 365エージェント版プランナーのビルドパッケージ（貼り付け用指示・受け入れテスト・費用・出典） | 完成・未デプロイ |
| `copilot/skills/genba-work-planner/SKILL.md` | Agent Skills標準（SKILL.md）版プランナー。M365 Copilot Cowork／GitHub Copilot／Claude共通 | 完成・未設置 |
| `docs/lumen-manual-review.md` | 過去マニュアル（Lumen出荷・保管業務pptx）の評価メモ＝フェーズ2の出発点 | 完成 |
| `tests/smoke.js` / `tests/planner-smoke.js` / `tests/copilot-agent-contract.js` | Playwright E2E（34＋16＋16項目） | 2026-09-08 全PASS |
| `README.md` / `CLAUDE.md` | 利用者向け説明／Claude Code向けリポジトリ規約 | 最新 |

ZIP同梱のサンプル（`samples/`）：planner入力→生成結果→エディタ→書き出しマニュアルの画面5枚、`sample_指示書.md`、`sample_骨格.json`、`sample_AI用プロンプト.txt`、`sample_書き出しマニュアル.html`（ブラウザで開けば完成品の様式が確認できる）。

---

## 2. 全体像（1枚で）

```
[計画]  planner.html（現場・オフライン）        ─┐
        Copilot 365エージェント／SKILL.md（事務所） ─┴→ 作業指示書.md（【撮影】ブロック）＋ 骨格.json
                                                          │
[作成]  作業者が指示書どおりに撮影 → index.html に骨格.json/指示書.md を📥取り込み → 写真を当てはめ・注釈
        → ✅提出前チェック（品質A≧90／承認7項目／改善効果） → ⬇HTML書き出し（承認欄A4・現場モード・点検記録内蔵）
                                                          │
[提出]  共有フォルダ 00_提出(inbox) に置く ──→ RK-01 台帳同期 ／ RK-02 PDF変換 ／ RK-03 見直し督促 ／ RK-04 FB集計 ／ RK-05 バックアップ
                                                          │
[台帳]  Kintone または Teams Lists（未決定）──→ 承認 → 運用中 → QR掲示で現場閲覧 → 📢フィードバック → 改訂（再取り込み）
```

設計原則：**現場層は「ブラウザで開くだけ」を死守（外部依存ゼロ・オフライン）／自動化はファイルと台帳という安定インターフェース越し／AIは外付け（契約書式で還流）**。

---

## 3. 凍結契約（変えるときはRK・Copilot・テストを同時改修）

1. **書き出しHTMLの埋め込みJSON** `<script type="application/json" id="__manualdata">`：`{id,title,place,author,approver,version,status,reviewDate,note,tools,ext:{approval,effect},steps:[{id,type(step|warn|check),title,desc,photo,edu:{time,done,mistake,escalate}}]}`。photoOrig/marksは埋め込まない（サイズ抑制）
2. **【撮影】ブロック**（指示書→ツール）：`【撮影】No.01 ／ 対象：… ／ ファイル名：01_….jpg` ＋ 次行 `合格条件：…`。ラベル語「対象／ファイル名／合格条件」は変更禁止。区切りは／と/どちらも可、全角数字可
3. **骨格JSON**（planner／Copilot→ツール）：`{title,place,tools,note,status:"draft",steps:[{type,title,desc,edu}]}`。`parseImport()` がそのまま読む
4. **台帳CSV**：UTF-8 BOM付き、列定義は rk-interface-spec.md §4
5. **状態遷移**：下書き→承認待ち→運用中→要見直し→廃止（削除しない）

---

## 4. 主要な設計判断ログ（なぜそうなっているか）

| 判断 | 理由 |
|---|---|
| 単一HTML・外部依存ゼロ | 現場スマホでオフライン動作・配布はファイルコピーだけ・費用ゼロ。CDN/fetch禁止はCLAUDE.mdに明記 |
| planner をテンプレート駆動（AI非搭載）にした | 市販調査（Teachme のテンプレート機能）から採用。確定的で毎回同じ出力。AIは「AI用プロンプト」で外付け |
| 品質スコアと承認前チェックを提出ゲートにした | GPT-5.6批判的検証パッケージの提案を採用（ただし同パッケージの実装はbuildDoc内に`<script>`を注入して壊れていたため不採用、アイデアのみ採用） |
| RKには画面操作をさせない | ファイル監視・JSON読取・Excel操作に限定。UI改版で壊れない。無音停止禁止（_errorフォルダ＋通知） |
| Copilot版は「エージェントビルダー・機能ゼロ構成」を第一候補にした | 指示のみ構成はCopilot Chatユーザーに無償、指示上限8,000字（現状約2,600字）。宣言型エージェントにJSONモードは無いので**書式の最終防衛線はindex.html側パーサー** |
| 過去マニュアル活用は「pptxを上手く書くスキル」ではなく3層分解にする | ①言語化ルール ②構造化データ正本（`__manualdata`）③指定書式レンダラー。判定できる項目はリントに寄せ、AIには判断だけ残す（lumen-manual-review.md §4） |

---

## 5. リサーチ結果の要点（出典は各docに記載）

- **市販ツール**：Teachme Biz（画像ステップ型）とtebiki（動画型）が二強。相場は初期0〜65,000円・月額3,000〜300,000円。乗り換え条件＝動画が主役／多言語常時／閲覧証跡が監査要件／数百本規模（market-research.md §4）
- **Copilot 365エージェント**：指示8,000字上限、会話のきっかけ最大12、知識は種類別上限（アップロード20ファイル等）、応答フォーマット強制なし、コードインタープリターのファイル出力に.jsonは非掲載（コードブロック渡しが確実）、基盤モデルは強制更新（更新のたびに受け入れテスト再実施）。Agent Skills（SKILL.md）はGitHub Copilot（2025-12-18）とM365 Copilot Cowork（OneDrive `/Documents/Cowork/skills/`・上限50）が採用済み（copilot-planner-agent.md §7）

---

## 6. 品質状態と既知の制限

- テスト：`node tests/smoke.js`（34）／`node tests/planner-smoke.js`（16）／`node tests/copilot-agent-contract.js`（16）— 2026-09-08 すべて ALL PASS
- 未対応（意図的）：モザイク／スポットライト注釈、動画、多言語、閲覧レポート・理解度テスト、スキルマップ
- 未検証：planner.html の「生成する」ボタンを**幅430pxのモバイル表示で**Playwright経由クリックすると結果が開かない事象が1回（`generate()` 直接呼び出しは成功、PC幅のテストは通過）。実機スマホで「生成する」を1回押して確認すること。実機で再現するなら固定フッターとの重なりを疑う
- 環境制約：この実行環境ではLibreOfficeがpptxを開けなかった（pptxの画像レンダリング不可）。pptx解析はzipfile＋XML直読で可能
- Boxの写しはGitHubより遅れている可能性あり。Box MCPはテキストのみアップロード可（ZIP・画像は不可）、ツール名が再接続で変わる

---

## 7. 直近の壁打ち結果と未決論点（フェーズ2の入口）

過去マニュアル「Lumenデバイス出荷・保管業務」pptxを評価（lumen-manual-review.md）。
残す型＝工程ナビ・帳票解説ページ・ステップグリッド。直す癖＝写真負債（未添付5か所）・低解像度／回転写真・完了条件なし・版管理情報なし・工程ナビの図形が4ページに個別コピー・読者混在（顧客説明と作業者手順）。

**ユーザーに確認が必要な5点**（回答でフェーズ2の設計が変わる）：
1. 主読者は顧客（協創プロジェクト向け説明）か作業者か。両方なら「同じ正本から読者別密度で出力」が必須
2. 指定書式は4:3 pptxハウススタイルで固定か。固定なら **index.htmlのJSON→4:3 pptxレンダラー**（pptxgenjs）が最短
3. 過去マニュアルの本数・形式のばらつき、および「良かった／質問が多かった」等の評価情報の有無
4. 写真原本フォルダの有無（pptx内は縮小済み）
5. 顧客別バリアントの有無（基本版＋差分で持つのがメンテ性の最大レバー）

---

## 8. フェーズ2「本格業務への適用検討」の提案計画

| 順 | やること | 成果物 | 目安 |
|---|---|---|---|
| 1 | 過去マニュアル5〜10本を収集（pptx/xlsx/docx可）。機密ラベルの扱いを決める | 収集リスト・開示範囲一覧 | 1週 |
| 2 | **パターン集計レポート**：レイアウト頻度・文字密度・写真サイズ／向き・写真負債率・用語出現（zipfile＋XMLで機械集計） | `docs/manual-corpus-report.md` | 1週 |
| 3 | スタイルガイドv0（良い例／悪い例は自社実物から引用）＋用語辞書 | `docs/style-guide.md`, `docs/glossary.md` | 1週 |
| 4 | スキル化：`SKILL.md`＋`scripts/ingest_pptx.py`（pptx→`__manualdata` JSON＋不足レポート）＋`scripts/lint.py`（禁止語・プレースホルダ・完了条件欠落・解像度・回転）＋`scripts/render_pptx.js`（JSON→4:3ハウス様式）＋評価用ゴールデンセット | `skills/genba-manual/` 一式 | 2週 |
| 5 | パイロット：1ライン・5本を新フローで作成（planner→撮影→index.html→書き出し）、既存1本を取り込み→再生成して比較 | 比較レポート・現場の反応 | 2週 |
| 6 | 台帳基盤（Teams／Kintone）決定 → RK-02（PDF変換）→ RK-01（台帳同期）着手 | RKシナリオ | spec.html §9-10 に準拠 |
| 7 | Copilotエージェント（パスA）を作成し受け入れテスト、SKILL.mdをCoworkに設置 | 稼働エージェント | 1日＋テスト |

---

## 9. 次セッションでの再開手順

```bash
# 1) 正本の取得（コンテナ再作成後も同じ）
git fetch origin claude/field-manual-tool-hgcc93
git checkout -B claude/field-manual-tool-hgcc93 origin/claude/field-manual-tool-hgcc93

# 2) 動作確認（Playwright: /opt/node22/lib/node_modules、Chromium: /opt/pw-browsers/chromium）
node tests/smoke.js && node tests/planner-smoke.js && node tests/copilot-agent-contract.js
```

守ること（CLAUDE.md にも記載）：外部依存を足さない／`buildDoc()` 内の `</script>` は `<\/script>`、VIEWER_JS内にバッククォート・`${`・単独バックスラッシュを書かない／凍結契約を変えるときはRK仕様・Copilot指示・テストを同時改修／顧客名入りの過去マニュアル原本はリポジトリにコミットしない（評価メモのみ）／PRは指示があるまで作らない／GitHub操作はMCP経由。

**次セッションへの最初の指示（コピー用）**：
「ZIP内の docs/HANDOVER.md を読み、§7の5つの未決論点を私に確認してから、§8の手順2（過去マニュアルのパターン集計レポート）から着手して。過去マニュアルはこれから渡す。」
