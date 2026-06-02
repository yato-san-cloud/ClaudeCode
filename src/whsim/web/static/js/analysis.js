// analysis.js — the "分析" (analysis) dashboard view for whsim.
//
// Consolidates an analysis-tool-style summary INTO whsim: it fetches the
// reshaped KPI payload from `GET /api/projects/{name}/analysis` and renders a
// Notion-style summary screen — "自動で見つけた注目ポイント" (指摘→提案 callouts)
// → 主要KPI hero grid → grouped standard KPIs → two lightweight self-drawn
// inline-SVG charts (per-stage congestion bar + cost / volume bar).
//
// Public API:
//   export async function mountAnalysis(targetEl, projectName)
//     — fetch the payload and render it into `targetEl`. Re-renders on the
//       document `themechange` event so SVG colours follow light/dark theme.
//
// Markup uses EXACTLY the CSS classes the shell owner defines in styles.css:
//   .an-section / .an-section-title
//   .callout (.danger|.warn|.info|.ok) > .c-icon / .c-main (.c-title/.c-fact/
//     .c-action) / .c-metric
//   .kpi-hero > .kpi-hero-cell (.kpi-label/.kpi-value/.kpi-unit/.delta.up|.down)
//   .kpi-group > .kpi-group-label + .kpi-grid > .kpi-card (.kpi-label/.kpi-value)
//   .chart-card > .chart-title/.chart-sub + inline <svg>
// Chart colours are read from CSS variables via getComputedStyle so they track
// the active theme. This module ships NO CSS of its own.
//
// Defensive throughout: a missing payload, empty insights, or a thin analytic
// estimate (few KPIs) must never throw; absent sections are simply omitted.

const SVGNS = 'http://www.w3.org/2000/svg';

// ---- small helpers ----------------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Resolve a CSS custom property off :root (theme-aware). Falls back if unset.
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
    return v || fallback;
  } catch (_e) {
    return fallback;
  }
}

// Thousands separators for an integer-ish number.
function group(n) {
  if (!isNum(n)) return String(n);
  const neg = n < 0 ? '-' : '';
  const [intPart, frac] = Math.abs(n).toString().split('.');
  const g = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg + g + (frac ? '.' + frac : '');
}

function el(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

// ---- icons (24x24 outline, stroke=currentColor — colour via .c-icon) --------

const ICONS = {
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  trend: '<path d="M3 17l6-6 4 4 7-8"/><path d="M21 7v5h-5"/>',
  bars: '<rect x="3" y="11" width="4" height="9" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

function iconSvg(name) {
  const inner = ICONS[name] || ICONS.info;
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round">' + inner + '</svg>';
}

// ---- callouts ("指摘 → 提案") -----------------------------------------------

const SEVERITIES = ['danger', 'warn', 'info', 'ok'];

function buildCallout(ins) {
  const sev = SEVERITIES.includes(ins.severity) ? ins.severity : 'info';
  const card = el('div', { class: 'callout ' + sev });

  const ic = el('div', { class: 'c-icon' });
  ic.innerHTML = iconSvg(ins.icon);
  card.appendChild(ic);

  const main = el('div', { class: 'c-main' });
  main.appendChild(el('div', { class: 'c-title' }, ins.title || ''));
  // .c-fact may carry inline <span class="num">…</span> markup from the API.
  const fact = el('div', { class: 'c-fact' });
  fact.innerHTML = ins.fact || '';
  main.appendChild(fact);
  // info callouts intentionally omit the recommended-action chip.
  if (ins.action && sev !== 'info') {
    const action = el('a', { class: 'c-action' });
    action.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" '
      + 'fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    action.appendChild(el('span', null, ins.action));
    main.appendChild(action);
  }
  card.appendChild(main);

  if (ins.metric != null && ins.metric !== '') {
    card.appendChild(el('div', { class: 'c-metric' }, String(ins.metric)));
  }
  return card;
}

function buildInsightsSection(insights) {
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '自動で見つけた注目ポイント'));
  if (!insights.length) {
    sec.appendChild(el('p', { class: 'c-fact' }, '注目すべき点は見つかりませんでした。'));
    return sec;
  }
  const list = el('div', { class: 'callouts' });
  insights.forEach((ins) => { if (ins) list.appendChild(buildCallout(ins)); });
  sec.appendChild(list);
  return sec;
}

// ---- KPIs -------------------------------------------------------------------

function valueSpan(value, unit) {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(el('span', { class: 'num' }, isNum(value) ? group(value) : String(value)));
  if (unit) wrap.appendChild(el('span', { class: 'kpi-unit' }, unit));
  return wrap;
}

function buildHero(heroItems) {
  const grid = el('div', { class: 'kpi-hero' });
  heroItems.forEach((h) => {
    if (!h) return;
    const cell = el('div', { class: 'kpi-hero-cell' });
    cell.appendChild(el('div', { class: 'kpi-label' }, h.label || ''));
    const val = el('div', { class: 'kpi-value' });
    val.appendChild(valueSpan(h.value, h.unit));
    cell.appendChild(val);
    if (h.delta && (h.delta.dir === 'up' || h.delta.dir === 'down')) {
      cell.appendChild(el('div', { class: 'delta ' + h.delta.dir }, h.delta.text || ''));
    }
    grid.appendChild(cell);
  });
  return grid;
}

function buildKpiGroups(groups) {
  const frag = document.createDocumentFragment();
  groups.forEach((grp) => {
    if (!grp || !Array.isArray(grp.items) || !grp.items.length) return;
    const wrap = el('div', { class: 'kpi-group' });
    wrap.appendChild(el('div', { class: 'kpi-group-label' }, grp.label || ''));
    const grid = el('div', { class: 'kpi-grid' });
    grp.items.forEach((it) => {
      if (!it) return;
      const card = el('div', { class: 'kpi-card' });
      card.appendChild(el('div', { class: 'kpi-label' }, it.label || ''));
      const val = el('div', { class: 'kpi-value num' });
      val.appendChild(valueSpan(it.value, it.unit));
      card.appendChild(val);
      grid.appendChild(card);
    });
    if (grid.children.length) {
      wrap.appendChild(grid);
      frag.appendChild(wrap);
    }
  });
  return frag;
}

function buildKpiSection(kpis) {
  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '主要KPI'));
  const hero = Array.isArray(kpis.hero) ? kpis.hero : [];
  if (hero.length) sec.appendChild(buildHero(hero));
  const groups = Array.isArray(kpis.groups) ? kpis.groups : [];
  if (groups.length) sec.appendChild(buildKpiGroups(groups));
  if (!hero.length && !groups.length) {
    sec.appendChild(el('p', { class: 'c-fact' }, 'KPIがまだありません。'));
  }
  return sec;
}

// ---- charts (lightweight self-drawn inline SVG) -----------------------------

// A vertical bar chart. `highlightLabel` paints the matching bar with the
// "warn" colour to mark the bottleneck/peak. Colours are theme-aware.
function barChart(labels, values, opts) {
  const o = opts || {};
  const W = 460, H = 240, m = { t: 16, r: 16, b: 38, l: 48 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const nums = values.map((v) => (isNum(v) ? v : 0));
  const maxY = Math.max(0.0001, Math.max(...nums) * 1.12);
  const n = Math.max(1, nums.length);
  const gap = iw / n, bw = gap * 0.58;
  const yOf = (v) => m.t + ih - ih * (v / maxY);

  const base = o.color || cssVar('--accent', '#2383e2');
  const peak = o.peakColor || cssVar('--warn', '#e2961a');
  const hair = cssVar('--line-hair', 'rgba(55,53,47,0.09)');
  const faint = cssVar('--ink-secondary', 'rgba(55,53,47,0.45)');

  const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%',
    role: 'img' });
  // gridlines + y labels
  for (let t = 0; t <= 4; t++) {
    const v = (maxY * t) / 4, yy = yOf(v);
    s.appendChild(svgEl('line', { x1: m.l, y1: yy, x2: W - m.r, y2: yy,
      stroke: hair, 'stroke-width': '1' }));
    const lab = svgEl('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end',
      'font-size': '11', fill: faint });
    lab.textContent = String(Math.round(v)) + (o.suffix || '');
    s.appendChild(lab);
  }
  nums.forEach((v, i) => {
    const cx = m.l + gap * i + gap / 2;
    const h = ih * (v / maxY);
    const isPeak = o.highlightLabel != null && labels[i] === o.highlightLabel;
    s.appendChild(svgEl('rect', { x: cx - bw / 2, y: yOf(v), width: bw,
      height: Math.max(0, h), rx: '3', fill: isPeak ? peak : base }));
    // value above bar
    const vt = svgEl('text', { x: cx, y: yOf(v) - 5, 'text-anchor': 'middle',
      'font-size': '11', fill: faint });
    vt.textContent = (o.fmt ? o.fmt(v) : String(v)) + (o.suffix || '');
    s.appendChild(vt);
    // x label
    const xt = svgEl('text', { x: cx, y: H - 12, 'text-anchor': 'middle',
      'font-size': '11.5', fill: faint });
    xt.textContent = labels[i];
    s.appendChild(xt);
  });
  return s;
}

function buildChartCard(title, sub, svg) {
  const card = el('div', { class: 'chart-card' });
  card.appendChild(el('div', { class: 'chart-title' }, title));
  if (sub) card.appendChild(el('div', { class: 'chart-sub' }, sub));
  if (svg) card.appendChild(svg);
  return card;
}

function buildChartsSection(charts, currency) {
  const stages = charts.stages || {};
  const cost = charts.cost || null;
  const hasStages = Array.isArray(stages.labels) && stages.labels.length;
  const hasCost = cost && Array.isArray(cost.labels) && cost.labels.length;
  if (!hasStages && !hasCost) return null;

  const sec = el('section', { class: 'an-section' });
  sec.appendChild(el('h2', { class: 'an-section-title' }, '物量の動き / コスト'));
  const grid = el('div', { class: 'chart-grid' });

  if (hasStages) {
    const svg = barChart(stages.labels, stages.values || [], {
      color: cssVar('--accent', '#2383e2'),
      peakColor: cssVar('--bad', '#e5484d'),
      highlightLabel: stages.peak_label,
      suffix: '%',
      fmt: (v) => (Math.round(v * 10) / 10).toString(),
    });
    const sub = stages.peak_label
      ? `工程別の稼働率（％）。${stages.peak_label}が最繁忙工程。`
      : '工程別の稼働率（％）。';
    grid.appendChild(buildChartCard('工程別 稼働率 / 混雑', sub, svg));
  }

  if (hasCost) {
    const cur = cost.currency || currency || '¥';
    const svg = barChart(cost.labels, cost.values || [], {
      color: cssVar('--outbound', '#0d9488'),
      fmt: (v) => cur + group(Math.round(v * 100) / 100),
    });
    grid.appendChild(buildChartCard('1件あたりコスト内訳',
      `${cur} / 件。人件費と設備費の内訳。`, svg));
  }

  sec.appendChild(grid);
  return sec;
}

// ---- mount ------------------------------------------------------------------

function render(targetEl, payload) {
  targetEl.innerHTML = '';
  const root = el('div', { class: 'an-view' });

  const data = payload && typeof payload === 'object' ? payload : {};
  const insights = Array.isArray(data.insights) ? data.insights : [];
  const kpis = data.kpis && typeof data.kpis === 'object' ? data.kpis : {};
  const charts = data.charts && typeof data.charts === 'object' ? data.charts : {};

  // Headline verdict banner (plain-language, from whsim's KPIs).
  if (typeof data.verdict === 'string' && data.verdict) {
    const sev = data.verdict.startsWith('対応可能') ? 'ok' : 'warn';
    const banner = el('div', { class: 'callout ' + sev });
    const ic = el('div', { class: 'c-icon' });
    ic.innerHTML = iconSvg(sev === 'ok' ? 'check' : 'alert');
    banner.appendChild(ic);
    const main = el('div', { class: 'c-main' });
    main.appendChild(el('div', { class: 'c-title' }, data.verdict));
    banner.appendChild(main);
    root.appendChild(banner);
  }

  // "estimate" source: gentle note that this is the instant analytic fallback.
  if (data.source === 'estimate') {
    const note = el('p', { class: 'chart-sub' },
      '※ 詳細シミュレーション未実行のため、簡易推計値を表示しています。');
    root.appendChild(note);
  }

  root.appendChild(buildInsightsSection(insights));
  root.appendChild(buildKpiSection(kpis));
  const chartsSec = buildChartsSection(charts, data.currency);
  if (chartsSec) root.appendChild(chartsSec);

  targetEl.appendChild(root);
}

export async function mountAnalysis(targetEl, projectName) {
  if (!targetEl) return;
  // No project yet: show a friendly prompt instead of fetching /projects/null.
  if (typeof projectName !== 'string' || !projectName.trim()) {
    targetEl._anPayload = null;
    targetEl.innerHTML = '';
    targetEl.appendChild(el('p', { class: 'c-fact' },
      '先にプロジェクトを作成して「実行」すると、ここに分析が表示されます。'));
    return;
  }
  targetEl.innerHTML = '';
  targetEl.appendChild(el('p', { class: 'chart-sub' }, '分析を読み込み中…'));

  let payload = null;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(projectName)}/analysis`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.json();
  } catch (err) {
    targetEl.innerHTML = '';
    targetEl.appendChild(el('p', { class: 'c-fact' },
      '分析データを取得できませんでした。'));
    return;
  }

  // Stash the latest payload on the element so the (one-time) theme handler
  // always re-renders the CURRENT data, not the payload captured on first mount.
  targetEl._anPayload = payload;
  render(targetEl, payload);

  // Re-render on theme change so the self-drawn SVG charts pick up new
  // CSS-variable colours (nice-to-have; harmless if the event never fires).
  if (!targetEl._anThemeHandler) {
    const handler = () => render(targetEl, targetEl._anPayload);
    targetEl._anThemeHandler = handler;
    document.addEventListener('themechange', handler);
  }
}
