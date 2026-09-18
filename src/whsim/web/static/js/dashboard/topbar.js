// dashboard/topbar.js — the ダッシュボード's own control strip: which scenario is
// on screen, where the replay clock stands, and the transport for it.
//
// Deliberately LOCAL to the dashboard rather than folded into the global header:
// the app header is shared by every view and carries the project-level ▶実行,
// while this strip is about the run currently being watched.
//
// EN comments / JA UI (no data-derived HTML here — every value goes in via
// textContent, so no escaping helper is needed).

const PREFIX = 'dtop';

function injectStyle() {
  if (document.getElementById(`${PREFIX}-style`)) return;
  const s = document.createElement('style');
  s.id = `${PREFIX}-style`;
  s.textContent = `
  .${PREFIX}{display:flex;align-items:center;gap:var(--sp-4);flex-wrap:wrap;
    padding:var(--sp-2) var(--sp-3);background:var(--bg-app);
    border:1px solid var(--line-hair);border-radius:var(--r-lg)}
  .${PREFIX}-grp{display:flex;align-items:center;gap:var(--sp-2);min-width:0}
  .${PREFIX}-lbl{font-size:var(--fs-xs);color:var(--ink-tertiary);white-space:nowrap}
  .${PREFIX}-scn{font-size:var(--fs-sm);color:var(--ink-primary);font-weight:var(--fw-medium);
    background:var(--bg-sunken);border:1px solid var(--line-soft);border-radius:var(--r-sm);
    padding:5px 10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .${PREFIX}-spacer{flex:1 1 auto}
  .${PREFIX}-clock{display:flex;align-items:center;gap:var(--sp-2)}
  .${PREFIX}-clock svg{width:16px;height:16px;stroke:var(--ink-tertiary);fill:none;stroke-width:1.6}
  .${PREFIX}-ct{display:flex;flex-direction:column;line-height:1.25}
  .${PREFIX}-ct .k{font-size:var(--fs-micro);color:var(--ink-tertiary)}
  .${PREFIX}-ct .v{font-size:var(--fs-sm);color:var(--ink-primary);font-weight:var(--fw-semibold);
    font-variant-numeric:tabular-nums}
  .${PREFIX}-btns{display:flex;align-items:center;gap:var(--sp-2)}
  .${PREFIX}-btn{display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);
    padding:6px 14px;border-radius:var(--r-sm);border:1px solid var(--line-soft);
    background:var(--bg-app);color:var(--ink-primary);cursor:pointer;white-space:nowrap}
  .${PREFIX}-btn:hover:not(:disabled){background:var(--bg-hover)}
  .${PREFIX}-btn:disabled{opacity:.45;cursor:default}
  .${PREFIX}-btn.is-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .${PREFIX}-btn.is-primary:hover:not(:disabled){background:var(--accent-hover,var(--accent))}
  .${PREFIX}-bar{flex:0 0 100%;height:3px;border-radius:2px;background:var(--bg-active);overflow:hidden}
  .${PREFIX}-bar>i{display:block;height:100%;background:var(--accent);border-radius:2px;
    transition:width var(--dur-1,.15s) linear}
  @media (prefers-reduced-motion:reduce){.${PREFIX}-bar>i{transition:none}}
  `;
  document.head.appendChild(s);
}

const CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

/** Seconds → 「X / Y 時間」 with one decimal on the elapsed side. */
function hours(sec) {
  const h = (Number(sec) || 0) / 3600;
  return h >= 10 ? h.toFixed(0) : h.toFixed(1);
}

export function mountTopbar(host, ctx) {
  if (!host) return null;
  injectStyle();
  host.className = PREFIX;
  host.innerHTML = `
    <div class="${PREFIX}-grp">
      <span class="${PREFIX}-lbl">シナリオ</span>
      <span class="${PREFIX}-scn" data-r="scn">—</span>
    </div>
    <div class="${PREFIX}-spacer"></div>
    <div class="${PREFIX}-clock">
      ${CLOCK_SVG}
      <span class="${PREFIX}-ct">
        <span class="k">シミュレーション時間</span>
        <span class="v" data-r="clock">—</span>
      </span>
    </div>
    <div class="${PREFIX}-btns">
      <button type="button" class="${PREFIX}-btn is-primary" data-a="play">▶ 再開</button>
      <button type="button" class="${PREFIX}-btn" data-a="stop">■ 停止</button>
      <button type="button" class="${PREFIX}-btn" data-a="settings">⚙ 設定</button>
    </div>
    <div class="${PREFIX}-bar"><i data-r="bar" style="width:0%"></i></div>`;

  let cur = ctx;
  const R = {};
  for (const el of host.querySelectorAll('[data-r]')) R[el.dataset.r] = el;

  // The dashboard does not own the transport state; it toggles the shell's.
  const onClick = (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'play') {
      // The primary button TOGGLES: it reads 再開 when parked and 一時停止 when
      // running, so it must act on the current state, not on a fixed verb.
      const playing = !!(cur.getPlaying && cur.getPlaying());
      if (cur.setPlaying) cur.setPlaying(!playing);
      render();
    } else if (a === 'stop') {
      if (cur.setPlaying) cur.setPlaying(false);
      render();
    } else if (a === 'settings') {
      // 設定 lives in the shell sidebar; open it rather than duplicating it here.
      const t = document.getElementById('settingsToggle');
      if (t) { t.click(); t.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  };
  host.addEventListener('click', onClick);

  function render() {
    const rep = cur.replay || null;
    const meta = (rep && rep.meta) || null;
    R.scn.textContent = cur.project || '—';
    R.scn.title = cur.project || '';
    const dur = meta ? Number(meta.duration_s) || 0 : 0;
    const t = Math.min(Number(cur.getTime ? cur.getTime() : 0) || 0, dur || Infinity);
    R.clock.textContent = dur ? `${hours(t)} / ${hours(dur)} 時間` : '—';
    R.bar.style.width = dur ? `${Math.max(0, Math.min(100, (t / dur) * 100)).toFixed(1)}%` : '0%';
    const playing = !!(cur.getPlaying && cur.getPlaying());
    const play = host.querySelector('[data-a="play"]');
    const stop = host.querySelector('[data-a="stop"]');
    if (play) {
      play.textContent = playing ? '⏸ 一時停止' : '▶ 再開';
      play.disabled = !cur.hasRun;
    }
    if (stop) stop.disabled = !cur.hasRun || !playing;
  }

  render();
  return {
    update(next) { cur = next || cur; render(); },
    tickClock() {
      const rep = cur.replay;
      const dur = rep && rep.meta ? Number(rep.meta.duration_s) || 0 : 0;
      if (!dur) return;
      const t = Math.min(Number(cur.getTime ? cur.getTime() : 0) || 0, dur);
      R.clock.textContent = `${hours(t)} / ${hours(dur)} 時間`;
      R.bar.style.width = `${Math.max(0, Math.min(100, (t / dur) * 100)).toFixed(1)}%`;
    },
    dispose() { host.removeEventListener('click', onClick); host.innerHTML = ''; },
  };
}
