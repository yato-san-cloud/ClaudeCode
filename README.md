# おおはしこどもクリニック 予約支援ツール

三島市・おおはしこどもクリニックの MEDICALPASS 順番受付（一般診察、当日朝6:00開始）を、
受付開始時刻ちょうどに自動で取るためのツールです。

## 大事な前提

- **自分（家族）の予約1件を、開始時刻に人間1人分の操作として取る**ためのものです。
  サーバーへの連打・並列アクセスはしない設計です（失敗時のみ数秒間隔で限定リトライ）。
- MEDICALPASS の利用規約はご自身で確認のうえ、自己責任で使ってください。
- 診察券番号・パスワード等は `.env` にのみ書き、絶対にコミットしないでください（`.gitignore` 済み）。

## 確認済みの予約フロー（MEDICALPASS）

1. `https://medicalpass.jp/users/login` でメールアドレス＋パスワードでログイン
2. 診療科ページ `https://medicalpass.jp/departments/2860` へ
3. 家族を複数登録している場合、受診する子を選択（`patientName` で指定）
4. メニュー「診察 / 注射 / 診察＋注射」から選ぶ
5. 受付内容の確認 →「受付する」
6. 受付番号（整理券）が発行されて完了

> 一般受付は当日6:00開始。整理券方式で、**定員に達すると受付停止**します（=激戦）。

## セットアップ（毎朝動かす手元のPC/サーバーで）

```bash
npm install
npx playwright install chromium
cp .env.example .env   # メールアドレスとパスワードを記入
```

Node.js 18 以上が必要です。

## 使い方

### 0. 設定なしで動く部分を確認

```bash
npm run selftest   # 時刻計算・設定読み込みの自己テスト（ネット不要）
```

### 1. 画面構造の記録（初回のおすすめ）

```bash
npm run inspect
```

ブラウザが開くので、**普段どおり手で**ログイン → 予約メニュー → 確認画面の手前まで操作。
操作内容（HTML・スクリーンショット・API通信）が `recon-output/` に自動保存されます。
スクリプト自身は何もクリックしません。保存フォルダを見て `config.json` の
`menuTextCandidates` / `proceedButtonTexts` / `successTexts` を実画面に合わせて調整できます。

### 2. 動作確認（予約はしない）

```bash
npm run book:dry
```

ログイン → 診療科ページ到達 → メニュー検出、までを今すぐ確認し、
`screenshots/dry-department.{png,html}` を保存します。

### 3. 本番

前日夜〜当日5:55までに起動しておくと、6:00ちょうどに予約を試行します。

```bash
npm run book
```

- NICT（日本標準時）と時刻同期してから待機
- 5分前にログインを済ませ、6:00:00 に予約を実行、各ステップをスクリーンショット保存
- `.env` に `NOTIFY_WEBHOOK_URL` を設定すると Discord/Slack に結果を通知

### 毎朝自動実行（cron 例, JST）

```
50 5 * * * cd /path/to/this/repo && npm run book >> book.log 2>&1
```

## 設定

### `config.json`

| キー | 意味 |
| --- | --- |
| `loginUrl` | ログインページ（既定 `https://medicalpass.jp/users/login`） |
| `departmentUrl` | 診療科ページ `https://medicalpass.jp/departments/2860` |
| `targetTimeJst` | 受付開始時刻（既定 `06:00:00`） |
| `preOpenLeadMinutes` | 何分前にログインして待機するか（既定 5） |
| `patientName` | 受診する子の氏名（家族1人なら空でよい） |
| `menuTextCandidates` | 押すメニュー名の候補（上から順に探す） |
| `proceedButtonTexts` | 確認画面で押すボタン名の候補 |
| `successTexts` | 予約完了と判定するテキスト |
| `closedTexts` | 受付前/停止と判定するテキスト |
| `retry` | 失敗時のリトライ間隔と上限 |
| `headless` | `false` でブラウザ表示（動作を目視できる） |

### 環境変数（任意）

| 変数 | 用途 |
| --- | --- |
| `MEDICALPASS_EMAIL` / `MEDICALPASS_PASSWORD` | ログイン情報（必須, `.env`） |
| `NOTIFY_WEBHOOK_URL` | 結果通知の Discord/Slack Webhook |
| `HEADLESS` | `1` でヘッドレス強制（サーバー実行時） |
| `CHROMIUM_PATH` | ブラウザ実行ファイルを固定パスで指定したい場合 |

## 現状のステータス

- ログインURL・診療科URL・フロー構成は公開情報から**確認済み**。
- 各画面のボタン/メニューの正確な表記は、`menuTextCandidates` などに複数候補を入れて
  テキスト一致で拾う設計にしてあります。初回に `npm run inspect` で実画面を記録すると確実です。
- 時刻同期・設定読み込み・ブラウザ起動・遷移までは検証済み
  （`npm run selftest` と `npm run book:dry` で確認可能）。
