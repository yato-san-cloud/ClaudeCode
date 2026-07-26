#!/usr/bin/env bash
#
# LINE 買い物チェックリストの初期セットアップ。
#
# Cloudflare のアカウントさえ作ってあれば、あとはこれ1本で
# ログイン → D1作成 → マイグレーション → デプロイ → シークレット登録 まで通る。
#
# 途中で失敗しても、直してもう一度実行すれば続きから進む(何度流しても安全)。

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_NAME=shopping
CONFIG=wrangler.jsonc
PLACEHOLDER=REPLACE_WITH_YOUR_D1_DATABASE_ID

if [ -t 1 ]; then
  C_STEP=$'\033[1;36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_WARN=''; C_ERR=''; C_B=''; C_0=''
fi

step() { printf '\n%s▶ %s%s\n' "$C_STEP" "$*" "$C_0"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_0" "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n%s✗ %s%s\n' "$C_ERR" "$*" "$C_0" >&2; exit 1; }

wr() { npx wrangler "$@"; }

# --- 0. 前提 -----------------------------------------------------------------

step '前提を確認しています'

command -v node >/dev/null || die 'Node.js が見つかりません。https://nodejs.org からインストールしてください。'
[ -d node_modules ] || die "依存パッケージが未インストールです。先に ${C_B}npm install${C_0} を実行してください。"
ok "Node.js $(node --version)"

# --- 1. Cloudflare ログイン ---------------------------------------------------

step 'Cloudflare にログインします'

# whoami は未ログインでも終了コード0を返すので、出力を読んで判定する。
# grep -q に流してはいけない。パイプが早期に閉じると wrangler が EPIPE で
# 固まる(ハングして返ってこない)。いったん変数に受けてから調べる。
logged_in() {
  local out
  out=$(wr whoami 2>&1) || true
  case "$out" in
    *'not authenticated'*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  ok 'CLOUDFLARE_API_TOKEN を使います'
elif logged_in; then
  ok 'ログイン済みです'
elif [ -t 0 ]; then
  info 'ブラウザが開きます。「Allow」を押してください。'
  wr login || die 'ログインに失敗しました。'
  logged_in || die 'ログインが完了していません。もう一度実行してください。'
  ok 'ログインしました'
else
  die "$(cat <<'EOF'
Cloudflare にログインしていません。

  このスクリプトは対話環境で実行してください(ブラウザ認証が必要です):
      bash scripts/setup.sh

  ブラウザを開けない環境(SSH先・CI等)では、APIトークンを使ってください:
      export CLOUDFLARE_API_TOKEN=...
      bash scripts/setup.sh
  トークンの作り方: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
EOF
)"
fi

# --- 2. D1 データベース -------------------------------------------------------

step "データベース (D1) を用意します"

# wrangler の出力書式はバージョンで変わるので、作成結果を読まずに一覧から引く
db_id() {
  wr d1 list --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = [];
      try { list = JSON.parse(s); } catch {}
      const hit = (Array.isArray(list) ? list : []).find((d) => d.name === process.argv[1]);
      process.stdout.write(hit ? String(hit.uuid ?? hit.database_id ?? "") : "");
    });
  ' "$DB_NAME"
}

ID=$(db_id || true)
if [ -z "$ID" ]; then
  info "'$DB_NAME' を新規作成します"
  wr d1 create "$DB_NAME" >/dev/null || die 'D1 の作成に失敗しました。'
  ID=$(db_id || true)
  [ -n "$ID" ] || die 'D1 は作成されましたが ID を取得できませんでした。wrangler d1 list を確認してください。'
  ok "作成しました ($ID)"
else
  ok "既にあります ($ID)"
fi

# wrangler.jsonc はコメント付きなので JSON.parse せず、置換だけで書き換える
RESULT=$(node -e '
  const fs = require("fs");
  const [file, placeholder, id] = process.argv.slice(1);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(placeholder)) {
    fs.writeFileSync(file, text.replace(placeholder, id));
    process.stdout.write("patched");
  } else if (text.includes(id)) {
    process.stdout.write("current");
  } else {
    process.stdout.write("other");
  }
' "$CONFIG" "$PLACEHOLDER" "$ID")

case "$RESULT" in
  patched) ok "$CONFIG に database_id を書き込みました" ;;
  current) ok "$CONFIG は設定済みです" ;;
  other)   warn "$CONFIG に別の database_id が入っています。意図した設定か確認してください。" ;;
esac

# --- 3. マイグレーション ------------------------------------------------------

step 'テーブルを作成します'
wr d1 migrations apply "$DB_NAME" --remote || die 'マイグレーションに失敗しました。'
ok 'スキーマを適用しました'

# --- 4. 初回デプロイ (URL を確定させる) ---------------------------------------

step 'Worker をデプロイします'
info 'LIFF の登録に URL が要るので、シークレット登録より先にデプロイします。'

LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
wr deploy 2>&1 | tee "$LOG" || die 'デプロイに失敗しました。'

URL=$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$LOG" | head -1 || true)
[ -n "$URL" ] || die 'デプロイ後の URL を取得できませんでした。上の出力を確認してください。'
ok "公開されました: $URL"

# --- 5. LINE コンソール側 -----------------------------------------------------

step 'ここから LINE Developers での作業です'

cat <<EOF

  https://developers.line.biz/console/ を開いて、プロバイダーを1つ作り、
  その下に ${C_B}チャネルを2つ${C_0} 作ってください。

  ${C_B}(a) LINE Login チャネル${C_0} — チェックリスト画面用
      ・Channel ID を控える                    → LIFF_CHANNEL_ID
      ・「LIFF」タブ → 追加
          エンドポイントURL : ${C_B}${URL}/${C_0}
          サイズ           : Full
          Scope            : profile と openid の${C_B}両方${C_0}
                             (openid が無いと画面が開きません)
      ・発行された LIFF ID を控える             → LIFF_ID

  ${C_B}(b) Messaging API チャネル${C_0} — Bot本体。同じプロバイダーの下に作る
      ・Channel secret を控える                → LINE_CHANNEL_SECRET
      ・アクセストークン(長期)を発行して控える  → LINE_CHANNEL_ACCESS_TOKEN
      ・Messaging API 設定:
          応答メッセージ                        : オフ
          あいさつメッセージ                    : オフ
          Webhook の利用                        : オン
          グループトークへの参加を許可する      : ${C_B}オン${C_0}  ← 忘れやすい

EOF

printf '  4つ揃ったら Enter を押してください: '
read -r _

# --- 6. シークレット登録 ------------------------------------------------------

step 'シークレットを登録します'
info '入力は画面に表示されません。空のまま Enter で「変更しない」になります。'

put_secret() {
  local name=$1 desc=$2 optional=${3:-} value out
  printf '\n  %s%s%s (%s)\n  > ' "$C_B" "$name" "$C_0" "$desc"
  read -rs value
  printf '\n'

  if [ -z "$value" ]; then
    if [ -n "$optional" ]; then
      warn "$name なしで進みます"
    else
      warn "$name をスキップしました(未登録のままだと動きません)"
    fi
    return 0
  fi

  # 失敗した理由が分からないと直しようがないので、エラー時だけ出力を見せる
  if out=$(printf '%s' "$value" | wr secret put "$name" 2>&1); then
    ok "$name を登録しました"
  else
    printf '%s\n' "$out" >&2
    die "$name の登録に失敗しました。"
  fi
}

put_secret LINE_CHANNEL_SECRET       'Messaging API の Channel secret'
put_secret LINE_CHANNEL_ACCESS_TOKEN 'Messaging API の長期アクセストークン'
put_secret LIFF_ID                   'LIFF タブで発行された ID'
put_secret LIFF_CHANNEL_ID           'LINE Login の Channel ID'
put_secret ANTHROPIC_API_KEY         '任意。未設定ならルールベースのみで動きます' optional

# --- 7. 反映 ------------------------------------------------------------------

step 'シークレットを反映するため、もう一度デプロイします'
wr deploy >/dev/null 2>&1 || die '再デプロイに失敗しました。'
ok '反映しました'

step '動作を確認します'
if curl -fsS -m 15 "$URL/liff-config.json" >/dev/null 2>&1; then
  ok 'Worker が応答しています'
else
  warn '応答を確認できませんでした。数十秒おいて下のURLをブラウザで開いてみてください。'
fi

# --- 完了 --------------------------------------------------------------------

cat <<EOF

${C_OK}${C_B}セットアップ完了${C_0}

  最後に1つだけ、LINE コンソールでの作業が残っています。

  Messaging API チャネル → Webhook URL に以下を貼って「検証」:

      ${C_B}${URL}/line/webhook${C_0}

  「成功」が出たら、奥さんとのグループトークに Bot を招待して、
  「牛乳」とでも送ってみてください。リストが返ってくれば動いています。

  ${C_B}うまくいかないとき${C_0}
    npx wrangler tail        通信が届いているかその場で見える
    npx wrangler secret list 登録済みのシークレット名を確認

EOF
