// version.js — header build badge: package version + git commit + commit time.
// Self-contained module (own script tag in index.html) so it never collides
// with the app shell. With the dev auto-sync loop, a glance at the badge after
// F5 answers 「いま見てるのは最新？」 — the hash/time change when a push lands.
const el = document.getElementById('versionBadge');

function fmtTime(iso) {
  // "2026-06-10 22:14:03 +0900" -> "06/10 22:14" (best-effort; raw on parse fail)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(iso || ''));
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : '';
}

async function load() {
  if (!el) return;
  try {
    const r = await fetch('/api/version', { headers: { Accept: 'application/json' } });
    if (!r.ok) return;            // badge is optional chrome — stay empty on error
    const v = await r.json();
    const bits = [`v${v.version || 'dev'}`];
    if (v.commit) bits.push(v.commit);
    const t = fmtTime(v.commit_time);
    if (t) bits.push(t);
    el.textContent = bits.join(' · ');
    el.title = v.commit_time
      ? `ビルド: ${v.commit || '?'}（${v.commit_time}）— F5で最新に更新されます`
      : 'ビルド情報';
    el.hidden = false;
  } catch (_e) { /* offline / dev edge — leave the badge hidden */ }
}

load();
