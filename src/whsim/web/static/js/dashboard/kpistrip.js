// dashboard/kpistrip.js — ダッシュボード上端の KPI ストリップ (6枚).
//
// Each card = tinted icon + grey label + big tabular number + unit, and a footer
// that carries the product's whole thesis: 「解析で当てる → DESで裏取り」. The
// footer reference is ALWAYS the analytic prediction (解析予測) and the delta is
// how far the measured DES run landed from it. There is no such thing as an
// invented target here — when no analytic prediction can be sourced for a metric
// the card simply renders without a footer.
//
// Prediction sources, in order:
//   1. ctx.analysis when source === 'estimate'  (the thin analytic estimate —
//      its hero/groups ARE the prediction, in display units already)
//   2. ctx.scorecard rows (判定/原価/人員 — composed from the same pure
//      estimators, so they stay available AFTER a run replaces the analysis)
//   3. none → no footer for that card.
//
// never-blocks: no run / partial payloads / missing fields degrade to a calm
// 「—」 frame, never a throw and never a blank box. EN comments / JA UI.
import { esc } from '../util.js';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Finite-number gate: anything else (null / undefined / NaN / string) → null,
// which every renderer below reads as "no data" rather than a zero.
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const scale = (v, k) => (v == null ? null : v * k);

const fmt = (n, d = 0) => (n == null ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

// Stroke-based 24×24 icon bodies (no emoji, no fills, inherit currentColor).
const ICONS = {
  bolt: '<path d="M13 3 5.5 13h5.2L11 21l7.5-10h-5.2L13 3Z"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
  gauge: '<path d="M3.8 17.5a8.5 8.5 0 1 1 16.4 0"/><path d="m12 17.5 3.8-5.3"/><circle cx="12" cy="17.5" r="1.1"/>',
  yen: '<path d="M7.8 4.5 12 11l4.2-6.5"/><path d="M12 11v8.5"/><path d="M8.2 13.4h7.6"/><path d="M8.2 16.4h7.6"/>',
  users: '<circle cx="9.2" cy="8.6" r="3.2"/><path d="M3.6 19.4a5.6 5.6 0 0 1 11.2 0"/><path d="M16.2 6.2a3.2 3.2 0 0 1 0 6"/><path d="M17.6 14.2a5.6 5.6 0 0 1 3.4 4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.8V12l3.4 2.1"/>',
};

const svg = (key) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false">${ICONS[key] || ICONS.bolt}</svg>`;

// ---------------------------------------------------------------------------
// card catalogue — the priority order the strip renders in. A card is dropped
// (not faked) when `read()` finds nothing in the run KPIs.
//   polarity: 'higher' = up is good / 'lower' = down is good /
//             'util'   = utilisation (only judged once it is already >=95%)
//   mode:     'pct' = relative %, 'pt' = point difference (%-unit metrics)
// ---------------------------------------------------------------------------
const DEFS = [
  {
    id: 'throughput', icon: 'bolt', tone: 'accent', dec: 0,
    label: () => '処理能力',
    unit: () => '件/時',
    read: (k) => num(k.throughput_per_hr),
    ref: (r) => r.throughput,
    hero: (h) => h.label === '処理能力',
    polarity: 'higher', mode: 'pct',
  },
  {
    id: 'completion', icon: 'check', tone: 'ok', dec: 0,
    label: () => '出荷完了率',
    unit: () => '%',
    read: (k) => scale(num(k.completion_rate), 100),
    ref: (r) => r.completion,
    hero: (h) => h.label === '出荷完了率',
    polarity: 'higher', mode: 'pt',
  },
  {
    id: 'bottleneck', icon: 'gauge', tone: 'warn', dec: 0,
    // Named after the measured bottleneck stage (kpis.bottleneck_jp), e.g.
    // 「ピッキング稼働率」; falls back to a neutral title before a run.
    label: (k) => (k && k.bottleneck_jp ? `${k.bottleneck_jp}稼働率` : 'ボトルネック稼働'),
    unit: () => '%',
    read: (k) => scale(num(k.bottleneck_utilization), 100),
    ref: (r) => r.bottleneck,
    hero: (h) => typeof h.label === 'string' && /稼働率$/.test(h.label),
    polarity: 'util', mode: 'pt',
  },
  {
    id: 'cost', icon: 'yen', tone: 'info', dec: 1,
    label: () => '1件あたりコスト',
    unit: (k) => (k && typeof k.currency === 'string' && k.currency ? k.currency : '¥'),
    read: (k) => num(k.cost_per_order) ?? num(k.total_cost_per_order),
    ref: (r) => r.cost,
    hero: (h) => h.label === '1件あたりコスト',
    polarity: 'lower', mode: 'pct',
  },
  {
    id: 'headcount', icon: 'users', tone: 'accent', dec: 0,
    label: () => '人員',
    unit: () => '名',
    read: (k) => num(k.headcount),
    ref: (r) => r.headcount,
    hero: (h) => h.label === '必要人員',
    polarity: 'lower', mode: 'pct',
  },
  {
    id: 'cycle', icon: 'clock', tone: 'info', dec: 1,
    label: () => '平均サイクル',
    unit: () => '分',
    read: (k) => scale(num(k.cycle_p50_s), 1 / 60),
    ref: (r) => r.cycle,
    hero: () => false,
    polarity: 'lower', mode: 'pct',
  },
];

// ---------------------------------------------------------------------------
// 解析予測 (the reference line). Everything below returns numbers that ALREADY
// live in the card's display unit, or null. Nothing here fabricates a value.
// ---------------------------------------------------------------------------
function buildRefs(ctx) {
  const out = { src: null };
  const an = ctx && ctx.analysis;

  // (1) the thin analytic estimate: its own hero/groups are the prediction.
  if (an && an.source === 'estimate' && an.kpis) {
    const hero = Array.isArray(an.kpis.hero) ? an.kpis.hero : [];
    const items = [];
    (Array.isArray(an.kpis.groups) ? an.kpis.groups : []).forEach((g) => {
      if (g && Array.isArray(g.items)) items.push(...g.items);
    });
    const all = hero.concat(items).filter((it) => it && num(it.value) != null);
    const byLabel = (...labels) => {
      const hit = all.find((it) => labels.indexOf(it.label) >= 0);
      return hit ? num(hit.value) : null;
    };
    const utilHit = all.find((it) => typeof it.label === 'string' && /稼働率$/.test(it.label));
    out.throughput = byLabel('処理能力');
    out.completion = byLabel('出荷完了率');
    out.bottleneck = utilHit ? num(utilHit.value) : null;
    out.cost = byLabel('1件あたりコスト');
    out.headcount = byLabel('人員', '必要人員');
    out.cycle = byLabel('平均サイクル');
    out.src = 'estimate';
    return out;
  }

  // (2) the scorecard: analytic too (analytic/cost/pickrate compositions), and
  // it survives a run — which is exactly when we need a prediction to compare.
  const rows = ctx && ctx.scorecard && Array.isArray(ctx.scorecard.rows)
    ? ctx.scorecard.rows : null;
  if (rows) {
    const row = (id) => rows.find((r) => r && r.id === id) || null;
    const v = row('verdict');
    if (v) {
      // The 判定 row's `sub` is authored by scorecard.py in one fixed shape:
      // 「容量114 > 需要100 件/h」. Read both numbers out of it; no match → no
      // footer (nothing is invented).
      // 容量 is `capacity_orders_per_hr` — the very number _common.py serves as
      // the analytic 「処理能力」 hero, so the two stay one definition.
      const m = /容量\s*([0-9][0-9,.]*)/.exec(String(v.sub || ''));
      if (m) out.throughput = num(parseFloat(m[1].replace(/,/g, '')));
      // v.num is the analytic PICKER utilisation (0-1). When the measured
      // bottleneck is some other stage the two are not the same metric, so it
      // is not offered as a reference.
      const bn = ctx.kpis && ctx.kpis.bottleneck;
      if (num(v.num) != null && v.num > 0 && (!bn || bn === 'picking')) {
        out.bottleneck = v.num * 100;
      }
    }
    const c = row('cost');
    if (c && num(c.per_order) != null && c.per_order > 0) out.cost = c.per_order;
    const h = row('headcount');
    if (h && num(h.num) != null && h.num > 0) out.headcount = h.num;
    if (out.throughput != null || out.bottleneck != null
      || out.cost != null || out.headcount != null) out.src = 'scorecard';
  }
  return out;
}

// Delta colour semantics are declared per card (see DEFS.polarity), never
// guessed at render time.
function deltaTone(def, d, value) {
  if (d == null || Math.abs(d) < 0.05) return 'flat';
  if (def.polarity === 'higher') return d > 0 ? 'ok' : 'bad';
  if (def.polarity === 'lower') return d > 0 ? 'bad' : 'ok';
  // 'util': a utilisation that is already hot (>=95%) getting hotter is bad;
  // below that a shift either way carries no verdict.
  if (value != null && value >= 95) return d > 0 ? 'bad' : 'ok';
  return 'flat';
}

// CI block for a card, taken from the analysis hero that annotates the same
// metric (half_width is already in the hero's display unit — see _common.py).
function ciFor(def, ctx) {
  const an = ctx && ctx.analysis;
  const hero = an && an.kpis && Array.isArray(an.kpis.hero) ? an.kpis.hero : null;
  if (!hero) return null;
  const hit = hero.find((h) => h && def.hero(h));
  const ci = hit && hit.ci;
  if (!ci || typeof ci !== 'object') return null;
  return ci;
}

function injectStyle() {
  if (document.getElementById('dkpi-style')) return;
  const s = document.createElement('style');
  s.id = 'dkpi-style';
  s.textContent = `
  .dkpi{display:flex;flex-direction:column;gap:var(--sp-2,8px);width:100%}
  .dkpi-grid{display:grid;gap:var(--sp-2,8px);
    grid-template-columns:repeat(6,minmax(0,1fr))}
  @media (max-width:1280px){.dkpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  @media (max-width:720px){.dkpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .dkpi-card{display:flex;flex-direction:column;gap:var(--sp-2,8px);min-width:0;
    padding:var(--sp-3,12px) var(--sp-4,16px);background:var(--bg-panel);
    border:1px solid var(--line-hair);border-radius:var(--r-lg,12px);box-shadow:var(--sh-xs)}
  .dkpi-top{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0}
  .dkpi-icon{flex:0 0 auto;width:28px;height:28px;border-radius:var(--r-sm,6px);
    display:flex;align-items:center;justify-content:center}
  .dkpi-icon svg{width:18px;height:18px}
  .dkpi-icon.t-accent{background:var(--accent-tint);color:var(--accent-ink)}
  .dkpi-icon.t-ok{background:var(--ok-tint);color:var(--ok-ink)}
  .dkpi-icon.t-warn{background:var(--warn-tint);color:var(--warn-ink)}
  .dkpi-icon.t-bad{background:var(--bad-tint);color:var(--bad-ink)}
  .dkpi-icon.t-info{background:var(--info-tint);color:var(--accent-ink)}
  .dkpi-label{font-size:var(--fs-xs,12px);color:var(--ink-tertiary);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dkpi-val{display:flex;align-items:baseline;gap:4px;min-width:0;flex-wrap:wrap}
  .dkpi-n{font-size:var(--fs-metric,28px);font-weight:var(--fw-semibold,600);
    color:var(--ink-primary);line-height:1.1;font-variant-numeric:tabular-nums;
    letter-spacing:-0.015em}
  .dkpi-u{font-size:var(--fs-xs,12px);color:var(--ink-tertiary)}
  .dkpi-ci{font-size:var(--fs-micro,11px);color:var(--ink-faint);
    font-variant-numeric:tabular-nums;margin-left:2px}
  .dkpi-foot{display:flex;align-items:center;gap:var(--sp-2,8px);min-height:16px;
    font-size:var(--fs-micro,11px);color:var(--ink-tertiary);min-width:0}
  .dkpi-ref{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    font-variant-numeric:tabular-nums}
  .dkpi-d{flex:0 0 auto;font-weight:var(--fw-semibold,600);
    font-variant-numeric:tabular-nums}
  .dkpi-d.ok{color:var(--ok)}
  .dkpi-d.bad{color:var(--bad)}
  .dkpi-d.flat{color:var(--ink-faint)}
  .dkpi-note{display:flex;align-items:center;gap:var(--sp-3,12px);
    font-size:var(--fs-xs,12px);color:var(--ink-tertiary)}
  .dkpi-run{padding:5px 12px;border-radius:var(--r-pill,999px);
    border:1px solid var(--line-strong);background:var(--bg-app);
    color:var(--ink-secondary);font:inherit;font-size:var(--fs-xs,12px);
    font-weight:var(--fw-semibold,600);cursor:pointer}
  .dkpi-run:hover{background:var(--bg-hover);color:var(--ink-primary)}
  .dkpi-card.is-empty .dkpi-n{color:var(--ink-faint)}
  @media (prefers-reduced-motion:no-preference){
    .dkpi-run{transition:background var(--dur-2,160ms) var(--ease,ease)}
  }
  `;
  document.head.appendChild(s);
}

/**
 * KPI strip — 6 cards across the top of the dashboard.
 * @param {HTMLElement} host
 * @param {object} ctx  read-only dashboard context (see dashboard.js)
 * @returns {{update:Function, dispose:Function}}
 */
export function mountKpiStrip(host, ctx) {
  injectStyle();
  const root = document.createElement('div');
  root.className = 'dkpi';
  host.innerHTML = '';
  host.appendChild(root);

  let cur = ctx || null;

  // One delegated listener for the whole strip (nothing to leak per update).
  const onClick = (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.dkpi-run') : null;
    if (!btn) return;
    if (cur && typeof cur.onRun === 'function') cur.onRun();
  };
  root.addEventListener('click', onClick);

  function cardHtml(def, k, refs) {
    const label = esc(def.label(k));
    const icon = `<span class="dkpi-icon t-${def.tone}">${svg(def.icon)}</span>`;
    const value = k ? def.read(k) : null;

    if (value == null) {
      return `<div class="dkpi-card is-empty">
        <div class="dkpi-top">${icon}<span class="dkpi-label">${label}</span></div>
        <div class="dkpi-val"><span class="dkpi-n">—</span></div>
        <div class="dkpi-foot"></div>
      </div>`;
    }

    // 95%CI disclosure — honesty about uncertainty is a hard requirement.
    let ciHtml = '';
    const ci = ciFor(def, cur);
    if (ci) {
      const hw = num(ci.half_width);
      const n = num(ci.n);
      const parts = [];
      if (hw != null && hw > 0) parts.push(`±${fmt(hw, hw < 10 ? 1 : 0)}`);
      if (n === 1) parts.push('n=1');
      if (parts.length) {
        // Only claim a confidence level the payload actually carries.
        const conf = num(ci.confidence);
        const lvl = conf ? `${Math.round(conf * 100)}%CI` : '信頼区間';
        const tip = hw != null && hw > 0
          ? `${parts[0]}（${lvl}, n=${n == null ? '—' : fmt(n)}）`
          : '1回のみの実行 — 信頼区間は取れていません';
        ciHtml = `<span class="dkpi-ci" title="${esc(tip)}">${esc(parts.join(' '))}</span>`;
      }
    }

    // Footer = 解析予測 + delta. Omitted entirely when no prediction exists.
    let foot = '';
    const ref = def.ref(refs);
    if (ref != null) {
      const unit = esc(def.unit(k));
      let dHtml = '';
      const d = def.mode === 'pt' ? value - ref
        : (Math.abs(ref) > 1e-9 ? ((value - ref) / Math.abs(ref)) * 100 : null);
      if (d != null) {
        const tone = deltaTone(def, d, value);
        const sign = d > 0 ? '+' : (d < 0 ? '−' : '±');
        const txt = `${sign}${fmt(Math.abs(d), 1)}${def.mode === 'pt' ? 'pt' : '%'}`;
        dHtml = `<span class="dkpi-d ${tone}">${esc(txt)}</span>`;
      }
      foot = `<span class="dkpi-ref">解析予測 ${esc(fmt(ref, def.dec))}${unit}</span>${dHtml}`;
    }

    return `<div class="dkpi-card">
      <div class="dkpi-top">${icon}<span class="dkpi-label">${label}</span></div>
      <div class="dkpi-val"><span class="dkpi-n">${esc(fmt(value, def.dec))}</span>
        <span class="dkpi-u">${esc(def.unit(k))}</span>${ciHtml}</div>
      <div class="dkpi-foot">${foot}</div>
    </div>`;
  }

  function render() {
    let k = null;
    let refs = {};
    try {
      k = cur && cur.hasRun && cur.kpis && typeof cur.kpis === 'object' ? cur.kpis : null;
      refs = buildRefs(cur || {});
    } catch (_) {
      // never-blocks: a malformed payload degrades to the empty strip.
      k = null;
      refs = {};
    }

    // With a run: keep only the cards real data can fill (fewer, never faked).
    const filled = k ? DEFS.filter((d) => d.read(k) != null) : [];
    // ...but a run whose KPI dict fills NOTHING still has to show the frames:
    // an empty grid is exactly the blank box never-blocks forbids.
    const defs = filled.length ? filled : DEFS;
    const cards = defs.map((d) => cardHtml(d, filled.length ? k : null, refs)).join('');

    let note = '';
    if (!k) {
      note = `<div class="dkpi-note"><span>シミュレーション未実行</span>
        <button type="button" class="dkpi-run">シミュレーションを実行</button></div>`;
    } else if (!filled.length) {
      note = `<div class="dkpi-note"><span>KPIを読み取れませんでした</span>
        <button type="button" class="dkpi-run">シミュレーションを実行</button></div>`;
    }
    root.innerHTML = `<div class="dkpi-grid">${cards}</div>${note}`;
  }

  render();

  return {
    update(next) {
      cur = next || cur;
      try { render(); } catch (_) { /* never-blocks */ }
    },
    dispose() {
      root.removeEventListener('click', onClick);
      host.innerHTML = '';
    },
  };
}
