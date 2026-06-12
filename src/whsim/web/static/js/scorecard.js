// scorecard.js — 採点表レール (Scorecard Rail).
//
// A persistent, Claude-Code-style right dock that shows the design's "scorecard"
// (判定/人員/原価/生産性/坪数/連鎖) recomputed analytically (DES-free, instant)
// on every edit/import/run. The values are the 解析的「当たり」; a DES run is the
// 裏取り — the rail keeps that two-stage framing always visible.
//
// Ownership / scope (per docs/SCORECARD_CONTRACT.md):
//   - Self-contained: injectStyle() with the `.sc-` prefix (no styles.css edits).
//   - Shown only on ②分析/③設計/④検証 phases (the rail scores *the design*);
//     hidden on ①取込/⑤提案. The shell (app.js) drives visibility via setPhase().
//   - Collapsible to a thin strip (~44px, icon+value) and fully hideable; width
//     is split-resizable (240–520px). Both states persist in localStorage.
//   - In ③設計 the designer owns the right side of the work area, so the rail
//     auto-collapses to the thin strip there and never overlaps the editor — the
//     dock is fixed-position and the shell pads `.main` by exactly the rail width
//     (full or strip), so reserved space, not overlap, is the contract.
//
// The rail exposes refresh()/setPhase()/setView()/dispose(); app.js debounces the
// recompute and wires the triggers (openProject / model-changed / save / run /
// design-dirty / phase entry).
import { esc } from './util.js';

const LS_COLLAPSED = 'whsim-rail-collapsed';   // '1' = collapsed to strip
const LS_HIDDEN = 'whsim-rail-hidden';         // '1' = fully hidden
const LS_WIDTH = 'whsim-rail-width';           // px, expanded width
const W_MIN = 240, W_MAX = 520, W_DEFAULT = 312;
const STRIP_W = 44;                            // collapsed strip width (px)
const NARROW = 1100;                           // <this px → default collapsed

// Phases the rail belongs to (design scorecard). Everything else hides it.
const RAIL_PHASES = new Set(['analyze', 'design', 'validate']);

// Per-row glyphs for the collapsed strip (recognisable without labels).
const ROW_ICON = {
  verdict: '◎', headcount: '人', cost: '¥', productivity: '⤴', tsubo: '坪', chain: '⛓',
};
// tone → accent colour token (left rule + strip dot). Theme-aware via CSS vars.
const TONE = {
  ok: 'var(--ok,#1db954)', warn: 'var(--warn,#f5b05a)',
  bad: 'var(--bad,#e3401c)', neutral: 'var(--ink-tertiary,#8195a8)',
};

function injectStyle() {
  if (document.getElementById('sc-style')) return;
  const s = document.createElement('style');
  s.id = 'sc-style';
  s.textContent = `
  .sc-rail{position:fixed;top:var(--header-h,56px);right:0;bottom:0;z-index:40;
    width:var(--sc-w,${W_DEFAULT}px);display:flex;flex-direction:column;
    background:var(--bg-sunken,#f2f1ee);border-left:1px solid var(--line,rgba(120,140,170,.18));
    box-shadow:-2px 0 10px rgba(8,16,28,.05);
    transition:width var(--dur-2,160ms) var(--ease-out,ease),transform var(--dur-2,160ms) var(--ease-out,ease);
    font:inherit}
  .sc-rail[hidden]{display:none}
  .sc-rail.is-collapsed{width:${STRIP_W}px}
  @media(prefers-reduced-motion:reduce){.sc-rail{transition:none}}
  /* resize gripper on the left border — wide hit area, hairline that lights on hover */
  .sc-grip{position:absolute;left:-4px;top:0;bottom:0;width:9px;cursor:col-resize;z-index:2;
    display:flex;align-items:center;justify-content:center}
  .sc-rail.is-collapsed .sc-grip{display:none}
  .sc-grip::after{content:"";width:2px;height:100%;background:transparent;
    transition:background var(--dur-1,120ms) var(--ease-out,ease)}
  .sc-grip:hover::after,.sc-grip.is-drag::after{background:var(--accent,#16C0DE)}
  /* header */
  .sc-head{display:flex;align-items:center;gap:6px;padding:9px 10px 9px 12px;
    border-bottom:1px solid var(--line,rgba(120,140,170,.18));flex:0 0 auto}
  .sc-title{font-size:12px;font-weight:800;letter-spacing:.04em;color:var(--ink-primary,#16202e);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
  .sc-title .sc-src{font-weight:600;color:var(--ink-tertiary,#8195a8);font-size:10.5px;margin-left:5px}
  .sc-ibtn{flex:0 0 auto;width:24px;height:24px;display:flex;align-items:center;justify-content:center;
    border:1px solid var(--line,rgba(120,140,170,.22));border-radius:7px;background:transparent;
    color:var(--ink-secondary,#52677c);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:0}
  .sc-ibtn:hover{border-color:var(--accent,#16C0DE);color:var(--accent,#16C0DE)}
  .sc-ibtn:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  /* scenario compare row */
  .sc-cmp{display:flex;align-items:center;gap:7px;padding:8px 12px;flex:0 0 auto;
    border-bottom:1px solid var(--line,rgba(120,140,170,.12))}
  .sc-cmp label{font-size:11px;font-weight:700;color:var(--ink-tertiary,#8195a8);white-space:nowrap}
  .sc-cmp select{flex:1;min-width:0;background:var(--bg-app,#fff);color:var(--ink-primary,#16202e);
    border:1px solid var(--line,rgba(120,140,170,.25));border-radius:7px;padding:5px 7px;font:inherit;font-size:12px}
  .sc-cmp select:focus{outline:none;border-color:var(--accent,#16C0DE)}
  /* rows */
  .sc-body{flex:1;min-height:0;overflow-y:auto;padding:9px 10px;display:flex;flex-direction:column;gap:7px}
  .sc-body::-webkit-scrollbar{width:7px}
  .sc-body::-webkit-scrollbar-thumb{background:var(--line,rgba(120,140,170,.3));border-radius:4px}
  /* height:auto overrides the global button{height:34px} so rows size to content */
  .sc-row{position:relative;text-align:left;cursor:pointer;font:inherit;height:auto;
    background:var(--bg-app,#fff);border:1px solid var(--line,rgba(120,140,170,.16));
    border-left:3px solid var(--sc-tone,var(--ink-tertiary,#8195a8));
    border-radius:10px;padding:8px 11px;display:flex;flex-direction:column;gap:2px;
    align-items:flex-start;
    transition:border-color var(--dur-1,120ms) var(--ease-out,ease),transform var(--dur-1,120ms) var(--ease-out,ease)}
  .sc-row:hover{border-color:var(--accent,#16C0DE);border-left-color:var(--sc-tone,var(--accent,#16C0DE));transform:translateX(-1px)}
  .sc-row:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  .sc-row-l{font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--ink-tertiary,#8195a8)}
  .sc-row-v{font-size:21px;font-weight:800;color:var(--ink-primary,#16202e);line-height:1.1;
    display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}
  .sc-row-v small{font-size:11px;font-weight:600;color:var(--ink-secondary,#52677c)}
  .sc-delta{font-size:11px;font-weight:800;padding:1px 6px;border-radius:999px;white-space:nowrap}
  .sc-delta.good{color:#0a7d3d;background:rgba(29,185,84,.14)}
  .sc-delta.bad{color:#c0341a;background:rgba(227,64,28,.13)}
  .sc-delta.flat{color:var(--ink-tertiary,#8195a8);background:rgba(120,140,170,.12)}
  .sc-row-sub{font-size:11px;color:var(--ink-secondary,#52677c);line-height:1.35;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* footer */
  .sc-foot{flex:0 0 auto;border-top:1px solid var(--line,rgba(120,140,170,.18));padding:9px 11px;
    display:flex;flex-direction:column;gap:6px}
  .sc-runbtn{width:100%;padding:8px 10px;border-radius:9px;border:none;cursor:pointer;font:inherit;
    font-weight:700;font-size:12.5px;background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c)}
  .sc-runbtn:hover{filter:brightness(1.07)}
  .sc-runbtn:disabled{opacity:.5;cursor:default}
  .sc-runbtn:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  .sc-stamp{font-size:10.5px;color:var(--ink-tertiary,#8195a8);text-align:center}
  /* loading / empty */
  .sc-msg{padding:18px 14px;font-size:12px;color:var(--ink-tertiary,#8195a8);text-align:center;line-height:1.5}
  /* ── collapsed strip ── */
  .sc-rail.is-collapsed .sc-cmp,.sc-rail.is-collapsed .sc-foot,
  .sc-rail.is-collapsed .sc-title,.sc-rail.is-collapsed .sc-row-sub,
  .sc-rail.is-collapsed .sc-delta,.sc-rail.is-collapsed [data-sc-hide]{display:none}
  .sc-rail.is-collapsed .sc-head{padding:9px 0;justify-content:center}
  .sc-rail.is-collapsed .sc-body{padding:8px 0;align-items:center;gap:6px}
  .sc-rail.is-collapsed .sc-row{width:34px;height:40px;padding:0;border-radius:9px;
    align-items:center;justify-content:center;gap:1px;border-left-width:0;border-top:3px solid var(--sc-tone)}
  .sc-rail.is-collapsed .sc-row:hover{transform:none}
  .sc-strip-ic{font-size:13px;line-height:1;color:var(--ink-tertiary,#8195a8)}
  .sc-strip-v{font-size:9.5px;font-weight:800;color:var(--ink-primary,#16202e);line-height:1;
    max-width:32px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
  .sc-rail:not(.is-collapsed) .sc-strip-ic,.sc-rail:not(.is-collapsed) .sc-strip-v{display:none}
  /* re-show tab: a small pull on the right edge when the rail is fully hidden */
  .sc-peek{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:39;
    writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.12em;
    padding:11px 4px;border:1px solid var(--line,rgba(120,140,170,.22));border-right:none;
    border-radius:9px 0 0 9px;background:var(--bg-app,#fff);color:var(--ink-secondary,#52677c);
    font:inherit;font-size:11px;font-weight:800;cursor:pointer;box-shadow:-2px 0 8px rgba(8,16,28,.07)}
  .sc-peek:hover{color:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE)}
  .sc-peek:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  .sc-peek[hidden]{display:none}
  @media(prefers-reduced-motion:reduce){.sc-row,.sc-grip::after{transition:none}}
  `;
  document.head.appendChild(s);
}

// Short value for the collapsed strip (drop unit, keep the headline glyph/number).
function stripValue(row) {
  const v = String(row.value ?? '—');
  // verdict/chain carry a leading status glyph; keep just that for the strip.
  if (row.id === 'verdict') return v.trim().charAt(0) || '◎';
  if (row.id === 'chain') return v.trim().charAt(0) || '⛓';
  // numeric rows: keep first ~4 chars (e.g. "712k", "43.5", "260").
  return v.replace(/\s/g, '').slice(0, 4);
}

// Format a signed delta with the right polarity colour. `goodWhenDown` flips the
// sense (cost/headcount: less = good; productivity: more = good).
function deltaChip(cur, ref, goodWhenDown, fmt) {
  if (cur == null || ref == null || !isFinite(cur) || !isFinite(ref)) return '';
  const d = cur - ref;
  const eps = Math.max(1e-9, Math.abs(ref) * 0.005);
  if (Math.abs(d) <= eps) return `<span class="sc-delta flat" title="実行と同等">＝</span>`;
  const up = d > 0;
  const good = goodWhenDown ? !up : up;
  const arrow = up ? '▲' : '▼';
  const txt = fmt ? fmt(Math.abs(d)) : Math.abs(d).toFixed(1);
  const title = `最後の実行(DES)比 ${up ? '+' : '−'}${txt}`;
  return `<span class="sc-delta ${good ? 'good' : 'bad'}" title="${esc(title)}">${arrow}${txt}</span>`;
}

export function mountScorecard(opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const onRun = opts.onRun || (() => {});
  const onNav = opts.onNav || ((view) => {
    document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view } }));
  });

  function clampWidth(w) { return Math.max(W_MIN, Math.min(W_MAX, w || W_DEFAULT)); }

  // Persisted UI state.
  let width = clampWidth(parseInt(localStorage.getItem(LS_WIDTH) || '', 10) || W_DEFAULT);
  let collapsed = localStorage.getItem(LS_COLLAPSED) === '1';
  let hidden = localStorage.getItem(LS_HIDDEN) === '1';
  // Narrow viewports default to collapsed (unless the user already chose).
  if (localStorage.getItem(LS_COLLAPSED) == null && window.innerWidth < NARROW) collapsed = true;

  // Live data + view context.
  let data = null;            // last scorecard payload
  let lastFetched = null;     // Date of last successful fetch
  let phase = null;           // current phase id (intake/analyze/design/validate/propose)
  let designerCollapse = false;   // forced strip in ③設計 (designer owns the right)
  let compareRun = false;     // scenario compare = 「最後の実行(DES)」
  let busy = false;

  // Whether the rail should be visible for the current phase.
  function visibleForPhase() { return !hidden && phase != null && RAIL_PHASES.has(phase); }
  // Effective collapsed = user-collapsed OR designer-forced strip.
  function effCollapsed() { return collapsed || designerCollapse; }

  // ── DOM ───────────────────────────────────────────────────────────────────
  const rail = document.createElement('aside');
  rail.className = 'sc-rail';
  rail.setAttribute('aria-label', '採点表レール');
  rail.hidden = true;
  // Mount into the #scorecardDock anchor when present (index.html); the rail is
  // fixed-position regardless, so it floats over the right edge either way.
  const host = document.getElementById('scorecardDock') || document.body;
  host.appendChild(rail);

  // Re-show pull-tab: shown only when the rail is fully hidden *and* the current
  // phase wants it — so 「✕で隠す」 is never a dead end.
  const peek = document.createElement('button');
  peek.type = 'button';
  peek.className = 'sc-peek';
  peek.hidden = true;
  peek.textContent = '採点表';
  peek.title = '採点表レールを表示';
  peek.setAttribute('aria-label', '採点表レールを表示');
  peek.addEventListener('click', () => {
    hidden = false;
    localStorage.setItem(LS_HIDDEN, '0');
    applyChrome();
    render();
  });
  host.appendChild(peek);

  // One-time: pad .main by the reserved var so content reflows beside the dock.
  if (!document.getElementById('sc-reserve-style')) {
    const rs = document.createElement('style');
    rs.id = 'sc-reserve-style';
    rs.textContent = `body.sc-rail-on .main{padding-right:calc(var(--sp-6,24px) + var(--sc-reserve,0px))}`;
    document.head.appendChild(rs);
  }

  function applyChrome() {
    rail.style.setProperty('--sc-w', width + 'px');
    rail.classList.toggle('is-collapsed', effCollapsed());
    rail.hidden = !visibleForPhase();
    // The pull-tab appears only when hidden by the user *in* a rail phase.
    peek.hidden = !(hidden && phase != null && RAIL_PHASES.has(phase));
    reserveSpace();
  }

  // Reserve exactly the rail's footprint on `.main` so the work area (incl. the
  // designer canvas) never sits under the dock — overlap is structurally
  // impossible. When hidden, no reservation. Uses a CSS var + class on <body>.
  function reserveSpace() {
    const show = visibleForPhase();
    const w = show ? (effCollapsed() ? STRIP_W : width) : 0;
    document.body.style.setProperty('--sc-reserve', w + 'px');
    document.body.classList.toggle('sc-rail-on', show);
    // Designer canvas reflows on the next resize tick; ask the shell to refit.
    if (show && opts.onReserve) opts.onReserve();
  }

  function render() {
    if (!visibleForPhase()) { applyChrome(); return; }
    const strip = effCollapsed();
    const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
    const run = (data && data.run) || { exists: false };

    const headHtml =
      `<div class="sc-head">
        <button class="sc-ibtn" data-sc="collapse" title="${strip ? '展開' : '折りたたむ'}"
                aria-label="${strip ? '展開' : '折りたたむ'}">${strip ? '›' : '‹'}</button>
        <span class="sc-title">採点表${data && data.source ? `<span class="sc-src">${esc(srcLabel(data.source))}</span>` : ''}</span>
        <button class="sc-ibtn" data-sc="hide" title="レールを隠す" aria-label="レールを隠す" data-sc-hide>✕</button>
      </div>`;

    const cmpDisabled = !run.exists;
    const cmpHtml =
      `<div class="sc-cmp">
        <label for="sc-cmp-sel">比較:</label>
        <select id="sc-cmp-sel" data-sc="compare">
          <option value="none"${compareRun ? '' : ' selected'}>なし</option>
          <option value="run"${compareRun ? ' selected' : ''}${cmpDisabled ? ' disabled' : ''}>最後の実行(DES)</option>
        </select>
      </div>`;

    let bodyHtml;
    if (!data) {
      bodyHtml = `<div class="sc-msg">${busy ? '採点中…' : '採点表を読み込み中…'}</div>`;
    } else if (!rows.length) {
      bodyHtml = `<div class="sc-msg">まだ採点できる設計がありません。<br>プロジェクトを開いて設計を始めてください。</div>`;
    } else {
      bodyHtml = rows.map((r) => rowHtml(r, run)).join('');
    }

    const footHtml =
      `<div class="sc-foot">
        <button class="sc-runbtn" data-sc="run" ${busy ? 'disabled' : ''}>▶ DESで実測検証</button>
        <div class="sc-stamp">${lastFetched ? '最終更新 ' + stamp(lastFetched) : '—'}</div>
      </div>`;

    rail.innerHTML =
      `<div class="sc-grip" data-sc="grip" role="separator" aria-orientation="vertical"
            aria-label="レール幅を調整" title="ドラッグで幅を調整"></div>`
      + headHtml
      + (strip ? '' : cmpHtml)
      + `<div class="sc-body">${bodyHtml}</div>`
      + (strip ? '' : footHtml);
    applyChrome();
  }

  function rowHtml(r, run) {
    const tone = TONE[r.tone] || TONE.neutral;
    const unit = r.unit ? `<small>${esc(r.unit)}</small>` : '';
    let delta = '';
    if (compareRun && run && run.exists) delta = deltaFor(r, run);
    const ic = ROW_ICON[r.id] || '•';
    return `<button class="sc-row" data-view="${esc(r.view || '')}" style="--sc-tone:${tone}"
              title="${esc((r.label || '') + (r.sub ? ' — ' + r.sub : ''))}">
      <span class="sc-strip-ic">${ic}</span>
      <span class="sc-strip-v">${esc(stripValue(r))}</span>
      <span class="sc-row-l" data-sc-hide>${esc(r.label || '')}</span>
      <span class="sc-row-v" data-sc-hide>${esc(String(r.value ?? '—'))}${unit}${delta}</span>
      ${r.sub ? `<span class="sc-row-sub" data-sc-hide>${esc(r.sub)}</span>` : ''}
    </button>`;
  }

  // Compute the ▲▼ chip for a row vs the last DES run, where a run value exists.
  function deltaFor(r, run) {
    if (r.id === 'cost' && r.per_order != null && run.cost_per_order != null) {
      return deltaChip(r.per_order, run.cost_per_order, true, (d) => '¥' + Math.round(d));
    }
    if (r.id === 'headcount' && r.num != null && run.headcount != null) {
      return deltaChip(r.num, run.headcount, true, (d) => d.toFixed(1) + '人');
    }
    if (r.id === 'productivity' && r.num != null && run.measured_productivity) {
      // Compare the analytic 行/h against the mean measured productivity.
      const vals = Object.values(run.measured_productivity).filter((x) => isFinite(x));
      if (vals.length) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        return deltaChip(r.num, mean, false, (d) => Math.round(d) + '');
      }
    }
    return '';
  }

  // ── data ────────────────────────────────────────────────────────────────
  async function fetchScorecard() {
    const name = getProject();
    if (!name) { data = null; render(); return; }
    busy = true;
    if (!data) render();   // first load shows the spinner; later loads update silently
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(name)}/scorecard`,
        { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
      lastFetched = new Date();
      // A run-less payload invalidates the run comparison choice.
      if (!(data.run && data.run.exists)) compareRun = false;
    } catch (_e) {
      // never-blocks: keep the last good data; show a soft note if we have none.
      if (!data) data = { rows: [], run: { exists: false }, source: '' };
    } finally {
      busy = false;
      render();
    }
  }

  // ── interaction ───────────────────────────────────────────────────────────
  rail.addEventListener('click', (e) => {
    const navBtn = e.target.closest('.sc-row[data-view]');
    if (navBtn) {
      const v = navBtn.dataset.view;
      if (v) onNav(v);
      return;
    }
    const act = e.target.closest('[data-sc]');
    if (!act) return;
    const a = act.dataset.sc;
    if (a === 'collapse') {
      collapsed = !collapsed;
      localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0');
      render();
    } else if (a === 'hide') {
      hidden = true;
      localStorage.setItem(LS_HIDDEN, '1');
      applyChrome();
      if (opts.onHide) opts.onHide();
    } else if (a === 'run') {
      onRun();
    }
  });
  rail.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-sc="compare"]');
    if (!sel) return;
    compareRun = sel.value === 'run';
    render();
  });

  // ── resize (split) ──────────────────────────────────────────────────────
  let dragging = false;
  function onGripDown(e) {
    const grip = e.target.closest('[data-sc="grip"]');
    if (!grip || effCollapsed()) return;
    e.preventDefault();
    dragging = true;
    grip.classList.add('is-drag');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const move = (ev) => {
      if (!dragging) return;
      // dock is right-anchored: width = distance from cursor to viewport right.
      width = clampWidth(window.innerWidth - ev.clientX);
      rail.style.setProperty('--sc-w', width + 'px');
      reserveSpace();
    };
    const up = () => {
      dragging = false;
      grip.classList.remove('is-drag');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem(LS_WIDTH, String(width));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  rail.addEventListener('pointerdown', onGripDown);

  // Keep the reserved space in sync when the viewport changes.
  const onResize = () => { reserveSpace(); };
  window.addEventListener('resize', onResize);

  applyChrome();

  return {
    // Re-fetch the scorecard (app.js debounces the trigger fan-in).
    refresh: fetchScorecard,
    // Phase entry: show/hide the rail; (re)fetch when entering a rail phase.
    setPhase(p) {
      const was = phase;
      phase = p;
      applyChrome();
      if (visibleForPhase() && p !== was) fetchScorecard();
      else render();
    },
    // View entry: ③設計(designer) forces the thin strip so the editor keeps the
    // right side; other views restore the user's chosen collapsed state.
    setView(v) {
      designerCollapse = (v === 'design');
      applyChrome();
      render();
    },
    // Let the shell re-show the rail (e.g. if a future affordance unhides it).
    show() { hidden = false; localStorage.setItem(LS_HIDDEN, '0'); applyChrome(); render(); },
    isHidden() { return hidden; },
    dispose() {
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('sc-rail-on');
      document.body.style.removeProperty('--sc-reserve');
      peek.remove();
      rail.remove();
    },
  };
}

function srcLabel(src) {
  return src === 'analytic' ? '解析' : (src || '');
}
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
