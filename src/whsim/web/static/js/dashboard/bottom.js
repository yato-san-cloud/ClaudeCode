// dashboard/bottom.js — ダッシュボード最下段の3カード.
//
//   (a) シミュレーションイベント — a dense 時刻/イベント/詳細/ステータス table.
//       replay carries no raw event log, so the feed is synthesised from what we
//       DO have: analysis.insights[] (severity → status colour) + milestones
//       distilled from kpis (ボトルネック検出 / 完了率) + replay.series samples
//       (処理進捗), newest first.
//   (b) 作業量推移 — replay.series as three lines 完了/処理中/稼働作業者 (ECharts),
//       with a thin "now" marker that follows the replay clock (no setOption per
//       frame — just translateX on an overlay div).
//   (c) レイアウトビュー — an always-on thumbnail drawn by hand from replay
//       (<canvas>): zone fills / walls / rack dots / stations, with ＋ − ⛶.
//
// The skeleton is built ONCE; update() only re-fills the table, calls
// setOption(opt, true) on the kept ECharts instance and repaints the canvas.
// Colours come from CSS tokens (theme flip is observed and redraws).
//
// never-blocks: no run / partial payloads / missing fields render three quiet
// card frames with 「シミュレーション未実行」 — never a throw, never a blank box.
// EN comments / JA UI.
import { esc } from '../util.js';
import * as echarts from 'echarts';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// Finite-number gate: anything else (null / undefined / NaN / string) → null,
// which every renderer below reads as "no data" rather than a zero.
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

const fmt = (n, d = 0) => (n == null ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

const reduceMotion = () => {
  try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (_) { return false; }
};

function tok(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (_) { return fb; }
}

// Utilisation arrives as a 0–1 fraction from the engine; tolerate a payload
// that already carries percent (never invent, only normalise).
function pct(v) {
  const n = num(v);
  if (n == null || n < 0) return null;
  return n <= 1.0001 ? n * 100 : Math.min(n, 100);
}

// Replay clock (seconds) → HH:MM:SS. Non-timed rows render 「—」 instead.
function hhmmss(t) {
  const s = num(t);
  if (s == null || s < 0) return '—';
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(sec)}`;
}

// insight.fact carries inline markup (<span class="num">99</span>); strip the
// tags so the cell stays one quiet line, then esc() it like any other datum.
const plain = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Feed severity → status word + colour class. The severity vocabulary is the
// one analysis.insights[] uses; the synthetic rows reuse it.
const STATUS = {
  danger: { text: '要注意', cls: 'bad' },
  warn: { text: '注意', cls: 'warn' },
  ok: { text: '完了', cls: 'ok' },
  info: { text: '進行中', cls: 'info' },
  note: { text: '参考', cls: 'info' },
  muted: { text: '待機', cls: 'muted' },
};
const ALERT = { danger: 1, warn: 1 };   // what the 要注意 filter keeps

// Total rows kept in the feed (the table itself scrolls).
const FEED_CAP = 10;

// Only let a data-supplied colour through if it is a plain hex literal.
const HEX = /^#[0-9a-fA-F]{3,8}$/;

function injectStyle() {
  if (document.getElementById('dbot-style')) return;
  const s = document.createElement('style');
  s.id = 'dbot-style';
  s.textContent = `
  .dbot-card{display:flex;flex-direction:column;gap:var(--sp-2,8px);min-width:0;
    padding:var(--sp-3,12px);background:var(--bg-app);border:1px solid var(--line-hair);
    border-radius:var(--r-lg,12px);box-shadow:var(--sh-xs)}
  .dbot-hd{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0}
  .dbot-ttl{font-size:13px;font-weight:var(--fw-semibold,600);color:var(--ink-secondary);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dbot-hd-r{margin-left:auto;flex:0 0 auto;display:flex;align-items:center;gap:6px}
  .dbot-sel{font:inherit;font-size:var(--fs-micro,11px);color:var(--ink-tertiary);
    background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:var(--r-sm,6px);
    padding:2px 6px;cursor:pointer}
  .dbot-sel:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:1px}
  .dbot-sel:disabled{opacity:.5;cursor:default}

  /* (a) event table */
  .dbot-scroll{position:relative;min-width:0;max-height:150px;overflow-y:auto;overflow-x:hidden;
    border:1px solid var(--line-soft);border-radius:var(--r-sm,6px)}
  .dbot-tbl{width:100%;border-collapse:collapse;table-layout:fixed;font-size:var(--fs-micro,11px)}
  .dbot-tbl th,.dbot-tbl td{padding:4px 7px;text-align:left;vertical-align:top;
    border-bottom:1px solid var(--line-soft);overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap}
  .dbot-tbl thead th{position:sticky;top:0;z-index:1;background:var(--bg-panel);
    color:var(--ink-tertiary);font-weight:var(--fw-medium,500);
    border-bottom:1px solid var(--line-hair);letter-spacing:var(--ls-micro,.04em)}
  .dbot-tbl tbody tr:last-child td{border-bottom:none}
  .dbot-tbl tbody tr:hover{background:var(--bg-hover)}
  /* c-t fits HH:MM:SS in the mono face, c-s fits the 「ステータス」 header —
     both were clipping to 「00:15:…」/「ステ…」 at the narrower widths. */
  .dbot-tbl .c-t{width:78px;font-family:var(--font-mono);font-variant-numeric:tabular-nums;
    color:var(--ink-tertiary)}
  .dbot-tbl .c-e{width:34%;color:var(--ink-primary)}
  .dbot-tbl .c-d{color:var(--ink-secondary)}
  .dbot-tbl .c-s{width:84px;text-align:right;font-weight:var(--fw-semibold,600)}
  .dbot-tbl .c-s.ok{color:var(--ok)}
  .dbot-tbl .c-s.warn{color:var(--warn)}
  .dbot-tbl .c-s.bad{color:var(--bad)}
  .dbot-tbl .c-s.info{color:var(--accent-ink,var(--accent))}
  .dbot-tbl .c-s.muted{color:var(--ink-faint)}
  .dbot-none{padding:10px;color:var(--ink-faint);font-size:var(--fs-micro,11px);text-align:center}
  .dbot-link{margin-top:auto;align-self:flex-start;font:inherit;font-size:var(--fs-micro,11px);
    color:var(--accent-ink,var(--accent));background:none;border:none;padding:2px 0;cursor:pointer}
  .dbot-link:hover{text-decoration:underline}
  .dbot-link:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:2px;
    border-radius:var(--r-xs,4px)}

  /* (b) throughput chart + now-marker overlay */
  .dbot-body{position:relative;min-width:0}
  .dbot-chart{width:100%;height:150px;min-width:0}
  .dbot-now{position:absolute;top:24px;bottom:22px;left:0;width:1px;
    background:var(--accent,#16C0DE);opacity:.55;pointer-events:none;display:none}
  .dbot-now.on{display:block}

  /* (c) map thumbnail */
  .dbot-map{position:relative;min-width:0;height:150px;border-radius:var(--r-sm,6px);
    background:var(--bg-sunken);border:1px solid var(--line-soft);overflow:hidden}
  .dbot-map canvas{display:block;width:100%;height:100%}
  .dbot-mbs{position:absolute;right:6px;bottom:6px;display:flex;gap:4px}
  .dbot-mb{width:22px;height:22px;display:grid;place-items:center;font:inherit;
    font-size:var(--fs-micro,11px);line-height:1;color:var(--ink-secondary);cursor:pointer;
    background:var(--bg-overlay,var(--bg-app));border:1px solid var(--line-hair);
    border-radius:var(--r-sm,6px);backdrop-filter:blur(4px)}
  .dbot-mb:hover{background:var(--bg-hover);color:var(--ink-primary)}
  .dbot-mb:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:1px}

  .dbot-empty{display:none;align-items:center;justify-content:center;min-height:110px;
    color:var(--ink-faint);font-size:var(--fs-xs,12px)}
  .dbot-card.is-empty .dbot-scroll,
  .dbot-card.is-empty .dbot-body,
  .dbot-card.is-empty .dbot-map,
  .dbot-card.is-empty .dbot-link{display:none}
  .dbot-card.is-empty .dbot-empty{display:flex}
  `;
  document.head.appendChild(s);
}

// One card frame. `body` sits above the shared empty-state slot.
function cardHtml(id, title, right, body) {
  return `<section class="dbot-card is-empty" data-card="${id}">
    <div class="dbot-hd"><span class="dbot-ttl">${title}</span>
      <span class="dbot-hd-r">${right || ''}</span></div>
    ${body}
    <div class="dbot-empty" aria-hidden="true">シミュレーション未実行</div>
  </section>`;
}

/**
 * 最下段 — イベントテーブル / 作業量推移 / レイアウトビュー.
 * @param {HTMLElement} host
 * @param {object} ctx  read-only dashboard context (see dashboard.js)
 * @returns {{update:Function, dispose:Function, resize:Function, tickClock:Function}}
 */
export function mountBottom(host, ctx) {
  if (!host) return null;
  injectStyle();

  // The host (#dashBottom) is itself the 3-column grid the integrator owns, so
  // the cards are appended as its DIRECT children — a wrapper div would collapse
  // all three into a single grid cell.
  const root = host;
  root.innerHTML =
    cardHtml('events', 'シミュレーションイベント',
      `<select class="dbot-sel" data-sel="sev" aria-label="表示するイベント">
         <option value="all">すべて</option><option value="alert">要注意</option>
       </select>`,
      `<div class="dbot-scroll"><table class="dbot-tbl">
         <thead><tr><th class="c-t">時刻</th><th class="c-e">イベント</th>
           <th class="c-d">詳細</th><th class="c-s">ステータス</th></tr></thead>
         <tbody data-rows="events"></tbody>
       </table></div>
       <button type="button" class="dbot-link" data-act="analysis">すべての指摘を見る →</button>`)
    + cardHtml('flow', '作業量推移', '',
      `<div class="dbot-body"><div class="dbot-chart" data-chart="flow"></div>
         <div class="dbot-now" data-now="flow" aria-hidden="true"></div></div>`)
    + cardHtml('map', 'レイアウトビュー', '',
      `<div class="dbot-map"><canvas data-canvas="map"></canvas>
         <div class="dbot-mbs">
           <button type="button" class="dbot-mb" data-zoom="in" aria-label="拡大" title="拡大">＋</button>
           <button type="button" class="dbot-mb" data-zoom="out" aria-label="縮小" title="縮小">－</button>
           <button type="button" class="dbot-mb" data-act="view2d" aria-label="全画面で開く" title="全画面で開く">⛶</button>
         </div></div>`);

  const q = (sel) => root.querySelector(sel);
  const cards = {
    events: q('[data-card=events]'), flow: q('[data-card=flow]'), map: q('[data-card=map]'),
  };
  const R = {
    rows: q('[data-rows=events]'),
    sel: q('[data-sel=sev]'),
    chartNode: q('[data-chart=flow]'),
    now: q('[data-now=flow]'),
    canvas: q('[data-canvas=map]'),
  };

  let cur = ctx || null;
  let sev = 'all';            // すべて / 要注意
  let chart = null;
  let pending = false;        // the chart wanted to draw while its host had 0 width
  let zoom = 1;               // thumbnail scale factor (about the bounds centre)
  let markerGeom = null;      // {left,right,w,min,max} for the cheap now-marker maths
  let lastX = -1;

  const setEmpty = (key, empty) => {
    if (cards[key]) cards[key].classList.toggle('is-empty', !!empty);
  };

  function killChart() {
    if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; }
  }
  // Lazy init: an ECharts instance created on a zero-width node stays zero-wide,
  // so defer until the row is actually laid out (the ResizeObserver retries).
  function ensureChart() {
    const node = R.chartNode;
    if (!node) return null;
    if (!node.clientWidth || !node.clientHeight) { pending = true; return null; }
    if (!chart) {
      try { chart = echarts.init(node, null, { renderer: 'canvas' }); } catch (_) { return null; }
    }
    return chart;
  }

  const series = () => {
    const rep = cur && cur.replay;
    const raw = rep && Array.isArray(rep.series) ? rep.series : [];
    return raw.filter((p) => p && num(p.t) != null);
  };

  // -------------------------------------------------------------------------
  // (a) シミュレーションイベント — derive a readable feed from what replay HAS
  // -------------------------------------------------------------------------

  // Milestones distilled from the wide kpis dict. Untimed (時刻 = 「—」).
  function milestones(k) {
    const out = [];
    if (!k) return out;
    // Status words follow the ENGINE's own cuts (kpis.py): a replication copes
    // when completion_rate >= 0.98 and the bottleneck sits under 0.95, and
    // can_handle_demand is the aggregate verdict. Nothing invented here.
    const coping = typeof k.can_handle_demand === 'boolean' ? k.can_handle_demand : null;
    const bp = pct(k.bottleneck_utilization);
    const bl = typeof k.bottleneck_jp === 'string' && k.bottleneck_jp
      ? k.bottleneck_jp
      : (typeof k.bottleneck === 'string' && k.bottleneck ? k.bottleneck : null);
    if (bl) {
      const s = coping === false ? 'danger' : (bp != null && bp >= 95 ? 'warn' : 'ok');
      out.push({
        t: null, sev: s, event: 'ボトルネック検出',
        detail: bp == null ? bl : `${bl}（稼働率 ${fmt(bp, 0)}%）`,
      });
    }
    const done = num(k.orders_completed);
    const arrived = num(k.orders_arrived);
    const rate = pct(k.completion_rate);
    if (done != null || rate != null) {
      const r = rate != null ? rate
        : (done != null && arrived != null && arrived > 0 ? (done / arrived) * 100 : null);
      const s = r == null || r >= 98 ? 'ok' : (coping === false ? 'danger' : 'warn');
      // Say only what is actually present — a missing count must not surface as
      // 「完了 —件」.
      const bits = [];
      if (done != null) bits.push(`完了 ${fmt(done)}件`);
      if (arrived != null && arrived > 0) bits.push(`到着 ${fmt(arrived)}件`);
      let detail = bits.join(' / ');
      if (r != null) detail = detail ? `${detail}（${fmt(r, 0)}%）` : `完了率 ${fmt(r, 0)}%`;
      out.push({ t: null, sev: s, event: '完了率', detail: detail || '—' });
    }
    return out;
  }

  // analysis.insights[] — the app's own findings, severity kept verbatim.
  function insightRows(a) {
    const list = a && Array.isArray(a.insights) ? a.insights : [];
    return list.map((it) => {
      // The endpoint's vocabulary is danger / warn / ok / info (see
      // web/routes/_common.py). `info` findings are reference notes (AGV 稼働率,
      // 1件あたり処理コスト) — they must NOT read as 完了.
      const raw = it && typeof it.severity === 'string' ? it.severity : 'info';
      const s = (raw === 'danger' || raw === 'warn' || raw === 'ok') ? raw : 'note';
      const detail = plain(it && it.fact) || plain(it && it.action) || plain(it && it.metric);
      return {
        t: null, sev: s,
        event: plain(it && it.title) || '指摘',
        detail: detail || '—',
      };
    });
  }

  // replay.series → 「処理進捗」 rows, newest first.
  function progressRows(pts) {
    const out = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      const done = num(p.done) || 0;
      const wip = num(p.wip) || 0;
      const active = num(p.active) || 0;
      out.push({
        t: p.t, sev: active > 0 ? 'info' : 'muted', event: '処理進捗',
        detail: `完了 ${fmt(done)}件 ・ 仕掛 ${fmt(wip)}件 ・ 稼働 ${fmt(active)}名`,
      });
    }
    return out;
  }

  function buildFeed() {
    const k = cur && cur.hasRun && cur.kpis && typeof cur.kpis === 'object' ? cur.kpis : null;
    const a = cur && cur.analysis && typeof cur.analysis === 'object' ? cur.analysis : null;
    // Signal first (findings + milestones), then fill the rest of the cap with
    // the most recent samples — "the last 10 things that happened".
    const head = insightRows(a).concat(milestones(k));
    const tail = progressRows(series());
    return head.concat(tail).slice(0, FEED_CAP);
  }

  function renderEvents() {
    const feed = buildFeed();
    if (R.sel) { R.sel.value = sev; R.sel.disabled = !feed.length; }
    if (!feed.length) { setEmpty('events', true); if (R.rows) R.rows.innerHTML = ''; return; }
    setEmpty('events', false);
    if (!R.rows) return;
    const shown = sev === 'alert' ? feed.filter((r) => ALERT[r.sev]) : feed;
    if (!shown.length) {
      R.rows.innerHTML = '<tr><td colspan="4" class="dbot-none">該当するイベントはありません</td></tr>';
      return;
    }
    R.rows.innerHTML = shown.map((r) => {
      const st = STATUS[r.sev] || STATUS.info;
      return `<tr>
        <td class="c-t">${esc(hhmmss(r.t))}</td>
        <td class="c-e" title="${esc(r.event)}">${esc(r.event)}</td>
        <td class="c-d" title="${esc(r.detail)}">${esc(r.detail)}</td>
        <td class="c-s ${st.cls}">${esc(st.text)}</td>
      </tr>`;
    }).join('');
  }

  // -------------------------------------------------------------------------
  // (b) 作業量推移 — 完了 / 処理中 / 稼働作業者
  // -------------------------------------------------------------------------
  function renderFlow() {
    const pts = series();
    if (pts.length < 2) {
      setEmpty('flow', true);
      killChart();
      markerGeom = null;
      if (R.now) R.now.classList.remove('on');
      return;
    }
    setEmpty('flow', false);

    const xs = pts.map((p) => p.t / 3600);
    const xmin = Math.min.apply(null, xs);
    const xmax = Math.max.apply(null, xs);
    const done = pts.map((p, i) => [xs[i], num(p.done) || 0]);
    const wip = pts.map((p, i) => [xs[i], num(p.wip) || 0]);
    const active = pts.map((p, i) => [xs[i], num(p.active) || 0]);

    const accent = tok('--accent', '#16C0DE');
    const warn = tok('--warn', '#B7791F');
    const ok = tok('--ok', '#2E7D55');
    const hair = tok('--line-hair', 'rgba(0,0,0,.09)');
    const ter = tok('--ink-tertiary', 'rgba(0,0,0,.45)');
    // Tick unit follows the real span: replay.series covers the replay WINDOW
    // (~900s), so hours would print duplicate ticks (0h 0.1h 0.1h 0.2h). Same
    // rule as the 処理推移 card in the rail, so the two read alike.
    const hour = (xmax - xmin) < 1.5
      ? (v) => `${Math.round(v * 60)}分`
      : (v) => `${Math.round(v * 10) / 10}h`;

    // Fixed pixel grid (containLabel:false) so tickClock() can map the replay
    // clock to an x pixel with arithmetic instead of an ECharts call per frame.
    const GRID = { left: 40, right: 12, top: 24, bottom: 22 };

    const c = ensureChart();
    if (!c) { markerGeom = null; return; }
    c.setOption({
      animation: !reduceMotion(),
      grid: Object.assign({ containLabel: false }, GRID),
      legend: {
        top: 0, right: 0, itemWidth: 9, itemHeight: 9, itemGap: 10, icon: 'roundRect',
        textStyle: { color: ter, fontSize: 10 },
        data: ['完了', '処理中', '稼働作業者'],
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: tok('--bg-app', '#fff'),
        borderColor: hair,
        borderWidth: 1,
        padding: [6, 8],
        textStyle: { color: tok('--ink-primary', '#37352F'), fontSize: 11 },
        extraCssText: 'box-shadow:none',
        formatter: (ps) => {
          if (!Array.isArray(ps) || !ps.length) return '';
          const head = esc(hour(ps[0].value[0]));
          const rows = ps.map((p) => `${esc(p.seriesName)} ${esc(fmt(p.value[1]))}`).join('<br>');
          return `${head}<br>${rows}`;
        },
      },
      xAxis: {
        type: 'value', min: xmin, max: xmax,
        axisLine: { lineStyle: { color: hair } },
        axisTick: { show: false },
        axisLabel: { color: ter, fontSize: 10, hideOverlap: true, formatter: hour },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: ter, fontSize: 10, formatter: (v) => fmt(v) },
        splitLine: { lineStyle: { color: hair, width: 1 } },
      },
      series: [
        { name: '完了', type: 'line', showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1.8, color: accent }, itemStyle: { color: accent }, data: done },
        { name: '処理中', type: 'line', showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1.4, color: warn }, itemStyle: { color: warn }, data: wip },
        { name: '稼働作業者', type: 'line', showSymbol: false, smooth: 0.25,
          lineStyle: { width: 1.2, color: ok, type: 'dashed' }, itemStyle: { color: ok }, data: active },
      ],
    }, true);

    markerGeom = {
      left: GRID.left, right: GRID.right, min: xmin, max: xmax,
      w: R.chartNode ? R.chartNode.clientWidth : 0,
    };
    lastX = -1;
    // Guarded: ctx.getTime() belongs to the host, and a throw here must not be
    // read as "the chart failed" (the caller's catch would kill the instance).
    try { tickClock(); } catch (_) { /* never-blocks */ }
  }

  // -------------------------------------------------------------------------
  // (c) レイアウトビュー — hand-drawn thumbnail, always on
  // -------------------------------------------------------------------------
  function drawMap() {
    const cv = R.canvas;
    if (!cv) return false;
    // Data first: with nothing to draw the answer is the empty state, whatever
    // the box measures. (Measuring first would mark the card "not empty" while
    // the panel is still hidden — i.e. a blank box with no run.)
    const rep = cur && cur.replay;
    const b = rep && rep.meta ? rep.meta.bounds : null;
    const bw = num(b && b.width);
    const bd = num(b && b.depth);
    if (!bw || !bd || bw <= 0 || bd <= 0) return false;

    const wrap = cv.parentElement;
    const cw = wrap ? wrap.clientWidth : 0;
    const ch = wrap ? wrap.clientHeight : 0;
    if (!cw || !ch) { pending = true; return true; }

    // devicePixelRatio backing store so hairlines stay crisp on retina.
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const pw = Math.round(cw * dpr);
    const ph = Math.round(ch * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    cv.style.width = `${cw}px`;
    cv.style.height = `${ch}px`;

    const g = cv.getContext('2d');
    if (!g) return false;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);

    // Fit bounds preserving aspect, then apply the thumbnail zoom about the
    // centre (the origin is derived from the centre, so it zooms in place).
    const s = Math.min(cw / bw, ch / bd) * 0.9 * zoom;
    const ox = cw / 2 - (bw / 2) * s;
    const oy = ch / 2 - (bd / 2) * s;
    const X = (x) => ox + x * s;
    const Y = (y) => oy + y * s;

    // envelope
    g.strokeStyle = tok('--line-strong', 'rgba(55,53,47,0.16)');
    g.lineWidth = 1;
    g.strokeRect(X(0) + 0.5, Y(0) + 0.5, bw * s, bd * s);

    // zones — their own colour, low alpha
    const zones = Array.isArray(rep.zones) ? rep.zones : [];
    const fallback = tok('--ink-faint', 'rgba(55,53,47,0.32)');
    zones.forEach((z) => {
      if (!z) return;
      const zx = num(z.x); const zy = num(z.y); const zw = num(z.w); const zh = num(z.h);
      if (zx == null || zy == null || !zw || !zh) return;
      const col = typeof z.color === 'string' && HEX.test(z.color) ? z.color : fallback;
      g.globalAlpha = 0.3;
      g.fillStyle = col;
      g.fillRect(X(zx), Y(zy), zw * s, zh * s);
      g.globalAlpha = 0.55;
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.strokeRect(X(zx) + 0.5, Y(zy) + 0.5, zw * s, zh * s);
      g.globalAlpha = 1;
    });

    // walls — polylines of [x,y] points
    const walls = Array.isArray(rep.walls) ? rep.walls : [];
    g.strokeStyle = tok('--canvas-wall-rep', '#6b7785');
    g.lineWidth = Math.max(1, Math.min(3, s * 0.12));
    g.lineJoin = 'round';
    walls.forEach((w) => {
      const pts = w && Array.isArray(w.points) ? w.points : [];
      if (pts.length < 2) return;
      g.beginPath();
      pts.forEach((p, i) => {
        if (!Array.isArray(p) || num(p[0]) == null || num(p[1]) == null) return;
        if (i === 0) g.moveTo(X(p[0]), Y(p[1])); else g.lineTo(X(p[0]), Y(p[1]));
      });
      g.stroke();
    });

    // racks — a dot per rack cell
    const racks = Array.isArray(rep.racks) ? rep.racks : [];
    const d = Math.max(1, Math.min(4, s * 0.55));
    g.fillStyle = tok('--canvas-rack', 'rgba(60,72,90,0.5)');
    racks.forEach((r) => {
      const rx = num(r && r.x); const ry = num(r && r.y);
      if (rx == null || ry == null) return;
      g.fillRect(X(rx) - d / 2, Y(ry) - d / 2, d, d);
    });

    // stations — a small accent marker
    const stations = Array.isArray(rep.stations) ? rep.stations : [];
    const sd = Math.max(3, Math.min(7, s * 0.9));
    g.fillStyle = tok('--accent', '#16C0DE');
    g.strokeStyle = tok('--canvas-marker-stroke', '#ffffff');
    g.lineWidth = 1;
    stations.forEach((st) => {
      const sx = num(st && st.x); const sy = num(st && st.y);
      if (sx == null || sy == null) return;
      g.fillRect(X(sx) - sd / 2, Y(sy) - sd / 2, sd, sd);
      g.strokeRect(X(sx) - sd / 2 + 0.5, Y(sy) - sd / 2 + 0.5, sd, sd);
    });
    return true;
  }

  function renderMap() {
    let ok = false;
    try { ok = drawMap(); } catch (_) { ok = false; }
    setEmpty('map', !ok);
  }

  function render() {
    pending = false;
    // Each card guards itself so one bad block cannot blank the whole row.
    try { renderEvents(); } catch (_) { setEmpty('events', true); }
    try { renderFlow(); } catch (_) { setEmpty('flow', true); killChart(); markerGeom = null; }
    try { renderMap(); } catch (_) { setEmpty('map', true); }
  }

  // -------------------------------------------------------------------------
  // interaction
  // -------------------------------------------------------------------------
  const onChange = (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-sel=sev]') : null;
    if (!el) return;
    sev = el.value === 'alert' ? 'alert' : 'all';
    try { renderEvents(); } catch (_) { setEmpty('events', true); }
  };

  const onClick = (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    const z = t.closest('[data-zoom]');
    if (z) {
      zoom = z.dataset.zoom === 'in'
        ? Math.min(6, zoom * 1.35)
        : Math.max(0.5, zoom / 1.35);
      renderMap();
      return;
    }
    const a = t.closest('[data-act]');
    if (!a) return;
    const go = cur && typeof cur.onSelectView === 'function' ? cur.onSelectView : null;
    if (!go) return;
    if (a.dataset.act === 'analysis') go('analysis');
    else if (a.dataset.act === 'view2d') go('view2d');
  };

  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);

  // Layout changes: retry a deferred init, otherwise re-measure chart + canvas.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (pending) { try { render(); } catch (_) { /* never-blocks */ } return; }
      if (chart) { try { chart.resize(); } catch (_) { /* noop */ } }
      if (markerGeom && R.chartNode) { markerGeom.w = R.chartNode.clientWidth; lastX = -1; }
      try { renderMap(); } catch (_) { /* never-blocks */ }
    });
    try { ro.observe(root); } catch (_) { ro = null; }
  }

  // Theme flip: token colours were baked into the option + the canvas, so redraw.
  let mo = null;
  if (typeof MutationObserver !== 'undefined') {
    mo = new MutationObserver(() => { try { render(); } catch (_) { /* never-blocks */ } });
    try {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (_) { mo = null; }
  }

  // The per-frame "now" marker. Pure arithmetic against the fixed pixel grid —
  // no setOption, no ECharts coordinate call, and a sub-pixel early-out.
  function tickClock() {
    const el = R.now;
    if (!el) return;
    // Hiding also drops the sub-pixel memo: otherwise coming back in range at
    // (nearly) the same x would early-out and never re-show the marker.
    const hide = () => { el.classList.remove('on'); lastX = -1; };
    const g = markerGeom;
    if (!g || !g.w || g.max <= g.min) { hide(); return; }
    const t = num(cur && typeof cur.getTime === 'function' ? cur.getTime() : null);
    if (t == null) { hide(); return; }
    const h = t / 3600;
    if (h < g.min || h > g.max) { hide(); return; }
    const inner = g.w - g.left - g.right;
    if (inner <= 0) { hide(); return; }
    const x = g.left + ((h - g.min) / (g.max - g.min)) * inner;
    if (lastX >= 0 && Math.abs(x - lastX) < 0.5) return;
    lastX = x;
    el.style.transform = `translateX(${x.toFixed(1)}px)`;
    el.classList.add('on');
  }

  render();

  return {
    update(next) {
      cur = next || cur;
      try { render(); } catch (_) { /* never-blocks */ }
    },
    resize() {
      if (pending) { try { render(); } catch (_) { /* never-blocks */ } return; }
      if (chart) { try { chart.resize(); } catch (_) { /* noop */ } }
      if (markerGeom && R.chartNode) { markerGeom.w = R.chartNode.clientWidth; lastX = -1; }
      try { renderMap(); } catch (_) { /* never-blocks */ }
    },
    tickClock() {
      try { tickClock(); } catch (_) { /* never-blocks */ }
    },
    dispose() {
      root.removeEventListener('change', onChange);
      root.removeEventListener('click', onClick);
      if (ro) { try { ro.disconnect(); } catch (_) { /* noop */ } ro = null; }
      if (mo) { try { mo.disconnect(); } catch (_) { /* noop */ } mo = null; }
      killChart();
      markerGeom = null;
      host.innerHTML = '';
    },
  };
}
