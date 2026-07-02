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

/** "HH:MM:SS" (JST) を、直近の未来のエポックms に変換する */
export function nextJstTimeToEpochMs(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  const now = new Date();
  // 現在のJST日付を求める（マシンのTZに依存しないようUTC+9で計算）
  const jstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const target = Date.UTC(
    jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate(),
    h - 9, m, s ?? 0
  );
  return target <= now.getTime() ? target + 24 * 3600 * 1000 : target;
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
