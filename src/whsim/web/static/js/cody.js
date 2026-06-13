/* ============================================================
   OCTA — メンダコ (dumbo octopus) mascot, the 物流シミュレータ
   supporter. Framework-free ES module. The legacy internal name
   is "cody" (module/CSS/identifiers) but the rendered character +
   every user-facing label is OCTA.

   The character is drawn as smooth vector art (rounded bell mantle,
   two floppy dumbo ear-fins, a fringe of swaying tentacles, big
   glinting eyes) on a coral identity palette that stays fixed across
   light/dark. The body is built once; only <g class="cody-face">
   (eyes/mouth/cyan WHSiM props) swaps per mood. Personality comes
   from CSS: the figure floats, the ears flap, the tentacles sway,
   and each mood adds its own comical motion (bounce / tilt / droop /
   tremble) — all gated by prefers-reduced-motion.

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

// Smooth vector canvas (viewBox units). Wider-than-tall, like a resting mendako.
const VB_W = 120, VB_H = 116;

// OCTA palette — warm coral, theme-independent (a mascot keeps one identity).
// Cyan/alert/zzz are the "tech" props that tie OCTA to the WHSiM world.
const C = {
  out: "#c93b55",     // soft coral outline
  base: "#ff8294",    // coral body
  sh: "#ec5870",      // shadow / darker tentacles
  hi: "#ffd9df",      // lit belly highlight
  ear: "#f5879a",     // ear-fins
  blush: "#ff5d77",
  eye: "#34202a",     // warm near-black
  glint: "#ffffff",
  mouth: "#8a2438",
  tongue: "#ff8da0",
  tech: "#34e3ff",    // cyan props (brand)
  techHi: "#bdf8ff",
  alert: "#ff5d72",
  zzz: "#9ab7ff",
  shadow: "rgba(120,40,55,.26)",
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

/* ---------- shared gradient defs (injected once, never removed) ---------- */
// All OCTA instances (the floating companion + every chat avatar) reference
// these by url(#...). Living in one persistent hidden <svg> keeps the refs valid
// no matter which instance mounts/unmounts.
const DEFS_ID = "octa-defs";
function ensureDefs() {
  if (typeof document === "undefined") return;
  if (document.getElementById(DEFS_ID)) return;
  const holder = document.createElementNS(SVG_NS, "svg");
  holder.id = DEFS_ID;
  holder.setAttribute("width", "0");
  holder.setAttribute("height", "0");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  holder.innerHTML =
    `<defs>` +
    `<radialGradient id="octaBody" cx=".4" cy=".3" r=".95">` +
      `<stop offset="0" stop-color="${C.hi}"/>` +
      `<stop offset=".55" stop-color="${C.base}"/>` +
      `<stop offset="1" stop-color="${C.sh}"/>` +
    `</radialGradient>` +
    `<linearGradient id="octaEar" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#ffa0b0"/>` +
      `<stop offset="1" stop-color="${C.ear}"/>` +
    `</linearGradient>` +
    `</defs>`;
  (document.body || document.documentElement).appendChild(holder);
}

/* ---------- invariant body (built once) ---------- */
// Eye centres (face pieces reuse these so eyes/glints/brows line up).
const EL = 48, ER = 72;

// One dumbo ear-fin (the signature feature). `side` = -1 (left) | 1 (right);
// mirrored about x=60. A big rounded wing reaching up-and-out from behind the
// upper mantle so the flap animation reads clearly.
function ear(side) {
  const f = (x) => (60 + side * (x - 60)).toFixed(1);
  const cls = side < 0 ? "octa-ear octa-ear-l" : "octa-ear octa-ear-r";
  const d = `M${f(33)},38 C${f(18)},25 ${f(4)},15 ${f(2)},28 ` +
            `C${f(0)},41 ${f(16)},49 ${f(34)},44 Z`;
  return `<path class="${cls}" d="${d}" fill="url(#octaEar)" ` +
         `stroke="${C.out}" stroke-width="2" stroke-linejoin="round"/>`;
}

// One tentacle (rounded capsule). Outer legs are darker for depth.
function leg(cx, h, dark) {
  return `<rect x="${cx - 5}" y="70" width="10" height="${h}" rx="5" ` +
         `fill="${dark ? C.sh : C.base}" stroke="${C.out}" stroke-width="2"/>`;
}

// Rounded bell mantle.
const MANTLE =
  `M60,15 C82,15 99,30 99,52 C99,73 84,87 60,87 ` +
  `C36,87 21,73 21,52 C21,30 38,15 60,15 Z`;

const BODY =
  // contact shadow on the "floor"
  `<ellipse cx="60" cy="111" rx="27" ry="3.4" fill="${C.shadow}"/>` +
  // ears (behind the body)
  `<g class="octa-ears">${ear(-1)}${ear(1)}</g>` +
  // tentacles (hang from under the body — drawn before it so the mantle overlaps)
  `<g class="octa-tentacles">` +
    leg(40, 26, true) + leg(50, 30, false) + leg(60, 32, false) +
    leg(70, 30, false) + leg(80, 26, true) +
  `</g>` +
  // body: bell mantle + belly highlight + cheeks
  `<g class="octa-body">` +
    `<path d="${MANTLE}" fill="url(#octaBody)" stroke="${C.out}" ` +
      `stroke-width="2.4" stroke-linejoin="round"/>` +
    `<ellipse cx="60" cy="64" rx="24" ry="17" fill="${C.hi}" opacity=".35"/>` +
    `<ellipse cx="${EL - 9}" cy="68" rx="6" ry="3.6" fill="${C.blush}" opacity=".45"/>` +
    `<ellipse cx="${ER + 9}" cy="68" rx="6" ry="3.6" fill="${C.blush}" opacity=".45"/>` +
  `</g>`;

/* ---------- face pieces ---------- */
function eyesOpen(lookUp = 0, opt = {}) {
  const ey = 58 + (lookUp ? -2 : 0);
  const bl = opt.blinkDur
    ? `<animate attributeName="ry" values="9.4;9.4;0.5;9.4" keyTimes="0;.9;.94;1" dur="${opt.blinkDur}" repeatCount="indefinite"/>`
    : "";
  const twin = opt.twin
    ? `<circle cx="${EL + 2.6}" cy="${ey + 3.4}" r="1.5" fill="${C.glint}"/>` +
      `<circle cx="${ER + 2.6}" cy="${ey + 3.4}" r="1.5" fill="${C.glint}"/>`
    : "";
  const eye = (cx) =>
    `<ellipse cx="${cx}" cy="${ey}" rx="7.6" ry="9.4" fill="${C.eye}">${bl}</ellipse>` +
    `<circle cx="${cx - 2.6}" cy="${ey - 4}" r="2.7" fill="${C.glint}"/>` +
    `<circle cx="${cx + 2.4}" cy="${ey + 3}" r="1.3" fill="${C.glint}" opacity=".75"/>`;
  return eye(EL) + eye(ER) + twin;
}
const arc = (cx, y0, y1, w) =>
  `<path d="M${cx - w},${y0} Q${cx},${y1} ${cx + w},${y0}" fill="none" stroke="${C.eye}" stroke-width="3.4" stroke-linecap="round"/>`;
const eyesHappy = arc(EL, 60, 50, 7) + arc(ER, 60, 50, 7);       // ^ ^
const eyesClosed = arc(EL, 55, 63, 7) + arc(ER, 55, 63, 7);      // ‿ ‿
const eyesDot =
  `<circle cx="${EL}" cy="58" r="2.8" fill="${C.eye}"/><circle cx="${ER}" cy="58" r="2.8" fill="${C.eye}"/>`;
const browsWorried =
  `<path d="M${EL - 7},46 L${EL + 5},50" stroke="${C.eye}" stroke-width="2.6" stroke-linecap="round"/>` +
  `<path d="M${ER + 7},46 L${ER - 5},50" stroke="${C.eye}" stroke-width="2.6" stroke-linecap="round"/>`;

// mouths (centred on x=60)
const smile = `<path d="M52,69 Q60,77 68,69" fill="none" stroke="${C.mouth}" stroke-width="3" stroke-linecap="round"/>`;
const mouthFlat = `<path d="M55,71 L65,71" stroke="${C.mouth}" stroke-width="3" stroke-linecap="round"/>`;
const mouthOpen =
  `<path d="M53,68 Q60,82 67,68 Z" fill="${C.mouth}"/>` +
  `<path d="M58,75 Q60,79 62,75 Z" fill="${C.tongue}"/>`;
const mouthWavy =
  `<path d="M53,70 q2.5,-3 5,0 q2.5,3 5,0 q2.5,-3 5,0" fill="none" stroke="${C.mouth}" stroke-width="2.4" stroke-linecap="round"/>`;

// animated cyan props (brand), floating up-and-right of OCTA's head
function dataDots() {
  const d = (cx, cy, r, b) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.tech}"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin="${b}" repeatCount="indefinite"/></circle>`;
  return d(99, 42, 2.2, "0s") + d(106, 33, 1.8, ".4s") + d(112, 24, 1.5, ".8s");
}
function typingDots() {
  const r = (x, b) =>
    `<rect x="${x}" y="4" width="4.4" height="4.4" rx="1.5" fill="${C.tech}"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin="${b}" repeatCount="indefinite"/></rect>`;
  return r(50, "0s") + r(58, ".15s") + r(66, ".3s");
}
function sparkle(cx, cy, b) {
  return `<g fill="${C.techHi}"><animate attributeName="opacity" values=".2;1;.2" dur="1.4s" begin="${b}" repeatCount="indefinite"/>` +
    `<path d="M${cx},${cy - 5} L${cx + 1.3},${cy - 1.3} L${cx + 5},${cy} L${cx + 1.3},${cy + 1.3} L${cx},${cy + 5} L${cx - 1.3},${cy + 1.3} L${cx - 5},${cy} L${cx - 1.3},${cy - 1.3} Z"/></g>`;
}
const qMark =
  `<text x="97" y="36" font-family="'Space Mono',monospace" font-weight="700" font-size="18" fill="${C.tech}">?` +
  `<animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="1.6s" repeatCount="indefinite"/></text>`;
const bang =
  `<text x="98" y="36" font-family="'Space Mono',monospace" font-weight="700" font-size="18" fill="${C.alert}">!` +
  `<animateTransform attributeName="transform" type="translate" values="0 0;1.6 0;-1.6 0;0 0" dur=".5s" repeatCount="indefinite"/></text>`;
const zzz =
  `<g font-family="'Space Mono',monospace" font-weight="700" fill="${C.zzz}">` +
  `<text x="92" y="34" font-size="10">z</text>` +
  `<text x="98" y="25" font-size="13">z</text>` +
  `<text x="105" y="14" font-size="16">z<animate attributeName="opacity" values=".3;1;.3" dur="2.6s" repeatCount="indefinite"/></text></g>`;

const FACES = {
  idle: () => eyesOpen(0, { blinkDur: "4.6s" }) + smile,
  thinking: () => eyesOpen(1, { blinkDur: "5.2s" }) + mouthFlat + dataDots(),
  typing: () => eyesOpen(0, { blinkDur: "4.0s" }) + mouthFlat + typingDots(),
  success: () => eyesHappy + mouthOpen + sparkle(100, 34, "0s") + sparkle(22, 40, ".5s"),
  error: () => eyesDot + browsWorried + mouthWavy + bang,
  curious: () => eyesOpen(0, { blinkDur: "3.4s" }) + smile + qMark,
  excited: () => eyesOpen(0, { twin: true }) + mouthOpen + sparkle(22, 40, "0s") + sparkle(100, 34, ".5s"),
  sleeping: () => eyesClosed + mouthFlat + zzz,
};

const INACTIVITY_MS = 60000;  // idle -> sleeping after ~60s of silence
const SUCCESS_IDLE_MS = 2500; // success -> idle after ~2.5s
const BUBBLE_FADE_MS = 220;   // must track the .cody-bubble CSS transition

// ---- anti-overlap (companion only) ----------------------------------------
// OCTA floats bottom-right; some views park important content there too (the
// bottom KPI bar, the right-edge scorecard rail, chart legends). To keep the
// mascot from covering readable values we (a) offer a user minimize toggle,
// persisted, and (b) auto-retreat to the bottom-left whenever OCTA's rectangle
// would intersect any of these "keep-clear" elements.
const MIN_KEY = "whsim-octa-min";       // "1" = user minimized
const EVADE_PAD = 8;                    // px gap required around keep-clear rects
const EVADE_SELECTORS = [
  "#kpiBar",          // bottom KPI bar (④検証 etc.)
  ".sc-rail",         // right-edge scorecard rail
  ".compare-thumbs",  // ⑤比較 proposal-PNG thumbnails
  "[data-octa-keep-clear]", // opt-in hook for any future bottom-right content
];

function readMinimized() {
  try { return localStorage.getItem(MIN_KEY) === "1"; } catch (_e) { return false; }
}
function writeMinimized(on) {
  try {
    if (on) localStorage.setItem(MIN_KEY, "1");
    else localStorage.removeItem(MIN_KEY);
  } catch (_e) { /* storage blocked — in-memory state still applies */ }
}

// Do two rects (DOMRect-like) overlap, allowing a `pad` gap?
function rectsOverlap(a, b, pad) {
  return !(a.right + pad <= b.left || a.left - pad >= b.right ||
           a.bottom + pad <= b.top || a.top - pad >= b.bottom);
}

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
    ".cody-figure svg{transform-origin:50% 92%}" +
    ".cody-figure svg.octa-pop{animation:octaPop .38s var(--ease-out,cubic-bezier(.16,1,.3,1))}" +
    "@keyframes octaPop{0%{transform:scale(1,1)}26%{transform:scale(1.12,.9)}56%{transform:scale(.95,1.06)}100%{transform:scale(1,1)}}" +
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
  ensureDefs();

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
  svg.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute("xmlns", SVG_NS);
  svg.innerHTML = BODY + `<g class="cody-face"></g>`;
  figure.appendChild(svg);

  // Minimize toggle: shrinks OCTA into a small puck in the corner; while
  // minimized OCTA never covers content. State persists across views/sessions.
  // Hidden on the non-floating (inline) mount, where there's nothing to avoid.
  let minBtn = null;
  if (companion) {
    minBtn = document.createElement("button");
    minBtn.className = "cody-min-toggle";
    minBtn.type = "button";
    minBtn.title = "OCTAを最小化";
    minBtn.setAttribute("aria-label", "OCTAを最小化");
    minBtn.textContent = "—";
    figure.appendChild(minBtn);
  }

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
  let minimized = companion && readMinimized();
  let evading = false;        // currently retreated due to a collision
  let evadeRaf = 0;           // pending rAF for a recompute

  function clearTimer(t) { if (t) clearTimeout(t); return null; }

  // ---- anti-overlap: minimize + auto-retreat (companion only) ----
  // Recompute whether OCTA's rectangle would cover any keep-clear element; if
  // so, add `.cody-evade` to shift it to the bottom-left. Minimizing always
  // clears the evade state (a minimized puck is small enough not to cover
  // values, and the user asked for it out of the way).
  function applyMinimized() {
    root.classList.toggle("cody-min", minimized);
    if (minBtn) {
      const label = minimized ? "OCTAを表示" : "OCTAを最小化";
      minBtn.title = label;
      minBtn.setAttribute("aria-label", label);
      minBtn.textContent = minimized ? "▢" : "—";
    }
  }
  function setMinimized(on) {
    minimized = !!on;
    writeMinimized(minimized);
    applyMinimized();
    recomputeEvade();
  }
  function recomputeEvade() {
    if (!companion || destroyed) return;
    // Minimized OCTA is a small corner puck — it doesn't need to flee.
    if (minimized) {
      if (evading) { evading = false; root.classList.remove("cody-evade"); }
      return;
    }
    // Measure with evade temporarily off so the test reflects OCTA's *home*
    // rect, avoiding a flip-flop where retreating frees the corner and OCTA
    // immediately returns into the same content.
    const wasEvading = evading;
    if (wasEvading) root.classList.remove("cody-evade");
    const me = figure.getBoundingClientRect();
    let hit = false;
    for (const sel of EVADE_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      for (const n of nodes) {
        if (n === root || root.contains(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;       // hidden element
        // Only the bottom-right region matters (where OCTA lives).
        if (rectsOverlap(me, r, EVADE_PAD)) { hit = true; break; }
      }
      if (hit) break;
    }
    evading = hit;
    root.classList.toggle("cody-evade", evading);
  }
  function scheduleEvade() {
    if (evadeRaf || destroyed) return;
    evadeRaf = requestAnimationFrame(() => {
      evadeRaf = 0;
      recomputeEvade();
    });
  }

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
  function show() { root.classList.remove("cody-hidden"); scheduleEvade(); return controller; }

  // ---- anti-overlap wiring (companion only) ----
  const onMinToggle = (e) => {
    // Don't let the click bubble to the figure (which opens chat).
    e.stopPropagation();
    setMinimized(!minimized);
  };
  const onViewportChange = () => scheduleEvade();
  let evadeObserver = null;
  if (companion) {
    if (minBtn) minBtn.addEventListener("click", onMinToggle);
    window.addEventListener("resize", onViewportChange, { passive: true });
    window.addEventListener("scroll", onViewportChange, { passive: true, capture: true });
    // Layout shifts (view switches, KPI bar appearing, rail expand/collapse)
    // change which keep-clear elements exist. Observe the document body and
    // recompute on the next frame; cheap because recompute is rAF-throttled.
    try {
      evadeObserver = new MutationObserver(() => scheduleEvade());
      evadeObserver.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    } catch (_e) { evadeObserver = null; }
  }

  function destroy() {
    destroyed = true;
    inactivityTimer = clearTimer(inactivityTimer);
    autoIdleTimer = clearTimer(autoIdleTimer);
    bubbleTimer = clearTimer(bubbleTimer);
    if (evadeRaf) { cancelAnimationFrame(evadeRaf); evadeRaf = 0; }
    closeBtn.removeEventListener("click", onClose);
    if (minBtn) minBtn.removeEventListener("click", onMinToggle);
    if (companion) {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, { capture: true });
    }
    if (evadeObserver) { evadeObserver.disconnect(); evadeObserver = null; }
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window.whsimCody === controller) {
      try { delete window.whsimCody; } catch (_e) { window.whsimCody = undefined; }
    }
  }

  const controller = {
    el: root,
    get mood() { return currentMood; },
    get minimized() { return minimized; },
    setMinimized, setMood, say, hide, show, destroy,
  };

  // ---- init ----
  applyMood(opts.mood && FACES[opts.mood] ? opts.mood : "idle");
  applyMinimized();
  armInactivity();
  if (opts.greet) showBubble(DEFAULT_LINES.curious);
  if (companion) scheduleEvade();

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
  ensureDefs();
  const animated = o.animated !== false;
  let face = (FACES[mood] || FACES.idle)();
  if (!animated) face = stripAnimate(face);
  const inner = BODY + `<g class="cody-face">${face}</g>`;
  const cls = o.cls ? ` class="${o.cls}"` : "";
  return `<svg viewBox="0 0 ${VB_W} ${VB_H}" xmlns="${SVG_NS}"${cls} ` +
    `aria-hidden="true">${inner}</svg>`;
}
