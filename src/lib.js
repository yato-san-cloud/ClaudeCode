import fs from 'node:fs';
import path from 'node:path';

/** .env を読んで process.env に反映する（依存パッケージなしの簡易版） */
export function loadDotEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export function loadConfig(file = 'config.json') {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * chromium.launch() に渡すオプションを組み立てる。
 * 通常は headless だけ指定すればよいが、ブラウザを固定パスに置いている環境向けに
 * CHROMIUM_PATH 環境変数 / config.chromiumPath で実行ファイルを明示できる。
 */
export function launchOptions(config) {
  // HEADLESS 環境変数があれば config より優先（サーバー/CIで headless 実行するため）
  const headless = process.env.HEADLESS !== undefined
    ? /^(1|true|yes)$/i.test(process.env.HEADLESS)
    : !!config.headless;
  const opts = { headless };
  const exe = process.env.CHROMIUM_PATH || config.chromiumPath;
  if (exe) opts.executablePath = exe;
  return opts;
}

// ---- 画面解析の純ロジック（ネット不要・テスト可能） ----

/** クリックしてはいけない要素の語（戻る/キャンセル/ログアウト等） */
export const AVOID_WORDS = [
  '戻る', 'もどる', 'キャンセル', '取消', '取り消', '中止', '削除', 'ログアウト',
  '閉じる', 'パスワード', '変更', '前へ', 'トップ', 'ホーム', 'マイページ',
];

const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();

/** ラベルがキーワード群にどれだけ一致するか。完全一致=3, 前方一致=2, 部分一致=1, なし=0 */
export function scoreLabelByKeywords(label, keywords) {
  const l = norm(label);
  if (!l) return 0;
  let best = 0;
  for (const kw of keywords) {
    const k = norm(kw);
    if (!k) continue;
    if (l === k) best = Math.max(best, 3);
    else if (l.startsWith(k) || k.startsWith(l)) best = Math.max(best, 2);
    else if (l.includes(k)) best = Math.max(best, 1);
  }
  return best;
}

/** 「現在の受付番号: 15」のような待ち状況表示を成功と誤認しないための語 */
export const QUEUE_STATUS_WORDS = ['現在', 'ただいま', 'ただ今', '只今', '呼び出し', '診察中', 'お呼び'];

/**
 * 自分に発行された受付番号を抽出する。
 * 行単位で判定し、待ち状況表示（現在の受付番号など）の行は除外する。
 */
export function extractReceiptNumber(text) {
  for (const line of (text || '').split('\n')) {
    const m = line.match(/(受付|整理|予約)番号\s*[:：は]?\s*(\d+)/);
    if (!m) continue;
    if (QUEUE_STATUS_WORDS.some((w) => line.includes(w))) continue;
    return m[2];
  }
  return null;
}

/**
 * ページ本文から予約フローの状態を判定する（純関数）。
 * 戻り値: { status: 'success' | 'already' | 'closed' | 'none', number?: string }
 *  - success: 受付が完了した（完了文言、または待ち状況でない受付番号＋お待ちください）
 *  - already: この患者は既に受付済み（再試行すると二重予約になるので成功扱いで停止）
 *  - closed:  受付時間外・受付停止・定員
 *  - none:    どれでもない（先へ進む/リトライ）
 */
export function detectOutcome(text, config = {}) {
  const t = text || '';
  if (/(既に|すでに)(受付|予約)|受付済み|予約済み/.test(t)) {
    return { status: 'already', number: extractReceiptNumber(t) };
  }
  if ((config.successTexts || []).some((s) => t.includes(s))
      || /(受付|予約)(が|を)?(完了|受け付けました)/.test(t)) {
    return { status: 'success', number: extractReceiptNumber(t) };
  }
  const num = extractReceiptNumber(t);
  if (num && /番でお待ち|お待ちください/.test(t)) {
    return { status: 'success', number: num };
  }
  if ((config.closedTexts || []).some((s) => t.includes(s))) {
    return { status: 'closed' };
  }
  return { status: 'none' };
}

/**
 * 確認画面で押す「前進」ボタンのスコア。
 * proceedTexts に一致するほど高く、AVOID_WORDS を含むと強く減点。
 * 0以下なら押さない。
 */
export function rankProceedLabel(label, proceedTexts) {
  const l = norm(label);
  if (!l) return -1;
  if (AVOID_WORDS.some((w) => l.includes(norm(w)))) return -10;
  return scoreLabelByKeywords(label, proceedTexts);
}

// ---- ここまで純ロジック ----

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('ja-JP', { hour12: false })}]`, ...args);
}

/**
 * NICT（情報通信研究機構）の時刻APIとの差分を計測する。
 * 戻り値: ローカル時計に加えるべきオフセット(ms)。取得失敗時は 0。
 */
export async function measureClockOffsetMs() {
  try {
    const t0 = Date.now();
    const res = await fetch('https://ntp-a1.nict.go.jp/cgi-bin/json', { signal: AbortSignal.timeout(5000) });
    const t1 = Date.now();
    const data = await res.json();
    const serverMs = data.st * 1000;
    const offset = serverMs - (t0 + t1) / 2;
    return Math.round(offset);
  } catch {
    return 0;
  }
}

/**
 * "HH:MM:SS" (JST) を、直近の未来のエポックms に変換する。
 * nowMs には補正済みの現在時刻を渡す（時計計算の基準を1つに揃えるため）。
 */
export function nextJstTimeToEpochMs(hhmmss, nowMs = Date.now()) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  // 現在のJST日付を求める（マシンのTZに依存しないようUTC+9で計算）
  const jstNow = new Date(nowMs + 9 * 3600 * 1000);
  const target = Date.UTC(
    jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(),
    h - 9, m ?? 0, s ?? 0
  );
  return target <= nowMs ? target + 24 * 3600 * 1000 : target;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Webhook (Discord/Slack互換) に通知。URL未設定なら何もしない */
export async function notify(message) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, text: message }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    log('通知の送信に失敗:', e.message);
  }
}

export async function saveShot(page, dir, name) {
  ensureDir(dir);
  const file = path.join(dir, `${timestamp()}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}
