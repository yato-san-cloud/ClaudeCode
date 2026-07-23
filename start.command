#!/usr/bin/env bash
# === カイロ紹介状アプリ 起動 (macOS / Linux) ===
# 初回起動時は依存パッケージを自動インストールします。
# macOS では Finder からダブルクリックで実行可能。

set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 が見つかりません。https://www.python.org/ からインストールしてください。"
    read -n 1 -s -r -p "Enterキーで終了"
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "[初回セットアップ] 仮想環境を作成します..."
    python3 -m venv .venv
    source .venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    pip install pywebview
else
    source .venv/bin/activate
fi

echo "アプリを起動します..."
python desktop.py
