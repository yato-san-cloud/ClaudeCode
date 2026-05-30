# whsim — 倉庫シミュレータ

**営業がゆるく組めて、裏で重厚なシミュレーションが走る**倉庫シミュレータ。

既存のシミュレータ（FlexSim / AnyLogic / Simio…）は、正確に動かすために全パラメータを最初に
埋めさせるため専門家しか使えません。whsim は **入力の難しさと計算の正確さを切り離す**ことで、
非エンジニア（営業）が顧客のゆるい要件をヒアリングしながらモデルを組み、裏で離散事象シミュレーション
（SimPy）を回して、**提案書にそのまま貼れる1枚の絵**を出すことを狙います。

## 設計の背骨：唯一の契約 = `model.json`

すべてのコンポーネントが、ひとつの正規スキーマ
（`whsim.schema.WarehouseModel`）を読み書きします。

```
  テンプレ ─────────┐
  ゆるい入力＋キー項目 ─┤
  分析ツールのZIP ────┼──▶  model.json  ──┬─▶ SimPyエンジン ─▶ KPI
  (将来) LLM対話 ────┘   (唯一の正)        ├─▶ 2D PNG（提案用）
                                          └─▶ (将来) 3Dレンダラ
```

- **テンプレート** = 全項目が仮値で埋まった `model.json`。だから取り込み前から必ず動く。
- **ZIP取り込み** = 分析ツールが出す複数JSON（`product_master` / `outbound` / `inbound` / `layout` …）を
  サブツリー単位で上書き。**壊れたファイルやJSON以外は優しくスキップ**し、バンドル全体は拒否しない。
  欠損は仮値のまま → **常に動く**。
- **プロベナンス**（出所＝`imported` / `interview` / `provisional`）を第一級機能として保持し、
  出力にも「N% your data」と明示。“簡単さ”と“信頼”を両立させ、将来のLLM質問リストにもなる。
- **プロジェクト（ワークスペース）** にすべてを永続化。分析ツールは供給元、whsim が正の保管庫。

## クイックスタート

```bash
pip install -e ".[dev]"

whsim templates                          # 利用可能なテンプレ一覧
whsim new acme --template ecommerce_small  # テンプレからプロジェクト作成（この時点で動く）
whsim estimate acme                      # 解析的な高速見積り（M/M/c、即答）
whsim run acme                           # 離散事象シミュレーション実行
whsim render acme                        # 提案用PNG（layout_heatmap.png）を出力
# あるいは run + render を一括：
whsim simulate acme

# 顧客データ（分析ツールが出したZIP）を取り込む：
python scripts/gen_sample_data.py        # examples/acme_upload.zip を生成
whsim new acme2 -t ecommerce_small
whsim import acme2 examples/acme_upload.zip
whsim simulate acme2
```

成果物は `projects/<name>/runs/run_XXXX/` に保存されます
（`kpis.json` / `heatmap.npy` / `layout_heatmap.png`）。

## アーキテクチャ

| モジュール | 役割 |
|---|---|
| `whsim/schema/model.py` | 正規スキーマ（pydantic）。全フィールドにデフォルト＝必ず妥当 |
| `whsim/templates.py` | テンプレ（仮値で満たした `model.json`）の読み込み |
| `whsim/importer.py` | ZIP→サブツリー判定→深いマージ→検証。寛容（壊れても止まらない） |
| `whsim/provenance.py` | 出所追跡（imported / interview / provisional）と信頼度 |
| `whsim/project.py` | ワークスペース永続化・実行管理 |
| `whsim/engine/` | SimPy 離散事象エンジン（経路・プロセス・実行） |
| `whsim/analytic.py` | M/M/c による即時見積り。エンジンのサニティ・オラクルも兼ねる |
| `whsim/kpis.py` | イベントログ→KPI＋平易な判定文 |
| `whsim/render/png2d.py` | 提案用2D PNG（レイアウト＋混雑ヒートマップ＋判定＋出所フッター） |
| `whsim/cli.py` | `whsim` コマンド |

## 開発

```bash
pytest -q                                 # 全テスト
pytest tests/test_engine.py::test_kpis_are_sane   # 単一テスト
ruff check src                            # lint
python scripts/gen_template_ecommerce.py  # テンプレ再生成
```

## ロードマップ（議論中）

- LLM対話によるモデル生成・修正（プロベナンスの provisional 項目を質問リスト化）
- バッチ/ゾーン/ウェーブピッキングなど `pick_strategy` の実装拡充
- AGV/AMR・コンベア・AS/RS など搬送設備のモデル化
- 3Dレンダラ（同じ `model.json` ＋実行成果物を入力にする“もう一つのレンダラ”）
- シナリオ比較（today vs +Nピッカー）の並置出力
