# jancode-dimensions

在庫データ(Excel)の **JANコード** から **三辺サイズ(縦・横・高さ)** を自動で調べ、
同じシートに転記するツールです。三辺合計(cm)も自動計算するので、宅配便のサイズ区分
(60/80/100/…)の判定にそのまま使えます。

## 重要: 「JANコード → 三辺サイズ」の情報源について

JANコード(バーコードの番号)**そのものにはサイズ情報が含まれていません**。
必ず何らかの商品データベースを参照する必要があります。調査した結果、現状は以下のとおりです。

| 取得元 | サイズの持ち方 | 精度 | 備考 |
|--------|----------------|------|------|
| **自社マスタ(CSV)** | 構造化(列で保持) | ◎ 確実 | 外部依存なし。**まずはこれを推奨** |
| **AI推定(Claude API)** | 商品名からLLMが推定 | ○ 推定値 | 市販の梱包支援SaaSと同方式。マスタ不要。要APIキー |
| **楽天市場 商品検索API** | 説明文の自由テキスト | △ ばらつき大 | 三辺の構造化フィールドは無い。要APIキー |
| **Yahoo!ショッピングAPI v3** | 説明文の自由テキスト | △ ばらつき大 | 同上。`jan_code` 検索は可。要APIキー |
| Amazon PA-API | 構造化(ItemDimensions) | ― | **2026-05-15 に廃止済み**のため非対応 |

つまり「無料・構造化・JAN→三辺」の万能APIは存在しません。本ツールは
**取得元を差し替え・追加できる「プロバイダ + キャッシュ」方式**を採用し、
確実な自社マスタを軸に、AI推定や楽天/Yahoo をベストエフォートで補完できるようにしています。

## インストール

```bash
pip install -r requirements.txt
# もしくは
pip install -e .
```

## 使い方

### 1. 自社マスタだけで転記(推奨・外部API不要)

JAN→サイズの対応表(CSV)を用意し、それを参照して転記します。

```bash
python -m jancode_dimensions process 在庫.xlsx \
    --master examples/master_sample.csv \
    --output 在庫_転記済み.xlsx
```

マスタCSVのヘッダは日本語/英語どちらでも可。次のいずれかの形式でサイズを記述します。

- 幅・奥行・高さ を個別の列で持つ（列名例: `幅,奥行,高さ` / `width,depth,height`）
- サイズを1列の自由テキストで持つ（列名例: `サイズ`。`幅40×奥行30×高さ25cm` などを自動解釈）

（`examples/master_sample.csv` に両方の例を同梱しています）

### 2. AI推定で補完(マスタ不要・商用サービスと同方式)

市販の梱包支援SaaS(梱包アシストAI等)と同じく、**商品名からAIがパッケージサイズを推定**します。
JAN→正確なサイズの無料DBは存在しないため、「梱包用途なら推定で十分」という割り切りの方式です。
入力Excelの`商品名`列を推定の材料に使うので、外部の商品検索APIは不要です。

```bash
pip install anthropic
export ANTHROPIC_API_KEY=あなたのAPIキー   # https://console.anthropic.com/

python -m jancode_dimensions process 在庫.xlsx \
    --providers local,ai \
    --master master.csv \
    --output 在庫_転記済み.xlsx
```

- マスタに無いJANだけがAI推定に回ります(`local,ai`の順でフォールバック)
- 推定した行は`備考`列に **「AI推定(要確認)」** と明示されます
- 結果はキャッシュされ、同じJANを2回推定することはありません
- 目安コスト: 既定モデル(claude-opus-4-8)で1商品あたり約0.5円。`--ai-model claude-haiku-4-5` なら約0.1円
- `商品名`列が無い行・空の行は推定しません(JAN番号だけからの推定は行わない設計)

### 3. 楽天/Yahoo で補完(要APIキー)

マスタに無いものだけをオンライン検索でフォールバックします。

```bash
export RAKUTEN_APP_ID=あなたの楽天アプリID
export YAHOO_APP_ID=あなたのYahooアプリID

python -m jancode_dimensions process 在庫.xlsx \
    --providers local,rakuten,yahoo \
    --master master.csv \
    --sleep 1.0 \
    --output 在庫_転記済み.xlsx
```

`--providers` に列挙した順にフォールバックし、**サイズが取れた時点で確定**します。
オンライン取得結果は SQLite キャッシュに蓄積され、次回以降は再検索しません
(`--sleep` はAPIのレート制限対策の待機秒)。

全部を組み合わせることもできます: `--providers local,rakuten,yahoo,ai`
(マスタ→楽天→Yahoo→最後にAI推定。楽天/Yahooで商品名だけ取れた場合、
その商品名がAI推定の材料として引き継がれます)

### 主なオプション

| オプション | 説明 |
|-----------|------|
| `--output PATH` | 出力先。省略時は入力を上書き |
| `--sheet NAME` | 対象シート名（省略時アクティブシート） |
| `--jan-column NAME` | JAN列のヘッダ名（省略時は自動判定） |
| `--providers LIST` | 取得元をカンマ区切りで指定（既定 `local`）。`local` / `ai` / `rakuten` / `yahoo` |
| `--master PATH` | 自社マスタCSV（`local` 用） |
| `--ai-model ID` | `ai` 用のClaudeモデルID（既定 `claude-opus-4-8`、安価にするなら `claude-haiku-4-5`） |
| `--cache PATH` | キャッシュDBのパス |
| `--no-cache` | キャッシュを使わない |
| `--sleep SEC` | リモートAPI呼び出しの最小間隔（秒）。ローカル参照・キャッシュヒットでは待たない |
| `--limit N` | 処理する最大件数（動作確認用） |
| `--dry-run` | 保存せず結果だけ表示 |

## 転記される列

入力シートのヘッダ末尾に以下の列を追記します（同名列が既にあれば上書き＝再実行しても列は増えません）。

`幅(cm)` / `奥行(cm)` / `高さ(cm)` / `三辺合計(cm)` / `取得元` / `照合商品名` / `取得日時` / `備考`

`照合商品名` は取得元で見つかった商品名です。**入力に既にある `商品名` 列は上書きしません**。
JANが正しい商品に一致したかの確認用として、別列に出力します。

JAN列は `JAN` `JANコード` `商品コード` `バーコード` 等から自動判定します
（見つからなければ `--jan-column` で指定）。

## 仕組み(アーキテクチャ)

```
Excel(JAN列+商品名) → LookupPipeline ──▶ Cache(SQLite) ──▶ 各Provider(順にフォールバック)
                                                             ├─ LocalMasterProvider (CSV)
                                                             ├─ RakutenProvider     (テキスト抽出)
                                                             ├─ YahooProvider       (テキスト抽出)
                                                             └─ AiEstimateProvider  (商品名からAI推定)
                    ← 幅/奥行/高さ/三辺合計 を転記
```

- `parser.py` … 「幅30×奥行20×高さ10cm」等の自由テキストから寸法を抽出（cm正規化）
- 幅/奥行/高さの割り当ては取得元表記に依存し必ずしも正確でないが、**三辺合計は順序に依存しない**ため配送サイズ判定には問題ありません。

### 取得元を追加したい場合

`DimensionProvider` を実装して `lookup(jan) -> ProductInfo | None` を返すだけです
（`providers/base.py` 参照）。Keepa等の有料APIや基幹システム連携もここに足せます。

## テスト

```bash
pytest            # 外部依存なしで parser / pipeline を検証
```
