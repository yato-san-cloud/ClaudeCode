// =============================================================================
// src/js/sprites.js  —  Game.Sprites
// Pure procedural Canvas2D "cute" art for まきばのしずく (Ranch Droplet).
//
// EVERY exported function is a pure draw:  (ctx, ...) -> void.
// No state reads, no clock reads, no RNG-that-touches-the-sim. Cosmetic
// variation uses a local deterministic hash so the same inputs always draw
// the same picture (safe to call while paused / at any speed).
//
// Shape language (art-bible): round & chunky, ~2 heads tall, huge glossy eyes
// with a white highlight + tiny blush, short stub legs, soft warm outlines
// (never pure black). Readable & adorable at ~40px.
// =============================================================================

Game.Sprites = (function () {
  "use strict";

  // ---- palette (mirror of art-bible §14, kept module-private) -----------------
  var P = {
    grass: { light: "#B6E870", base: "#93D95C", mid: "#6EBB45", dark: "#4F9A37", blade: "#57A83A" },
    soil: { light: "#CBA074", base: "#A9744A", dark: "#7E5230", till: "#8A5A38" },
    water: { light: "#9FD9E8", base: "#6FBDD6", dark: "#4E9CBB" },
    wood: { light: "#DBA772", base: "#B77F4E", dark: "#8A5A34", plank: "#C99461" },
    roof: { red: "#E27A5F", redDark: "#C15A44", blue: "#7FB4D6", blueDark: "#5E93B6" },
    stone: { light: "#C9CBD6", base: "#A6A9B8", dark: "#7C8092" },
    ui: {
      cream: "#FFF6E3", parchment: "#FBEAC8", panel: "#FFFBF0",
      border: "#E7C596", borderDark: "#C89B63", wood: "#B77F4E",
      text: "#6B4A2F", textSoft: "#9A7B5C", shadow: "#3A2A1A"
    },
    accent: {
      pink: "#FF9CC2", pinkDeep: "#FF6FA5", pinkLight: "#FFD1E3",
      mint: "#85E0BE", mintDeep: "#4FC79C", mintLight: "#C4F3E2",
      yellow: "#FFD84D", sky: "#8FD6F2", lav: "#C9B6F2"
    },
    status: { alert: "#FF6B6B", amber: "#FFB454", good: "#7ED957" },
    prod: {
      milk: "#FFFDF6", milkShade: "#EAE6D6", quality_milk: "#FFF6D6",
      cheese: "#FFCE4E", cheeseShade: "#E0A82F", butter: "#FFE39B",
      yogurt: "#FFEFF3", egg: "#FBEFD6", eggShade: "#E7D2A9",
      wool: "#F3EDDF", woolShade: "#DAD2BE", fine_wool: "#ECE6FB",
      truffle: "#423229", truffleShade: "#2C2018", goat_milk: "#F6FBEF", manure: "#6B4E37"
    },
    light: { lamp: "#FFE7A8", star: "#FFFDF0", moon: "#FDF6E3" },
    wx: { cloud: "#FFFFFF", cloudShade: "#DCE6EE", rain: "#A9D8EC", fog: "#EAF2F4", snow: "#FFFFFF" }
  };

  // Breed base colors (art-bible §14 quick ref)
  var CC = {
    holstein:        { body: "#FFFDF6", belly: "#FFFFFF", spot: "#3A3A3E", muzzle: "#F4B8C4", horn: "#EAD9B4" },
    jersey:          { body: "#C8925A", belly: "#E4BC8A", ring: "#8A5E3C", muzzle: "#D8B48C", horn: "#5A4632" },
    brown_swiss:     { body: "#A89078", belly: "#E8DCC8", stripe: "#E8DCC8", muzzle: "#E8DCC8", horn: "#D8C9AA" },
    highland:        { body: "#C57A3E", belly: "#D89A5C", fluff: "#D89A5C", horn: "#E8D6B0" },
    belted_galloway: { body: "#2E2C30", belly: "#26242A", belt: "#F4F0E6", horn: "#1E1C22" },
    wagyu:           { body: "#3B2F2C", belly: "#4A3A34", sheen: "#5A463E", horn: "#4A3A32", tag: "#FFD84D" },
    mini_cow:        { body: "#FFFDF6", belly: "#FFFFFF", spot: "#3A3A3E", collar: "#85E0BE", bell: "#FFD84D" },
    dexter:          { body: "#2A2A2E", belly: "#242428", spot: null, horn: "#3A3A40" }
  };

  var EYE = "#3A2A2A";          // eye ink (never pure black)
  var TAU = Math.PI * 2;

  // ---------------------------------------------------------------------------
  // tiny local math / color helpers (pure; no cross-module deps)
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function h01(n, salt) {
    // deterministic cosmetic hash (mirrors Util.hash01 so drawings are stable)
    var h = ((n | 0) * 374761393 + (salt | 0) * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function _hx(c) { c = c.replace("#", ""); if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
  function _rgb(a) { return "rgb(" + (a[0] | 0) + "," + (a[1] | 0) + "," + (a[2] | 0) + ")"; }
  function mix(c1, c2, t) { var a = _hx(c1), b = _hx(c2); return _rgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  function light(c, t) { return mix(c, "#FFFFFF", t); }
  function dark(c, t) { return mix(c, "#1A1310", t); }
  function rgba(c, a) { var x = _hx(c); return "rgba(" + x[0] + "," + x[1] + "," + x[2] + "," + a + ")"; }

  // outline = darkest tone of the object's own hue (warm outline, art-bible §2.4)
  function outline(ctx, color, w) { ctx.strokeStyle = dark(color, 0.42); ctx.lineWidth = w == null ? 1.5 : w; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke(); }

  function ell(ctx, cx, cy, rx, ry) {
    ctx.beginPath();
    if (ctx.ellipse) { ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, TAU); }
    else { ctx.save(); ctx.translate(cx, cy); ctx.scale(rx, ry); ctx.arc(0, 0, 1, 0, TAU); ctx.restore(); }
  }
  function circle(ctx, cx, cy, r) { ctx.beginPath(); ctx.arc(cx, cy, Math.abs(r), 0, TAU); }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fillP(ctx, c) { ctx.fillStyle = c; ctx.fill(); }

  // soft contact shadow on the ground (grounds every sprite)
  function contactShadow(ctx, cx, cy, w, alpha) {
    ctx.save();
    ell(ctx, cx, cy, w * 0.5, w * 0.16);
    ctx.fillStyle = rgba(P.ui.shadow, alpha == null ? 0.18 : alpha);
    ctx.fill();
    ctx.restore();
  }

  // vertical top-light gradient clipped to the current path's bbox
  function bodyGrad(ctx, topY, botY, base) {
    var g = ctx.createLinearGradient(0, topY, 0, botY);
    g.addColorStop(0, light(base, 0.14));
    g.addColorStop(0.55, base);
    g.addColorStop(1, dark(base, 0.10));
    return g;
  }

  // ===========================================================================
  // FACE KIT  —  the money-maker (reusable kawaii eyes + blush + mouth)
  // face(ctx, x,y, r, opts)   x,y = face/eye centre; r ~ head radius
  // opts: { blink 0..1 (1=closed), mood, look{x,y}, blush, mouth, eyeColor,
  //         lashes, spacing, eyeScale, sparkle }
  // ===========================================================================
  function face(ctx, x, y, r, opts) {
    opts = opts || {};
    var mood = opts.mood || "neutral";
    var blink = clamp(opts.blink || 0, 0, 1);
    var look = opts.look || { x: 0, y: 0 };
    var lx = (look.x || 0), ly = (look.y || 0);
    var spacing = (opts.spacing != null ? opts.spacing : 0.42) * r;
    var eScale = opts.eyeScale != null ? opts.eyeScale : 1;
    var eyeColor = opts.eyeColor || EYE;
    var ew = r * 0.24 * eScale;             // eye half-width
    var eh = r * 0.34 * eScale;             // eye half-height (taller than wide)
    var ox = lx * r * 0.10, oy = ly * r * 0.10;

    var sleepy = (mood === "sleepy" || mood === "sleep" || mood === "content2");
    var closed = blink >= 0.96 || sleepy;

    // eyes
    var i;
    for (i = -1; i <= 1; i += 2) {
      var ex = x + i * spacing + ox, ey = y + oy;
      if (closed) {
        // happy closed arc  ‿
        ctx.beginPath();
        ctx.arc(ex, ey - eh * 0.15, ew * 1.05, Math.PI * 0.15, Math.PI * 0.85, false);
        ctx.strokeStyle = eyeColor; ctx.lineWidth = Math.max(1.2, r * 0.05); ctx.lineCap = "round"; ctx.stroke();
      } else {
        var ry = eh * (1 - blink * 0.90);
        // eye ink
        ell(ctx, ex, ey, ew, ry);
        ctx.fillStyle = eyeColor; ctx.fill();
        if (blink < 0.5) {
          // big highlight upper-left + tiny sparkle lower-right
          ell(ctx, ex - ew * 0.30, ey - ry * 0.42, ew * 0.42, ry * 0.42);
          ctx.fillStyle = "#FFFFFF"; ctx.fill();
          circle(ctx, ex + ew * 0.34, ey + ry * 0.34, ew * 0.16);
          ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fill();
        }
        if (opts.lashes) {
          ctx.strokeStyle = eyeColor; ctx.lineWidth = Math.max(1, r * 0.035); ctx.lineCap = "round";
          var lxo = i > 0 ? 1 : -1;
          for (var L = -1; L <= 1; L++) {
            ctx.beginPath();
            ctx.moveTo(ex + lxo * ew * 0.9, ey - ry * 0.7 + L * ry * 0.5);
            ctx.lineTo(ex + lxo * ew * 1.5, ey - ry * 0.95 + L * ry * 0.5);
            ctx.stroke();
          }
        }
      }
    }

    // blush
    if (opts.blush) {
      ctx.save();
      ctx.fillStyle = rgba(P.accent.pinkLight, 0.6);
      for (i = -1; i <= 1; i += 2) { ell(ctx, x + i * spacing * 1.55, y + eh * 0.85, r * 0.16, r * 0.10); ctx.fill(); }
      ctx.restore();
    }

    // mouth (minimal — eyes carry it)
    var m = opts.mouth || (mood === "happy" ? "smile" : (mood === "love" ? "smile" : (mood === "sad" ? "frown" : (mood === "sleepy" ? "o" : "none"))));
    var my = y + eh * 1.35;
    ctx.strokeStyle = opts.mouthColor || dark(P.ui.text, 0.05);
    ctx.lineWidth = Math.max(1.1, r * 0.045); ctx.lineCap = "round";
    if (m === "smile") {
      ctx.beginPath(); ctx.arc(x + ox, my - r * 0.14, r * 0.20, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
    } else if (m === "w") {
      ctx.beginPath();
      ctx.arc(x - r * 0.09, my - r * 0.05, r * 0.11, Math.PI * 0.1, Math.PI * 0.9);
      ctx.arc(x + r * 0.09, my - r * 0.05, r * 0.11, Math.PI * 0.1, Math.PI * 0.9); ctx.stroke();
    } else if (m === "frown") {
      ctx.beginPath(); ctx.arc(x + ox, my + r * 0.12, r * 0.18, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
    } else if (m === "o") {
      ell(ctx, x + ox, my, r * 0.07, r * 0.09); ctx.fillStyle = rgba(P.accent.pinkDeep, 0.6); ctx.fill();
    } else if (m === "cat") {
      ctx.beginPath();
      ctx.moveTo(x - r * 0.16, my - r * 0.05); ctx.quadraticCurveTo(x - r * 0.06, my + r * 0.06, x, my - r * 0.02);
      ctx.quadraticCurveTo(x + r * 0.06, my + r * 0.06, x + r * 0.16, my - r * 0.05); ctx.stroke();
    }
  }

  // ===========================================================================
  // ANIMALS
  // animal(ctx, breedId, x,y, opts)   x,y = ground contact point (feet)
  // opts: { size, facing(1|-1|'left'), hopPhase, blink, mood, adult, look }
  // ===========================================================================
  var BREED_SIZE = {
    holstein: 1.00, jersey: 0.92, brown_swiss: 1.06, highland: 1.10, belted_galloway: 1.00,
    wagyu: 0.98, mini_cow: 0.72, dexter: 0.82,
    chicken: 0.46, duck: 0.5, sheep: 0.78, goat: 0.72, pig: 0.66, alpaca: 0.96,
    rabbit: 0.38, dog: 0.56, cat: 0.5, horse: 1.15
  };

  function animal(ctx, breedId, x, y, opts) {
    opts = opts || {};
    var isCow = !!CC[breedId];
    var baseSize = BREED_SIZE[breedId] != null ? BREED_SIZE[breedId] : 1;
    var adult = opts.adult !== false;
    var babyMul = adult ? 1 : 0.62;
    var sizeMul = (opts.size || 1) * baseSize * babyMul;
    var facing = opts.facing;
    var flip = (facing === -1 || facing === "left") ? -1 : 1;
    var U = 46 * sizeMul;                     // nominal creature scale (px)
    var hop = opts.hopPhase || 0;
    var bob = Math.sin(hop) * 0.03 * U;       // gentle idle bob
    var headBig = adult ? 1 : 1.28;           // babies: bigger head

    ctx.save();
    try {
      // contact shadow shrinks as sprite rises
      contactShadow(ctx, x, y, U * 0.80, 0.18 - Math.max(0, Math.sin(hop)) * 0.05);
      ctx.translate(x, y - bob);
      ctx.scale(flip, 1);

      var mood = opts.mood || "neutral";
      var blink = opts.blink || 0;
      var look = opts.look || { x: 0, y: 0 };

      if (isCow) drawCow(ctx, breedId, U, headBig, mood, blink, look, adult, hop);
      else if (breedId === "chicken") drawChicken(ctx, U, mood, blink, look, hop);
      else if (breedId === "duck") drawDuck(ctx, U, mood, blink, look, hop);
      else if (breedId === "sheep") drawSheep(ctx, U, headBig, mood, blink, look);
      else if (breedId === "goat") drawGoat(ctx, U, headBig, mood, blink, look);
      else if (breedId === "pig") drawPig(ctx, U, headBig, mood, blink, look);
      else if (breedId === "alpaca") drawAlpaca(ctx, U, mood, blink, look);
      else if (breedId === "rabbit") drawRabbit(ctx, U, headBig, mood, blink, look, hop);
      else if (breedId === "dog") drawDog(ctx, U, headBig, mood, blink, look, hop);
      else if (breedId === "cat") drawCat(ctx, U, headBig, mood, blink, look, hop);
      else if (breedId === "horse") drawHorse(ctx, U, headBig, mood, blink, look);
      else drawCow(ctx, "holstein", U, headBig, mood, blink, look, adult, hop); // safe fallback
    } catch (e) {
      if (Game && Game._recordError) Game._recordError("Sprites.animal:" + breedId, e);
    }
    ctx.restore();
  }

  // ---- leg stub helper (draw before body) -----------------------------------
  function legs(ctx, U, color, spread, len, splay) {
    len = len || 0.14 * U; spread = spread || 0.30 * U; splay = splay || 0.16 * U;
    ctx.fillStyle = color;
    var xs = [-spread, -spread + splay, spread - splay, spread];
    for (var i = 0; i < xs.length; i++) { rr(ctx, xs[i] - 0.05 * U, -len, 0.10 * U, len + 0.05 * U, 0.05 * U); ctx.fill(); }
  }

  // ---------------------------------------------------------------------------
  // COW (generic build, per-breed overlays)
  // origin at feet; body sits above; head to the front (+x, 3/4)
  // ---------------------------------------------------------------------------
  function drawCow(ctx, id, U, headBig, mood, blink, look, adult, hop) {
    var c = CC[id];
    var body = c.body, belly = c.belly || light(body, 0.18);
    var bodyCY = -0.52 * U, bodyRX = 0.50 * U, bodyRY = 0.34 * U;
    var headR = 0.30 * U * headBig;
    var headX = 0.34 * U, headY = -0.86 * U - (headBig - 1) * 0.10 * U;

    // legs
    legs(ctx, U, dark(body, id === "holstein" || id === "mini_cow" ? 0.05 : 0.18), 0.34 * U, 0.16 * U);

    // tail (behind body)
    ctx.strokeStyle = dark(body, 0.15); ctx.lineWidth = 0.05 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-bodyRX * 0.9, bodyCY); ctx.quadraticCurveTo(-bodyRX * 1.25, bodyCY + 0.25 * U, -bodyRX * 1.05, bodyCY + 0.5 * U); ctx.stroke();
    ell(ctx, -bodyRX * 1.05, bodyCY + 0.52 * U, 0.05 * U, 0.07 * U); ctx.fillStyle = dark(body, 0.30); ctx.fill();

    // body bean
    ell(ctx, 0, bodyCY, bodyRX, bodyRY);
    ctx.fillStyle = bodyGrad(ctx, bodyCY - bodyRY, bodyCY + bodyRY, body); ctx.fill();
    outline(ctx, body, Math.max(1.2, 0.032 * U));
    // belly patch
    ctx.save(); ell(ctx, 0, bodyCY, bodyRX, bodyRY); ctx.clip();
    ell(ctx, 0.02 * U, bodyCY + 0.14 * U, bodyRX * 0.72, bodyRY * 0.62); ctx.fillStyle = rgba(belly, 0.9); ctx.fill();

    // ---- per-breed body patterns (clipped to body) ----
    if (id === "holstein" || id === "mini_cow") {
      ctx.fillStyle = c.spot;
      var n = id === "mini_cow" ? 2 : 3;
      var seeds = [[-0.22, -0.05, 0.20], [0.24, 0.10, 0.17], [-0.02, 0.16, 0.14], [0.30, -0.14, 0.12]];
      for (var s = 0; s < n + 1 && s < seeds.length; s++) {
        var sp = seeds[s];
        ell(ctx, sp[0] * U, bodyCY + sp[1] * U, sp[2] * U * (0.9 + h01(s, id.length) * 0.3), sp[2] * U * 0.85); ctx.fill();
      }
    } else if (id === "belted_galloway") {
      ctx.fillStyle = c.belt;
      rr(ctx, -0.17 * U, bodyCY - bodyRY, 0.34 * U, bodyRY * 2, 0.04 * U); ctx.fill();
    } else if (id === "brown_swiss") {
      ctx.fillStyle = rgba(c.stripe, 0.55);
      rr(ctx, -bodyRX, bodyCY - bodyRY, bodyRX * 2, 0.12 * U, 0.05 * U); ctx.fill(); // dorsal cream stripe
    } else if (id === "wagyu") {
      ctx.strokeStyle = rgba(c.sheen, 0.8); ctx.lineWidth = 0.10 * U; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-bodyRX * 0.5, bodyCY - bodyRY * 0.7); ctx.quadraticCurveTo(0, bodyCY - bodyRY, bodyRX * 0.6, bodyCY - bodyRY * 0.5); ctx.stroke();
    } else if (id === "jersey") {
      ell(ctx, 0.02 * U, bodyCY + 0.14 * U, bodyRX * 0.72, bodyRY * 0.62); ctx.fillStyle = rgba(c.belly, 0.6); ctx.fill();
    }
    ctx.restore();

    // udder hint on milk breeds (tiny + cute)
    if (adult && (id === "holstein" || id === "jersey" || id === "brown_swiss" || id === "mini_cow")) {
      ell(ctx, 0.02 * U, bodyCY + bodyRY * 0.72, 0.10 * U, 0.07 * U);
      ctx.fillStyle = "#F4B8C4"; ctx.fill();
    }

    // ---- highland shaggy fur over body (before head) ----
    if (id === "highland") drawFur(ctx, 0, bodyCY, bodyRX, bodyRY, c.fluff, body, 14);

    // ---- head ----
    // ears (behind head)
    ctx.fillStyle = dark(body, 0.06);
    ell(ctx, headX - headR * 0.85, headY - headR * 0.35, headR * 0.34, headR * 0.24); ctx.fill();
    ell(ctx, headX + headR * 0.85, headY - headR * 0.35, headR * 0.34, headR * 0.24); ctx.fill();

    // horns
    drawHorns(ctx, id, headX, headY, headR, c);

    // head circle
    circle(ctx, headX, headY, headR);
    ctx.fillStyle = bodyGrad(ctx, headY - headR, headY + headR, body); ctx.fill();
    outline(ctx, body, Math.max(1.2, 0.032 * U));

    if (id === "highland") {
      // fringe over eyes; eyes peek out as glints
      drawFur(ctx, headX, headY - headR * 0.2, headR * 0.95, headR * 0.85, c.fluff, body, 10);
      // two eye glints under fringe
      ctx.fillStyle = "#FFFFFF";
      circle(ctx, headX - headR * 0.28, headY + headR * 0.18, headR * 0.09); ctx.fill();
      circle(ctx, headX + headR * 0.28, headY + headR * 0.18, headR * 0.09); ctx.fill();
      // horns on top of fringe
      drawHorns(ctx, id, headX, headY, headR, c, true);
      return;
    }

    // muzzle patch + nostrils
    var muzzleY = headY + headR * 0.42, muW = headR * 0.62, muH = headR * 0.40;
    var muzzleCol = c.muzzle || light(body, 0.25);
    ell(ctx, headX, muzzleY, muW, muH); ctx.fillStyle = muzzleCol; ctx.fill();
    if (id === "jersey") { ctx.strokeStyle = rgba(c.ring, 0.8); ctx.lineWidth = 0.03 * U; ctx.stroke(); }
    ctx.fillStyle = dark(muzzleCol, 0.28);
    ell(ctx, headX - muW * 0.34, muzzleY, muW * 0.13, muH * 0.22); ctx.fill();
    ell(ctx, headX + muW * 0.34, muzzleY, muW * 0.13, muH * 0.22); ctx.fill();

    // forelock (little tuft)
    if (id === "jersey" || id === "brown_swiss") {
      ctx.fillStyle = dark(body, 0.12);
      ell(ctx, headX, headY - headR * 0.82, headR * 0.24, headR * 0.16); ctx.fill();
    }

    // face kit
    var faceOpt = {
      blink: blink, mood: mood, look: look,
      blush: mood === "happy" || mood === "love" || id === "mini_cow" || !adult,
      eyeColor: EYE, spacing: 0.45,
      lashes: id === "jersey",
      eyeScale: id === "mini_cow" || id === "jersey" || id === "brown_swiss" ? 1.12 : 1
    };
    if (id === "jersey") faceOpt.eyeColor = dark(c.ring, 0.15);
    face(ctx, headX, headY - headR * 0.02, headR, faceOpt);

    // wagyu gold ear tag + idle sparkle
    if (id === "wagyu") {
      circle(ctx, headX + headR * 0.9, headY - headR * 0.2, headR * 0.12); ctx.fillStyle = c.tag; ctx.fill();
      outline(ctx, c.tag, 1);
      if (Math.sin(hop * 0.7) > 0.85) sparkle(ctx, headX + headR * 1.1, headY - headR * 0.9, 0.5);
    }
    // mini_cow bell collar
    if (id === "mini_cow") {
      ctx.strokeStyle = c.collar; ctx.lineWidth = 0.07 * U;
      ctx.beginPath(); ctx.arc(headX, headY + headR * 0.7, headR * 0.8, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
      circle(ctx, headX, headY + headR * 0.98, headR * 0.16); ctx.fillStyle = c.bell; ctx.fill(); outline(ctx, c.bell, 1);
      circle(ctx, headX, headY + headR * 1.06, headR * 0.05); ctx.fillStyle = dark(c.bell, 0.3); ctx.fill();
    }
  }

  function drawHorns(ctx, id, hx, hy, hr, c, onTop) {
    var horn = c.horn; if (!horn) return;
    ctx.fillStyle = horn;
    if (id === "highland") {
      if (!onTop) return;
      // huge sweeping pale horns
      for (var i = -1; i <= 1; i += 2) {
        ctx.beginPath();
        ctx.moveTo(hx + i * hr * 0.5, hy - hr * 0.55);
        ctx.quadraticCurveTo(hx + i * hr * 1.5, hy - hr * 0.6, hx + i * hr * 1.7, hy - hr * 1.05);
        ctx.quadraticCurveTo(hx + i * hr * 1.35, hy - hr * 0.55, hx + i * hr * 0.55, hy - hr * 0.35);
        ctx.closePath(); ctx.fill(); outline(ctx, horn, 1.2);
      }
      return;
    }
    // small nubs / neat horns
    var big = (id === "wagyu" || id === "dexter" || id === "jersey");
    for (var j = -1; j <= 1; j += 2) {
      ell(ctx, hx + j * hr * 0.55, hy - hr * 0.72, hr * (big ? 0.14 : 0.16), hr * (big ? 0.22 : 0.14));
      ctx.fill(); outline(ctx, horn, 1);
    }
  }

  // shaggy fur: overlapping downward wavy strokes
  function drawFur(ctx, cx, cy, rx, ry, fluff, base, count) {
    ctx.save();
    ell(ctx, cx, cy, rx, ry); ctx.clip();
    ctx.strokeStyle = rgba(dark(fluff, 0.05), 0.8); ctx.lineWidth = Math.max(1, rx * 0.10); ctx.lineCap = "round";
    for (var i = 0; i < count; i++) {
      var t = i / (count - 1), sx = cx + (t - 0.5) * rx * 2.0;
      var top = cy - ry + h01(i, 7) * ry * 0.4;
      ctx.beginPath();
      ctx.moveTo(sx, top);
      ctx.quadraticCurveTo(sx + rx * 0.12, top + ry * 0.6, sx + (h01(i, 3) - 0.5) * rx * 0.3, top + ry * (1.1 + h01(i, 9) * 0.5));
      ctx.stroke();
    }
    ctx.strokeStyle = rgba(light(fluff, 0.18), 0.5);
    for (var k = 0; k < count; k += 2) {
      var sx2 = cx + (k / (count - 1) - 0.5) * rx * 1.8;
      ctx.beginPath(); ctx.moveTo(sx2, cy - ry * 0.6); ctx.lineTo(sx2 + rx * 0.05, cy + ry * 0.6); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // CHICKEN
  // ---------------------------------------------------------------------------
  function drawChicken(ctx, U, mood, blink, look, hop) {
    var body = "#FBF7EC", beak = "#F2A63C", comb = "#E8607A", leg = "#F2A63C";
    var cy = -0.42 * U, r = 0.36 * U;
    // legs
    ctx.strokeStyle = leg; ctx.lineWidth = 0.05 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-0.08 * U, -0.02 * U); ctx.lineTo(-0.08 * U, -0.16 * U); ctx.moveTo(0.08 * U, -0.02 * U); ctx.lineTo(0.08 * U, -0.16 * U); ctx.stroke();
    // tail feathers
    ctx.fillStyle = light(body, 0.02);
    ell(ctx, -r * 0.85, cy - r * 0.2, r * 0.5, r * 0.28); ctx.fill(); outline(ctx, body, 1.2);
    // egg body
    ell(ctx, 0, cy, r * 0.85, r); ctx.fillStyle = bodyGrad(ctx, cy - r, cy + r, body); ctx.fill(); outline(ctx, body, 1.4);
    // wing
    ctx.save(); ell(ctx, 0, cy, r * 0.85, r); ctx.clip();
    ell(ctx, r * 0.2, cy + r * 0.1, r * 0.5, r * 0.55); ctx.fillStyle = rgba(P.prod.eggShade, 0.6); ctx.fill(); ctx.restore();
    // comb (3 bumps) + wattle
    ctx.fillStyle = comb;
    for (var i = 0; i < 3; i++) { circle(ctx, (i - 1) * r * 0.22, cy - r * 0.98, r * 0.14); ctx.fill(); }
    ell(ctx, r * 0.55, cy - r * 0.42, r * 0.09, r * 0.14); ctx.fill();
    // beak
    ctx.fillStyle = beak; ctx.beginPath();
    ctx.moveTo(r * 0.72, cy - r * 0.28); ctx.lineTo(r * 1.02, cy - r * 0.18); ctx.lineTo(r * 0.72, cy - r * 0.08); ctx.closePath(); ctx.fill();
    // face
    face(ctx, r * 0.28, cy - r * 0.28, r * 0.6, { blink: blink, mood: mood, look: look, blush: true, spacing: 0.5, eyeScale: 0.85 });
  }

  // ---------------------------------------------------------------------------
  // DUCK
  // ---------------------------------------------------------------------------
  function drawDuck(ctx, U, mood, blink, look, hop) {
    var body = "#FFD95C", bill = "#F2953C";
    var cy = -0.40 * U, r = 0.38 * U;
    // legs
    ctx.strokeStyle = bill; ctx.lineWidth = 0.05 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-0.07 * U, -0.02 * U); ctx.lineTo(-0.07 * U, -0.14 * U); ctx.moveTo(0.09 * U, -0.02 * U); ctx.lineTo(0.09 * U, -0.14 * U); ctx.stroke();
    // tail flip
    ctx.fillStyle = light(body, 0.05);
    ell(ctx, -r * 0.8, cy - r * 0.15, r * 0.4, r * 0.3); ctx.fill();
    // body
    ell(ctx, 0, cy, r, r * 0.82); ctx.fillStyle = bodyGrad(ctx, cy - r * 0.82, cy + r * 0.82, body); ctx.fill(); outline(ctx, body, 1.4);
    // wing
    ctx.save(); ell(ctx, 0, cy, r, r * 0.82); ctx.clip();
    ell(ctx, r * 0.1, cy + r * 0.05, r * 0.55, r * 0.5); ctx.fillStyle = rgba(dark(body, 0.10), 0.5); ctx.fill(); ctx.restore();
    // head
    var hx = r * 0.55, hy = cy - r * 0.7, hr = r * 0.5;
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.4);
    // bill
    ctx.fillStyle = bill; rr(ctx, hx + hr * 0.5, hy - hr * 0.05, hr * 0.9, hr * 0.4, hr * 0.2); ctx.fill(); outline(ctx, bill, 1);
    face(ctx, hx, hy - hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.42, eyeScale: 0.9 });
  }

  // ---------------------------------------------------------------------------
  // SHEEP (fluffy cloud)
  // ---------------------------------------------------------------------------
  function drawSheep(ctx, U, headBig, mood, blink, look) {
    var wool = "#F3EDDF", faceC = "#E9C9A0", leg = "#6B5540";
    var cy = -0.48 * U, r = 0.42 * U;
    legs(ctx, U, leg, 0.24 * U, 0.14 * U, 0.10 * U);
    // cloud body = ring of bumps
    ctx.beginPath();
    var bumps = 9;
    for (var i = 0; i < bumps; i++) {
      var a = (i / bumps) * TAU, bx = Math.cos(a) * r * 0.95, by = cy + Math.sin(a) * r * 0.72;
      circle(ctx, bx, by, r * 0.34);
    }
    ell(ctx, 0, cy, r, r * 0.78);
    ctx.fillStyle = wool; ctx.fill();
    // outline the blob softly by stroking bumps
    ctx.save();
    for (i = 0; i < bumps; i++) { var a2 = (i / bumps) * TAU; circle(ctx, Math.cos(a2) * r * 0.95, cy + Math.sin(a2) * r * 0.72, r * 0.34); ctx.strokeStyle = rgba(P.prod.woolShade, 0.7); ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.restore();
    // inner fluff shading
    ctx.fillStyle = rgba(P.prod.woolShade, 0.35);
    circle(ctx, -r * 0.2, cy + r * 0.2, r * 0.28); ctx.fill();
    // head
    var hx = r * 0.55, hy = cy - r * 0.1, hr = r * 0.42 * headBig;
    ell(ctx, hx, hy, hr, hr * 1.05); ctx.fillStyle = faceC; ctx.fill(); outline(ctx, faceC, 1.3);
    // floppy ears
    ctx.fillStyle = dark(faceC, 0.10);
    ell(ctx, hx - hr * 0.9, hy - hr * 0.1, hr * 0.35, hr * 0.2); ctx.fill();
    ell(ctx, hx + hr * 0.9, hy - hr * 0.1, hr * 0.35, hr * 0.2); ctx.fill();
    // wool fringe on top of head
    ctx.fillStyle = wool;
    for (i = -1; i <= 1; i++) { circle(ctx, hx + i * hr * 0.4, hy - hr * 0.85, hr * 0.3); ctx.fill(); }
    face(ctx, hx, hy + hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.4, eyeColor: dark(faceC, 0.4) });
  }

  // ---------------------------------------------------------------------------
  // GOAT
  // ---------------------------------------------------------------------------
  function drawGoat(ctx, U, headBig, mood, blink, look) {
    var body = "#EFE6D2", horn = "#C9B48A", leg = "#6B5540";
    var cy = -0.46 * U, rx = 0.44 * U, ry = 0.30 * U;
    legs(ctx, U, leg, 0.28 * U, 0.15 * U);
    ell(ctx, 0, cy, rx, ry); ctx.fillStyle = bodyGrad(ctx, cy - ry, cy + ry, body); ctx.fill(); outline(ctx, body, 1.3);
    // little tail
    ell(ctx, -rx * 0.95, cy - ry * 0.2, ry * 0.22, ry * 0.3); ctx.fillStyle = body; ctx.fill();
    // head (side-ish)
    var hx = rx * 0.7, hy = cy - ry * 1.25, hr = 0.26 * U * headBig;
    // backward-curved horns
    ctx.strokeStyle = horn; ctx.lineWidth = hr * 0.28; ctx.lineCap = "round";
    for (var i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.3, hy - hr * 0.7); ctx.quadraticCurveTo(hx + i * hr * 0.5, hy - hr * 1.5, hx - i * hr * 0.1, hy - hr * 1.7); ctx.stroke(); }
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.3);
    // floppy ears
    ctx.fillStyle = dark(body, 0.08);
    ell(ctx, hx - hr * 0.95, hy, hr * 0.4, hr * 0.22); ctx.fill();
    ell(ctx, hx + hr * 0.95, hy, hr * 0.4, hr * 0.22); ctx.fill();
    // beard
    ctx.fillStyle = light(body, 0.10);
    ell(ctx, hx, hy + hr * 1.0, hr * 0.18, hr * 0.35); ctx.fill();
    // rectangular pupils = horizontal dashes (cute)
    face(ctx, hx, hy + hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.42, eyeScale: 0.7, mouth: mood === "happy" ? "smile" : "none" });
    // dash pupils overlay
    if ((blink || 0) < 0.5) {
      ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = hr * 0.05;
      ctx.beginPath(); ctx.moveTo(hx - hr * 0.42 - hr * 0.05, hy); ctx.lineTo(hx - hr * 0.42 + hr * 0.05, hy);
      ctx.moveTo(hx + hr * 0.42 - hr * 0.05, hy); ctx.lineTo(hx + hr * 0.42 + hr * 0.05, hy); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  // PIG
  // ---------------------------------------------------------------------------
  function drawPig(ctx, U, headBig, mood, blink, look) {
    var body = "#F6B8C0", snout = "#EE9AA8", leg = "#E092A0";
    var cy = -0.42 * U, r = 0.42 * U;
    legs(ctx, U, leg, 0.30 * U, 0.12 * U);
    // curly tail
    ctx.strokeStyle = snout; ctx.lineWidth = 0.045 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(-r * 0.95, cy - r * 0.1, r * 0.14, Math.PI, TAU + Math.PI * 0.5); ctx.stroke();
    // body
    ell(ctx, 0, cy, r, r * 0.78); ctx.fillStyle = bodyGrad(ctx, cy - r * 0.78, cy + r * 0.78, body); ctx.fill(); outline(ctx, body, 1.4);
    // head
    var hx = r * 0.5, hy = cy - r * 0.55, hr = 0.30 * U * headBig;
    // floppy triangle ears
    ctx.fillStyle = dark(body, 0.08);
    for (var i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.5, hy - hr * 0.7); ctx.lineTo(hx + i * hr * 0.95, hy - hr * 0.2); ctx.lineTo(hx + i * hr * 0.25, hy - hr * 0.2); ctx.closePath(); ctx.fill(); }
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.4);
    // big snout
    ell(ctx, hx, hy + hr * 0.5, hr * 0.55, hr * 0.4); ctx.fillStyle = snout; ctx.fill(); outline(ctx, snout, 1.2);
    ctx.fillStyle = dark(snout, 0.28);
    circle(ctx, hx - hr * 0.2, hy + hr * 0.5, hr * 0.1); ctx.fill();
    circle(ctx, hx + hr * 0.2, hy + hr * 0.5, hr * 0.1); ctx.fill();
    face(ctx, hx, hy - hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: true, spacing: 0.5, eyeScale: 0.85 });
  }

  // ---------------------------------------------------------------------------
  // ALPACA (stubby-long neck signature)
  // ---------------------------------------------------------------------------
  function drawAlpaca(ctx, U, mood, blink, look) {
    var body = "#F1E9D6", leg = "#D8CBB2";
    var cy = -0.5 * U, rx = 0.34 * U, ry = 0.30 * U;
    legs(ctx, U, leg, 0.20 * U, 0.20 * U, 0.10 * U);
    // fluffy oval body
    ell(ctx, 0, cy, rx, ry); ctx.fillStyle = bodyGrad(ctx, cy - ry, cy + ry, body); ctx.fill();
    // bumpy fluff outline
    ctx.save(); ell(ctx, 0, cy, rx, ry); ctx.clip();
    ctx.fillStyle = rgba(P.accent.lav, 0.10); ell(ctx, 0, cy - ry * 0.4, rx, ry * 0.6); ctx.fill(); ctx.restore();
    outline(ctx, body, 1.3);
    // curved fluff neck
    ctx.beginPath();
    ctx.moveTo(rx * 0.2, cy - ry * 0.6);
    ctx.quadraticCurveTo(rx * 0.9, cy - ry * 1.6, rx * 0.7, cy - ry * 2.6);
    ctx.lineTo(rx * 0.2, cy - ry * 2.5);
    ctx.quadraticCurveTo(rx * 0.2, cy - ry * 1.4, -rx * 0.05, cy - ry * 0.5);
    ctx.closePath(); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.3);
    // head
    var hx = rx * 0.5, hy = cy - ry * 2.8, hr = 0.20 * U;
    // banana ears
    ctx.fillStyle = dark(body, 0.06);
    for (var i = -1; i <= 1; i += 2) { ell(ctx, hx + i * hr * 0.5, hy - hr * 0.9, hr * 0.2, hr * 0.4); ctx.fill(); }
    ell(ctx, hx, hy, hr, hr * 1.05); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.2);
    // topknot fringe
    ctx.fillStyle = light(body, 0.02);
    for (i = -1; i <= 1; i++) { circle(ctx, hx + i * hr * 0.3, hy - hr * 0.85, hr * 0.28); ctx.fill(); }
    face(ctx, hx, hy + hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: true, spacing: 0.42, eyeScale: 1.15 });
  }

  // ---------------------------------------------------------------------------
  // RABBIT
  // ---------------------------------------------------------------------------
  function drawRabbit(ctx, U, headBig, mood, blink, look, hop) {
    var body = "#F4EFE6";
    var cy = -0.34 * U, r = 0.34 * U;
    // cotton tail
    circle(ctx, -r * 0.8, cy + r * 0.2, r * 0.22); ctx.fillStyle = "#FFFFFF"; ctx.fill();
    // body
    ell(ctx, 0, cy, r * 0.8, r * 0.72); ctx.fillStyle = bodyGrad(ctx, cy - r, cy + r, body); ctx.fill(); outline(ctx, body, 1.3);
    // head
    var hx = r * 0.35, hy = cy - r * 0.6, hr = 0.28 * U * headBig;
    // huge tall ears (one can flop via hop)
    var flop = Math.sin(hop) * 0.15;
    ctx.fillStyle = body;
    for (var i = -1; i <= 1; i += 2) {
      ctx.save(); ctx.translate(hx + i * hr * 0.4, hy - hr * 0.5); ctx.rotate(i * (0.12 + (i > 0 ? flop : 0)));
      ell(ctx, 0, -hr * 0.9, hr * 0.24, hr * 0.85); ctx.fill(); outline(ctx, body, 1.1);
      ell(ctx, 0, -hr * 0.9, hr * 0.12, hr * 0.6); ctx.fillStyle = rgba(P.accent.pinkLight, 0.9); ctx.fill(); ctx.fillStyle = body; ctx.restore();
    }
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.2);
    face(ctx, hx, hy, hr, { blink: blink, mood: mood, look: look, blush: true, spacing: 0.42, eyeScale: 1.1, mouth: "w" });
    // pink nose
    ell(ctx, hx, hy + hr * 0.35, hr * 0.08, hr * 0.06); ctx.fillStyle = P.accent.pinkDeep; ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // DOG (看板犬)
  // ---------------------------------------------------------------------------
  function drawDog(ctx, U, headBig, mood, blink, look, hop) {
    var body = "#E2B27C", ear = "#C79461", tongue = "#FF9CB0";
    var cy = -0.4 * U, rx = 0.4 * U, ry = 0.3 * U;
    legs(ctx, U, dark(body, 0.06), 0.28 * U, 0.14 * U);
    // waggy tail
    ctx.save(); ctx.translate(-rx * 0.9, cy - ry * 0.3); ctx.rotate(Math.sin(hop * 2.2) * 0.5);
    ctx.strokeStyle = body; ctx.lineWidth = 0.09 * U; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-rx * 0.3, -ry * 0.5); ctx.stroke(); ctx.restore();
    // body
    ell(ctx, 0, cy, rx, ry); ctx.fillStyle = bodyGrad(ctx, cy - ry, cy + ry, body); ctx.fill(); outline(ctx, body, 1.3);
    // head
    var hx = rx * 0.55, hy = cy - ry * 0.9, hr = 0.28 * U * headBig;
    // floppy ears (behind)
    ctx.fillStyle = ear;
    ell(ctx, hx - hr * 0.85, hy + hr * 0.1, hr * 0.32, hr * 0.55); ctx.fill();
    ell(ctx, hx + hr * 0.85, hy + hr * 0.1, hr * 0.32, hr * 0.55); ctx.fill();
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.3);
    // muzzle
    ell(ctx, hx, hy + hr * 0.45, hr * 0.5, hr * 0.35); ctx.fillStyle = light(body, 0.14); ctx.fill();
    // tongue pant
    ell(ctx, hx, hy + hr * 0.75 + Math.abs(Math.sin(hop * 2)) * hr * 0.06, hr * 0.14, hr * 0.2); ctx.fillStyle = tongue; ctx.fill();
    // nose
    ell(ctx, hx, hy + hr * 0.4, hr * 0.13, hr * 0.1); ctx.fillStyle = dark(P.ui.text, 0.1); ctx.fill();
    face(ctx, hx, hy - hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.44, eyeScale: 1 });
  }

  // ---------------------------------------------------------------------------
  // CAT (看板猫)
  // ---------------------------------------------------------------------------
  function drawCat(ctx, U, headBig, mood, blink, look, hop) {
    var body = "#F0A55A";
    var cy = -0.36 * U, rx = 0.4 * U, ry = 0.26 * U;
    // curly tail
    ctx.save(); ctx.strokeStyle = body; ctx.lineWidth = 0.08 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-rx * 0.85, cy);
    ctx.quadraticCurveTo(-rx * 1.35, cy - ry * 0.8, -rx * 1.0, cy - ry * 1.8 + Math.sin(hop) * ry * 0.2); ctx.stroke(); ctx.restore();
    // loaf body
    ell(ctx, 0, cy, rx, ry); ctx.fillStyle = bodyGrad(ctx, cy - ry, cy + ry, body); ctx.fill(); outline(ctx, body, 1.3);
    // tabby stripes
    ctx.save(); ell(ctx, 0, cy, rx, ry); ctx.clip();
    ctx.strokeStyle = rgba(dark(body, 0.15), 0.6); ctx.lineWidth = 0.04 * U;
    for (var s = -1; s <= 1; s++) { ctx.beginPath(); ctx.moveTo(s * rx * 0.35, cy - ry); ctx.lineTo(s * rx * 0.35, cy - ry * 0.2); ctx.stroke(); }
    ctx.restore();
    // head
    var hx = rx * 0.55, hy = cy - ry * 1.0, hr = 0.27 * U * headBig;
    // pointy ears
    ctx.fillStyle = body;
    for (var i = -1; i <= 1; i += 2) {
      ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.5, hy - hr * 0.6); ctx.lineTo(hx + i * hr * 0.85, hy - hr * 1.25); ctx.lineTo(hx + i * hr * 0.1, hy - hr * 0.9); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.45, hy - hr * 0.7); ctx.lineTo(hx + i * hr * 0.65, hy - hr * 1.05); ctx.lineTo(hx + i * hr * 0.28, hy - hr * 0.85); ctx.closePath(); ctx.fillStyle = P.accent.pinkLight; ctx.fill(); ctx.fillStyle = body;
    }
    circle(ctx, hx, hy, hr); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.3);
    var sleepy = mood === "sleepy" || mood === "content";
    face(ctx, hx, hy, hr, { blink: sleepy ? 1 : blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.42, mouth: "cat", eyeScale: 0.95 });
    // whiskers
    ctx.strokeStyle = rgba("#FFFFFF", 0.7); ctx.lineWidth = Math.max(0.8, hr * 0.03);
    for (i = -1; i <= 1; i += 2) for (var w = -1; w <= 1; w++) {
      ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.25, hy + hr * 0.4 + w * hr * 0.08); ctx.lineTo(hx + i * hr * 0.95, hy + hr * 0.35 + w * hr * 0.16); ctx.stroke();
    }
    // pink nose
    ctx.beginPath(); ctx.moveTo(hx - hr * 0.06, hy + hr * 0.28); ctx.lineTo(hx + hr * 0.06, hy + hr * 0.28); ctx.lineTo(hx, hy + hr * 0.38); ctx.closePath(); ctx.fillStyle = P.accent.pinkDeep; ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // HORSE
  // ---------------------------------------------------------------------------
  function drawHorse(ctx, U, headBig, mood, blink, look) {
    var body = "#B5713E", mane = "#6B4A2F";
    var cy = -0.58 * U, rx = 0.5 * U, ry = 0.34 * U;
    legs(ctx, U, dark(body, 0.1), 0.36 * U, 0.22 * U);
    // tail
    ctx.strokeStyle = mane; ctx.lineWidth = 0.1 * U; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-rx * 0.95, cy); ctx.quadraticCurveTo(-rx * 1.2, cy + 0.3 * U, -rx * 1.05, cy + 0.55 * U); ctx.stroke();
    // body
    ell(ctx, 0, cy, rx, ry); ctx.fillStyle = bodyGrad(ctx, cy - ry, cy + ry, body); ctx.fill(); outline(ctx, body, 1.4);
    // neck + head — compact chibi pony (short, chunky neck; head sits close to body)
    var nx = rx * 0.5;
    ctx.beginPath(); ctx.moveTo(nx - rx * 0.18, cy - ry * 0.15);
    ctx.quadraticCurveTo(nx + rx * 0.42, cy - ry * 0.85, nx + rx * 0.6, cy - ry * 1.35);
    ctx.lineTo(nx + rx * 0.14, cy - ry * 1.32);
    ctx.quadraticCurveTo(nx - rx * 0.02, cy - ry * 0.7, nx - rx * 0.46, cy - ry * 0.05);
    ctx.closePath(); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.4);
    var hx = nx + rx * 0.48, hy = cy - ry * 1.5, hr = 0.25 * U * headBig;
    // mane down the neck
    ctx.strokeStyle = mane; ctx.lineWidth = 0.1 * U; ctx.lineCap = "round";
    for (var m = 0; m < 4; m++) { ctx.beginPath(); ctx.moveTo(nx + rx * 0.1 + m * 0.07 * U, cy - ry * (0.35 + m * 0.3)); ctx.lineTo(nx - rx * 0.12 + m * 0.07 * U, cy - ry * (0.22 + m * 0.3)); ctx.stroke(); }
    // ears
    ctx.fillStyle = body;
    for (var i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.moveTo(hx + i * hr * 0.3, hy - hr * 0.62); ctx.lineTo(hx + i * hr * 0.5, hy - hr * 1.05); ctx.lineTo(hx - i * hr * 0.02, hy - hr * 0.72); ctx.closePath(); ctx.fill(); }
    // rounder head + soft muzzle
    ell(ctx, hx, hy, hr * 1.02, hr * 1.05); ctx.fillStyle = body; ctx.fill(); outline(ctx, body, 1.3);
    ell(ctx, hx + hr * 0.16, hy + hr * 0.66, hr * 0.56, hr * 0.42); ctx.fillStyle = dark(body, 0.06); ctx.fill();
    // star blaze
    ell(ctx, hx, hy - hr * 0.16, hr * 0.17, hr * 0.38); ctx.fillStyle = light(body, 0.5); ctx.fill();
    face(ctx, hx, hy - hr * 0.05, hr, { blink: blink, mood: mood, look: look, blush: mood === "happy", spacing: 0.52, eyeScale: 0.95 });
  }

  // ===========================================================================
  // BUILDINGS
  // building(ctx, type, x,y, opts{level,w,h,lit})   x,y = ground centre (feet)
  // w,h are footprint tiles; we size to ~w*TILE wide. `lit` = night glow.
  // ===========================================================================
  function building(ctx, type, x, y, opts) {
    opts = opts || {};
    var TILE = 48;
    var fw = (opts.w || 2) * TILE, fh = (opts.h || 2) * TILE;
    var lit = !!opts.lit, level = opts.level || 1, phase = opts.phase || 0;
    ctx.save();
    try {
      contactShadow(ctx, x, y, fw * 0.9, 0.16);
      ctx.translate(x, y);
      switch (type) {
        case "barn": bBarn(ctx, fw, fh, lit, false); break;
        case "barn_big": bBarn(ctx, fw, fh, lit, true); break;
        case "coop": bCoop(ctx, fw, fh, lit); break;
        case "silo": bSilo(ctx, fw, fh); break;
        case "dairy": bDairy(ctx, fw, fh, lit, phase); break;
        case "house": bHouse(ctx, fw, fh, lit, phase); break;
        case "windmill": bWindmill(ctx, fw, fh, phase); break;
        case "market_stall": bStall(ctx, fw, fh); break;
        case "well": bWell(ctx, fw, fh); break;
        case "warehouse": bWarehouse(ctx, fw, fh, lit); break;
        case "pasture": bPasture(ctx, fw, fh); break;
        case "pond": bPond(ctx, fw, fh, phase); break;
        case "fence": bFence(ctx, fw, fh); break;
        case "sprinkler": bSprinkler(ctx, fw, fh, phase); break;
        case "feed_trough": bTrough(ctx, fw, fh); break;
        default: bGeneric(ctx, fw, fh, lit); break;
      }
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.building:" + type, e); }
    ctx.restore();
  }

  function wall(ctx, w, h, col) {
    rr(ctx, -w / 2, -h, w, h, Math.min(10, w * 0.08));
    ctx.fillStyle = bodyGrad(ctx, -h, 0, col); ctx.fill(); outline(ctx, col, 1.6);
  }
  function gambrel(ctx, w, y, col, dcol) {
    var hw = w / 2;
    ctx.beginPath();
    ctx.moveTo(-hw * 1.08, y);
    ctx.lineTo(-hw * 0.6, y - w * 0.22);
    ctx.quadraticCurveTo(0, y - w * 0.42, hw * 0.6, y - w * 0.22);
    ctx.lineTo(hw * 1.08, y);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); outline(ctx, col, 1.6);
    // underside line
    ctx.fillStyle = rgba(dcol, 0.5); rr(ctx, -hw * 1.08, y - w * 0.02, w * 1.08, w * 0.05, 2); ctx.fill();
  }

  function windowGlow(ctx, x, y, r, lit) {
    if (lit) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
      g.addColorStop(0, rgba(P.light.lamp, 0.9)); g.addColorStop(1, rgba(P.light.lamp, 0));
      ctx.fillStyle = g; circle(ctx, x, y, r * 2.4); ctx.fill();
    }
    circle(ctx, x, y, r); ctx.fillStyle = lit ? P.light.lamp : rgba(P.accent.sky, 0.55); ctx.fill(); outline(ctx, P.ui.wood, 1.2);
  }

  function bBarn(ctx, w, h, lit, big) {
    var bw = w * (big ? 0.92 : 0.82), bh = h * 0.58;
    wall(ctx, bw, bh, P.wood.base);
    // plank lines
    ctx.strokeStyle = rgba(P.wood.dark, 0.5); ctx.lineWidth = 1;
    for (var i = 1; i < 4; i++) { var px = -bw / 2 + (bw / 4) * i; ctx.beginPath(); ctx.moveTo(px, -bh); ctx.lineTo(px, 0); ctx.stroke(); }
    // roof
    gambrel(ctx, bw * 1.02, -bh, P.roof.red, P.roof.redDark);
    if (big) { gambrel(ctx, bw * 0.55, -bh - w * 0.14, P.roof.red, P.roof.redDark); }
    // hay door w/ X-brace
    var dw = bw * 0.34, dh = bh * 0.7;
    rr(ctx, -dw / 2, -dh, dw, dh, dw * 0.3); ctx.fillStyle = P.ui.parchment; ctx.fill(); outline(ctx, P.ui.border, 1.4);
    ctx.strokeStyle = rgba(P.wood.dark, 0.6); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-dw / 2, -dh); ctx.lineTo(dw / 2, 0); ctx.moveTo(dw / 2, -dh); ctx.lineTo(-dw / 2, 0); ctx.stroke();
    // heart window
    heartPath(ctx, bw * 0.28, -bh * 0.6, bh * 0.16);
    ctx.fillStyle = lit ? P.light.lamp : rgba(P.accent.pinkLight, 0.8); ctx.fill(); outline(ctx, P.accent.pink, 1.2);
    if (lit) { heartPath(ctx, bw * 0.28, -bh * 0.6, bh * 0.16); ctx.fillStyle = rgba(P.light.lamp, 0.4); ctx.fill(); }
    // weathervane
    ctx.strokeStyle = P.wood.dark; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -bh - w * 0.42); ctx.lineTo(0, -bh - w * 0.55); ctx.stroke();
    ell(ctx, 0, -bh - w * 0.58, w * 0.05, w * 0.03); ctx.fillStyle = P.ui.text; ctx.fill();
  }

  function bCoop(ctx, w, h) {
    var bw = w * 0.7, bh = h * 0.42;
    wall(ctx, bw, bh, P.wood.light);
    // slanted roof
    ctx.beginPath(); ctx.moveTo(-bw * 0.62, -bh); ctx.lineTo(bw * 0.62, -bh); ctx.lineTo(bw * 0.5, -bh - bh * 0.6); ctx.lineTo(-bw * 0.7, -bh - bh * 0.6); ctx.closePath();
    ctx.fillStyle = P.roof.red; ctx.fill(); outline(ctx, P.roof.red, 1.5);
    // entry hole + ramp
    circle(ctx, 0, -bh * 0.4, bh * 0.22); ctx.fillStyle = dark(P.wood.base, 0.3); ctx.fill();
    ctx.fillStyle = P.wood.plank; rr(ctx, -bh * 0.18, -bh * 0.2, bh * 0.36, bh * 0.3, 2); ctx.fill();
    // perch + egg pip
    ell(ctx, bw * 0.4, -bh * 0.5, bh * 0.12, bh * 0.16); ctx.fillStyle = P.prod.egg; ctx.fill(); outline(ctx, P.prod.eggShade, 1);
  }

  function bSilo(ctx, w, h) {
    var bw = w * 0.6, bh = h * 0.82;
    rr(ctx, -bw / 2, -bh, bw, bh, bw * 0.12);
    ctx.fillStyle = bodyGrad(ctx, -bh, 0, P.stone.light); ctx.fill(); outline(ctx, P.stone.base, 1.6);
    // bands
    ctx.strokeStyle = rgba(P.stone.dark, 0.4); ctx.lineWidth = 1.5;
    for (var i = 1; i < 5; i++) { var yy = -bh + (bh / 5) * i; ctx.beginPath(); ctx.moveTo(-bw / 2, yy); ctx.lineTo(bw / 2, yy); ctx.stroke(); }
    // dome cap
    ctx.beginPath(); ctx.arc(0, -bh, bw * 0.52, Math.PI, TAU); ctx.fillStyle = P.roof.blue; ctx.fill(); outline(ctx, P.roof.blue, 1.5);
    // feed window
    rr(ctx, -bw * 0.18, -bh * 0.5, bw * 0.36, bh * 0.22, 3); ctx.fillStyle = P.accent.yellow; ctx.fill(); outline(ctx, dark(P.accent.yellow, 0.2), 1);
  }

  function bDairy(ctx, w, h, lit, phase) {
    var bw = w * 0.78, bh = h * 0.5;
    wall(ctx, bw, bh, P.ui.parchment);
    // blue roof
    ctx.beginPath(); ctx.moveTo(-bw * 0.6, -bh); ctx.lineTo(0, -bh - bh * 0.7); ctx.lineTo(bw * 0.6, -bh); ctx.closePath();
    ctx.fillStyle = P.roof.blue; ctx.fill(); outline(ctx, P.roof.blue, 1.6);
    // chimney + steam
    ctx.fillStyle = P.stone.base; rr(ctx, bw * 0.28, -bh - bh * 0.5, bw * 0.12, bh * 0.4, 2); ctx.fill();
    for (var i = 0; i < 3; i++) { var t = (phase + i * 0.33) % 1; ctx.globalAlpha = (1 - t) * 0.5; circle(ctx, bw * 0.34, -bh - bh * 0.55 - t * bh * 0.7, bh * 0.08 + t * bh * 0.06); ctx.fillStyle = P.wx.cloud; ctx.fill(); }
    ctx.globalAlpha = 1;
    // shop window w/ cheese
    windowGlow(ctx, 0, -bh * 0.45, bh * 0.2, lit);
    ell(ctx, 0, -bh * 0.45, bh * 0.12, bh * 0.1); ctx.fillStyle = P.prod.cheese; ctx.fill();
  }

  function bHouse(ctx, w, h, lit, phase) {
    var bw = w * 0.74, bh = h * 0.5;
    wall(ctx, bw, bh, P.ui.parchment);
    ctx.beginPath(); ctx.moveTo(-bw * 0.62, -bh); ctx.lineTo(0, -bh - bh * 0.75); ctx.lineTo(bw * 0.62, -bh); ctx.closePath();
    ctx.fillStyle = P.roof.red; ctx.fill(); outline(ctx, P.roof.red, 1.6);
    // round door + wreath
    var dw = bw * 0.26;
    rr(ctx, -dw / 2, -bh * 0.62, dw, bh * 0.62, dw * 0.5); ctx.fillStyle = P.wood.base; ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    circle(ctx, 0, -bh * 0.5, dw * 0.28); ctx.strokeStyle = P.accent.mint; ctx.lineWidth = 2; ctx.stroke();
    // window
    windowGlow(ctx, bw * 0.3, -bh * 0.55, bh * 0.15, lit);
    // flower box
    ctx.fillStyle = P.wood.dark; rr(ctx, bw * 0.3 - bh * 0.16, -bh * 0.38, bh * 0.32, bh * 0.1, 2); ctx.fill();
    ctx.fillStyle = P.accent.pink; circle(ctx, bw * 0.3 - bh * 0.08, -bh * 0.4, bh * 0.04); ctx.fill();
    ctx.fillStyle = P.accent.yellow; circle(ctx, bw * 0.3 + bh * 0.08, -bh * 0.4, bh * 0.04); ctx.fill();
    // chimney smoke
    ctx.fillStyle = P.stone.base; rr(ctx, -bw * 0.35, -bh - bh * 0.5, bh * 0.14, bh * 0.4, 2); ctx.fill();
    for (var i = 0; i < 2; i++) { var t = (phase + i * 0.5) % 1; ctx.globalAlpha = (1 - t) * 0.4; circle(ctx, -bw * 0.32, -bh - bh * 0.55 - t * bh * 0.5, bh * 0.06 + t * bh * 0.05); ctx.fillStyle = P.wx.cloud; ctx.fill(); }
    ctx.globalAlpha = 1;
  }

  function bWindmill(ctx, w, h, phase) {
    var bw = w * 0.42, bh = h * 0.9;
    ctx.beginPath(); ctx.moveTo(-bw * 0.5, 0); ctx.lineTo(-bw * 0.32, -bh); ctx.lineTo(bw * 0.32, -bh); ctx.lineTo(bw * 0.5, 0); ctx.closePath();
    ctx.fillStyle = bodyGrad(ctx, -bh, 0, P.ui.cream); ctx.fill(); outline(ctx, P.wood.base, 1.6);
    // cap
    ctx.beginPath(); ctx.moveTo(-bw * 0.36, -bh); ctx.lineTo(0, -bh - bh * 0.16); ctx.lineTo(bw * 0.36, -bh); ctx.closePath(); ctx.fillStyle = P.roof.red; ctx.fill(); outline(ctx, P.roof.red, 1.4);
    // door
    rr(ctx, -bw * 0.12, -bh * 0.32, bw * 0.24, bh * 0.32, 3); ctx.fillStyle = P.wood.dark; ctx.fill();
    // rotating blades
    var cx = 0, cy = -bh;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(phase * TAU);
    for (var b = 0; b < 4; b++) {
      ctx.rotate(TAU / 4);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(bw * 0.14, -w * 0.42); ctx.lineTo(-bw * 0.1, -w * 0.4); ctx.closePath();
      ctx.fillStyle = P.ui.panel; ctx.fill(); outline(ctx, P.wood.base, 1.2);
    }
    ctx.restore();
    circle(ctx, cx, cy, w * 0.05); ctx.fillStyle = P.wood.dark; ctx.fill();
  }

  function bStall(ctx, w, h) {
    var bw = w * 0.8, bh = h * 0.34;
    // counter
    ctx.fillStyle = P.wood.base; rr(ctx, -bw / 2, -bh, bw, bh, 4); ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    // posts
    ctx.fillStyle = P.wood.dark; rr(ctx, -bw / 2, -bh - h * 0.4, 5, h * 0.4, 2); ctx.fill(); rr(ctx, bw / 2 - 5, -bh - h * 0.4, 5, h * 0.4, 2); ctx.fill();
    // striped scalloped awning
    var ay = -bh - h * 0.4, aw = bw * 1.05;
    for (var i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? P.accent.pink : P.ui.panel;
      var sx = -aw / 2 + (aw / 6) * i;
      ctx.beginPath(); ctx.moveTo(sx, ay); ctx.lineTo(sx + aw / 6, ay); ctx.lineTo(sx + aw / 6, ay + h * 0.14); ctx.arc(sx + aw / 12, ay + h * 0.14, aw / 12, 0, Math.PI); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = P.wood.dark; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-aw / 2, ay); ctx.lineTo(aw / 2, ay); ctx.stroke();
    // baskets
    ell(ctx, -bw * 0.24, -bh * 0.4, bw * 0.12, bh * 0.28); ctx.fillStyle = P.wood.plank; ctx.fill();
    circle(ctx, -bw * 0.24, -bh * 0.5, bw * 0.06); ctx.fillStyle = P.status.alert; ctx.fill();
    circle(ctx, bw * 0.22, -bh * 0.5, bw * 0.06); ctx.fillStyle = P.accent.yellow; ctx.fill();
  }

  function bWell(ctx, w, h) {
    var bw = w * 0.6;
    // stone rim
    ell(ctx, 0, -bw * 0.16, bw * 0.5, bw * 0.24); ctx.fillStyle = P.stone.base; ctx.fill(); outline(ctx, P.stone.dark, 1.5);
    ell(ctx, 0, -bw * 0.2, bw * 0.4, bw * 0.18); ctx.fillStyle = P.water.base; ctx.fill();
    ell(ctx, -bw * 0.1, -bw * 0.22, bw * 0.14, bw * 0.06); ctx.fillStyle = rgba(P.water.light, 0.8); ctx.fill();
    // posts + peaked roof
    ctx.strokeStyle = P.wood.base; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-bw * 0.4, -bw * 0.2); ctx.lineTo(-bw * 0.36, -bw * 0.9); ctx.moveTo(bw * 0.4, -bw * 0.2); ctx.lineTo(bw * 0.36, -bw * 0.9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-bw * 0.5, -bw * 0.9); ctx.lineTo(0, -bw * 1.2); ctx.lineTo(bw * 0.5, -bw * 0.9); ctx.closePath(); ctx.fillStyle = P.wood.dark; ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    // bucket
    rr(ctx, -bw * 0.08, -bw * 0.7, bw * 0.16, bw * 0.16, 2); ctx.fillStyle = P.wood.plank; ctx.fill();
  }

  function bWarehouse(ctx, w, h, lit) {
    var bw = w * 0.82, bh = h * 0.5;
    wall(ctx, bw, bh, P.wood.plank);
    ctx.beginPath(); ctx.moveTo(-bw * 0.58, -bh); ctx.lineTo(0, -bh - bh * 0.5); ctx.lineTo(bw * 0.58, -bh); ctx.closePath(); ctx.fillStyle = P.roof.red; ctx.fill(); outline(ctx, P.roof.red, 1.6);
    // double doors
    rr(ctx, -bw * 0.28, -bh * 0.8, bw * 0.56, bh * 0.8, 3); ctx.fillStyle = P.wood.base; ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    ctx.strokeStyle = rgba(P.wood.dark, 0.6); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -bh * 0.8); ctx.lineTo(0, 0); ctx.stroke();
    // crates beside
    ctx.fillStyle = P.wood.light;
    rr(ctx, bw * 0.34, -bh * 0.3, bh * 0.3, bh * 0.3, 2); ctx.fill(); outline(ctx, P.wood.dark, 1);
    rr(ctx, bw * 0.34, -bh * 0.62, bh * 0.3, bh * 0.3, 2); ctx.fill(); outline(ctx, P.wood.dark, 1);
  }

  function bPasture(ctx, w, h) {
    // grass plot + gate + tree
    ell(ctx, 0, -h * 0.1, w * 0.5, h * 0.24); ctx.fillStyle = rgba(P.grass.mid, 0.5); ctx.fill();
    railFence(ctx, w, h);
    // shade tree
    var tx = w * 0.28, ty = -h * 0.25;
    ctx.fillStyle = P.wood.base; rr(ctx, tx - 3, ty, 6, h * 0.3, 2); ctx.fill();
    circle(ctx, tx, ty, w * 0.16); ctx.fillStyle = P.grass.mid; ctx.fill();
    circle(ctx, tx - w * 0.1, ty + w * 0.02, w * 0.11); ctx.fillStyle = P.grass.base; ctx.fill();
    circle(ctx, tx + w * 0.08, ty - w * 0.03, w * 0.1); ctx.fillStyle = P.grass.light; ctx.fill();
  }

  function railFence(ctx, w, h) {
    var y0 = -h * 0.02;
    ctx.strokeStyle = P.wood.plank; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-w * 0.46, y0 - 10); ctx.lineTo(w * 0.46, y0 - 10); ctx.moveTo(-w * 0.46, y0 - 20); ctx.lineTo(w * 0.46, y0 - 20); ctx.stroke();
    ctx.fillStyle = P.wood.base;
    for (var i = -2; i <= 2; i++) { rr(ctx, i * w * 0.22 - 3, y0 - 28, 6, 30, 3); ctx.fill(); }
  }

  function bFence(ctx, w, h) {
    var y0 = -h * 0.06;
    ctx.strokeStyle = P.wood.plank; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-w * 0.4, y0 - 8); ctx.lineTo(w * 0.4, y0 - 8); ctx.moveTo(-w * 0.4, y0 - 18); ctx.lineTo(w * 0.4, y0 - 18); ctx.stroke();
    ctx.fillStyle = P.wood.base;
    rr(ctx, -w * 0.42, y0 - 26, 6, 28, 3); ctx.fill(); rr(ctx, w * 0.42 - 6, y0 - 26, 6, 28, 3); ctx.fill();
    circle(ctx, -w * 0.39, y0 - 26, 4); ctx.fill(); circle(ctx, w * 0.39, y0 - 26, 4); ctx.fill();
  }

  function bPond(ctx, w, h, phase) {
    ell(ctx, 0, -h * 0.12, w * 0.5, h * 0.32); ctx.fillStyle = P.water.base; ctx.fill(); outline(ctx, P.water.dark, 1.4);
    ell(ctx, 0, -h * 0.16, w * 0.42, h * 0.24); ctx.fillStyle = rgba(P.water.light, 0.5); ctx.fill();
    // ripples
    ctx.strokeStyle = rgba(P.water.light, 0.6); ctx.lineWidth = 1.5;
    var rp = (phase % 1);
    ctx.beginPath(); ell(ctx, -w * 0.1, -h * 0.1, w * 0.1 * (0.5 + rp), h * 0.05 * (0.5 + rp)); ctx.globalAlpha = 1 - rp; ctx.stroke(); ctx.globalAlpha = 1;
    // lily pad
    circle(ctx, w * 0.18, -h * 0.06, w * 0.08); ctx.fillStyle = P.grass.mid; ctx.fill();
    circle(ctx, w * 0.19, -h * 0.07, w * 0.02); ctx.fillStyle = P.accent.pink; ctx.fill();
    // reeds
    ctx.strokeStyle = P.grass.dark; ctx.lineWidth = 2;
    for (var i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-w * 0.32 + i * 6, -h * 0.18); ctx.lineTo(-w * 0.33 + i * 6, -h * 0.34); ctx.stroke(); }
  }

  function bSprinkler(ctx, w, h, phase) {
    ctx.fillStyle = P.stone.base; rr(ctx, -3, -h * 0.4, 6, h * 0.4, 2); ctx.fill();
    ctx.save(); ctx.translate(0, -h * 0.4); ctx.rotate(Math.sin(phase * TAU) * 0.5);
    ctx.fillStyle = P.stone.light; rr(ctx, -w * 0.12, -4, w * 0.24, 8, 3); ctx.fill(); ctx.restore();
    // water arcs
    ctx.strokeStyle = rgba(P.accent.sky, 0.6); ctx.lineWidth = 1.5;
    for (var i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.moveTo(i * w * 0.1, -h * 0.4); ctx.quadraticCurveTo(i * w * 0.3, -h * 0.6, i * w * 0.36, -h * 0.2); ctx.stroke(); }
  }

  function bTrough(ctx, w, h) {
    ctx.fillStyle = P.wood.base; rr(ctx, -w * 0.36, -h * 0.24, w * 0.72, h * 0.2, 4); ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    ctx.fillStyle = P.accent.yellow; rr(ctx, -w * 0.32, -h * 0.22, w * 0.64, h * 0.1, 3); ctx.fill();
    // hopper
    ctx.fillStyle = P.wood.plank; ctx.beginPath(); ctx.moveTo(-w * 0.1, -h * 0.24); ctx.lineTo(w * 0.1, -h * 0.24); ctx.lineTo(w * 0.06, -h * 0.5); ctx.lineTo(-w * 0.06, -h * 0.5); ctx.closePath(); ctx.fill();
  }

  function bGeneric(ctx, w, h, lit) {
    var bw = w * 0.7, bh = h * 0.5; wall(ctx, bw, bh, P.wood.base);
    ctx.beginPath(); ctx.moveTo(-bw * 0.6, -bh); ctx.lineTo(0, -bh - bh * 0.5); ctx.lineTo(bw * 0.6, -bh); ctx.closePath(); ctx.fillStyle = P.roof.red; ctx.fill(); outline(ctx, P.roof.red, 1.5);
    windowGlow(ctx, 0, -bh * 0.4, bh * 0.16, lit);
  }

  function heartPath(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.7);
    ctx.bezierCurveTo(cx - r * 1.3, cy - r * 0.4, cx - r * 0.5, cy - r * 1.1, cx, cy - r * 0.35);
    ctx.bezierCurveTo(cx + r * 0.5, cy - r * 1.1, cx + r * 1.3, cy - r * 0.4, cx, cy + r * 0.7);
    ctx.closePath();
  }

  // ===========================================================================
  // CROPS   crop(ctx, cropId, x,y, opts{stage 0..3, watered, sway, wilt})
  // origin at soil surface (feet). 4 stages + wilt.
  // ===========================================================================
  function crop(ctx, cropId, x, y, opts) {
    opts = opts || {};
    var stage = clamp(opts.stage == null ? 3 : opts.stage, 0, 3);
    var sway = opts.sway || 0;
    var wilt = !!opts.wilt;
    var U = 40;
    ctx.save();
    try {
      contactShadow(ctx, x, y, U * 0.5, 0.12);
      ctx.translate(x, y);
      // soil mound
      ell(ctx, 0, 0, U * 0.28, U * 0.10); ctx.fillStyle = opts.watered ? P.soil.till : P.soil.base; ctx.fill();
      if (stage === 0) { // seed
        ctx.fillStyle = P.soil.dark;
        for (var i = -1; i <= 1; i++) { ell(ctx, i * U * 0.08, -U * 0.02, U * 0.02, U * 0.03); ctx.fill(); }
      } else {
        var lean = Math.sin(sway) * (wilt ? -0.05 : 0.08);
        ctx.rotate(lean);
        if (wilt) drawWiltPlant(ctx, U, stage);
        else drawCropStage(ctx, cropId, U, stage);
      }
      if (opts.watered && stage > 0) { ctx.fillStyle = rgba(P.accent.sky, 0.5); ell(ctx, U * 0.2, -U * 0.02, U * 0.03, U * 0.05); ctx.fill(); }
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.crop:" + cropId, e); }
    ctx.restore();
  }

  function stemLeaves(ctx, U, hgt, leafCol) {
    ctx.strokeStyle = P.grass.dark; ctx.lineWidth = Math.max(1.5, U * 0.05); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -hgt); ctx.stroke();
    ctx.fillStyle = leafCol || P.grass.mid;
    ell(ctx, -U * 0.12, -hgt * 0.5, U * 0.12, U * 0.06); ctx.fill();
    ell(ctx, U * 0.12, -hgt * 0.65, U * 0.12, U * 0.06); ctx.fill();
  }

  function drawCropStage(ctx, cropId, U, stage) {
    // stage 1 sprout, 2 growing, 3 ready — with per-crop "ready" signature
    if (stage === 1) {
      ctx.strokeStyle = P.grass.mid; ctx.lineWidth = U * 0.045; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -U * 0.18); ctx.stroke();
      ctx.fillStyle = P.grass.light;
      ell(ctx, -U * 0.08, -U * 0.2, U * 0.09, U * 0.05); ctx.fill();
      ell(ctx, U * 0.08, -U * 0.2, U * 0.09, U * 0.05); ctx.fill();
      return;
    }
    var ready = stage === 3;
    var hgt = ready ? U * 0.62 : U * 0.4;
    switch (cropId) {
      case "corn":
        stemLeaves(ctx, U, hgt * 1.2, P.grass.mid);
        if (ready) { ell(ctx, U * 0.06, -hgt * 1.0, U * 0.1, U * 0.22); ctx.fillStyle = P.accent.yellow; ctx.fill(); outline(ctx, dark(P.accent.yellow, 0.2), 1);
          ctx.fillStyle = P.grass.dark; ell(ctx, -U * 0.02, -hgt * 1.0, U * 0.06, U * 0.22); ctx.fill(); }
        break;
      case "wheat": case "hay":
        stemLeaves(ctx, U, hgt, "#E7C15A");
        if (ready) { ctx.fillStyle = cropId === "hay" ? "#E9C77A" : "#E7C15A"; for (var k = -1; k <= 1; k++) { ell(ctx, k * U * 0.06, -hgt - U * 0.06, U * 0.05, U * 0.14); ctx.fill(); } }
        break;
      case "pumpkin":
        stemLeaves(ctx, U, hgt * 0.5, P.grass.mid);
        if (ready) { ell(ctx, 0, -U * 0.18, U * 0.26, U * 0.22); ctx.fillStyle = "#EE8A3C"; ctx.fill(); outline(ctx, "#C96A24", 1.4);
          ctx.strokeStyle = rgba("#C96A24", 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -U * 0.38); ctx.lineTo(0, -U * 0.02); ctx.stroke(); }
        break;
      case "carrot":
        ctx.fillStyle = P.grass.light; for (var c = -1; c <= 1; c++) { ctx.strokeStyle = P.grass.mid; ctx.lineWidth = U * 0.03; ctx.beginPath(); ctx.moveTo(0, -U * 0.05); ctx.lineTo(c * U * 0.12, -hgt); ctx.stroke(); }
        if (ready) { ctx.fillStyle = "#F2953C"; ctx.beginPath(); ctx.moveTo(-U * 0.08, -U * 0.05); ctx.lineTo(U * 0.08, -U * 0.05); ctx.lineTo(0, U * 0.12); ctx.closePath(); ctx.fill(); }
        break;
      case "turnip":
        stemLeaves(ctx, U, hgt * 0.5, P.grass.mid);
        if (ready) { ell(ctx, 0, -U * 0.05, U * 0.16, U * 0.14); ctx.fillStyle = "#F7F3E8"; ctx.fill(); ell(ctx, 0, -U * 0.13, U * 0.16, U * 0.07); ctx.fillStyle = P.accent.lav; ctx.fill(); outline(ctx, dark("#F7F3E8", 0.15), 1); }
        break;
      case "sunflower":
        stemLeaves(ctx, U, hgt * 1.3, P.grass.mid);
        if (ready) { for (var p = 0; p < 10; p++) { var a = (p / 10) * TAU; ell(ctx, Math.cos(a) * U * 0.18, -hgt * 1.3 + Math.sin(a) * U * 0.18, U * 0.07, U * 0.04); ctx.fillStyle = P.accent.yellow; ctx.fill(); }
          circle(ctx, 0, -hgt * 1.3, U * 0.12); ctx.fillStyle = P.soil.dark; ctx.fill(); }
        break;
      case "alfalfa": case "clover":
        stemLeaves(ctx, U, hgt * 0.6, P.grass.base);
        if (ready) { ctx.fillStyle = cropId === "alfalfa" ? P.accent.lav : P.grass.light; for (var q = 0; q < 3; q++) { var qa = (q / 3) * TAU; circle(ctx, Math.cos(qa) * U * 0.1, -hgt * 0.6 + Math.sin(qa) * U * 0.1, U * 0.06); ctx.fill(); } }
        break;
      case "grass": default:
        ctx.strokeStyle = ready ? P.grass.base : P.grass.mid; ctx.lineWidth = U * 0.04; ctx.lineCap = "round";
        for (var g = -2; g <= 2; g++) { ctx.beginPath(); ctx.moveTo(g * U * 0.05, 0); ctx.quadraticCurveTo(g * U * 0.06, -hgt * 0.6, g * U * 0.08, -hgt); ctx.stroke(); }
        break;
    }
    if (ready) { if ((Math.floor(Date.now() / 500) % 4) === 0) { /* sparkle handled by render */ } }
  }

  function drawWiltPlant(ctx, U, stage) {
    ctx.strokeStyle = P.status.amber; ctx.lineWidth = U * 0.045; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(U * 0.1, -U * 0.2, U * 0.2, -U * 0.15); ctx.stroke();
    ctx.fillStyle = rgba(P.status.amber, 0.8);
    ell(ctx, U * 0.2, -U * 0.15, U * 0.1, U * 0.05); ctx.fill();
  }

  // ===========================================================================
  // PROPS / DECORATIONS   prop(ctx, propId, x,y, opts)
  // ===========================================================================
  function prop(ctx, propId, x, y, opts) {
    opts = opts || {};
    var U = 40, phase = opts.phase || 0;
    ctx.save();
    try {
      contactShadow(ctx, x, y, U * 0.5, 0.12);
      ctx.translate(x, y);
      switch (propId) {
        case "flower_bed": pFlowerBed(ctx, U); break;
        case "scarecrow": pScarecrow(ctx, U); break;
        case "signboard": case "picket_sign": pSign(ctx, U); break;
        case "lantern": case "star_lantern": pLantern(ctx, U, propId === "star_lantern", opts.lit); break;
        case "bench": pBench(ctx, U); break;
        case "fountain": pFountain(ctx, U, phase); break;
        case "topiary_cow": pTopiary(ctx, U); break;
        case "hay_bale": pHayBale(ctx, U); break;
        case "balloon": pBalloon(ctx, U, phase); break;
        case "flower_arch": pArch(ctx, U); break;
        case "windbell": pWindbell(ctx, U, phase); break;
        case "pond_lily": pLily(ctx, U); break;
        case "tree": pTree(ctx, U); break;
        case "rock": pRock(ctx, U); break;
        case "flower": pFlower(ctx, U, opts.color); break;
        default: pSign(ctx, U); break;
      }
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.prop:" + propId, e); }
    ctx.restore();
  }

  function pFlowerBed(ctx, U) {
    ctx.fillStyle = P.wood.base; rr(ctx, -U * 0.3, -U * 0.14, U * 0.6, U * 0.16, 3); ctx.fill(); outline(ctx, P.wood.dark, 1.2);
    var cols = [P.accent.pink, P.accent.yellow, P.accent.lav, P.status.alert];
    for (var i = 0; i < 5; i++) { pFlowerHead(ctx, -U * 0.24 + i * U * 0.12, -U * 0.16, U * 0.06, cols[i % cols.length]); }
  }
  function pFlowerHead(ctx, x, y, r, col) {
    ctx.fillStyle = col; for (var p = 0; p < 5; p++) { var a = (p / 5) * TAU; circle(ctx, x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.6); ctx.fill(); }
    circle(ctx, x, y, r * 0.5); ctx.fillStyle = P.accent.yellow; ctx.fill();
  }
  function pFlower(ctx, U, col) { ctx.strokeStyle = P.grass.dark; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -U * 0.24); ctx.stroke(); pFlowerHead(ctx, 0, -U * 0.28, U * 0.09, col || P.accent.pink); }
  function pScarecrow(ctx, U) {
    ctx.strokeStyle = P.wood.base; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -U * 0.7); ctx.moveTo(-U * 0.24, -U * 0.5); ctx.lineTo(U * 0.24, -U * 0.5); ctx.stroke();
    ctx.fillStyle = P.status.amber; circle(ctx, 0, -U * 0.78, U * 0.14); ctx.fill(); outline(ctx, P.status.amber, 1.2);
    ctx.fillStyle = P.wood.dark; ctx.beginPath(); ctx.moveTo(-U * 0.16, -U * 0.86); ctx.lineTo(U * 0.16, -U * 0.86); ctx.lineTo(0, -U * 1.1); ctx.closePath(); ctx.fill();
    face(ctx, 0, -U * 0.78, U * 0.14, { mood: "happy", blush: true });
  }
  function pSign(ctx, U) {
    ctx.fillStyle = P.wood.base; rr(ctx, -3, -U * 0.4, 6, U * 0.4, 2); ctx.fill();
    ctx.fillStyle = P.ui.parchment; rr(ctx, -U * 0.28, -U * 0.62, U * 0.56, U * 0.28, 4); ctx.fill(); outline(ctx, P.wood.dark, 1.4);
    ctx.strokeStyle = rgba(P.ui.text, 0.5); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-U * 0.18, -U * 0.52); ctx.lineTo(U * 0.18, -U * 0.52); ctx.moveTo(-U * 0.18, -U * 0.44); ctx.lineTo(U * 0.1, -U * 0.44); ctx.stroke();
  }
  function pLantern(ctx, U, star, lit) {
    ctx.fillStyle = P.wood.dark; rr(ctx, -3, -U * 0.5, 6, U * 0.5, 2); ctx.fill();
    var gcol = star ? P.accent.lav : P.status.amber;
    if (lit) { var g = ctx.createRadialGradient(0, -U * 0.6, 0, 0, -U * 0.6, U * 0.4); g.addColorStop(0, rgba(P.light.lamp, 0.8)); g.addColorStop(1, rgba(P.light.lamp, 0)); ctx.fillStyle = g; circle(ctx, 0, -U * 0.6, U * 0.4); ctx.fill(); }
    if (star) { drawStar(ctx, 0, -U * 0.6, U * 0.16, P.accent.yellow); }
    else { rr(ctx, -U * 0.12, -U * 0.72, U * 0.24, U * 0.24, 4); ctx.fillStyle = lit ? P.light.lamp : rgba(gcol, 0.7); ctx.fill(); outline(ctx, P.wood.dark, 1.4); }
  }
  function pBench(ctx, U) {
    ctx.fillStyle = P.wood.base; rr(ctx, -U * 0.3, -U * 0.2, U * 0.6, U * 0.08, 3); ctx.fill();
    rr(ctx, -U * 0.3, -U * 0.42, U * 0.6, U * 0.06, 3); ctx.fill();
    ctx.fillStyle = P.wood.dark; rr(ctx, -U * 0.26, -U * 0.14, 5, U * 0.14, 2); ctx.fill(); rr(ctx, U * 0.22, -U * 0.14, 5, U * 0.14, 2); ctx.fill();
  }
  function pFountain(ctx, U, phase) {
    ell(ctx, 0, -U * 0.06, U * 0.4, U * 0.16); ctx.fillStyle = P.stone.base; ctx.fill(); outline(ctx, P.stone.dark, 1.5);
    ell(ctx, 0, -U * 0.09, U * 0.32, U * 0.12); ctx.fillStyle = P.water.base; ctx.fill();
    ctx.fillStyle = P.stone.light; rr(ctx, -U * 0.06, -U * 0.4, U * 0.12, U * 0.32, 3); ctx.fill();
    ell(ctx, 0, -U * 0.42, U * 0.14, U * 0.06); ctx.fillStyle = P.water.light; ctx.fill();
    // sprays
    ctx.strokeStyle = rgba(P.accent.sky, 0.6); ctx.lineWidth = 1.5;
    for (var i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.moveTo(0, -U * 0.44); ctx.quadraticCurveTo(i * U * 0.18, -U * 0.6, i * U * 0.22, -U * 0.2); ctx.stroke(); }
  }
  function pTopiary(ctx, U) {
    ctx.fillStyle = P.grass.mid; ell(ctx, 0, -U * 0.3, U * 0.28, U * 0.24); ctx.fill();
    circle(ctx, U * 0.18, -U * 0.42, U * 0.12); ctx.fill(); // head
    ctx.fillStyle = P.grass.dark; ell(ctx, -U * 0.18, -U * 0.1, U * 0.05, U * 0.12); ctx.fill(); ell(ctx, U * 0.14, -U * 0.1, U * 0.05, U * 0.12); ctx.fill();
    ctx.fillStyle = P.grass.light; circle(ctx, -U * 0.06, -U * 0.34, U * 0.08); ctx.fill();
  }
  function pHayBale(ctx, U) {
    ell(ctx, 0, -U * 0.16, U * 0.26, U * 0.2); ctx.fillStyle = "#E9C77A"; ctx.fill(); outline(ctx, dark("#E9C77A", 0.2), 1.4);
    ctx.strokeStyle = rgba(dark("#E9C77A", 0.25), 0.7); ctx.lineWidth = 1.5;
    for (var i = -1; i <= 1; i++) { ell(ctx, i * U * 0.1, -U * 0.16, U * 0.05, U * 0.18); ctx.stroke(); }
  }
  function pBalloon(ctx, U, phase) {
    var yo = Math.sin(phase * TAU) * U * 0.03;
    ctx.strokeStyle = rgba(P.ui.text, 0.4); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -U * 0.4 + yo); ctx.stroke();
    ell(ctx, 0, -U * 0.6 + yo, U * 0.16, U * 0.2); ctx.fillStyle = P.accent.pink; ctx.fill();
    ell(ctx, -U * 0.05, -U * 0.66 + yo, U * 0.05, U * 0.07); ctx.fillStyle = rgba("#FFFFFF", 0.6); ctx.fill();
  }
  function pArch(ctx, U) {
    ctx.strokeStyle = P.wood.base; ctx.lineWidth = 5; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-U * 0.4, 0); ctx.lineTo(-U * 0.4, -U * 0.5); ctx.quadraticCurveTo(0, -U * 0.9, U * 0.4, -U * 0.5); ctx.lineTo(U * 0.4, 0); ctx.stroke();
    for (var i = 0; i < 6; i++) { var t = i / 5, a = Math.PI * (1 - t); pFlowerHead(ctx, Math.cos(a) * U * 0.4, -U * 0.5 + Math.sin(a) * -U * 0.35 - U * 0.05, U * 0.05, i % 2 ? P.accent.pink : P.accent.lav); }
  }
  function pWindbell(ctx, U, phase) {
    ctx.strokeStyle = P.wood.dark; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -U * 0.5); ctx.lineTo(0, -U * 0.3); ctx.stroke();
    ctx.save(); ctx.translate(0, -U * 0.3); ctx.rotate(Math.sin(phase * TAU) * 0.2);
    ctx.beginPath(); ctx.arc(0, 0, U * 0.1, Math.PI, TAU); ctx.lineTo(U * 0.1, U * 0.04); ctx.lineTo(-U * 0.1, U * 0.04); ctx.closePath(); ctx.fillStyle = P.accent.sky; ctx.fill(); outline(ctx, P.water.dark, 1.2);
    ctx.fillStyle = P.ui.parchment; rr(ctx, -U * 0.03, U * 0.06, U * 0.06, U * 0.14, 2); ctx.fill(); ctx.restore();
  }
  function pLily(ctx, U) { circle(ctx, 0, -U * 0.04, U * 0.16); ctx.fillStyle = P.grass.mid; ctx.fill(); pFlowerHead(ctx, 0, -U * 0.06, U * 0.06, P.accent.pinkLight); }
  function pTree(ctx, U) {
    ctx.fillStyle = P.wood.base; rr(ctx, -U * 0.05, -U * 0.4, U * 0.1, U * 0.4, 3); ctx.fill();
    circle(ctx, 0, -U * 0.5, U * 0.26); ctx.fillStyle = P.grass.mid; ctx.fill();
    circle(ctx, -U * 0.16, -U * 0.42, U * 0.16); ctx.fillStyle = P.grass.base; ctx.fill();
    circle(ctx, U * 0.14, -U * 0.46, U * 0.15); ctx.fillStyle = P.grass.light; ctx.fill();
  }
  function pRock(ctx, U) { ell(ctx, 0, -U * 0.1, U * 0.22, U * 0.16); ctx.fillStyle = P.stone.base; ctx.fill(); outline(ctx, P.stone.dark, 1.4); ell(ctx, -U * 0.05, -U * 0.14, U * 0.1, U * 0.06); ctx.fillStyle = P.stone.light; ctx.fill(); }

  function drawStar(ctx, cx, cy, r, col) {
    ctx.beginPath();
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + i * TAU / 5, a2 = a + TAU / 10;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a2) * r * 0.45, cy + Math.sin(a2) * r * 0.45);
    }
    ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  }

  // ===========================================================================
  // TILES   tile(ctx, terrain, x,y, size, variant)   x,y = tile top-left
  // ===========================================================================
  function tile(ctx, terrain, x, y, size, variant) {
    variant = variant || 0;
    ctx.save();
    try {
      if (terrain === "water") drawWaterTile(ctx, x, y, size, variant);
      else if (terrain === "dirt") drawDirtTile(ctx, x, y, size, variant);
      else if (terrain === "path") drawPathTile(ctx, x, y, size, variant);
      else drawGrassTile(ctx, x, y, size, variant);
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.tile:" + terrain, e); }
    ctx.restore();
  }

  function drawGrassTile(ctx, x, y, s, v) {
    // checker shading via variant parity for subtle mowed-row feel
    var base = ((x / s + y / s) | 0) % 2 === 0 ? P.grass.base : mix(P.grass.base, P.grass.mid, 0.25);
    ctx.fillStyle = base; ctx.fillRect(x, y, s + 1, s + 1);
    // top highlight band
    ctx.fillStyle = rgba(P.grass.light, 0.25); ctx.fillRect(x, y, s + 1, s * 0.22);
    // accent blades (deterministic per variant)
    ctx.strokeStyle = P.grass.blade; ctx.lineWidth = Math.max(1, s * 0.03); ctx.lineCap = "round";
    var n = 3 + ((v % 3));
    for (var i = 0; i < n; i++) {
      var bx = x + h01(v * 7 + i, 1) * s, by = y + s * 0.5 + h01(v * 7 + i, 2) * s * 0.45;
      var lean = (h01(v * 7 + i, 3) - 0.5) * s * 0.12;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx + lean, by - s * 0.12, bx + lean * 1.5, by - s * 0.2); ctx.stroke();
    }
    // occasional tiny flower
    if (h01(v, 11) > 0.82) { pFlowerHead(ctx, x + h01(v, 12) * s, y + s * 0.6 + h01(v, 13) * s * 0.3, s * 0.05, h01(v, 14) > 0.5 ? P.accent.pink : P.accent.yellow); }
  }

  function drawDirtTile(ctx, x, y, s, v) {
    ctx.fillStyle = P.soil.base; ctx.fillRect(x, y, s + 1, s + 1);
    // furrows
    ctx.strokeStyle = rgba(P.soil.dark, 0.5); ctx.lineWidth = Math.max(1, s * 0.04);
    for (var i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x, y + (s / 4) * i); ctx.lineTo(x + s, y + (s / 4) * i); ctx.stroke(); }
    ctx.fillStyle = rgba(P.soil.light, 0.4); ctx.fillRect(x, y, s + 1, s * 0.12);
    for (var k = 0; k < 3; k++) { ell(ctx, x + h01(v + k, 5) * s, y + h01(v + k, 6) * s, s * 0.03, s * 0.02); ctx.fillStyle = rgba(P.soil.dark, 0.4); ctx.fill(); }
  }

  function drawPathTile(ctx, x, y, s, v) {
    ctx.fillStyle = mix(P.soil.light, P.stone.light, 0.4); ctx.fillRect(x, y, s + 1, s + 1);
    // pebbles
    for (var i = 0; i < 4; i++) {
      var px = x + h01(v * 5 + i, 8) * s, py = y + h01(v * 5 + i, 9) * s;
      ell(ctx, px, py, s * 0.07, s * 0.05); ctx.fillStyle = i % 2 ? P.stone.base : P.stone.light; ctx.fill(); outline(ctx, P.stone.dark, 0.8);
    }
  }

  function drawWaterTile(ctx, x, y, s, v) {
    var g = ctx.createLinearGradient(x, y, x, y + s); g.addColorStop(0, P.water.light); g.addColorStop(1, P.water.base);
    ctx.fillStyle = g; ctx.fillRect(x, y, s + 1, s + 1);
    // shimmer
    ctx.strokeStyle = rgba(P.water.light, 0.7); ctx.lineWidth = Math.max(1, s * 0.03); ctx.lineCap = "round";
    var t = (v % 8) / 8;
    for (var i = 0; i < 2; i++) {
      var wy = y + s * (0.3 + i * 0.35) + Math.sin((t + i) * TAU) * s * 0.05;
      ctx.beginPath(); ctx.moveTo(x + s * 0.2, wy); ctx.quadraticCurveTo(x + s * 0.5, wy - s * 0.06, x + s * 0.8, wy); ctx.stroke();
    }
  }

  // ===========================================================================
  // PARTICLES / FX
  // heart/sparkle/coin(ctx, x,y, t)  — t = life 0..1 (0 fresh, 1 gone)
  // weatherParticle(ctx, type, x,y, t) — t = phase/time
  // ===========================================================================
  function heart(ctx, x, y, t) {
    t = clamp(t || 0, 0, 1);
    var sc = (0.6 + t * 0.7) * 10, a = 1 - t;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.rotate(Math.sin(t * 6) * 0.15);
    heartPath(ctx, 0, 0, sc); ctx.fillStyle = P.accent.pink; ctx.fill();
    heartPath(ctx, 0, 0, sc); outline(ctx, P.accent.pinkDeep, 1.2);
    ell(ctx, -sc * 0.3, -sc * 0.3, sc * 0.2, sc * 0.15); ctx.fillStyle = rgba("#FFFFFF", 0.7); ctx.fill();
    ctx.restore();
  }

  function sparkle(ctx, x, y, t) {
    t = clamp(t || 0, 0, 1);
    var sc = Math.sin(t * Math.PI) * 9 + 2, a = Math.sin(t * Math.PI);
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y); ctx.rotate(t * 1.5);
    ctx.fillStyle = P.accent.yellow;
    for (var i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(sc * 0.18, -sc * 0.18, 0, -sc); ctx.quadraticCurveTo(-sc * 0.18, -sc * 0.18, 0, 0); ctx.fill();
    }
    circle(ctx, 0, 0, sc * 0.2); ctx.fillStyle = "#FFFFFF"; ctx.fill();
    ctx.restore();
  }

  function coin(ctx, x, y, t) {
    t = clamp(t || 0, 0, 1);
    var a = 1 - t * t, wob = Math.cos(t * 8);
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y);
    ell(ctx, 0, 0, 8 * Math.abs(wob) + 1, 8); ctx.fillStyle = P.accent.yellow; ctx.fill(); outline(ctx, dark(P.accent.yellow, 0.25), 1.4);
    ell(ctx, 0, 0, 5 * Math.abs(wob) + 0.5, 5); ctx.fillStyle = light(P.accent.yellow, 0.25); ctx.fill();
    if (Math.abs(wob) > 0.4) { ctx.fillStyle = dark(P.accent.yellow, 0.3); ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("G", 0, 0.5); }
    ctx.restore();
  }

  function weatherParticle(ctx, type, x, y, t) {
    ctx.save();
    try {
      if (type === "rain") {
        ctx.strokeStyle = rgba(P.wx.rain, 0.55); ctx.lineWidth = 1.6; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 2, y + 9); ctx.stroke();
      } else if (type === "snow") {
        var sway = Math.sin((t || 0) + x * 0.1) * 2;
        circle(ctx, x + sway, y, 2 + (Math.floor(x) % 2)); ctx.fillStyle = rgba(P.wx.snow, 0.85); ctx.fill();
      } else if (type === "leaf") {
        ctx.save(); ctx.translate(x, y); ctx.rotate((t || 0) * 3 + x);
        var lc = [ "#E8894B", "#D45E3C", "#E9B84C" ][Math.floor(x) % 3];
        ell(ctx, 0, 0, 4, 2.2); ctx.fillStyle = lc; ctx.fill(); ctx.restore();
      } else if (type === "petal") {
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin((t || 0) + x) * 0.8);
        ell(ctx, 0, 0, 3.5, 2); ctx.fillStyle = rgba("#FFC7DD", 0.9); ctx.fill(); ctx.restore();
      } else if (type === "pollen" || type === "mote") {
        var g = ctx.createRadialGradient(x, y, 0, x, y, 3); g.addColorStop(0, rgba("#FFE27A", 0.8)); g.addColorStop(1, rgba("#FFE27A", 0));
        ctx.fillStyle = g; circle(ctx, x, y, 3); ctx.fill();
      } else if (type === "dust") {
        ctx.strokeStyle = rgba(P.soil.light, (1 - (t || 0)) * 0.6); ctx.lineWidth = 2;
        circle(ctx, x, y, 3 + (t || 0) * 8); ctx.stroke();
      } else if (type === "zzz") {
        ctx.fillStyle = rgba(P.accent.sky, 1 - (t || 0)); ctx.font = "bold " + (7 + (t || 0) * 5) + "px sans-serif"; ctx.textAlign = "center"; ctx.fillText("Z", x, y);
      } else if (type === "droplet") {
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.quadraticCurveTo(x + 3, y, x, y + 3); ctx.quadraticCurveTo(x - 3, y, x, y - 5); ctx.closePath();
        ctx.fillStyle = P.accent.sky; ctx.fill();
        ell(ctx, x - 1, y - 1, 1, 1.5); ctx.fillStyle = rgba("#FFFFFF", 0.7); ctx.fill();
      } else if (type === "splash") {
        ctx.strokeStyle = rgba(P.water.light, 1 - (t || 0)); ctx.lineWidth = 1.5;
        circle(ctx, x, y, 2 + (t || 0) * 7); ctx.stroke();
      }
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.weatherParticle:" + type, e); }
    ctx.restore();
  }

  // ===========================================================================
  // UI ICONS  uiIcon(ctx, iconId, x,y, size)   (tolerates 3-arg (ctx,id,size))
  // Draws centred at (x,y) within a `size` box. For product/menu canvases.
  // ===========================================================================
  function uiIcon(ctx, iconId, x, y, size) {
    if (size === undefined) { size = x; x = 0; y = 0; }   // (ctx, iconId, size) form
    var s = size || 32, r = s * 0.5;
    ctx.save();
    try {
      ctx.translate(x + (arguments.length <= 3 ? r : 0), y + (arguments.length <= 3 ? r : 0));
      switch (iconId) {
        case "milk": case "goat_milk": iBottle(ctx, r, iconId === "goat_milk" ? P.prod.goat_milk : P.prod.milk); break;
        case "quality_milk": iBottle(ctx, r, P.prod.quality_milk); sparkle(ctx, r * 0.4, -r * 0.5, 0.5); break;
        case "cheese": iCheese(ctx, r); break;
        case "butter": iButter(ctx, r); break;
        case "yogurt": iCup(ctx, r, P.prod.yogurt); break;
        case "egg": iEgg(ctx, r, P.prod.egg); break;
        case "wool": iWool(ctx, r, P.prod.wool); break;
        case "fine_wool": iWool(ctx, r, P.prod.fine_wool); sparkle(ctx, r * 0.5, -r * 0.4, 0.5); break;
        case "truffle": iTruffle(ctx, r); break;
        case "manure": iManure(ctx, r); break;
        case "coin": coin(ctx, 0, 0, 0); break;
        case "heart": heart(ctx, 0, r * 0.3, 0); break;
        case "star": drawStar(ctx, 0, 0, r * 0.8, P.accent.yellow); outline(ctx, dark(P.accent.yellow, 0.3), 1); break;
        case "hunger": iBowl(ctx, r); break;
        case "happiness": heart(ctx, 0, r * 0.3, 0); break;
        case "health": iCross(ctx, r); break;
        case "cleanliness": sparkle(ctx, 0, 0, 0.5); break;
        case "grass": case "hay": iGrass(ctx, r, iconId); break;
        case "corn": iCorn(ctx, r); break;
        case "water": weatherParticle(ctx, "droplet", 0, 0, 0); break;
        default: iGeneric(ctx, r, iconId); break;
      }
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.uiIcon:" + iconId, e); }
    ctx.restore();
  }

  function iBottle(ctx, r, col) {
    rr(ctx, -r * 0.42, -r * 0.6, r * 0.84, r * 1.2, r * 0.18); ctx.fillStyle = col; ctx.fill(); outline(ctx, P.prod.milkShade, 1.4);
    rr(ctx, -r * 0.24, -r * 0.8, r * 0.48, r * 0.22, r * 0.06); ctx.fillStyle = P.accent.sky; ctx.fill();
    ell(ctx, -r * 0.2, -r * 0.2, r * 0.1, r * 0.3); ctx.fillStyle = rgba("#FFFFFF", 0.6); ctx.fill();
  }
  function iCheese(ctx, r) {
    ctx.beginPath(); ctx.moveTo(-r * 0.7, r * 0.4); ctx.lineTo(r * 0.7, r * 0.4); ctx.lineTo(r * 0.7, -r * 0.1); ctx.lineTo(-r * 0.4, -r * 0.5); ctx.closePath();
    ctx.fillStyle = P.prod.cheese; ctx.fill(); outline(ctx, P.prod.cheeseShade, 1.4);
    ctx.fillStyle = P.prod.cheeseShade; circle(ctx, 0, r * 0.1, r * 0.12); ctx.fill(); circle(ctx, r * 0.35, r * 0.2, r * 0.08); ctx.fill();
  }
  function iButter(ctx, r) { rr(ctx, -r * 0.6, -r * 0.3, r * 1.2, r * 0.6, r * 0.1); ctx.fillStyle = P.prod.butter; ctx.fill(); outline(ctx, dark(P.prod.butter, 0.2), 1.4); rr(ctx, -r * 0.6, -r * 0.3, r * 1.2, r * 0.2, r * 0.1); ctx.fillStyle = rgba("#FFFFFF", 0.4); ctx.fill(); }
  function iCup(ctx, r, col) { ctx.beginPath(); ctx.moveTo(-r * 0.4, -r * 0.4); ctx.lineTo(r * 0.4, -r * 0.4); ctx.lineTo(r * 0.3, r * 0.5); ctx.lineTo(-r * 0.3, r * 0.5); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); outline(ctx, dark(col, 0.15), 1.4); ell(ctx, 0, -r * 0.4, r * 0.4, r * 0.1); ctx.fillStyle = light(col, 0.3); ctx.fill(); }
  function iEgg(ctx, r, col) { ell(ctx, 0, r * 0.05, r * 0.55, r * 0.7); ctx.fillStyle = col; ctx.fill(); outline(ctx, P.prod.eggShade, 1.4); ell(ctx, -r * 0.15, -r * 0.15, r * 0.14, r * 0.2); ctx.fillStyle = rgba("#FFFFFF", 0.6); ctx.fill(); }
  function iWool(ctx, r, col) { for (var i = 0; i < 5; i++) { var a = (i / 5) * TAU; circle(ctx, Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35, r * 0.32); } circle(ctx, 0, 0, r * 0.4); ctx.fillStyle = col; ctx.fill(); outline(ctx, dark(col, 0.12), 1.2); }
  function iTruffle(ctx, r) { ell(ctx, 0, r * 0.1, r * 0.55, r * 0.45); ctx.fillStyle = P.prod.truffle; ctx.fill(); outline(ctx, P.prod.truffleShade, 1.4); ctx.fillStyle = rgba(P.prod.truffleShade, 0.8); circle(ctx, -r * 0.15, 0, r * 0.08); ctx.fill(); circle(ctx, r * 0.2, r * 0.15, r * 0.06); ctx.fill(); }
  function iManure(ctx, r) { ell(ctx, 0, r * 0.25, r * 0.55, r * 0.28); ctx.fillStyle = P.prod.manure; ctx.fill(); ell(ctx, 0, r * 0.0, r * 0.35, r * 0.22); ctx.fill(); circle(ctx, 0, -r * 0.2, r * 0.16); ctx.fill(); outline(ctx, dark(P.prod.manure, 0.2), 1.2); }
  function iBowl(ctx, r) { ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI); ctx.closePath(); ctx.fillStyle = P.status.amber; ctx.fill(); outline(ctx, dark(P.status.amber, 0.2), 1.4); ell(ctx, 0, 0, r * 0.55, r * 0.12); ctx.fillStyle = light(P.status.amber, 0.2); ctx.fill(); }
  function iCross(ctx, r) { ctx.fillStyle = P.status.good; rr(ctx, -r * 0.15, -r * 0.5, r * 0.3, r, r * 0.08); ctx.fill(); rr(ctx, -r * 0.5, -r * 0.15, r, r * 0.3, r * 0.08); ctx.fill(); }
  function iGrass(ctx, r, id) { ctx.strokeStyle = id === "hay" ? "#E9C77A" : P.grass.base; ctx.lineWidth = r * 0.14; ctx.lineCap = "round"; for (var g = -1; g <= 1; g++) { ctx.beginPath(); ctx.moveTo(g * r * 0.25, r * 0.5); ctx.quadraticCurveTo(g * r * 0.35, -r * 0.1, g * r * 0.4, -r * 0.5); ctx.stroke(); } }
  function iCorn(ctx, r) { ell(ctx, 0, 0, r * 0.3, r * 0.6); ctx.fillStyle = P.accent.yellow; ctx.fill(); outline(ctx, dark(P.accent.yellow, 0.2), 1.2); ctx.fillStyle = P.grass.mid; ell(ctx, -r * 0.25, r * 0.1, r * 0.18, r * 0.5); ctx.fill(); }
  function iGeneric(ctx, r, id) {
    circle(ctx, 0, 0, r * 0.6); ctx.fillStyle = P.ui.parchment; ctx.fill(); outline(ctx, P.ui.borderDark, 1.4);
    ctx.fillStyle = P.ui.textSoft; ctx.font = "bold " + (r * 0.7) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((id && id[0] ? id[0].toUpperCase() : "?"), 0, 1);
  }

  // ---------------------------------------------------------------------------
  // init — optional; publishes shared palette for other visual modules if none.
  // (Only side effects live here, per integration rules.)
  // ---------------------------------------------------------------------------
  function init(ctx) {
    try {
      if (!Game.Palette) Game.Palette = P;
      if (!Game.CowColors) Game.CowColors = CC;
    } catch (e) { if (Game && Game._recordError) Game._recordError("Sprites.init", e); }
  }

  return {
    init: init,
    face: face,
    animal: animal,
    building: building,
    crop: crop,
    prop: prop,
    tile: tile,
    weatherParticle: weatherParticle,
    heart: heart,
    sparkle: sparkle,
    coin: coin,
    uiIcon: uiIcon,
    palette: P,
    cowColors: CC
  };
})();
