# whsim — developer convenience targets.
# Usage: `make <target>`. See `make help` for the list.

.DEFAULT_GOAL := help
.PHONY: help install dev test lint fmt e2e

help: ## このヘルプを表示 / show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## 依存込みでパッケージをインストール (dev + web extras)
	python -m pip install -e ".[dev,web]"

dev: ## Web アプリを起動 (http://127.0.0.1:8000)
	whsim serve

test: ## テストを実行
	pytest -q

lint: ## ソースを lint
	ruff check src

fmt: ## ソースを整形 (ruff format)
	ruff format src tests

# NOTE: e2e hits a LIVE server. Start it first in another terminal: `make dev`.
# (The pytest web suite uses an in-process TestClient and runs under `make test`.)
E2E_URL ?= http://127.0.0.1:8000
e2e: ## ライブサーバへのスモーク確認。先に別ターミナルで `make dev` が必要
	curl -fsS $(E2E_URL)/api/templates >/dev/null && echo "e2e OK: $(E2E_URL) is up"
