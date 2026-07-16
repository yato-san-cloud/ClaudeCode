# 業務OS — プロジェクト文書業務の型・Skill・ルール集

物流プロジェクト業務(議事録・審議回答・要件定義・調査依頼・版管理)をAIと分担するための横断基盤。
案件固有の成果物はGoogle Drive、**業務の「型」はこのリポジトリ**に置く。

- 初回分析: 2026-07-16(ローソン袋井サテライトPJの実ファイル群から業務構造を逆算)
- 原則: **AIはドラフトと検算まで、人間は「削る・送る・消す」の3つ**

## 構成

| パス | 中身 |
|---|---|
| `docs/00_業務マップ.md` | 業務の構造分析(日次/週次/月次、入力→処理→出力、AI/人間の分界) |
| `docs/01_自動化候補一覧.md` | 改善候補16件の評価と優先順位(全16件実装済み) |
| `docs/02_運用ルール_命名・版管理・正本.md` | 命名規則(N系)・版管理(V系)・正本(M系)・機密区分 |
| `docs/03_数字整合監査_設計.md` | numbers.json(単一数字ソース)による横断監査の設計書 |
| `.claude/skills/gijiroku/` | 議事録Skill: 文字起こし→論点別議事録ドラフト |
| `.claude/skills/suji-trace/` | 数字トレースSkill: 出典セル特定・検算・根拠整理(個別深掘り) |
| `.claude/skills/suji-audit/` | 数字監査Skill: numbers.jsonと文書群の横断一致確認 |
| `.claude/skills/handoff/` | 引継ぎSkill: セッション間HANDOFF・申し送り生成 |
| `.claude/skills/moc-audit/` | MOC棚卸しSkill: 掲載漏れ・リンク切れ・★重複検出 |
| `.claude/skills/chosa-irai/` | 調査依頼書Skill: 現場/SQL調査AI/顧客の3タイプ別に生成 |
| `.claude/skills/soteimondo/` | 想定問答Skill: 会議直前用Q&Aパック(社内限り) |
| `.claude/skills/project-init/` | 立ち上げSkill: 新案件の骨格一式をプレースホルダ置換で生成 |
| `templates/` | 議事録・根拠整理・引継ぎ書・想定問答・調査依頼書3種・Rev更新/配布前チェックリスト・プロジェクト立ち上げキット |
| `numbers/` | 単一数字ソース(numbers.json)の置き場と書き方ガイド |
| `scripts/name_lint.py` | 命名規則リント(読み取り専用、Python3のみで動作) |
| `scripts/numbers_check.py` | 数字整合監査: `<!-- num:キー -->` 注釈付き文書とJSONを突合 |
| `scripts/md2office.py` | md→docx/html統一変換(タイプ別プリセット、正本保護の_2退避付き) |
| `scripts/suji_one_pager.py` | 根拠整理md→「数字1枚」印刷対応HTML生成 |

## 使い方(Claude Codeセッションから)

このリポジトリをワーキングディレクトリにしてClaude Codeを起動すると、`.claude/skills/` のSkillが自動で使える。Driveのファイルは接続済みMCP経由で**読み取り**、成果物のドラフトはセッション内で生成する。

### 呼び出し例

```
/gijiroku 0705のIT部門打合せの文字起こし(Driveの◯◯.md)から議事録ドラフトを作って
/suji-trace 審議資料の「月+22万」の根拠をRev10まで遡って検算して
/suji-audit numbers.jsonと審議回答・数字1枚の数字が一致しているか監査して
/handoff このセッションの内容を次セッション用HANDOFFにまとめて
/moc-audit 08_システム検討フォルダとMOCを突合して
/chosa-irai 残論点T9とT12を篁さん向け現場調査シートにして
/soteimondo 0629議事録の継続論点から次回IT協議の想定問答を作って
/project-init 新案件◯◯の立ち上げキットを展開して
```

### スクリプト(いずれも読み取り専用またはドラフト生成のみ)

```bash
python3 scripts/name_lint.py --list names.txt                        # 命名規則チェック
python3 scripts/numbers_check.py numbers/numbers.json 文書.md        # 数字整合監査(--grepで注釈候補提案)
python3 scripts/md2office.py 議事録.md --type gijiroku --out docx,html # md→docx/html変換
python3 scripts/suji_one_pager.py 根拠整理.md                        # 数字1枚HTML生成
```

### 定型プロンプト: 正本サーチ

> 「◯◯(論点名)」の最新の正本を探して。手順: (1) MOC.mdの該当セクションで★付きを確認 (2) Driveで同系統の版チェーン(vN/RevN)を検索 (3) ★とファイルの版番号が食い違っていたら両方提示。docx正本ルール(docs/02のM-2)に注意。

### 命名リント

```bash
# Driveのファイル名一覧を names.txt に貼り付けて:
python3 scripts/name_lint.py --list names.txt
```

## 明日からの運用手順

1. **会議があった日**: 文字起こしを入手 → `/gijiroku` でドラフト → 手動修正 → `md2office.py` でdocx化 → `templates/配布前チェックリスト.md` を通して配布。次回協議前は `/soteimondo` で想定問答
2. **数字を変えた日**(Rev更新): `templates/Rev更新チェックリスト.md` をコピーして一巡 → numbers.jsonを更新 → `/suji-audit` で全文書の一致を機械確認(個別の深掘りは `/suji-trace`)
3. **調査を依頼するとき**: `/chosa-irai` で調査者タイプ別(現場/SQL/顧客)の依頼書を生成
4. **セッションを跨ぐとき**: 終了前に `/handoff` → 生成されたHANDOFFを次セッションの最初に貼る
5. **週1回(金曜推奨)**: `/moc-audit` でMOC棚卸し → 追記案を適用 → 気が向いたら `name_lint.py` も
6. **新案件が始まったら**: `/project-init` で骨格一式(フォルダ構成・MOC・CLAUDE.md・申し送りプロトコル)を10分で展開
7. **新しい型が生まれたら**: このリポジトリにテンプレ/Skillとして追加してcommit(業務OSを育てる)

## 安全上の約束(全Skill共通)

- Driveへの書き込み・リネーム・削除はしない(提案のみ)
- 配布・送信はしない(人間がGOを出す)
- 🔒私的メモ(人物評・交渉戦術)を配布物・引継ぎ書に転記しない
- 検算が通らない数字に✅を付けない
