# RK連携インターフェース仕様（キーエンスRK ⇔ 現場マニュアルツール）

RKシナリオ（RK-01〜05）がツールの成果物を機械的に処理するための契約仕様。
**この仕様は凍結扱いとし、変更時はRKシナリオと同時改修する**（spec.html §6.4）。

## 1. 基本方針

- RKは画面操作ではなく、**ファイル・JSON・CSV**を主なインターフェースとする（Teams/Kintone画面の小変更で壊れるリスクを避ける）
- 台帳キーは `manual_id + version`。同一 `manual_id` で版数が上がったら改訂として扱い、旧版は `90_旧版` へ退避する

## 2. 入力（RKが読むもの）

| 入力 | 場所 | 用途 |
|---|---|---|
| 書き出しHTML | `00_提出_inbox` | 正本。RK-01/02の処理対象 |
| 台帳JSON / 台帳CSV（任意） | 同上 | 作成者がツールの「台帳JSON/CSV」で出力した場合、HTMLパース不要で台帳登録可能 |
| バックアップJSON | `98_バックアップ` | RK-05の世代管理対象 |

## 3. HTML内の読み取り対象（データ契約）

読み取り対象は **`<script type="application/json" id="__manualdata">` の1箇所のみ**。
`__manualext` という別タグは存在しない（レビュー版で提案されたが、契約を1つに保つため
`__manualdata` 内の `ext` フィールドに統合した）。

```jsonc
{
  "id": "abc123",            // manual_id（台帳キー）
  "title": "…", "place": "…", "author": "…", "approver": "…",
  "version": "1.2", "status": "active", "reviewDate": "2026-10-31",
  "note": "…", "tools": "…", "createdAt": 1234567890,
  "ext": {
    "approval": { "photoSecurity": true, "orderChecked": true, "...": "承認前チェック7項目" },
    "effect":   { "beforeMinutes": "30", "afterMinutes": "10", "monthlyCount": "20", "memo": "…" }
  },
  "steps": [
    { "id": "…", "type": "step|warn|check", "title": "…", "desc": "…",
      "photo": "data:image/jpeg;base64,…",
      "edu": { "time": "3分", "done": "完了条件", "mistake": "…", "escalate": "…" } // 任意
    }
  ]
}
```

- 正規表現での抽出例: `<script type="application/json" id="__manualdata">([\s\S]*?)</script>`
- JSON内の `<\/` は正規のJSONエスケープであり、そのままパースできる
- `ext`・`edu` は任意フィールド。存在しない旧ファイルも正常として扱うこと

## 4. 台帳CSV / JSON のスキーマ

ツールの「台帳CSV」ボタンが出力する列（1行=1マニュアル）。CSVは**UTF-8 BOM付き**（Excel/kintone文字化け対策）。

| 列 | 内容 |
|---|---|
| manual_id / title / place / version / status | 基本情報（statusは draft/wait/active/retired） |
| author / approver / reviewDate | 責任・見直し |
| updatedAt / exportedAt | 更新日・最終書き出し日 |
| stepCount / photoStepCount / warnStepCount / checkStepCount | 規模・充足 |
| qualityScore / qualityGrade / qualityBlockers | 品質スコア(0-100)・ランク(A≧90/B≧80/C≧70/D)・不足項目 |
| beforeMinutes / afterMinutes / monthlyCount / monthlySavedHours | 改善効果（削減h/月=(前-後)×回数÷60） |
| effectMemo | 改善効果メモ |

kintoneアプリのフィールドコードはこの列名に合わせると、RKのマッピングが単純になる。

## 5. 出力（RKが書くもの）

- 正本ライブラリへのHTML配置（命名: `[管理番号]_[設備]_[作業]_v[版数].html`）
- PDF変換後のPDF配置（HTMLとペア）
- 台帳アプリ/Listsへの登録・更新
- 処理ログCSV: `99_RPAログ/YYYYMM.csv`（日時・シナリオID・対象ファイル・manual_id・version・結果・エラー内容）

## 6. 異常時ルール

- 1ファイルのエラーで後続処理を止めない
- エラー対象は `_error` フォルダへ退避し、管理者向け通知を生成する（**無音停止の禁止**）
- 同一ファイルの二重処理をしない（処理済みは移動 or 台帳の更新日時と照合）。再実行は常に安全であること

## 7. 作業指示書ジェネレーター連携（【撮影】ブロック取込）

Copilotエージェント「作業指示書ジェネレーター」が出力する指示書（.md/.txt）を、
ツールの「📥取り込み」に渡すと、撮影ブロックからマニュアルの骨格を自動生成する。

### 読み取る形式（指示書側は変更禁止）

```
【撮影】No.03 ／ 対象：棚Aのラベル貼付位置 ／ ファイル名：03_ラベル位置.jpg
　　　　合格条件：ラベルの文字が読めること
```

### マッピング

| 指示書 | ツール側 |
|---|---|
| `対象：` | 手順タイトル |
| `合格条件：` | 完了条件（`edu.done`。書き出しHTML・現場モードに表示） |
| `ファイル名：` | 説明欄に「指定ファイル名：…」として記載（RK側のファイル照合用に保持） |
| `No.` | 手順の並び順（昇順。全角数字可。無い場合は出現順） |
| `今日やること：` または先頭の `# 見出し` | マニュアルのタイトル（無ければファイル名） |

- 生成されるマニュアルは下書き・写真なし（作業者が撮影して埋める）
- 区切りは全角`／`・半角`/`のどちらも可。`合格条件：`は同じ行でも次行でも可
- パースは寛容だが、ラベル語（対象／ファイル名／合格条件）の変更には追従しない

## 8. 処理イメージ（PowerShell擬似コード）

```powershell
$Inbox="C:\ManualOps\00_提出_inbox"; $Wait="C:\ManualOps\02_承認待ち"
$Err="C:\ManualOps\_error"; $Log="C:\ManualOps\99_RPAログ\manual_rk_log.csv"

Get-ChildItem $Inbox -Filter *.html | ForEach-Object {
  try {
    $text = Get-Content $_.FullName -Raw -Encoding UTF8
    $m = [regex]::Match($text, '<script type="application/json" id="__manualdata">([\s\S]*?)</script>')
    if (-not $m.Success) { throw "__manualdata が見つかりません" }
    $d = $m.Groups[1].Value | ConvertFrom-Json
    $name = "{0}_{1}_v{2}.html" -f $d.id, ($d.title -replace '[\\/:*?"<>|]','_'), $d.version
    Move-Item $_.FullName (Join-Path $Wait $name)
    # TODO: PDF変換(RK-02) / 台帳登録(RK-01) / 旧版退避
    Add-Content $Log ("{0},{1},{2},OK" -f (Get-Date), $d.id, $d.version) -Encoding UTF8
  } catch {
    Move-Item $_.FullName $Err -Force
    Add-Content $Log ("{0},{1},,NG,{2}" -f (Get-Date), $_.Name, $_.Exception.Message) -Encoding UTF8
    # TODO: 管理者通知
  }
}
```
