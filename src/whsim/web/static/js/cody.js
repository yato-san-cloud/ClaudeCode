/* ============================================================
   OCTA — メンダコ (deep-sea octopus) pixel-art mascot.
   Framework-free ES module. The legacy internal name is "cody"
   (module/CSS/identifiers) but the rendered character + every
   user-facing label is OCTA, the 物流シミュレータ supporter.

   The mascot is generated as run-length-merged 1×1 SVG pixels from
   a parametric silhouette (mantle + ears + scalloped tentacle
   fringe), shaded with a fixed coral palette so OCTA keeps one
   identity across light/dark. Only the <g class="cody-face"> (eyes
   /mouth/props) swaps per mood; the body is built once. Cyan props
   (data dots, ?, Zzz, sparkles) tie OCTA to the WHSiM world.

   Public API (unchanged — the web shell calls this):
     mountCody(targetEl, opts) -> controller
       controller.setMood(mood, { say, autoIdleMs })
       controller.say(text, { mood, ms })
       controller.hide() / controller.show()
       controller.destroy()
     codyAvatarSVG(mood) -> static <svg> string (chat avatars)
   The most-recently-mounted controller is also exposed as
   window.whsimCody for non-module callers.
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

// Pixel grid (viewBox units). Wider-than-tall, like a resting mendako.
const GW = 22, GH = 20;

// OCTA palette — warm coral, theme-independent (a mascot keeps one
// identity). Cyan/alert/zzz are the "tech" props that tie to WHSiM.
const C = {
  out: "#5b1f2b",     // dark warm outline ring
  base: "#f4647a",    // coral body
  hi: "#ff98a7",      // lit highlight (upper-left)
  sh: "#d2455d",      // shadow (lower edge / lower-right)
  ear: "#ff8493",     // ears, a touch pinker
  eye: "#2a121a",     // near-black warm
  glint: "#ffffff",
  mouth: "#7a2233",
  tech: "#34e3ff",    // cyan props (brand)
  techHi: "#bdf8ff",
  alert: "#ff6b7d",
  zzz: "#9ab7ff",
  shadow: "rgba(91,31,43,.30)",
};

const MOODS = [
  "idle", "thinking", "typing", "success",
  "error", "curious", "excited", "sleeping",
];

// Default Japanese lines per mood — OCTA's voice: calm, dependable,
// "いっしょに、いい流れをつくろう". Never blames the user.
const DEFAULT_LINES = {
  idle: "いっしょに、いい流れをつくろう。まずは小さく動かそう。",
  thinking: "ちょっと考えてるよ…",
  typing: "書いてるところ。もう少し待ってね。",
  success: "できた。ついでにここも整えておいたよ。",
  error: "エラーは敵じゃないよ。直せる。",
  curious: "なにを作る？物流のこと、なんでも聞いてね。",
  excited: "いいね、それ動かしてみよう！",
  sleeping: "zzz… 呼んだら起きるよ。",
};

/* ---------- parametric silhouette → pixel grid ---------- */
const inEll = (x, y, ex, ey, rx, ry) =>
  ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 <= 1;
const CXP = 10.5, MY = 8.6, MRX = 8.8, MRY = 5.4;
const botY = (x) => MY + MRY * Math.sqrt(Math.max(0, 1 - ((x - CXP) / MRX) ** 2));

// codes: 0 empty · 1 base · 2 highlight · 3 shadow · 4 ear
function buildGrid() {
  const g = Array.from({ length: GH }, () => Array(GW).fill(0));
  const bumps = [-6.8, -3.4, 0, 3.4, 6.8].map((dx) => [CXP + dx, botY(CXP + dx)]);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const xc = x + 0.5, yc = y + 0.5; let f = 0;
    if (inEll(xc, yc, CXP, MY, MRX, MRY)) f = 1;                       // mantle
    if (inEll(xc, yc, CXP - 5.0, 3.7, 2.5, 2.7) ||
        inEll(xc, yc, CXP + 5.0, 3.7, 2.5, 2.7)) f = 4;               // ears
    for (const [bx, by] of bumps)                                     // tentacle nubs
      if (inEll(xc, yc, bx, by, 0.95, 1.85) && yc >= by - 0.2) f = f || 3;
    g[y][x] = f;
  }
  // shading on the mantle
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (g[y][x] === 1) {
    const xc = x + 0.5, yc = y + 0.5;
    if (inEll(xc, yc, CXP - 2.2, 6.4, 3.2, 2.6)) g[y][x] = 2;
    else if (yc > 11.4 || inEll(xc, yc, CXP + 3.6, 11.0, 3.4, 2.6)) g[y][x] = 3;
  }
  // clean base "sockets" behind the eyes (uniform colour for crisp eyes + blink)
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (g[y][x] > 0 && g[y][x] !== 4) {
    const xc = x + 0.5, yc = y + 0.5;
    if (inEll(xc, yc, 7, 9.4, 1.9, 2.4) || inEll(xc, yc, 14, 9.4, 1.9, 2.4)) g[y][x] = 1;
  }
  return g;
}

const GRID = buildGrid();
const FILL_OF = { 1: C.base, 2: C.hi, 3: C.sh, 4: C.ear };

function filled(x, y) { return x >= 0 && x < GW && y >= 0 && y < GH && GRID[y][x] > 0; }
function isEdge(x, y) {
  if (GRID[y][x] !== 0) return false;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
    if (filled(x + dx, y + dy)) return true;
  return false;
}
// Merge horizontal runs of the same colour into one <rect> (fewer nodes, no seams).
function runRects(test, colorOf) {
  let s = "";
  for (let y = 0; y < GH; y++) {
    let x = 0;
    while (x < GW) {
      if (test(x, y)) {
        const col = colorOf(x, y); let w = 1;
        while (x + w < GW && test(x + w, y) && colorOf(x + w, y) === col) w++;
        s += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${col}"/>`;
        x += w;
      } else x++;
    }
  }
  return s;
}

// Invariant body (built once): contact shadow + outline ring + shaded fills.
const BODY_INNER =
  `<ellipse cx="11" cy="18.7" rx="7" ry="1.1" fill="${C.shadow}"/>` +
  runRects((x, y) => isEdge(x, y), () => C.out) +
  runRects((x, y) => GRID[y][x] > 0, (x, y) => FILL_OF[GRID[y][x]]);

/* ---------- face pieces (grid coordinates) ---------- */
function eyesOpen(lookUp, twin) {
  const y = 8 + (lookUp ? -1 : 0);
  const g2 = twin
    ? `<rect x="7" y="${y + 2}" width="1" height="1" fill="${C.glint}"/><rect x="14" y="${y + 2}" width="1" height="1" fill="${C.glint}"/>`
    : "";
  return `<rect x="6" y="${y}" width="2" height="3" fill="${C.eye}"/>` +
    `<rect x="13" y="${y}" width="2" height="3" fill="${C.eye}"/>` +
    `<rect x="6" y="${y}" width="1" height="1" fill="${C.glint}"/>` +
    `<rect x="13" y="${y}" width="1" height="1" fill="${C.glint}"/>` + g2;
}
function blink(dur) {
  const a = `<animate attributeName="height" values="0;0;3;0" keyTimes="0;.92;.96;1" dur="${dur}" repeatCount="indefinite"/>`;
  return `<rect x="6" y="8" width="2" height="0" fill="${C.base}">${a}</rect>` +
    `<rect x="13" y="8" width="2" height="0" fill="${C.base}">${a}</rect>`;
}
// chevron "^ ^" happy eyes
const eyesHappy =
  `<rect x="6" y="9" width="1" height="1" fill="${C.eye}"/><rect x="7" y="8" width="1" height="1" fill="${C.eye}"/><rect x="8" y="9" width="1" height="1" fill="${C.eye}"/>` +
  `<rect x="13" y="9" width="1" height="1" fill="${C.eye}"/><rect x="14" y="8" width="1" height="1" fill="${C.eye}"/><rect x="15" y="9" width="1" height="1" fill="${C.eye}"/>`;
// gentle "‿ ‿" closed (sleeping)
const eyesClosed =
  `<rect x="6" y="9" width="1" height="1" fill="${C.eye}"/><rect x="7" y="10" width="1" height="1" fill="${C.eye}"/><rect x="8" y="9" width="1" height="1" fill="${C.eye}"/>` +
  `<rect x="13" y="9" width="1" height="1" fill="${C.eye}"/><rect x="14" y="10" width="1" height="1" fill="${C.eye}"/><rect x="15" y="9" width="1" height="1" fill="${C.eye}"/>`;
const eyesDot =
  `<rect x="7" y="9" width="1" height="2" fill="${C.eye}"/><rect x="14" y="9" width="1" height="2" fill="${C.eye}"/>`;
const browsWorried =
  `<rect x="6" y="7" width="1" height="1" fill="${C.eye}"/><rect x="7" y="6" width="1" height="1" fill="${C.eye}"/>` +
  `<rect x="15" y="7" width="1" height="1" fill="${C.eye}"/><rect x="14" y="6" width="1" height="1" fill="${C.eye}"/>`;
// mouths
const smile =
  `<rect x="10" y="13" width="2" height="1" fill="${C.mouth}"/><rect x="9" y="12" width="1" height="1" fill="${C.mouth}"/><rect x="12" y="12" width="1" height="1" fill="${C.mouth}"/>`;
const mouthFlat = `<rect x="10" y="12" width="2" height="1" fill="${C.mouth}"/>`;
const mouthOpen =
  `<rect x="9" y="12" width="4" height="1" fill="${C.mouth}"/><rect x="10" y="13" width="2" height="1" fill="${C.mouth}"/>`;
const mouthWavy =
  `<rect x="9" y="13" width="1" height="1" fill="${C.mouth}"/><rect x="10" y="12" width="1" height="1" fill="${C.mouth}"/><rect x="11" y="13" width="1" height="1" fill="${C.mouth}"/><rect x="12" y="12" width="1" height="1" fill="${C.mouth}"/>`;

// animated cyan props
function dataDots() {
  const d = (cx, cy, r, b) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.tech}"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin="${b}" repeatCount="indefinite"/></circle>`;
  return d(17.5, 5.5, 0.7, "0s") + d(19, 4.3, 0.55, ".4s") + d(20.2, 3.3, 0.45, ".8s");
}
function typingDots() {
  const r = (x, b) =>
    `<rect x="${x}" y="14.5" width="1.1" height="1.1" rx=".3" fill="${C.tech}"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin="${b}" repeatCount="indefinite"/></rect>`;
  return r(8.4, "0s") + r(10.4, ".15s") + r(12.4, ".3s");
}
function sparkle(cx, cy, b) {
  return `<g fill="${C.techHi}"><animate attributeName="opacity" values=".2;1;.2" dur="1.4s" begin="${b}" repeatCount="indefinite"/>` +
    `<rect x="${cx - 0.4}" y="${cy - 1.4}" width="0.8" height="2.8"/><rect x="${cx - 1.4}" y="${cy - 0.4}" width="2.8" height="0.8"/></g>`;
}
const qMark =
  `<text x="17.3" y="6.6" font-family="'Space Mono',monospace" font-weight="700" font-size="6" fill="${C.tech}">?` +
  `<animateTransform attributeName="transform" type="translate" values="0 0;0 -.6;0 0" dur="1.6s" repeatCount="indefinite"/></text>`;
const bang =
  `<text x="17.6" y="6.6" font-family="'Space Mono',monospace" font-weight="700" font-size="6" fill="${C.alert}">!` +
  `<animateTransform attributeName="transform" type="translate" values="0 0;.5 0;-.5 0;0 0" dur=".5s" repeatCount="indefinite"/></text>`;
const zzz =
  `<g font-family="'Space Mono',monospace" font-weight="700" fill="${C.zzz}">` +
  `<text x="16.2" y="6.5" font-size="3.4">z</text>` +
  `<text x="17.6" y="4.6" font-size="4.4">z</text>` +
  `<text x="19.2" y="2.6" font-size="5.4">z<animate attributeName="opacity" values=".3;1;.3" dur="2.6s" repeatCount="indefinite"/></text></g>`;

const FACES = {
  idle: () => eyesOpen(0) + smile + blink("4.6s"),
  thinking: () => eyesOpen(1) + mouthFlat + blink("5.2s") + dataDots(),
  typing: () => eyesOpen(0) + blink("4.0s") + typingDots(),
  success: () => eyesHappy + mouthOpen + sparkle(18, 5, "0s"),
  error: () => eyesDot + browsWorried + mouthWavy + bang,
  curious: () => eyesOpen(0, false) + smile + blink("3.4s") + qMark,
  excited: () => eyesOpen(0, true) + mouthOpen + sparkle(4.5, 6, "0s") + sparkle(18, 5.5, ".5s"),
  sleeping: () => eyesClosed + mouthFlat + zzz,
};

const INACTIVITY_MS = 60000;  // idle -> sleeping after ~60s of silence
const SUCCESS_IDLE_MS = 2500; // success -> idle after ~2.5s
const BUBBLE_FADE_MS = 220;   // must track the .cody-bubble CSS transition

// Strip SMIL <animate>/<animateTransform> — CSS reduced-motion can't disable SMIL.
const stripAnimate = (m) => m.replace(/<animate(Transform)?\b[^>]*\/?>(?:[^<]*<\/animate(Transform)?>)?/g, "");

let counter = 0;

const STYLE_ID = "cody-injected-style";
function ensureInjectedStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Mood-change squash "pop" on the svg (independent of the figure's float),
  // plus a token-driven focus ring for the bubble close button.
  style.textContent =
    ".cody-figure svg{transform-origin:50% 96%}" +
    ".cody-figure svg.octa-pop{animation:octaPop .34s var(--ease-out,cubic-bezier(.16,1,.3,1))}" +
    "@keyframes octaPop{0%{transform:scale(1,1)}28%{transform:scale(1.09,.93)}58%{transform:scale(.97,1.04)}100%{transform:scale(1,1)}}" +
    "@media (prefers-reduced-motion:reduce){.cody-figure svg.octa-pop{animation:none}}" +
    ".cody-bubble-close:focus-visible{outline:2px solid var(--line-focus, var(--accent));outline-offset:2px;opacity:1}";
  (document.head || document.documentElement).appendChild(style);
}

/**
 * Mount OCTA into a target element.
 * @param {HTMLElement|string} targetEl  element or selector
 * @param {Object} [opts]
 * @param {string} [opts.mood="idle"]    initial mood
 * @param {boolean} [opts.companion=true] floating bottom-right placement w/ bubble
 * @param {boolean} [opts.greet=false]   show a greeting bubble on mount
 * @returns {Object} controller
 */
export function mountCody(targetEl, opts = {}) {
  const target =
    typeof targetEl === "string" ? document.querySelector(targetEl) : targetEl;
  if (!target) throw new Error("mountCody: target element not found");

  const companion = opts.companion !== false;
  ensureInjectedStyle();

  let reduceMotion = false;
  try {
    reduceMotion = !!(window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (_e) { reduceMotion = false; }

  // ---- DOM scaffold ----
  const root = document.createElement("div");
  root.className = "cody-root" + (companion ? " cody-companion" : "");
  root.setAttribute("data-cody", String(++counter));

  const bubble = document.createElement("div");
  bubble.className = "cody-bubble";
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  bubble.hidden = true;

  const bubbleText = document.createElement("span");
  bubbleText.className = "cody-bubble-text";

  const closeBtn = document.createElement("button");
  closeBtn.className = "cody-bubble-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "閉じる");
  closeBtn.textContent = "▾";
  const onClose = () => hideBubble();
  closeBtn.addEventListener("click", onClose);

  bubble.appendChild(bubbleText);
  bubble.appendChild(closeBtn);

  const figure = document.createElement("div");
  figure.className = "cody-figure";
  figure.setAttribute("role", "img");
  figure.setAttribute("aria-label", "OCTA マスコット");
  figure.title = "OCTA";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${GW} ${GH}`);
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.innerHTML = BODY_INNER + `<g class="cody-face"></g>`;
  figure.appendChild(svg);

  root.appendChild(bubble);
  root.appendChild(figure);
  target.appendChild(root);

  const faceGroup = svg.querySelector(".cody-face");

  // ---- state ----
  let currentMood = "idle";
  let inactivityTimer = null;
  let autoIdleTimer = null;
  let bubbleTimer = null;
  let destroyed = false;

  function clearTimer(t) { if (t) clearTimeout(t); return null; }

  function armInactivity() {
    inactivityTimer = clearTimer(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (!destroyed && currentMood !== "sleeping") applyMood("sleeping");
    }, INACTIVITY_MS);
  }

  // applyMood swaps only the face <g>; the body stays put. A brief squash
  // "pop" gives the change some life (companion only, motion allowed).
  function applyMood(mood) {
    if (!FACES[mood]) mood = "idle";
    const changed = mood !== currentMood;
    currentMood = mood;
    const face = FACES[mood]();
    faceGroup.innerHTML = reduceMotion ? stripAnimate(face) : face;
    root.setAttribute("data-mood", mood);
    if (companion && !reduceMotion && changed) {
      svg.classList.remove("octa-pop");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!destroyed) svg.classList.add("octa-pop");
      }));
    }
  }

  function showBubble(text, ms) {
    bubbleTimer = clearTimer(bubbleTimer);
    bubbleText.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove("is-open");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!destroyed) bubble.classList.add("is-open");
    }));
    if (typeof ms === "number" && ms > 0) bubbleTimer = setTimeout(hideBubble, ms);
  }

  function hideBubble() {
    bubbleTimer = clearTimer(bubbleTimer);
    bubble.classList.remove("is-open");
    setTimeout(() => {
      if (!bubble.classList.contains("is-open")) bubble.hidden = true;
    }, BUBBLE_FADE_MS);
  }

  // ---- controller API ----
  function setMood(mood, { say: sayText, autoIdleMs } = {}) {
    if (destroyed) return controller;
    autoIdleTimer = clearTimer(autoIdleTimer);
    applyMood(mood);
    if (typeof sayText === "string" && sayText.length) showBubble(sayText);
    if (mood === "success" && autoIdleMs !== 0) {
      autoIdleTimer = setTimeout(() => { if (!destroyed) applyMood("idle"); }, autoIdleMs || SUCCESS_IDLE_MS);
    } else if (typeof autoIdleMs === "number" && autoIdleMs > 0) {
      autoIdleTimer = setTimeout(() => { if (!destroyed) applyMood("idle"); }, autoIdleMs);
    }
    if (mood !== "sleeping") armInactivity();
    return controller;
  }

  function say(text, { mood, ms } = {}) {
    if (destroyed) return controller;
    const line = typeof text === "string" && text.length
      ? text : DEFAULT_LINES[mood || currentMood] || DEFAULT_LINES.idle;
    if (mood) applyMood(mood);
    showBubble(line, ms);
    armInactivity();
    return controller;
  }

  function hide() { root.classList.add("cody-hidden"); return controller; }
  function show() { root.classList.remove("cody-hidden"); return controller; }

  function destroy() {
    destroyed = true;
    inactivityTimer = clearTimer(inactivityTimer);
    autoIdleTimer = clearTimer(autoIdleTimer);
    bubbleTimer = clearTimer(bubbleTimer);
    closeBtn.removeEventListener("click", onClose);
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window.whsimCody === controller) {
      try { delete window.whsimCody; } catch (_e) { window.whsimCody = undefined; }
    }
  }

  const controller = {
    el: root,
    get mood() { return currentMood; },
    setMood, say, hide, show, destroy,
  };

  // ---- init ----
  applyMood(opts.mood && FACES[opts.mood] ? opts.mood : "idle");
  armInactivity();
  if (opts.greet) showBubble(DEFAULT_LINES.curious);

  window.whsimCody = controller;
  return controller;
}

export default mountCody;

/**
 * Static (non-animated) OCTA SVG markup for inline avatars — e.g. the chat
 * thread, where one small OCTA sits beside each of its messages. Reuses the
 * exact body + per-mood face, but strips every animation so many avatars on
 * screen stay cheap and calm.
 * @param {string} [mood="idle"] one of MOODS
 * @returns {string} an <svg>…</svg> string
 */
export function codyAvatarSVG(mood = "idle") {
  return octaSVG(mood, { animated: false, cls: "cody-avatar-svg" });
}

/**
 * Standalone OCTA <svg> for any context (avatars, boot/loading, previews).
 * @param {string} [mood="idle"] one of MOODS
 * @param {Object} [o]
 * @param {boolean} [o.animated=true] keep SMIL blink/props (false = calm/static)
 * @param {string}  [o.cls=""]        extra class on the <svg>
 * @returns {string} an <svg>…</svg> string
 */
function octaSVG(mood = "idle", o = {}) {
  const animated = o.animated !== false;
  let face = (FACES[mood] || FACES.idle)();
  if (!animated) face = stripAnimate(face);
  const inner = BODY_INNER + `<g class="cody-face">${face}</g>`;
  const cls = o.cls ? ` class="${o.cls}"` : "";
  return `<svg viewBox="0 0 ${GW} ${GH}" xmlns="${SVG_NS}"${cls} ` +
    `shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
}
