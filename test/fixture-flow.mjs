/**
 * 実ブラウザで予約フロー全体（ログイン→メニュー選択→確認→受付番号）を
 * 模擬HTML(fixtures)相手に通しで検証する。ネット不要。
 *
 *   node test/fixture-flow.mjs
 *
 * book.js を --now でサブプロセス起動し、出力に受付番号が出れば成功。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => pathToFileURL(path.join(here, 'fixtures', name)).href;

const tmp = mkdtempSync(path.join(tmpdir(), 'mp-fixture-'));
const configPath = path.join(tmp, 'config.json');
writeFileSync(configPath, JSON.stringify({
  loginUrl: fx('login.html'),
  departmentUrl: fx('department.html'),
  targetTimeJst: '06:00:00',
  preOpenLeadMinutes: 5,
  patientName: '',
  menuTextCandidates: ['診察', '一般診察', '診察＋注射'],
  proceedButtonTexts: ['受付する', '予約する', '次へ', '確認', '確定'],
  successTexts: ['受付が完了'],
  closedTexts: ['受付時間外', '受付を停止'],
  retry: { intervalSeconds: 1, maxAttempts: 2 },
  headless: true,
  screenshotsDir: path.join(tmp, 'shots'),
}, null, 2));

const chromium = process.env.CHROMIUM_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const res = spawnSync('node', ['src/book.js', '--now'], {
  cwd: path.join(here, '..'),
  encoding: 'utf8',
  env: {
    ...process.env,
    CONFIG_FILE: configPath,
    CHROMIUM_PATH: chromium,
    HEADLESS: '1',
    MEDICALPASS_EMAIL: 'test@example.com',
    MEDICALPASS_PASSWORD: 'dummy',
    NOTIFY_WEBHOOK_URL: '',
  },
  timeout: 120000,
});

const out = (res.stdout || '') + (res.stderr || '');
process.stdout.write(out);

if (/受付番号\s*[:：]?\s*\d+/.test(out) && /予約成功/.test(out)) {
  console.log('\n✅ fixture-flow: PASS（実ブラウザで予約完了まで到達）');
  process.exit(0);
} else {
  console.error('\n❌ fixture-flow: FAIL');
  process.exit(1);
}
