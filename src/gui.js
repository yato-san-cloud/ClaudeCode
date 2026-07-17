/**
 * シンプルなローカルGUI。ブラウザで設定を編集し、下見/予約をボタンで実行できる。
 *   npm run gui        → http://127.0.0.1:8787 を開く
 *
 * 依存パッケージなし（Nodeの標準モジュールのみ）。ローカル(127.0.0.1)専用。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, notify } from './lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CONFIG = path.join(root, 'config.json');
const ENV = path.join(root, '.env');
const PORT = Number(process.env.GUI_PORT || 8787);

let child = null; // 実行中のブラウザ予約プロセス
const sseClients = new Set();
const logHistory = []; // 後からページを開いても結果が見えるよう直近ログを保持
const LOG_HISTORY_MAX = 500;

function broadcast(line) {
  if (line !== '__DONE__') {
    logHistory.push(line);
    if (logHistory.length > LOG_HISTORY_MAX) logHistory.shift();
  }
  for (const res of sseClients) res.write(`data: ${line.replace(/\n/g, '\\n')}\n\n`);
}

/**
 * POSTの防御: 外部サイトからの単純リクエスト(CSRF)を拒否する。
 * - Content-Type は application/json のみ許可（text/plain の単純POSTを弾く）
 * - Origin ヘッダがある場合は自分自身(127.0.0.1/localhost)のみ許可
 */
function postAllowed(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false;
  return true;
}

/** .env を読み取り（値だけ） */
function readEnv() {
  const out = {};
  if (fs.existsSync(ENV)) {
    for (const l of fs.readFileSync(ENV, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !l.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function writeEnv(env) {
  const lines = ['# MEDICALPASS ログイン情報（GUIが管理）'];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV, lines.join('\n') + '\n');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function runBook(flags, showBrowser) {
  if (child) { broadcast('⚠ すでに実行中です。'); return; }
  broadcast(`▶ 実行: node src/book.js ${flags.join(' ')}`);
  child = spawn('node', ['src/book.js', ...flags], {
    cwd: root,
    env: { ...process.env, HEADLESS: showBrowser ? '0' : '1' },
  });
  const pipe = (buf) => buf.toString().split('\n').filter(Boolean).forEach(broadcast);
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);
  child.on('close', (code) => {
    broadcast(`■ 終了 (code ${code})`);
    broadcast('__DONE__');
    child = null;
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(here, 'gui.html')));
    return;
  }

  if (url.pathname === '/api/state') {
    const cfg = loadConfig(CONFIG);
    const env = readEnv();
    return json(res, 200, {
      email: env.MEDICALPASS_EMAIL || '',
      hasPassword: !!env.MEDICALPASS_PASSWORD,
      notifyWebhook: env.NOTIFY_WEBHOOK_URL || '',
      hasLineToken: !!env.LINE_CHANNEL_ACCESS_TOKEN,
      lineUserId: env.LINE_USER_ID || '',
      patientName: cfg.patientName || '',
      patientCardNumber: cfg.patientCardNumber || '',
      targetTimeJst: cfg.targetTimeJst || '06:00:00',
      menuTextCandidates: (cfg.menuTextCandidates || []).join(', '),
      departmentUrl: cfg.departmentUrl || '',
      running: !!child,
    });
  }

  if (req.method === 'POST' && !postAllowed(req)) {
    return json(res, 403, { error: 'forbidden' });
  }

  if (url.pathname === '/api/save' && req.method === 'POST') {
    const b = await readBody(req);
    const env = readEnv();
    env.MEDICALPASS_EMAIL = b.email ?? env.MEDICALPASS_EMAIL ?? '';
    if (b.password) env.MEDICALPASS_PASSWORD = b.password; // 空なら既存を保持
    env.NOTIFY_WEBHOOK_URL = b.notifyWebhook ?? env.NOTIFY_WEBHOOK_URL ?? '';
    if (b.lineToken) env.LINE_CHANNEL_ACCESS_TOKEN = b.lineToken; // 空なら既存を保持
    env.LINE_USER_ID = b.lineUserId ?? env.LINE_USER_ID ?? '';
    writeEnv(env);

    const cfg = loadConfig(CONFIG);
    cfg.patientName = b.patientName ?? cfg.patientName;
    cfg.patientCardNumber = b.patientCardNumber ?? cfg.patientCardNumber;
    // <input type=time> は "HH:MM" を返すことがあるので "HH:MM:SS" に正規化
    if (b.targetTimeJst) {
      cfg.targetTimeJst = /^\d{2}:\d{2}$/.test(b.targetTimeJst) ? `${b.targetTimeJst}:00` : b.targetTimeJst;
    }
    if (b.departmentUrl) cfg.departmentUrl = b.departmentUrl;
    if (typeof b.menuTextCandidates === 'string') {
      cfg.menuTextCandidates = b.menuTextCandidates.split(',').map((s) => s.trim()).filter(Boolean);
    }
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    const b = await readBody(req);
    const mode = { preflight: ['--preflight'], dry: ['--dry-run'], now: ['--now'], book: [] }[b.mode];
    if (!mode) return json(res, 400, { error: 'unknown mode' });
    runBook(mode, !!b.showBrowser);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/test-notify' && req.method === 'POST') {
    // 保存済みの .env を読み直してから送信（GUIプロセスの環境変数を最新化）
    Object.assign(process.env, readEnv());
    const configured = [];
    if (process.env.NOTIFY_WEBHOOK_URL) configured.push('Webhook');
    if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID) configured.push('LINE');
    if (configured.length === 0) {
      broadcast('⚠ 通知先が未設定です。LINEのトークン+ユーザーID、またはWebhook URLを保存してください。');
      return json(res, 200, { ok: false });
    }
    broadcast(`▶ テスト通知を送信します (${configured.join(', ')})`);
    const results = await notify('🔔 テスト通知: おおはしこどもクリニック予約ツールからの送信テストです');
    for (const r of results) {
      broadcast(r.ok ? `✅ ${r.target}: 送信成功（届いたか確認してください）` : `❌ ${r.target}: 失敗 (${r.detail})`);
    }
    return json(res, 200, { ok: results.every((r) => r.ok) });
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (child) { child.kill('SIGINT'); broadcast('⏹ 停止しました。'); }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    // 接続時に過去ログを再生（夜に本番開始→朝にページを開き直しても結果が見える）
    for (const line of logHistory) res.write(`data: ${line.replace(/\n/g, '\\n')}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  予約ツールGUI: http://127.0.0.1:${PORT}\n  （Ctrl+C で終了）\n`);
});
