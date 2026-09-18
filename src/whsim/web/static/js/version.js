// version.js — header build badge: package version + git commit + commit time,
// PLUS a live "new build available" indicator. Self-contained module (own
// script tag in index.html) so it never collides with the app shell.
//
// With the dev auto-sync loop (start.bat: git reset --hard every ~15s + uvicorn
// --reload), a freshly-pushed build restarts the server, so /api/version reports
// a new commit. We poll it and, when the commit changes from the one this tab
// loaded, light the badge up as 「更新あり ↻」 — click (or F5) to reload onto the
// latest. Answers 「いま見てるのは最新？」 without the user having to remember.
const el = document.getElementById('versionBadge');
let loadedCommit = null;      // the build this tab is actually running
let stale = false;            // a newer build has been pushed since load

function injectStyle() {
  if (document.getElementById('vb-style')) return;
  const s = document.createElement('style');
  s.id = 'vb-style';
  s.textContent = `
  .version-badge.is-stale{ cursor:pointer; color:var(--ink-onAccent,#04222c);
    background:var(--accent,#16C0DE); border-color:var(--accent,#16C0DE);
    animation:vbPulse 1.6s ease-in-out infinite; }
  @keyframes vbPulse{ 0%,100%{ box-shadow:0 0 0 0 rgba(52,227,255,.0); }
    50%{ box-shadow:0 0 0 4px rgba(52,227,255,.28); } }
  @media (prefers-reduced-motion:reduce){ .version-badge.is-stale{ animation:none; } }
  `;
  document.head.appendChild(s);
}

function fmtTime(iso) {
  // "2026-06-10 22:14:03 +0900" -> "06/10 22:14" (best-effort; raw on parse fail)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(iso || ''));
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : '';
}

function paint(v) {
  const bits = [`v${v.version || 'dev'}`];
  if (v.commit) bits.push(v.commit);
  const t = fmtTime(v.commit_time);
  if (t) bits.push(t);
  el.textContent = bits.join(' · ');
  el.title = v.commit_time
    ? `ビルド: ${v.commit || '?'}（${v.commit_time}）— F5で最新に更新されます`
    : 'ビルド情報';
  el.hidden = false;
}

function markStale() {
  if (stale) return;
  stale = true;
  el.classList.add('is-stale');
  el.textContent = '更新あり ↻ クリックで最新';
  el.title = '新しいビルドが公開されました。クリック（またはF5）で最新に更新します。';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  const reload = () => location.reload();
  el.addEventListener('click', reload);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reload(); }
  });
}

async function fetchVersion() {
  const r = await fetch('/api/version', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function load() {
  if (!el) return;
  injectStyle();
  try {
    const v = await fetchVersion();
    loadedCommit = v.commit || null;
    paint(v);
  } catch (_e) { /* offline / dev edge — leave the badge hidden */ }
}

// Poll for a newer build. Cheap (one tiny GET); only flips state once. Stops
// nagging after the first detection (the badge stays "更新あり" until reload).
async function poll() {
  if (stale || !el || el.hidden) return;
  try {
    const v = await fetchVersion();
    if (loadedCommit && v.commit && v.commit !== loadedCommit) markStale();
  } catch (_e) { /* server bouncing mid-reload is normal — ignore */ }
}

load();
setInterval(poll, 12000);
