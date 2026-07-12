#!/usr/bin/env node
/*
 * build.js — assembles the single-file game.
 *
 * Reads:
 *   data/content.json, data/balance.json   -> embedded as Game.DATA
 *   src/css/*.css (alpha order)             -> inlined <style>
 *   src/js/<module>.js (explicit order)     -> each wrapped in its own IIFE
 *
 * Emits:
 *   index.html          -> full standalone document (repo deliverable + Playwright tests)
 *   build/artifact.html -> inner content only (for the Artifact tool, which supplies <html>/<head>/<body>)
 *
 * Integration contract: every module runs in its own function scope and may
 * only share state by attaching to the global `Game` namespace. `Game`,
 * `Game.DATA` exist before any module runs. Boot happens on DOMContentLoaded.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const p = (...a) => path.join(ROOT, ...a);

// Fixed module load order (dependencies first).
const MODULE_ORDER = [
  'util',     // rng, math, easing, format, EventBus
  'state',    // central Game.state + newGame()
  'save',     // localStorage persistence + autosave
  'time',     // day/season/weather clock
  'economy',  // money, market, transactions
  'world',    // tile grid, building placement/occupancy
  'crops',    // planting, growth, harvest
  'animals',  // entities, needs, production, breeding, AI
  'sprites',  // procedural draw functions
  'render',   // camera, layered canvas draw, particles, lighting
  'audio',    // WebAudio synth sfx + music
  'input',    // mouse/touch/keyboard, pan/zoom, placement
  'ui',       // HUD + panels + notifications + modals
  'tutorial', // onboarding
  'game',     // bootstrap + main loop wiring
];

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJsonSafe(file, label) {
  const raw = readIfExists(file);
  if (raw == null) { console.warn(`[build] WARN missing ${label}: ${file} -> using {}`); return {}; }
  try { return JSON.parse(raw); }
  catch (e) { console.error(`[build] ERROR invalid JSON in ${label}: ${e.message}`); process.exitCode = 1; return {}; }
}

// Escape characters unsafe inside an inline <script> JS object literal:
// '<' '>' (avoid </script>) and U+2028/U+2029 (line terminators in JS strings).
const UNSAFE_INLINE = new RegExp('[<>\\u2028\\u2029]', 'g');
function safeInlineJson(obj) {
  return JSON.stringify(obj).replace(UNSAFE_INLINE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---- data ----
const content = readJsonSafe(p('data/content.json'), 'content');
const balance = readJsonSafe(p('data/balance.json'), 'balance');
const dataJson = safeInlineJson({ content, balance });

// ---- css ----
let css = '';
const cssDir = p('src/css');
if (fs.existsSync(cssDir)) {
  const files = fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).sort();
  for (const f of files) css += `\n/* ==== ${f} ==== */\n` + fs.readFileSync(path.join(cssDir, f), 'utf8');
}

// ---- js modules ----
let js = '';
let present = 0;
for (const name of MODULE_ORDER) {
  const file = p('src/js', name + '.js');
  const src = readIfExists(file);
  if (src == null) { console.warn(`[build] WARN module missing: ${name}.js (stubbed)`); continue; }
  present++;
  js += `\n/* ======================= module: ${name} ======================= */\n(function(){\n${src}\n})();\n`;
}

const scriptBlock =
`"use strict";
window.Game = window.Game || {};
Game.DATA = ${dataJson};
Game.BUILD = { modules: ${JSON.stringify(MODULE_ORDER)} };
${js}
(function(){
  function boot(){ try { if (Game.boot) Game.boot(); else console.error('Game.boot missing'); } catch(e){ console.error('BOOT ERROR', e); var el=document.getElementById('boot-error'); if(el){el.style.display='block'; el.textContent='起動エラー: '+(e && e.message);} } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();`;

// ---- markup (game shell; UI module populates the rest) ----
const MARKUP =
`<div id="app" class="app">
  <canvas id="world" class="world-canvas" aria-label="牧場ワールド"></canvas>
  <div id="hud" class="hud" aria-live="polite"></div>
  <div id="dock" class="dock"></div>
  <div id="panels" class="panels"></div>
  <div id="toast" class="toast-layer" aria-live="polite"></div>
  <div id="overlay" class="overlay-layer"></div>
  <div id="boot-error" class="boot-error" style="display:none"></div>
</div>`;

const STYLE = `<style>\n${css}\n</style>`;

// artifact.html = inner content only (Artifact tool wraps it)
const artifactHtml = `${STYLE}\n${MARKUP}\n<script>\n${scriptBlock}\n</script>\n`;

// index.html = full standalone document
const fullHtml =
`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#8ecae6">
<title>まきばのしずく 🐄 — 牧場経営シミュレータ</title>
${STYLE}
</head>
<body>
${MARKUP}
<script>
${scriptBlock}
</script>
</body>
</html>
`;

fs.mkdirSync(p('build'), { recursive: true });
fs.writeFileSync(p('index.html'), fullHtml);
fs.writeFileSync(p('build/artifact.html'), artifactHtml);

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + 'KB';
console.log(`[build] modules: ${present}/${MODULE_ORDER.length} present`);
console.log(`[build] content keys: ${Object.keys(content).length}, balance keys: ${Object.keys(balance).length}`);
console.log(`[build] wrote index.html (${kb(fullHtml)}) and build/artifact.html (${kb(artifactHtml)})`);
