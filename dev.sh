#!/usr/bin/env bash
# One-command dev loop (macOS/Linux): auto-pull the current branch + auto-reloading
# server. Keep the browser open and just press F5 -- pull / restart / cache are all
# handled. Ctrl+C stops both the server and the auto-sync.
#
# WARNING: the auto-sync HARD-RESETS the working tree to origin/<branch> every 15s,
# so pushes appear with no manual `git pull`. Do not hand-edit tracked files while
# it runs -- local edits will be discarded.
set -euo pipefail
cd "$(dirname "$0")"
BR="$(git rev-parse --abbrev-ref HEAD)"
echo "[whsim dev] auto-syncing to origin/$BR every 15s; server runs with --reload."
echo "[whsim dev] open http://127.0.0.1:8000  and just press F5 to see the latest."
( while true; do git fetch origin "$BR" -q && git reset --hard "origin/$BR" -q; sleep 15; done ) &
SYNC=$!
trap 'kill "$SYNC" 2>/dev/null || true' EXIT
whsim serve --reload
