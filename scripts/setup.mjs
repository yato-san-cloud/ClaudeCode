#!/usr/bin/env node
/**
 * LINE 買い物チェックリストの初期セットアップ。
 *
 * Cloudflare のアカウントさえ作ってあれば、これ1本で
 * ログイン → D1作成 → マイグレーション → デプロイ → シークレット登録 まで通る。
 *
 * Node で書いてあるのは Windows のためで、bash スクリプトだと cmd.exe から
 * 動かない(Git for Windows の既定では bash が PATH に入らない)。
 * wrangler も npx ではなく bin を直接叩く。npx はシェル経由になり、
 * Windows では .cmd の扱いでつまずく。
 *
 * 何度実行しても安全。既にあるものは作り直さない。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const DB_NAME = 'shopping';
const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

// ---------- 表示 ----------

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint('1');
const step = (s) => console.log(`\n${paint('1;36')('▶ ' + s)}`);
const ok = (s) => console.log(`  ${paint('32')('✓')} ${s}`);
const warn = (s) => console.log(`  ${paint('33')('!')} ${s}`);
const info = (s) => console.log(`    ${s}`);

function die(message) {
  console.error(`\n${paint('31')('✗ ' + message)}`);
  process.exit(1);
}

// ---------- 入力 ----------

/**
 * 質問はこの1つの interface を使い回す。毎回 createInterface すると、
 * close した時点で stdin が終了してしまい、2問目以降が永久に返ってこない。
 *
 * 生成を遅らせているのは wrangler login と stdin を奪い合わないため。
 * 対話が要る wrangler の呼び出しは、最初の ask() より前に済ませてある。
 */
let rl = null;
let muted = false;

function prompt() {
  if (rl) return rl;
  // terminal は明示せず自動判定に任せる(端末なら true になりマスクが効く)。
  // なお入力を一括でパイプ流ししたときは動かない。readline が全行を
  // 一度に処理してしまい、2問目を訊く前に stdin が終わるため。
  // 人が1行ずつ答える前提の対話スクリプトなので、そこは許容している。
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl._writeToOutput = (s) => {
    if (!muted) rl.output.write(s);
  };
  return rl;
}

function closePrompt() {
  if (rl) rl.close();
  rl = null;
}

function ask(query, { hidden = false } = {}) {
  return new Promise((resolve) => {
    prompt().question(query, (answer) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden; // プロンプト自体は出したいので、出力後にマスクへ切り替える
  });
}

// ---------- wrangler ----------

/**
 * @param {string[]} args
 * @param {{capture?: boolean, quiet?: boolean, input?: string}} options
 */
function wrangler(args, { capture = false, quiet = false, input } = {}) {
  return new Promise((resolve) => {
    const stdio = capture
      ? [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe']
      : [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'];

    const child = spawn(process.execPath, [WRANGLER, ...args], { cwd: ROOT, stdio });

    let out = '';
    if (capture) {
      for (const [stream, mirror] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          out += chunk;
          if (!quiet) mirror.write(chunk);
        });
      }
    }

    if (input !== undefined) child.stdin.end(input);
    child.on('error', (error) => resolve({ code: 1, out: out + String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

// ---------- 0. 前提 ----------

step('前提を確認しています');

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) die(`Node.js 18 以上が必要です(いまは ${process.versions.node})。`);
if (!fs.existsSync(WRANGLER)) {
  die(`依存パッケージが未インストールです。先に ${bold('npm install')} を実行してください。`);
}
ok(`Node.js v${process.versions.node}`);

// ---------- 1. ログイン ----------

step('Cloudflare にログインします');

async function loggedIn() {
  const { out } = await wrangler(['whoami'], { capture: true, quiet: true });
  return !out.includes('not authenticated');
}

if (process.env.CLOUDFLARE_API_TOKEN) {
  ok('CLOUDFLARE_API_TOKEN を使います');
} else if (await loggedIn()) {
  ok('ログイン済みです');
} else if (process.stdin.isTTY) {
  info('ブラウザが開きます。Google でログインして「Allow」を押してください。');
  await wrangler(['login']);
  if (!(await loggedIn())) die('ログインが完了していません。もう一度実行してください。');
  ok('ログインしました');
} else {
  die(
    'Cloudflare にログインしていません。\n\n' +
      '  ブラウザ認証が要るので、対話できるターミナルで実行してください:\n' +
      `      ${bold('npm run setup')}\n\n` +
      '  ブラウザを開けない環境では API トークンを使ってください:\n' +
      '      set CLOUDFLARE_API_TOKEN=...   (Windows)\n' +
      '      export CLOUDFLARE_API_TOKEN=... (Mac/Linux)\n' +
      '  作り方: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  );
}

// ---------- 2. D1 ----------

step('データベース (D1) を用意します');

// 作成コマンドの出力書式はバージョンで変わるので、一覧から引く
async function findDbId() {
  const { out } = await wrangler(['d1', 'list', '--json'], { capture: true, quiet: true });
  const start = out.indexOf('[');
  if (start === -1) return null;
  let list;
  try {
    list = JSON.parse(out.slice(start, out.lastIndexOf(']') + 1));
  } catch {
    return null;
  }
  const hit = (Array.isArray(list) ? list : []).find((d) => d?.name === DB_NAME);
  return hit ? String(hit.uuid ?? hit.database_id ?? '') || null : null;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let dbId = await findDbId();
if (!dbId) {
  info(`'${DB_NAME}' を新規作成します`);
  const { code, out } = await wrangler(['d1', 'create', DB_NAME], { capture: true, quiet: true });
  if (code !== 0) {
    console.error(out);
    die('D1 の作成に失敗しました。');
  }
  // 一覧が追いつかないことがあるので、作成時の出力からも拾えるようにしておく
  dbId = (await findDbId()) ?? out.match(UUID)?.[0] ?? null;
  if (!dbId) {
    console.error(out);
    die('D1 は作成されましたが ID を取得できませんでした。npx wrangler d1 list を確認してください。');
  }
  ok(`作成しました (${dbId})`);
} else {
  ok(`既にあります (${dbId})`);
}

// wrangler.jsonc はコメント付きなので JSON.parse せず、置換だけで書き換える
const configText = fs.readFileSync(CONFIG, 'utf8');
if (configText.includes(PLACEHOLDER)) {
  fs.writeFileSync(CONFIG, configText.replace(PLACEHOLDER, dbId));
  ok('wrangler.jsonc に database_id を書き込みました');
} else if (configText.includes(dbId)) {
  ok('wrangler.jsonc は設定済みです');
} else {
  warn('wrangler.jsonc に別の database_id が入っています。意図した設定か確認してください。');
}

// ---------- 3. マイグレーション ----------

step('テーブルを作成します');
{
  const { code } = await wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
  if (code !== 0) die('マイグレーションに失敗しました。');
}
ok('スキーマを適用しました');

// ---------- 4. 初回デプロイ ----------

step('Worker をデプロイします');
info('LIFF の登録に URL が要るので、シークレット登録より先にデプロイします。');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** URL を拾うために stdout を捕まえる。副作用は下の登録待ちで補う。 */
async function tryDeploy() {
  const { code, out } = await wrangler(['deploy'], { capture: true });
  return { code, out: stripAnsi(out) };
}

let deploy = await tryDeploy();

// workers.dev のサブドメインはアカウントごとに一度だけ登録が要る。
// wrangler は自分で訊いて登録までしてくれるのだが、こちらが URL 目当てで
// stdout を捕まえていると「非対話」と判断して勝手に no と答えてしまう。
// この失敗のときだけ捕捉をやめ、wrangler 自身に訊かせる。
// (ここより前で ask() を呼んでいないので stdin は空いている)
if (deploy.code !== 0 && /workers\.dev subdomain/i.test(deploy.out)) {
  console.log('');
  warn('workers.dev のサブドメインが未登録です(アカウントごとに初回だけ必要)。');
  info('このあと wrangler が登録するか訊いてきます。y と答えて、好きな名前を1つ決めてください。');
  info('あとで変えにくいので短めが無難です。URL は https://line-shopping-list.<名前>.workers.dev になります。');
  console.log('');

  await wrangler(['deploy']); // 完全対話。ここで登録とデプロイが済む
  deploy = await tryDeploy(); // URL を拾い直す
}

if (deploy.code !== 0) {
  console.error(deploy.out);
  const onboarding = deploy.out.match(
    /https:\/\/dash\.cloudflare\.com\/[^\s]*?\/workers\/onboarding/,
  )?.[0];
  if (onboarding) {
    info(`サブドメインは次のページからも登録できます: ${onboarding}`);
  }
  die('デプロイに失敗しました。');
}

const url = deploy.out.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev/)?.[0];
if (!url) die('デプロイ後の URL を取得できませんでした。上の出力を確認してください。');
ok(`公開されました: ${url}`);

// ---------- 5. LINE コンソール ----------

step('ここから LINE Developers での作業です');

console.log(`
  https://developers.line.biz/console/ を開いて、プロバイダーを1つ作り、
  その下に ${bold('チャネルを2つ')} 作ってください。

  ${bold('(a) LINE Login チャネル')} — チェックリスト画面用
      ・Channel ID を控える                    → LIFF_CHANNEL_ID
      ・「LIFF」タブ → 追加
          エンドポイントURL : ${bold(url + '/')}
          サイズ           : Full
          Scope            : profile と openid の${bold('両方')}
                             (openid が無いと画面が開きません)
      ・発行された LIFF ID を控える             → LIFF_ID

  ${bold('(b) Messaging API チャネル')} — Bot本体。同じプロバイダーの下に作る
      ・Channel secret を控える                → LINE_CHANNEL_SECRET
      ・アクセストークン(長期)を発行して控える  → LINE_CHANNEL_ACCESS_TOKEN
      ・Messaging API 設定:
          応答メッセージ                        : オフ
          あいさつメッセージ                    : オフ
          Webhook の利用                        : オン
          グループトークへの参加を許可する      : ${bold('オン')}  ← 忘れやすい
`);

await ask('  4つ揃ったら Enter を押してください: ');

// ---------- 6. シークレット ----------

step('シークレットを登録します');
info('入力は画面に表示されません。空のまま Enter で「登録しない」になります。');

async function putSecret(name, desc, { optional = false } = {}) {
  const value = await ask(`\n  ${bold(name)} (${desc})\n  > `, { hidden: true });
  if (!value) {
    warn(optional ? `${name} なしで進みます` : `${name} をスキップしました(未登録だと動きません)`);
    return;
  }
  // 失敗した理由が分からないと直しようがないので、エラー時だけ出力を見せる
  const { code, out } = await wrangler(['secret', 'put', name], {
    capture: true,
    quiet: true,
    input: value,
  });
  if (code !== 0) {
    console.error(out);
    die(`${name} の登録に失敗しました。`);
  }
  ok(`${name} を登録しました`);
}

await putSecret('LINE_CHANNEL_SECRET', 'Messaging API の Channel secret');
await putSecret('LINE_CHANNEL_ACCESS_TOKEN', 'Messaging API の長期アクセストークン');
await putSecret('LIFF_ID', 'LIFF タブで発行された ID');
await putSecret('LIFF_CHANNEL_ID', 'LINE Login の Channel ID');
await putSecret('ANTHROPIC_API_KEY', '任意。未設定ならルールベースのみで動きます', {
  optional: true,
});

closePrompt(); // 以降は入力を待たない。開いたままだとプロセスが終われない。

// ---------- 7. 反映と確認 ----------

step('シークレットを反映するため、もう一度デプロイします');
{
  const { code } = await wrangler(['deploy'], { capture: true, quiet: true });
  if (code !== 0) die('再デプロイに失敗しました。');
}
ok('反映しました');

step('動作を確認します');
try {
  const response = await fetch(`${url}/liff-config.json`, { signal: AbortSignal.timeout(15000) });
  if (response.ok) ok('Worker が応答しています');
  else warn(`応答はありましたが状態が ${response.status} です。`);
} catch {
  warn('応答を確認できませんでした。数十秒おいて下の URL をブラウザで開いてみてください。');
}

// ---------- 完了 ----------

console.log(`
${paint('32')(bold('セットアップ完了'))}

  最後に1つだけ、LINE コンソールでの作業が残っています。

  Messaging API チャネル → Webhook URL に以下を貼って「検証」:

      ${bold(url + '/line/webhook')}

  「成功」が出たら、奥さんとのグループトークに Bot を招待して、
  「牛乳」とでも送ってみてください。リストが返ってくれば動いています。

  ${bold('うまくいかないとき')}
    npm run tail      通信が届いているかその場で見える
    npm run secrets   登録済みのシークレット名を確認
`);
