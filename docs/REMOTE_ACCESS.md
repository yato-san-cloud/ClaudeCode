# 自宅PCのwhsimに、会社のPCからアクセスする

想定している構成はひとつだけです。

```
会社のPC  ──HTTPS──▶  Cloudflare  ──トンネル──▶  自宅PC の whsim (127.0.0.1:8000)
                                                  └─ projects/ … 実データはここから出ない
```

ポイント:

- **ルータのポート開放をしない。** 自宅PCから外へ接続を張るだけなので、家庭内LANに
  外から入れる穴は開きません。
- **データは自宅PCから出ません。** whsim は `projects/` をローカルのファイルとして
  読み書きするだけで、外部サービスにアップロードもアカウント登録もしません。
  Cloudflare を通るのは画面と API のやりとりだけです。
- **全ルートにパスワード。** 画面も `/api/*` も同じ1つのセッションで守られます。
  `/api/projects` が素通しなら、それは実データの全件エクスポートと同じなので。

---

## 1. パスワードを決める

環境変数 `WHSIM_PASSWORD` に入れます。これが設定されている時だけ認証が有効になります。

**Windows (PowerShell)** — 恒久設定:
```powershell
setx WHSIM_PASSWORD "ここに十分に長いパスワード"
# 反映には PowerShell を開き直す
```

**macOS / Linux** — `~/.zshrc` or `~/.bashrc` に:
```bash
export WHSIM_PASSWORD='ここに十分に長いパスワード'
```

パスワードは**長さが全て**です。総当たりは 8回失敗で5分ロックしますが、
短い単語を選んでいい理由にはなりません。パスフレーズ（単語4つ以上）を推奨します。

> パスワードを変えると、発行済みのセッションは**全て無効**になります。
> 「会社のPCに入れっぱなしのログインを切りたい」時は、パスワードを変えるのが
> そのままログアウト操作になります。

## 2. whsim を起動する

```bash
whsim serve            # 既定の 127.0.0.1:8000 のまま。トンネルがここへ繋ぎます
```

起動時に `パスワード保護: 有効（全ルート）` と出れば効いています。

> `--host 0.0.0.0` のように外から届く場所へ直接バインドしようとすると、パスワード
> 未設定の場合は**起動を拒否**します。うっかり公開してしまう事故を防ぐためです。

## 3. Cloudflare Tunnel を通す

Cloudflare のアカウントと、Cloudflare で管理しているドメインが1つ必要です（無料枠で足ります）。

```bash
# インストール（例）
#   Windows: winget install --id Cloudflare.cloudflared
#   macOS:   brew install cloudflared
#   Linux:   https://pkg.cloudflare.com/ の手順

cloudflared tunnel login                     # ブラウザでドメインを選ぶ
cloudflared tunnel create whsim              # トンネルを作る（UUIDが出ます）
cloudflared tunnel route dns whsim whsim.example.com   # 好きなホスト名を割り当て
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: whsim
credentials-file: /home/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: whsim.example.com
    service: http://127.0.0.1:8000
  - service: http_status:404
```

```bash
cloudflared tunnel run whsim
```

これで `https://whsim.example.com` が会社のPCから開きます。最初にログイン画面が出ます。

### トンネル配下での設定

`cloudflared` は whsim にはローカルから接続してくるので、そのままだと総当たり制限が
「全員おなじIP」に見えてしまいます。本当のアクセス元IPを信頼するよう明示します。

```bash
export WHSIM_TRUST_PROXY=1
```

> これは**トンネルやリバースプロキシの背後にいる時だけ**設定してください。直接
> 公開している状態でこれを入れると、`X-Forwarded-For` を詐称して回数制限を
> 回避されます（既定でオフなのはそのためです）。

Cookie は既定で `Secure` 付き（HTTPS 前提）です。社内LANで平文HTTPのまま使う等の
特殊な場合だけ `WHSIM_INSECURE_COOKIE=1` で外せます。

## 4. 常時起動にする（任意）

**Windows**: `whsim serve` と `cloudflared tunnel run whsim` をそれぞれタスク
スケジューラの「ログオン時に実行」に登録するのが最短です。

**Linux (systemd --user)**:
```ini
# ~/.config/systemd/user/whsim.service
[Unit]
Description=whsim
[Service]
Environment=WHSIM_PASSWORD=…
Environment=WHSIM_TRUST_PROXY=1
ExecStart=/usr/local/bin/whsim serve
Restart=on-failure
[Install]
WantedBy=default.target
```
```bash
systemctl --user enable --now whsim
sudo loginctl enable-linger $USER   # ログアウトしても動かす
```

生存確認は `GET /healthz`（認証不要・`{"ok":true}` のみ）を使えます。プロジェクトの
有無自体が秘密なので、この応答には中身を一切載せていません。

---

## もう一段固くしたい場合

**Cloudflare Access** を被せると、whsim に届く前に Cloudflare 側で認証できます
（メールのワンタイムコード等）。whsim 側のパスワードはそのまま残してください
— Access の設定ミスや将来の変更で素通しになった時、最後の1枚として効きます。

## この認証で守れるもの・守れないもの

守れる:
- インターネット全体からプロジェクトを読まれる・消されること
- URL を知られただけでのアクセス
- ログイン総当たり（8回で5分ロック、パスワード由来の署名付きセッション）

守れない:
- **パスワードを知っている人は全部できます。** 利用者ごとの権限分離はありません。
  1人が自分の作業を自分のPCで動かす前提の設計です。
- 自宅PCそのものが乗っ取られた場合。データは平文でディスク上にあります。
- 会社のPC側に残るブラウザのキャッシュやセッション。共用PCで使うなら、使用後に
  ログアウト（またはパスワード変更）してください。

顧客の実データを扱う以上、**そもそも誰に渡してよいデータなのか**は、この仕組みとは
別に判断してください。
