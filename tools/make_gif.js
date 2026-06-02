/*
 * tools/make_gif.js — 沼のプレイ映像(GIF)をヘッドレス生成する。
 *
 * ブラウザ/Canvas/外部ツールを使わず、ゲームロジックを実際に回して各フレームを
 * インデックスカラーのバッファに描画し、自作の GIF89a エンコーダ(LZW)で書き出す。
 *
 *   node tools/make_gif.js [out.gif]
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---- 再現性のためのシード付き乱数 ----
(function (seed) {
  let a = seed >>> 0;
  Math.random = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})(777);

global.window = global;
const ROOT = path.join(__dirname, '..');
for (const f of ['js/physics.js', 'js/audio.js', 'js/board.js', 'js/game.js']) {
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}
const Numa = global.Numa;

// ---- パレット（インデックスカラー） ----
const PAL = [
  [13, 20, 16],    // 0 背景上
  [16, 35, 26],    // 1 背景中
  [5, 8, 10],      // 2 背景下
  [150, 180, 165], // 3 壁
  [180, 198, 188], // 4 釘
  [42, 111, 74],   // 5 チャッカー
  [255, 211, 77],  // 6 ゴールド(フラッシュ/羽根開)
  [22, 56, 42],    // 7 ヤクモノ本体
  [10, 32, 24],    // 8 ステージ水面
  [192, 57, 43],   // 9 V赤
  [255, 225, 90],  // 10 V光/大当たり
  [111, 165, 136], // 11 羽根(閉)
  [255, 255, 255], // 12 玉(白)
  [154, 167, 172], // 13 玉(影)
  [180, 230, 200], // 14 沼の文字/明
  [29, 58, 43],    // 15 枠
  [214, 230, 221], // 16 屋根釘
  [52, 196, 122],  // 17 ゲージ緑
];
const PAL_SIZE = 32; // 2^5 にパディング

const SCALE = 0.5;
const W = Math.round(460 * SCALE);
const H = Math.round(680 * SCALE);
const S = (v) => v * SCALE;

const board = new Numa.Board();

// ---- 簡易ラスタライザ（インデックスバッファ） ----
function makeBuf() { return new Uint8Array(W * H); }
function px(buf, x, y, c) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  buf[y * W + x] = c;
}
function fillRect(buf, x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(buf, x + i, y + j, c);
}
function fillCircle(buf, cx, cy, r, c) {
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r2) px(buf, cx + dx, cy + dy, c);
}
function line(buf, x0, y0, x1, y1, c, t) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const h = (t || 1) >> 1;
  for (;;) {
    fillRect(buf, x0 - h, y0 - h, t || 1, t || 1, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

// ---- 1フレームを描画してインデックスバッファを返す ----
function renderFrame(st) {
  const buf = makeBuf();
  // 背景（3バンド）
  fillRect(buf, 0, 0, W, Math.round(H * 0.4), 0);
  fillRect(buf, 0, Math.round(H * 0.4), W, Math.round(H * 0.4), 1);
  fillRect(buf, 0, Math.round(H * 0.8), W, H - Math.round(H * 0.8), 2);

  // 壁
  for (const w of board.walls) line(buf, S(w.ax), S(w.ay), S(w.bx), S(w.by), 3, 2);
  // 釘
  for (const p of board.pegs) fillCircle(buf, S(p.x), S(p.y), Math.max(1, Math.round(S(p.r))), 4);

  // チャッカー
  for (const c of board.CHUCKERS) {
    const flash = st.chuckerFlash[c.id] > 0;
    fillRect(buf, S(c.x - c.w / 2), S(c.y - 8), Math.round(S(c.w)), Math.round(S(16)), flash ? 6 : 5);
  }

  // ヤクモノ
  const YK = board.YK, STG = board.STAGE, VZ = board.VZONE;
  fillRect(buf, S(YK.left), S(YK.top), S(YK.right - YK.left), S(YK.bottom - YK.top), 7);
  fillRect(buf, S(STG.left), S(STG.top), S(STG.right - STG.left), S(STG.floor - STG.top), 8);
  fillRect(buf, S(VZ.x - VZ.w / 2), S(VZ.y - 6), S(VZ.w), S(12), st.vFlash > 0 ? 10 : 9);
  // 羽根
  const open = st.wingAmt;
  const wcol = open > 0.5 ? 6 : 11;
  drawWing(buf, 156, YK.top + 2, -1, open, wcol);
  drawWing(buf, 288, YK.top + 2, 1, open, wcol);
  // 屋根の釘（フタは閉じている時のみ）
  for (const p of board.roofShoulder) fillCircle(buf, S(p.x), S(p.y), Math.max(1, Math.round(S(p.r))), 16);
  if (open < 0.5) for (const p of board.roofLid) fillCircle(buf, S(p.x), S(p.y), Math.max(1, Math.round(S(p.r))), 16);

  // 玉
  for (const b of st.balls) {
    fillCircle(buf, S(b.x), S(b.y), Math.max(2, Math.round(S(6.2))), 12);
  }

  // 目標ゲージ（最下部）
  const pct = Math.max(0, Math.min(1, st.balance / 10000));
  fillRect(buf, 2, H - 6, W - 4, 4, 15);
  fillRect(buf, 2, H - 6, Math.round((W - 4) * pct), 4, pct >= 1 ? 6 : 17);

  // 大当たり/V演出: 金枠を点滅
  if (st.mode === 'jackpot' || st.vFlash > 0) {
    const on = (st.frame >> 2) % 2 === 0 || st.vFlash > 0.5;
    if (on) {
      const t = 4;
      fillRect(buf, 0, 0, W, t, 6); fillRect(buf, 0, H - t, W, t, 6);
      fillRect(buf, 0, 0, t, H, 6); fillRect(buf, W - t, 0, t, H, 6);
    }
  } else {
    // 通常の枠
    line(buf, 1, 1, W - 1, 1, 15, 2); line(buf, 1, H - 1, W - 1, H - 1, 15, 2);
    line(buf, 1, 1, 1, H - 1, 15, 2); line(buf, W - 1, 1, W - 1, H - 1, 15, 2);
  }
  return buf;
}

function drawWing(buf, eaveX, eaveY, dir, open, col) {
  const peakX = board.CX, peakY = board.YK.top - 26;
  const tipClosedX = (eaveX + peakX) / 2, tipClosedY = (eaveY + peakY) / 2;
  const tipOpenX = eaveX + dir * 30, tipOpenY = eaveY - 30;
  const tipX = tipClosedX + (tipOpenX - tipClosedX) * open;
  const tipY = tipClosedY + (tipOpenY - tipClosedY) * open;
  line(buf, S(eaveX), S(eaveY), S(tipX), S(tipY), col, 3);
}

// ---- GIF89a エンコーダ（教科書どおりの可変長LZW） ----
function lzwEncode(minCode, indices) {
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize, next, dict;
  const init = () => {
    dict = new Map();
    for (let i = 0; i < clear; i++) dict.set(String.fromCharCode(i), i);
    next = eoi + 1; codeSize = minCode + 1;
  };
  const bytes = []; let cur = 0, bits = 0;
  const out = (c) => { cur |= c << bits; bits += codeSize; while (bits >= 8) { bytes.push(cur & 0xff); cur >>= 8; bits -= 8; } };
  init();
  out(clear);
  let w = String.fromCharCode(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String.fromCharCode(indices[i]);
    const wk = w + k;
    if (dict.has(wk)) { w = wk; continue; }
    out(dict.get(w));
    dict.set(wk, next++);
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    if (next === 4096) { out(clear); init(); }
    w = k;
  }
  out(dict.get(w));
  out(eoi);
  if (bits > 0) bytes.push(cur & 0xff);
  return bytes;
}

function buildGif(frames, delay) {
  const out = [];
  const push = (...b) => out.push(...b);
  const u16 = (v) => push(v & 0xff, (v >> 8) & 0xff);
  // Header + Logical Screen Descriptor
  for (const ch of 'GIF89a') push(ch.charCodeAt(0));
  u16(W); u16(H);
  push(0xf0 | 4); // GCT present, 2^(4+1)=32 colors
  push(0, 0);
  // Global Color Table
  for (let i = 0; i < PAL_SIZE; i++) {
    const c = PAL[i] || [0, 0, 0];
    push(c[0], c[1], c[2]);
  }
  // NETSCAPE looping
  push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') push(ch.charCodeAt(0));
  push(0x03, 0x01, 0x00, 0x00, 0x00);
  // frames
  const minCode = 5;
  for (const idx of frames) {
    push(0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00); // GCE
    push(0x2c); u16(0); u16(0); u16(W); u16(H); push(0x00); // Image Descriptor
    push(minCode);
    const data = lzwEncode(minCode, idx);
    for (let p = 0; p < data.length; p += 255) {
      const chunk = data.slice(p, p + 255);
      push(chunk.length, ...chunk);
    }
    push(0x00);
  }
  push(0x3b);
  return Buffer.from(out);
}

// ---- シミュレーションしてフレーム収集 ----
const game = new Numa.Game(board, Numa.audio, { onStats() {}, onMessage() {}, onZawa() {}, onResult() {} });
let firstV = null, frame = 0;
const hv = game._hitV.bind(game); game._hitV = () => { if (firstV == null) firstV = frame; hv(); };
game.setAutoFire(true);

const snaps = [];
const TOTAL = 60 * 22; // 最大22秒ぶん回す
for (frame = 0; frame < TOTAL; frame++) {
  game.update(1 / 60);
  snaps.push({
    balls: game.balls.map((b) => ({ x: b.x, y: b.y })),
    wingAmt: game.wing.amt,
    vFlash: game.fx.vFlash,
    chuckerFlash: { C: game.fx.chuckerFlash.C, L: game.fx.chuckerFlash.L, R: game.fx.chuckerFlash.R },
    mode: game.mode,
    balance: game.balance(),
    frame,
  });
  if (firstV != null && frame > firstV + 60 * 8) break;
}

// V の約2秒前から、大当たり数ラウンドぶんを 20fps(=3フレ間引き)で切り出す
const vCap = firstV == null ? 60 : firstV;
const startF = Math.max(0, vCap - 60 * 2);
const endF = Math.min(snaps.length - 1, vCap + 60 * 7);
const frames = [];
for (let i = startF; i <= endF; i += 3) {
  const buf = renderFrame(snaps[i]);
  frames.push(buf);
}

const outPath = process.argv[2] || path.join(ROOT, 'docs', 'numa-demo.gif');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const gif = buildGif(frames, 5); // delay 5/100s ≒ 20fps
fs.writeFileSync(outPath, gif);
console.log(`firstV @ ${(vCap / 60).toFixed(1)}s, frames=${frames.length}, ${(gif.length / 1024).toFixed(0)}KB -> ${outPath}`);

// 検証用: 代表フレームをPNGで書き出す（PNG=1）
if (process.env.PNG) {
  const zlib = require('zlib');
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const writePng = (idx, p) => {
    const raw = Buffer.alloc((W * 3 + 1) * H);
    let o = 0;
    for (let y = 0; y < H; y++) { raw[o++] = 0; for (let x = 0; x < W; x++) { const c = PAL[idx[y * W + x]] || [0, 0, 0]; raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2]; } }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    fs.writeFileSync(p, png);
  };
  const fa = Math.floor(frames.length * 0.2), fb = Math.floor(frames.length * 0.55);
  writePng(frames[fa], '/tmp/numa_a.png');
  writePng(frames[fb], '/tmp/numa_b.png');
  console.log('PNG stills -> /tmp/numa_a.png /tmp/numa_b.png');
}
