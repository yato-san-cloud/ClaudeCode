#!/usr/bin/env node
/*
 * test-playwright.js — headless QA harness.
 *
 * Loads index.html in Chromium, captures console/page errors, drives the game
 * through a deterministic scenario using the Game.test.* hook API, and writes
 * screenshots to build/shots/. Prints a machine-readable JSON summary.
 *
 * Required in-game hooks (Game.test.*): ready, newGame, snapshot, advanceDays,
 * buyAnimal, build, sellAll, save, load, errors. Missing hooks are reported,
 * not fatal — the harness still captures boot + runtime console errors.
 *
 * Usage: node tools/test-playwright.js [--smoke] [--headed]
 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'build', 'shots');
const SMOKE = process.argv.includes('--smoke');
const EXEC = '/opt/pw-browsers/chromium';

const summary = {
  booted: false,
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  failedRequests: [],
  steps: [],
  snapshots: {},
  missingHooks: [],
  screenshots: [],
};

const push = (arr, s, cap = 60) => { if (arr.length < cap) arr.push(s); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], headless: !process.argv.includes('--headed') });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === 'error') push(summary.consoleErrors, text);
    else if (t === 'warning') push(summary.consoleWarnings, text, 40);
  });
  page.on('pageerror', (err) => push(summary.pageErrors, String(err && err.stack || err)));
  page.on('requestfailed', (req) => push(summary.failedRequests, `${req.method()} ${req.url()} :: ${req.failure() && req.failure().errorText}`, 40));

  const shot = async (name) => {
    const file = path.join(SHOTS, name + '.png');
    try { await page.screenshot({ path: file }); summary.screenshots.push(path.relative(ROOT, file)); }
    catch (e) { push(summary.steps, { step: 'screenshot:' + name, ok: false, err: e.message }); }
  };

  const evalStep = async (name, fn, arg) => {
    try {
      const r = await page.evaluate(fn, arg);
      summary.steps.push({ step: name, ok: r && r.ok !== false, result: r });
      return r;
    } catch (e) {
      summary.steps.push({ step: name, ok: false, err: e.message });
      return { ok: false, err: e.message };
    }
  };

  const url = 'file://' + path.join(ROOT, 'index.html');
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });

  // Wait for boot: Game exists and (test.ready() true OR state present)
  try {
    await page.waitForFunction(() => {
      const G = window.Game;
      if (!G) return false;
      if (G.test && typeof G.test.ready === 'function') return !!G.test.ready();
      return !!G.state;
    }, { timeout: 12000 });
    summary.booted = true;
  } catch { summary.booted = false; }

  // Let the render loop run a bit to surface rAF errors.
  await page.waitForTimeout(1200);
  await shot('01-boot');

  // Detect hooks
  const hooks = await page.evaluate(() => {
    const t = (window.Game && window.Game.test) || {};
    const names = ['ready','newGame','snapshot','advanceDays','buyAnimal','build','sellAll','save','load','errors','petRandom','plant','harvestAll'];
    const out = {};
    names.forEach(n => out[n] = typeof t[n] === 'function');
    return out;
  }).catch(() => ({}));
  summary.missingHooks = Object.keys(hooks).filter(k => !hooks[k]);

  if (!SMOKE && summary.booted) {
    await evalStep('newGame', () => { try { window.Game.test.newGame(); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await page.waitForTimeout(600);
    await shot('02-newgame');
    summary.snapshots.afterNew = await page.evaluate(() => { try { return window.Game.test.snapshot(); } catch (e) { return { err: String(e) }; } }).catch(e => ({ err: e.message }));

    await evalStep('advanceDays(3)', () => { try { window.Game.test.advanceDays(3); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await page.waitForTimeout(400);
    await shot('03-day3');
    summary.snapshots.afterDay3 = await page.evaluate(() => { try { return window.Game.test.snapshot(); } catch (e) { return { err: String(e) }; } }).catch(e => ({ err: e.message }));

    await evalStep('buyAnimal(chicken)', () => { try { return window.Game.test.buyAnimal('chicken') || { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await evalStep('sellAll', () => { try { window.Game.test.sellAll(); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await evalStep('petRandom', () => { try { window.Game.test.petRandom && window.Game.test.petRandom(); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });

    await evalStep('save', () => { try { window.Game.test.save(); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await evalStep('load', () => { try { window.Game.test.load(); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });

    await evalStep('advanceDays(30)', () => { try { window.Game.test.advanceDays(30); return { ok: true }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; } });
    await page.waitForTimeout(800);
    await shot('04-day30-stress');
    summary.snapshots.afterDay30 = await page.evaluate(() => { try { return window.Game.test.snapshot(); } catch (e) { return { err: String(e) }; } }).catch(e => ({ err: e.message }));

    // internal caught errors
    summary.internalErrors = await page.evaluate(() => { try { return (window.Game.test.errors && window.Game.test.errors()) || []; } catch (e) { return ['errors() failed: ' + e.message]; } }).catch(() => []);
  }

  await browser.close();

  const ok = summary.booted && summary.consoleErrors.length === 0 && summary.pageErrors.length === 0 && (summary.internalErrors ? summary.internalErrors.length === 0 : true);
  summary.pass = ok;
  fs.writeFileSync(path.join(ROOT, 'build', 'qa-summary.json'), JSON.stringify(summary, null, 2));
  console.log('=== QA SUMMARY (JSON) ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('=== END QA SUMMARY ===');
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('HARNESS FATAL', e); process.exit(3); });
