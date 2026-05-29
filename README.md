# カイロ紹介状アプリ

整体・カイロプラクティック院向けの **紹介状自動生成** + **レントゲン骨盤分析** をひとつにまとめたデスクトップアプリ。

## 機能

### 1. 紹介状の自動生成
- 院内のWebフォームから患者情報を入力 → 紹介状PDFを即ダウンロード
- Google Form連携用のWebhook API (`/api/google-form-webhook`)
- 日本語の全角/半角を考慮した自動折り返しと、長文時の自動改ページ
- X線注釈画像を紹介状に添付可能

### 2. レントゲン骨盤分析（ヒューマン・イン・ザ・ループ）
- 骨盤傾斜・脚長差・脊椎アライメントの3種類
- OpenCVで基準点（ランドマーク）を自動検出 → **施術者がドラッグで補正**
- 補正に合わせて計測値をリアルタイム再計算
- スケール設定で **mm 換算**（未設定なら px のみ表示）
- 補正後の注釈画像をダウンロード／紹介状に添付

## 起動方法（3通り）

### A. ダブルクリックで起動（先生向け・最も簡単）
- **Windows**: `start.bat` をダブルクリック
- **macOS**: `start.command` をダブルクリック
  - 初回のみ「開発元未確認」警告 → 右クリック→「開く」で許可

初回起動時は仮想環境を作成し、依存パッケージを自動でインストールします。
2回目以降はそのまま立ち上がります。

### B. 単一実行ファイルとして配布する
```bash
pip install pyinstaller
pyinstaller chiro_app.spec
# 成果物: dist/ChiroReferralApp(.exe)
```
USB等で先生のPCにコピーして、ダブルクリックで起動できます。

### C. 開発用（ターミナルから）
```bash
pip install -r requirements.txt
python desktop.py     # ネイティブウィンドウで起動
# または
python app.py         # 通常のFlask（ブラウザでアクセス）
```

## PWAとしてインストール

ブラウザで開いた状態（`python app.py`等）なら、Chrome/Edge から「アプリとしてインストール」できます。
- ナビバーの「アプリとしてインストール」ボタン、またはアドレスバーの＋アイコン
- インストール後はホーム画面/スタートメニューから単体アプリのように起動

## テスト

```bash
python tests/test_basic.py
```

## 構成

```
desktop.py                  デスクトップアプリ起動 (pywebview)
app.py                      Flaskアプリ本体
modules/
  referral_letter.py        紹介状PDF生成 (CJK折返し・改ページ・画像添付)
  xray_analyzer.py          ランドマーク検出 / 計測 / 注釈描画
templates/                  画面 (ホーム・紹介状・X線分析)
static/
  css/style.css
  manifest.webmanifest      PWAマニフェスト
  sw.js                     Service Worker (オフライン対応)
  icons/                    アプリアイコン
  sample/                   テスト用サンプル画像
tests/test_basic.py         動作確認テスト
chiro_app.spec              PyInstaller 設定 (単一実行ファイル化)
start.bat / start.command   ワンクリック起動スクリプト
```

## Google Form連携

Google FormのApps Scriptから、フォーム送信時に以下を呼びます：

```javascript
function onFormSubmit(e) {
  var data = {};
  for (var key in e.namedValues) data[key] = e.namedValues[key][0];
  UrlFetchApp.fetch("https://<デプロイ先>/api/google-form-webhook", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(data)
  });
}
```

院内のPCで使うだけならGoogle Form連携は不要で、内蔵のWebフォームでOK。

## 注意

X線の計測値はあくまで参考値です。臨床判断は必ず専門家（医師）が行ってください。
