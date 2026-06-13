// progress.js — 「処理してる感」と正直なETAを出す待ち表現の共用部品.
//
// 2系統:
//  (1) startRunProgress() — DES実行(▶実行/作業方法比較/シナリオ比較)の進捗。
//      サーバの GET /run/progress を 300ms ポーリングし、SimPyのシミュ内時計
//      (倉庫の1日が何時まで進んだか)を本物の進捗バーにする。ETAは実測レートから
//      算出しEMAで平滑化。フォークリフトが荷物を運びながらバーを走る＝世界観アニメ。
//  (2) forkliftBusy(label) — 取込・解析など短い同期処理の不確定待ち。ETAは出さず
//      フォークリフトが往復するインジケータ＋シマー。返り値の stop() で消す。
//
// ビルドレス・self-contained injectStyle、プレフィックス .rp-。テーマCSS変数で
// ダーク/ライト両対応。EN comments / JA UI.

function injectStyle() {
  if (document.getElementById('rp-style')) return;
  const s = document.createElement('style');
  s.id = 'rp-style';
  s.textContent = `
  .rp-ov{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb,var(--bg-app,#0b1016) 62%,transparent);backdrop-filter:blur(3px);
    animation:rp-fade .18s ease}
  @keyframes rp-fade{from{opacity:0}to{opacity:1}}
  .rp-card{width:min(520px,92vw);background:var(--bg-panel,#121a24);border:1px solid var(--line-strong,rgba(120,140,170,.3));
    border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:22px 24px;color:var(--ink-primary,#eaf2f8);
    font-family:var(--font-sans,inherit)}
  .rp-h{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;margin-bottom:4px}
  .rp-h .rp-spin{animation:rp-spin 1.1s linear infinite;display:inline-block}
  @keyframes rp-spin{to{transform:rotate(360deg)}}
  .rp-sub{font-size:12px;color:var(--ink-tertiary,#8ea4b6);margin-bottom:16px}
  .rp-clockrow{display:flex;align-items:baseline;justify-content:space-between;font-variant-numeric:tabular-nums;
    font-size:12px;color:var(--ink-secondary,#b6c6d4);margin-bottom:6px}
  .rp-clock{font-size:20px;font-weight:800;color:var(--ink-primary,#eaf2f8);letter-spacing:.5px}
  /* track with the forklift running along it */
  .rp-track{position:relative;height:30px;margin:2px 0 4px}
  .rp-rail{position:absolute;left:0;right:0;top:50%;height:8px;transform:translateY(-50%);
    border-radius:6px;background:var(--bg-sunken,rgba(120,140,170,.16));overflow:hidden}
  .rp-fill{position:absolute;left:0;top:0;bottom:0;border-radius:6px;width:0%;
    background:linear-gradient(90deg,var(--accent,#16C0DE),color-mix(in srgb,var(--accent,#16C0DE) 60%,#7ef6ff));
    transition:width .32s cubic-bezier(.4,0,.2,1)}
  /* moving shimmer inside the fill = 「処理してる感」 */
  .rp-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,
    rgba(255,255,255,.35),transparent);background-size:40% 100%;animation:rp-sh 1.1s linear infinite}
  @keyframes rp-sh{from{background-position:-40% 0}to{background-position:140% 0}}
  .rp-truck{position:absolute;top:50%;left:0%;transform:translate(-50%,-58%);font-size:20px;
    transition:left .32s cubic-bezier(.4,0,.2,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))}
  .rp-flag{position:absolute;top:50%;right:-2px;transform:translateY(-50%);font-size:15px;opacity:.8}
  .rp-meta{display:flex;align-items:center;justify-content:space-between;margin-top:12px;font-size:12.5px;
    color:var(--ink-secondary,#b6c6d4);font-variant-numeric:tabular-nums}
  .rp-eta{font-weight:700;color:var(--accent,#16C0DE)}
  .rp-pips{display:flex;gap:4px}
  .rp-pip{width:13px;height:5px;border-radius:3px;background:var(--bg-sunken,rgba(120,140,170,.25))}
  .rp-pip.on{background:var(--accent,#16C0DE)}
  /* phase tag (準備中/実行中/集計中) so the bar is never silently stuck at 0% */
  .rp-phase{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;
    background:var(--accent-tint,rgba(22,192,222,.16));color:var(--accent-ink,#16C0DE);
    margin-left:auto}
  /* 中止 (cancel/escape) button */
  .rp-cancel{margin-top:16px;width:100%;padding:9px 14px;border-radius:10px;
    border:1px solid var(--line-strong,rgba(120,140,170,.3));background:transparent;
    color:var(--ink-secondary,#b6c6d4);font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;
    transition:border-color .12s ease,color .12s ease,background .12s ease}
  .rp-cancel:hover{border-color:var(--bad,#FF5A78);color:var(--bad,#FF5A78);
    background:color-mix(in srgb,var(--bad,#FF5A78) 8%,transparent)}
  .rp-cancel:disabled{opacity:.5;cursor:default}
  .rp-cancel:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  /* indeterminate inline strip (imports / analysis) */
  .rp-busy{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--ink-secondary,#52677c)}
  .rp-busy-track{position:relative;flex:1;min-width:70px;height:16px;border-radius:8px;overflow:hidden;
    background:var(--bg-sunken,rgba(120,140,170,.18))}
  .rp-busy-truck{position:absolute;top:50%;transform:translate(-50%,-55%);font-size:14px;
    animation:rp-shuttle 1.5s ease-in-out infinite}
  @keyframes rp-shuttle{0%{left:8%}50%{left:92%}100%{left:8%}}
  @media(prefers-reduced-motion:reduce){
    .rp-fill::after,.rp-busy-truck{animation:none}
    .rp-h .rp-spin{animation:none}
  }
  `;
  document.head.appendChild(s);
}

// frac (0..1) → a warehouse workday clock 08:00 → 17:00 (cosmetic but intuitive:
// "倉庫の1日" reads as morning→evening even though the sim window is rebased).
function workdayClock(frac) {
  const mins = 8 * 60 + Math.max(0, Math.min(1, frac)) * 9 * 60;
  const h = Math.floor(mins / 60), m = Math.floor(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return '1秒未満';
  if (sec < 90) return `約 ${Math.ceil(sec)} 秒`;
  return `約 ${Math.ceil(sec / 60)} 分`;
}

// ── (1) DES run progress overlay (server-polled, honest ETA) ────────────────
// opts: { getProject, title?, sub?, jobs?(=total DES jobs for multi-runs),
//         onCancel?() — when set, a 「✕ 中止」 button (and the Esc key) call it;
//         the caller POSTs /run/cancel and resolves its run as cancelled. }
export function startRunProgress(opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const ov = document.createElement('div');
  ov.className = 'rp-ov';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-live', 'polite');
  ov.setAttribute('aria-label', '実行中');
  document.body.appendChild(ov);

  let etaEma = null;       // smoothed ETA seconds
  let lastFrac = 0;
  let timer = 0;
  let stopped = false;
  let cancelling = false;
  const canCancel = typeof opts.onCancel === 'function';

  function doCancel() {
    if (!canCancel || cancelling || stopped) return;
    cancelling = true;
    const btn = ov.querySelector('.rp-cancel');
    if (btn) { btn.disabled = true; btn.textContent = '中止しています…'; }
    const ph = ov.querySelector('.rp-phase'); if (ph) ph.textContent = '中止中';
    try { opts.onCancel(); } catch (_e) { /* caller handles the POST result */ }
  }
  const onKey = (e) => { if (e.key === 'Escape') doCancel(); };
  if (canCancel) document.addEventListener('keydown', onKey);

  function paint(p) {
    const frac = Math.max(lastFrac, Math.min(1, p.frac || 0));   // monotone
    lastFrac = frac;
    const pct = Math.round(frac * 100);
    // ETA from measured rate, EMA-smoothed so it doesn't jitter.
    let eta = null;
    if (p.elapsed_s != null && frac > 0.02) {
      const raw = (p.elapsed_s / frac) * (1 - frac);
      etaEma = etaEma == null ? raw : etaEma * 0.6 + raw * 0.4;
      eta = etaEma;
    }
    const reps = p.reps || 1, rep = Math.min(p.rep || 0, reps);
    const jobs = p.total_jobs || 1;
    const pips = Array.from({ length: reps }, (_, i) =>
      `<span class="rp-pip${i < rep ? ' on' : ''}"></span>`).join('');
    const jobLine = jobs > 1
      ? `<span>方式 ${(p.job || 0) + 1} / ${jobs}</span>`
      : `<span class="rp-pips" title="レプリケーション ${rep}/${reps}">🔁 ${pips}</span>`;
    const phase = cancelling ? '中止中' : (p.phase || '');
    ov.innerHTML =
      `<div class="rp-card">
        <div class="rp-h"><span class="rp-spin">🏭</span>${esc(opts.title || '倉庫の1日をシミュレーション中…')}
          ${phase ? `<span class="rp-phase">${esc(phase)}</span>` : ''}</div>
        <div class="rp-sub">${esc(opts.sub || '重厚な離散事象シミュレーションで、捌けるか・原価・人員を実測します。')}</div>
        <div class="rp-clockrow"><span>🕐 シミュ内時刻</span><span class="rp-clock">${workdayClock(frac)}</span><span>17:00</span></div>
        <div class="rp-track">
          <div class="rp-rail"><div class="rp-fill" style="width:${pct}%"></div></div>
          <div class="rp-truck" style="left:${pct}%">🚚</div>
          <div class="rp-flag">🏁</div>
        </div>
        <div class="rp-meta">${jobLine}<span><span>${pct}%</span> ・ <span class="rp-eta">⏱ あと ${fmtEta(eta)}</span></span></div>
        ${canCancel ? `<button type="button" class="rp-cancel"${cancelling ? ' disabled' : ''}>${cancelling ? '中止しています…' : '✕ 中止（Esc）'}</button>` : ''}
      </div>`;
    const cb = ov.querySelector('.rp-cancel');
    if (cb && !cancelling) cb.onclick = doCancel;
  }

  paint({ frac: 0, elapsed_s: 0 });   // immediate feedback before first poll

  async function poll() {
    if (stopped) return;
    const name = getProject();
    if (name) {
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(name)}/run/progress`,
          { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const p = await r.json();
          if (p && p.active) paint(p);
        }
      } catch (_e) { /* keep the last frame; the run is still going */ }
    }
    timer = setTimeout(poll, 300);
  }
  timer = setTimeout(poll, 250);

  return {
    stop(how = 'done') {
      if (stopped) return;   // idempotent: callers may stop() in finally after a cancel
      stopped = true;
      clearTimeout(timer);
      if (canCancel) document.removeEventListener('keydown', onKey);
      if (how === 'cancelled') {
        // Calm exit on 中止 — no 100% flourish (it didn't finish).
        ov.remove();
        return;
      }
      // brief 100% flourish so it never just vanishes mid-bar
      paint({ frac: 1, elapsed_s: 0 });
      ov.querySelector('.rp-eta') && (ov.querySelector('.rp-eta').textContent = '✓ 完了');
      setTimeout(() => { ov.remove(); }, 280);
    },
  };
}

// ── (2) indeterminate inline busy strip (imports / quick analysis) ──────────
// Replaces a plain "取込中…" line with a forklift shuttling + shimmer. No ETA
// (these are short/uncertain). Returns { el, stop }. Mount el wherever the text
// used to go (or pass a host to swap its content).
export function forkliftBusy(label = '処理中…', host = null) {
  injectStyle();
  const el = document.createElement('span');
  el.className = 'rp-busy';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    `<span>${esc(label)}</span>
     <span class="rp-busy-track"><span class="rp-busy-truck">🚚</span></span>`;
  if (host) { host.innerHTML = ''; host.appendChild(el); }
  return {
    el,
    setLabel(t) { const s = el.querySelector('span'); if (s) s.textContent = t; },
    stop() { if (el.parentNode) el.remove(); },
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
