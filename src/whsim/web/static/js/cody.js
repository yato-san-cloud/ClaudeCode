/* ============================================================
   Cody — terminal-bot mascot, framework-free ES module.

   Geometry is copied verbatim from the design reference
   (design_handoff_cody_mascot / cody.html): viewBox 0 0 300 392,
   terracotta body #D97757, rust lines #9C4226, neon face #86E29B,
   amber accents #F0B860, a blinking head cursor and per-mood SMIL
   animations. The invariant body is built once; only the <g> that
   holds the face is swapped per mood.

   Public API (the web shell calls this):
     mountCody(targetEl, opts) -> controller
       controller.setMood(mood, { say, autoIdleMs })
       controller.say(text, { mood, ms })
       controller.hide() / controller.show()
       controller.destroy()
   The most-recently-mounted controller is also exposed as
   window.whsimCody for non-module callers.
   ============================================================ */

const SVG_NS = "http://www.w3.org/2000/svg";

// Palette — identical to the reference prototype.
const C = {
  body: "#D97757",
  bodyHi: "#E59072",
  line: "#9C4226",
  screen: "#211C17",
  bezel: "#160F08",
  neon: "#86E29B",
  neonHi: "#C5F5D2",
  amber: "#F0B860",
  rust: "#BE5A38",
};

export const MOODS = [
  "idle",
  "thinking",
  "typing",
  "success",
  "error",
  "curious",
  "excited",
  "sleeping",
];

// Default Japanese lines per mood (callers can override via say()).
// Tone: calm, dependable, "直せるよ" energy — never blames the user.
const DEFAULT_LINES = {
  idle: "いっしょに作ろう。まずは小さく動かそう。",
  thinking: "ちょっと考えてるよ…",
  typing: "書いてるところ。もう少し待ってね。",
  success: "できた。ついでにここも整えておいた。",
  error: "エラーは敵じゃないよ。直せる。",
  curious: "何を作る？手伝うよ。",
  excited: "いいね、それ動かしてみよう！",
  sleeping: "zzz… 呼んだら起きるよ。",
};

/* ---------- face geometry (copied from reference `faces`) ---------- */
const FACES = {
  idle: () => `
    <circle cx="128" cy="162" r="9" fill="${C.neon}"/>
    <circle cx="172" cy="162" r="9" fill="${C.neon}"/>
    <circle cx="131" cy="159" r="2.6" fill="${C.bezel}"/>
    <circle cx="175" cy="159" r="2.6" fill="${C.bezel}"/>
    <path d="M133 188 Q150 201 167 188" fill="none" stroke="${C.neon}" stroke-width="5" stroke-linecap="round"/>`,

  thinking: () => `
    <circle cx="130" cy="160" r="8" fill="${C.neon}"/>
    <circle cx="174" cy="160" r="8" fill="${C.neon}"/>
    <circle cx="133" cy="156" r="2.4" fill="${C.bezel}"/>
    <circle cx="177" cy="156" r="2.4" fill="${C.bezel}"/>
    <line x1="140" y1="193" x2="160" y2="193" stroke="${C.neon}" stroke-width="4" stroke-linecap="round"/>
    <g fill="${C.neon}">
      <circle cx="184" cy="146" r="3.2"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin="0s" repeatCount="indefinite"/></circle>
      <circle cx="194" cy="140" r="2.4"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin=".4s" repeatCount="indefinite"/></circle>
      <circle cx="201" cy="135" r="1.8"><animate attributeName="opacity" values="1;.2;1" dur="1.2s" begin=".8s" repeatCount="indefinite"/></circle>
    </g>`,

  success: () => `
    <path d="M120 164 Q128 153 136 164" fill="none" stroke="${C.neon}" stroke-width="5" stroke-linecap="round"/>
    <path d="M164 164 Q172 153 180 164" fill="none" stroke="${C.neon}" stroke-width="5" stroke-linecap="round"/>
    <path d="M127 184 Q150 209 173 184 Z" fill="${C.neon}"/>
    <path d="M183 138 l5 6 l11 -13" fill="none" stroke="${C.neonHi}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,

  typing: () => `
    <circle cx="128" cy="161" r="7" fill="${C.neon}"/>
    <circle cx="172" cy="161" r="7" fill="${C.neon}"/>
    <circle cx="150" cy="190" r="5.5" fill="none" stroke="${C.neon}" stroke-width="4"/>
    <g fill="${C.neon}">
      <rect x="118" y="206" width="9" height="6" rx="2"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin="0s" repeatCount="indefinite"/></rect>
      <rect x="132" y="206" width="9" height="6" rx="2"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin=".15s" repeatCount="indefinite"/></rect>
      <rect x="146" y="206" width="9" height="6" rx="2"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin=".3s" repeatCount="indefinite"/></rect>
      <rect x="160" y="206" width="9" height="6" rx="2"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin=".45s" repeatCount="indefinite"/></rect>
      <rect x="174" y="206" width="9" height="6" rx="2"><animate attributeName="opacity" values=".25;1;.25" dur=".9s" begin=".6s" repeatCount="indefinite"/></rect>
    </g>`,

  error: () => `
    <line x1="116" y1="149" x2="134" y2="154" stroke="${C.neon}" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="184" y1="149" x2="166" y2="154" stroke="${C.neon}" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="128" cy="164" r="8" fill="${C.neon}"/>
    <circle cx="172" cy="164" r="8" fill="${C.neon}"/>
    <circle cx="128" cy="162" r="2.4" fill="${C.bezel}"/>
    <circle cx="172" cy="162" r="2.4" fill="${C.bezel}"/>
    <path d="M132 193 q9 -7 18 0 q9 7 18 0" fill="none" stroke="${C.neon}" stroke-width="4" stroke-linecap="round"/>
    <g stroke="${C.amber}" stroke-width="3.5" stroke-linecap="round">
      <line x1="192" y1="134" x2="192" y2="143"/>
    </g>
    <circle cx="192" cy="149" r="2.2" fill="${C.amber}"/>`,

  sleeping: () => `
    <path d="M120 161 Q128 169 136 161" fill="none" stroke="${C.neon}" stroke-width="5" stroke-linecap="round"/>
    <path d="M164 161 Q172 169 180 161" fill="none" stroke="${C.neon}" stroke-width="5" stroke-linecap="round"/>
    <line x1="144" y1="192" x2="156" y2="192" stroke="${C.neon}" stroke-width="4" stroke-linecap="round"/>
    <g fill="${C.neon}" font-family="'JetBrains Mono','Noto Sans JP',monospace" font-weight="700">
      <text x="176" y="152" font-size="11">z</text>
      <text x="187" y="143" font-size="14">z</text>
      <text x="199" y="132" font-size="18">z</text>
    </g>`,

  excited: () => `
    <circle cx="128" cy="160" r="10.5" fill="${C.neon}"/>
    <circle cx="172" cy="160" r="10.5" fill="${C.neon}"/>
    <circle cx="124" cy="156" r="3.4" fill="${C.neonHi}"/>
    <circle cx="168" cy="156" r="3.4" fill="${C.neonHi}"/>
    <path d="M124 182 Q150 213 176 182 Z" fill="${C.neon}"/>
    <g stroke="${C.amber}" stroke-width="2.8" stroke-linecap="round">
      <line x1="108" y1="142" x2="108" y2="150"/><line x1="104" y1="146" x2="112" y2="146"/>
      <line x1="196" y1="148" x2="196" y2="156"/><line x1="192" y1="152" x2="200" y2="152"/>
    </g>`,

  curious: () => `
    <circle cx="128" cy="162" r="9" fill="${C.neon}"/>
    <circle cx="172" cy="162" r="9" fill="${C.neon}"/>
    <circle cx="125" cy="159" r="2.6" fill="${C.bezel}"/>
    <circle cx="169" cy="159" r="2.6" fill="${C.bezel}"/>
    <circle cx="150" cy="191" r="5" fill="none" stroke="${C.neon}" stroke-width="4"/>
    <g fill="${C.amber}" font-family="'JetBrains Mono','Noto Sans JP',monospace" font-weight="700">
      <text x="184" y="146" font-size="22">?</text>
    </g>`,
};

// Per-mood cursor blink duration (the "heartbeat"): fast while
// processing, slow while waiting/sleeping.
const CURSOR_DUR = {
  idle: "1.1s",
  thinking: "0.45s",
  typing: "0.55s",
  success: "0.9s",
  error: "0.7s",
  curious: "0.9s",
  excited: "0.4s",
  sleeping: "2.2s",
};

/* ---------- invariant body (built once) ---------- */
// Everything except the face <g> and the cursor's <animate> dur,
// which we tweak per mood without rebuilding the whole tree.
function bodyMarkup() {
  return `
  <rect x="96"  y="244" width="44" height="26" rx="13" fill="${C.body}" stroke="${C.line}" stroke-width="3"/>
  <rect x="160" y="244" width="44" height="26" rx="13" fill="${C.body}" stroke="${C.line}" stroke-width="3"/>
  <rect x="38"  y="150" width="24" height="58" rx="12" fill="${C.body}" stroke="${C.line}" stroke-width="3" transform="rotate(8 50 179)"/>
  <rect x="238" y="150" width="24" height="58" rx="12" fill="${C.body}" stroke="${C.line}" stroke-width="3" transform="rotate(-8 250 179)"/>
  <circle cx="48"  cy="210" r="9" fill="${C.body}" stroke="${C.line}" stroke-width="3"/>
  <circle cx="252" cy="210" r="9" fill="${C.body}" stroke="${C.line}" stroke-width="3"/>
  <rect x="58" y="70" width="184" height="184" rx="42" fill="${C.body}" stroke="${C.line}" stroke-width="3"/>
  <line x1="150" y1="70" x2="150" y2="46" stroke="${C.line}" stroke-width="4" stroke-linecap="round"/>
  <rect class="cody-cursor" x="143" y="22" width="14" height="22" rx="3" fill="${C.neon}">
    <animate attributeName="opacity" values="1;1;0;0" dur="1.1s" keyTimes="0;.5;.5;1" repeatCount="indefinite"/>
  </rect>
  <rect x="80" y="100" width="140" height="124" rx="18" fill="${C.bezel}"/>
  <rect x="84" y="104" width="132" height="116" rx="15" fill="${C.screen}"/>
  <circle cx="100" cy="120" r="3.6" fill="${C.rust}"/>
  <circle cx="113" cy="120" r="3.6" fill="${C.amber}"/>
  <circle cx="126" cy="120" r="3.6" fill="${C.neon}"/>
  <line x1="138" y1="120" x2="206" y2="120" stroke="#352b20" stroke-width="2"/>
  <g class="cody-face"></g>`;
}

const INACTIVITY_MS = 60000; // idle -> sleeping after ~60s of silence
const SUCCESS_IDLE_MS = 2500; // success -> idle after ~2.5s

let counter = 0;

/**
 * Mount Cody into a target element.
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
  if (!target) {
    throw new Error("mountCody: target element not found");
  }

  const companion = opts.companion !== false;

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
  closeBtn.textContent = "▾"; // ▾
  closeBtn.addEventListener("click", () => hideBubble());

  bubble.appendChild(bubbleText);
  bubble.appendChild(closeBtn);

  const figure = document.createElement("div");
  figure.className = "cody-figure";
  figure.setAttribute("role", "img");
  figure.setAttribute("aria-label", "Cody マスコット");
  figure.title = "Cody";

  // The SVG is created once; the face <g> and cursor dur are mutated.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 300 392");
  svg.setAttribute("xmlns", SVG_NS);
  svg.innerHTML = bodyMarkup();
  figure.appendChild(svg);

  root.appendChild(bubble);
  root.appendChild(figure);
  target.appendChild(root);

  const faceGroup = svg.querySelector(".cody-face");
  const cursorAnim = svg.querySelector(".cody-cursor animate");

  // ---- state ----
  let currentMood = "idle";
  let inactivityTimer = null;
  let autoIdleTimer = null;
  let bubbleTimer = null;
  let destroyed = false;

  function clearTimer(t) {
    if (t) clearTimeout(t);
    return null;
  }

  function armInactivity() {
    inactivityTimer = clearTimer(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      if (!destroyed && currentMood !== "sleeping") {
        applyMood("sleeping");
      }
    }, INACTIVITY_MS);
  }

  // applyMood swaps only the face + cursor speed (body stays put).
  function applyMood(mood) {
    if (!FACES[mood]) mood = "idle";
    currentMood = mood;
    faceGroup.innerHTML = FACES[mood]();
    if (cursorAnim) {
      cursorAnim.setAttribute("dur", CURSOR_DUR[mood] || "1.1s");
    }
    root.setAttribute("data-mood", mood);
  }

  function showBubble(text, ms) {
    bubbleTimer = clearTimer(bubbleTimer);
    bubbleText.textContent = text;
    bubble.hidden = false;
    // force reflow so the entrance transition replays
    void bubble.offsetWidth;
    bubble.classList.add("is-open");
    if (typeof ms === "number" && ms > 0) {
      bubbleTimer = setTimeout(hideBubble, ms);
    }
  }

  function hideBubble() {
    bubbleTimer = clearTimer(bubbleTimer);
    bubble.classList.remove("is-open");
    // keep it in the DOM during the fade, then hide for a11y
    setTimeout(() => {
      if (!bubble.classList.contains("is-open")) bubble.hidden = true;
    }, 220);
  }

  // ---- controller API ----
  function setMood(mood, { say: sayText, autoIdleMs } = {}) {
    if (destroyed) return controller;
    autoIdleTimer = clearTimer(autoIdleTimer);
    applyMood(mood);

    if (typeof sayText === "string" && sayText.length) {
      showBubble(sayText);
    }

    // success auto-returns to idle after ~2.5s unless overridden.
    if (mood === "success" && autoIdleMs !== 0) {
      autoIdleTimer = setTimeout(() => {
        if (!destroyed) applyMood("idle");
      }, autoIdleMs || SUCCESS_IDLE_MS);
    } else if (typeof autoIdleMs === "number" && autoIdleMs > 0) {
      autoIdleTimer = setTimeout(() => {
        if (!destroyed) applyMood("idle");
      }, autoIdleMs);
    }

    // any explicit interaction resets the inactivity countdown.
    if (mood !== "sleeping") armInactivity();
    return controller;
  }

  function say(text, { mood, ms } = {}) {
    if (destroyed) return controller;
    const line = typeof text === "string" && text.length ? text : DEFAULT_LINES[mood || currentMood] || DEFAULT_LINES.idle;
    if (mood) applyMood(mood);
    showBubble(line, ms);
    armInactivity();
    return controller;
  }

  function hide() {
    root.classList.add("cody-hidden");
    return controller;
  }

  function show() {
    root.classList.remove("cody-hidden");
    return controller;
  }

  function destroy() {
    destroyed = true;
    inactivityTimer = clearTimer(inactivityTimer);
    autoIdleTimer = clearTimer(autoIdleTimer);
    bubbleTimer = clearTimer(bubbleTimer);
    closeBtn.removeEventListener("click", hideBubble);
    if (root.parentNode) root.parentNode.removeChild(root);
    if (window.whsimCody === controller) {
      try {
        delete window.whsimCody;
      } catch (_e) {
        window.whsimCody = undefined;
      }
    }
  }

  const controller = {
    el: root,
    get mood() {
      return currentMood;
    },
    setMood,
    say,
    hide,
    show,
    destroy,
  };

  // ---- init ----
  applyMood(opts.mood && FACES[opts.mood] ? opts.mood : "idle");
  armInactivity();
  if (opts.greet) {
    showBubble(DEFAULT_LINES.curious);
  }

  // expose for non-module callers (most-recent wins).
  window.whsimCody = controller;

  return controller;
}

export default mountCody;
