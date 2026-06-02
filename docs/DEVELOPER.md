# whsim 開発者ガイド

倉庫シミュレータ whsim の設計・コンポーネント・拡張方法・テスト/lint をまとめます。
ユーザー向けの導入は [`USER_GUIDE.md`](USER_GUIDE.md) を、全体像は
リポジトリ直下の [`README.md`](../README.md) を参照してください。

---

## 1. 設計の背骨：唯一の契約 `WarehouseModel`

すべてのコンポーネントは **ひとつの正規スキーマ**
`whsim.schema.model.WarehouseModel`（pydantic v2）を読み書きします。

```
  テンプレ ───────────┐
  設計エディタの編集 ──┤
  顧客ZIP（分析ツール）─┼──▶  WarehouseModel  ──┬─▶ SimPy エンジン ─▶ KPI
  CAD(DXF) / 距離CSV ──┤      (唯一の正)         ├─▶ 2D PNG / GIF（提案用）
  Cody チャット ───────┘                         └─▶ 3D（three.js）リプレイ
```

設計上の不変条件：

- **全フィールドにデフォルト値がある** → どんなモデルも常に妥当で、常に実行可能
  （"never blocks on missing data"）。この規則はスキーマで構造的に強制されます。
- 各コンポーネントは **このスキーマと実行成果物に対する純関数**として書かれており、
  独立してテスト・差し替え可能です。
- 厳格バリデーションは既定。乱れた取り込みデータの補正は **インポート経路のみ**で行います
  （`WarehouseModel.coerce_messy()` / `normalize_ids()`）。手入力の不正値は普通に検証エラー。

---

## 2. コンポーネント一覧（`src/whsim/`）

| モジュール | 役割 |
|---|---|
| `schema/model.py` | 正規スキーマ。全項目デフォルト。`coerce_messy` / `normalize_ids` も持つ |
| `templates.py` | テンプレ（仮値で満たした `model.json`）の読み込み |
| `importer.py` | ZIP→サブツリー判定→深いマージ→検証。寛容（壊れても止めない、部分取込OK） |
| `provenance.py` | 出所追跡（`imported` / `interview` / `provisional`）と「N% your data」 |
| `project.py` | ワークスペース永続化（`projects/<name>/`、gitignore 済み）・実行管理 |
| `distances.py` | 実測の棚間距離行列（CSV/JSON）を寛容に取り込み（`distance_overrides`） |
| `cad.py` | DXF 取り込み（ezdxf）→ 外形/壁/ゾーン（m 単位、mm/m 自動判定） |
| `design.py` | `materialize_racks`：ゾーンの棚パラメータ→具体的 `locations` 格子（SKU 再ペグ） |
| `slotting.py` / `workmethod.py` | ABC スロッティング / 作業方式（5軸）の補助 |
| `analytic.py` | M/M/c の閉形式即時見積り。エンジンのサニティ・オラクルも兼ねる |
| `engine/` | SimPy 離散事象エンジン（下記） |
| `kpis.py` | イベントログ→KPI（コスト含む）＋平易な日本語判定文 |
| `cody.py` | チャット意図ルータ（`respond()`）。LLM 差し替えの seam（純関数・IO なし） |
| `render/replay.py` | リプレイ契約（2D/3D 両ビューが消費する軌跡データ） |
| `render/png2d.py` | 提案用 2D PNG（レイアウト＋混雑ヒートマップ＋判定＋出所フッター） |
| `render/anim2d.py` | 動く 2D リプレイ GIF（サーバサイド、ブラウザ不要） |
| `export_doc.py` | 編集可能な提案書 PPTX/PDF（python-pptx / reportlab、CJK フォント） |
| `web/app.py` | FastAPI バックエンド＋SPA フロント（`static/`） |
| `cli.py` | `whsim` コマンド（new / import / run / render / animate / simulate / estimate / serve） |

### エンジン（`src/whsim/engine/`）

| モジュール | 役割 |
|---|---|
| `build.py` | モデル→ワールド（資源・ゾーン・ロケーション・作業者）を構築 |
| `graph.py` | 壁対応の通路格子（4連結 occupancy grid）＋ Dijkstra。`World.dist` = 実測 override > graph > Manhattan |
| `routing.py` | Manhattan 距離など基本ルーティング |
| `processes.py` | SimPy プロセス：`order_source` / `picker_agent` / `agv_agent` / `forklift_agent` ほか。作業員・AGV は個体エージェント |
| `run.py` | `run_once` / `run_replications`（モンテカルロ、ヒート平均） |
| `scenarios.py` | ドット経路編集の what-if（`apply_scenario`）＋ `payback_months` |

**AGV モードはパイプライン**：AGV エージェントが totes を取りに行き → ready queue →
ピッカーが処理。バッチ/ゾーン/ウェーブは 1 トリップに `batch_size`（= `orders_per_trip`）件を
まとめます。`peak_factor` で需要をスケール。各エージェントは軌跡キーフレームを出力し、
2D/3D の両ビューが同じ `replay.json` を消費します。

---

## 3. 開発フロー

```bash
pip install -e ".[dev,web]"   # dev=pytest/ruff/httpx, web=fastapi/uvicorn。docs 出力は ".[docs]"
make test                     # = pytest -q
make lint                     # = ruff check src
make fmt                      # = ruff format src tests
make dev                      # = whsim serve（http://127.0.0.1:8000）
make e2e                      # ライブサーバへのスモーク確認（先に `make dev` が必要）
```

`make help` で全ターゲットを表示します。

- Python ≥3.10、pydantic v2、SimPy 4、NumPy、Matplotlib（Agg, ヘッドレス）、Typer。
- コードの識別子・コメントは英語、ユーザー向け文言・ドキュメントは日本語。

---

## 4. テスト

```bash
pytest -q                                         # 全テスト
pytest tests/test_engine.py::test_kpis_are_sane   # 単一テスト
```

- Web テストは **インプロセスの FastAPI `TestClient`** を使うため、サーバ起動は不要です
  （`make test` に含まれます）。
- `tests/test_perf_scale.py` は **スケール/性能ガード**。大規模モデル（数千ロケーション・
  数千 SKU・8時間シフト）を組んでエンジンを回し、(a) 寛容な時間予算内に完了、(b) KPI が
  有限、(c) リプレイが構築できる、ことを検証します。マイクロベンチではなく、
  **性能の崖（cliff）を検出する回帰ガード**です。予算は参照機の実測に対し十分な余裕（〜20倍）を
  持たせています。
- `analytic.py` の M/M/c はエンジンの **サニティ・オラクル**としてもテストで使われます。

---

## 5. テンプレートを追加する（コード変更不要）

1. `templates/<id>/template.json` を作成 = 全項目が仮値で埋まった `model.json`。
2. `templates/<id>/manifest.json` を作成（`template_id` / `name` などのメタ）。
3. 以上。`whsim templates` と Web の一覧に自動で出ます。コードの変更は不要です。

雛形の再生成：

```bash
python scripts/gen_template_ecommerce.py   # テンプレ再生成
python scripts/gen_sample_data.py          # examples/acme_upload.zip 生成
```

---

## 6. 拡張ポイント（seam）

- **LLM 対話**：`cody.respond(message, context) -> dict` は純粋な意図ルータ。
  本体を LLM のツール呼び出しに差し替え、**同じ dict** を返せば下流（API・フロント）は無改修。
- **取り込みサブツリー**：`schema/model.py` の `MERGEABLE_SUBTREES` に追加すると、
  その名前を持つ ZIP 内ファイルがマージ対象になります。
- **距離の上書き**：実測値があれば `distance_overrides`（`"fromLoc|toLoc" -> m`）が
  graph / Manhattan より優先されます。
- **シナリオ**：`scenarios.apply_scenario` はドット経路（例
  `orders.profile.peak_factor`）でベースモデルを編集します。

---

## 7. リポジトリ運用メモ

- `projects/` と `examples/*.zip` は実行時生成物で gitignore 済み。
- ルートの `Makefile` が install / dev / test / lint / fmt / e2e を提供。
- `.claude/settings.json` の SessionStart フックが、クラウドセッション起動時に
  `pip install -e ".[dev,web]"` → `import whsim` を実行して環境を準備します
  （リモート環境のみ。ローカルでは何もしません）。
