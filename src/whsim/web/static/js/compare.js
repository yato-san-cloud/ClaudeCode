// compare.js — scenario-comparison view for a 3PL sales proposal.
//
// Renders "現行 vs 提案" side by side: a header row of scenario names, a
// decision-relevant KPI comparison table with delta coloring (緑=改善 /
// 赤=悪化), and a row of proposal PNG thumbnails. The headline metric is
// 1件あたりコスト. Pure DOM / Canvas-free, no imports — fully self-contained.
//
// Public API:
//   new CompareView(container, data)  — build the UI into `container`
//   view.setData(data)                — re-render with new data
//   view.setLoading()                 — show a skeleton placeholder mid-fetch
//   view.dispose()                    — tear down and detach listeners
//
// Defensive throughout: missing kpis, null cost fields, or a single-scenario
// dataset must never throw; absent numbers render as "—".

// ---- formatting helpers ----------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Yen with thousands separators. `decimals` controls fractional digits.
function yen(v, decimals = 0) {
  if (!isNum(v)) return '—';
  const fixed = v.toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '¥' + sign + grouped + (frac ? '.' + frac : '');
}

function pct(v, decimals = 0) {
  if (!isNum(v)) return '—';
  // completion_rate / utilization may arrive as a fraction (0–1) or already %.
  const scaled = Math.abs(v) <= 1.0 ? v * 100 : v;
  return scaled.toFixed(decimals) + '%';
}

function num(v, decimals = 0) {
  if (!isNum(v)) return '—';
  return v.toFixed(decimals);
}

function minutes(seconds, decimals = 1) {
  if (!isNum(seconds)) return '—';
  return (seconds / 60).toFixed(decimals) + '分';
}

// Headcount: explicit `headcount`, else sum of staffing counts.
function headcountOf(k) {
  if (isNum(k.headcount)) return k.headcount;
  const parts = [k.n_pickers, k.n_packers, k.n_agvs].filter(isNum);
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0);
}

// ---- metric definitions ----------------------------------------------------
// polarity: +1 = higher is better, -1 = lower is better, 0 = neutral (no delta).
// get(k): the comparable numeric value (or null). fmt(k): display string.

const METRICS = [
  {
    label: '判定', polarity: 0, headline: false, verdict: true,
    get: () => null,
    fmt: (k) => (typeof k.verdict === 'string' && k.verdict) ? k.verdict : '—',
  },
  {
    label: 'スループット', unit: '件/時', polarity: 1,
    get: (k) => (isNum(k.throughput_per_hr) ? k.throughput_per_hr : null),
    fmt: (k) => (isNum(k.throughput_per_hr) ? num(k.throughput_per_hr, 1) : '—'),
  },
  {
    label: '出荷完了率', polarity: 1,
    get: (k) => {
      if (isNum(k.completion_rate)) return Math.abs(k.completion_rate) <= 1 ? k.completion_rate * 100 : k.completion_rate;
      if (isNum(k.orders_completed) && isNum(k.orders_arrived) && k.orders_arrived > 0) {
        return (k.orders_completed / k.orders_arrived) * 100;
      }
      return null;
    },
    fmt: (k) => {
      if (isNum(k.completion_rate)) return pct(k.completion_rate, 1);
      if (isNum(k.orders_completed) && isNum(k.orders_arrived) && k.orders_arrived > 0) {
        return pct(k.orders_completed / k.orders_arrived, 1);
      }
      return '—';
    },
  },
  {
    label: 'ボトルネック', polarity: -1,
    get: (k) => (isNum(k.bottleneck_utilization) ? (Math.abs(k.bottleneck_utilization) <= 1 ? k.bottleneck_utilization * 100 : k.bottleneck_utilization) : null),
    fmt: (k) => {
      const name = (typeof k.bottleneck_jp === 'string' && k.bottleneck_jp) ? k.bottleneck_jp : '—';
      if (name === '—' && !isNum(k.bottleneck_utilization)) return '—';
      const u = isNum(k.bottleneck_utilization) ? ' ' + pct(k.bottleneck_utilization, 0) : '';
      return name + u;
    },
  },
  {
    label: '必要人員', unit: '名', polarity: -1,
    get: (k) => headcountOf(k),
    fmt: (k) => {
      const h = headcountOf(k);
      return isNum(h) ? num(h, 0) + '名' : '—';
    },
  },
  {
    label: '1件あたりコスト', polarity: -1, headline: true,
    get: (k) => (isNum(k.total_cost_per_order) ? k.total_cost_per_order : null),
    fmt: (k) => yen(k.total_cost_per_order, 1),
  },
  {
    label: '月間コスト', polarity: -1,
    get: (k) => (isNum(k.monthly_cost) ? k.monthly_cost : null),
    fmt: (k) => yen(k.monthly_cost, 0),
  },
  {
    label: '投資回収', polarity: -1,
    get: (k) => (isNum(k.payback_months) && k.payback_months > 0 ? k.payback_months : null),
    fmt: (k) => (isNum(k.payback_months) && k.payback_months > 0 ? num(k.payback_months, 1) + 'ヶ月' : '—'),
  },
  {
    label: '1件あたり歩行', unit: 'm', polarity: -1,
    get: (k) => (isNum(k.walk_per_order_m) ? k.walk_per_order_m : null),
    fmt: (k) => (isNum(k.walk_per_order_m) ? num(k.walk_per_order_m, 1) + 'm' : '—'),
  },
  {
    label: 'サイクル中央値', polarity: -1,
    get: (k) => (isNum(k.cycle_p50_s) ? k.cycle_p50_s : null),
    fmt: (k) => minutes(k.cycle_p50_s, 1),
  },
];

// ---- delta computation ------------------------------------------------------

// Returns { dir: 'better'|'worse'|null, text: '(−18%)'|'(+¥2.3)'|'' }.
function computeDelta(metric, baseVal, altVal) {
  if (metric.polarity === 0) return { dir: null, text: '' };
  if (!isNum(baseVal) || !isNum(altVal)) return { dir: null, text: '' };
  const rawDiff = altVal - baseVal;
  if (rawDiff === 0) return { dir: null, text: '' };
  const improved = metric.polarity > 0 ? rawDiff > 0 : rawDiff < 0;
  const dir = improved ? 'better' : 'worse';

  let text;
  if (isNum(baseVal) && baseVal !== 0) {
    const pctChange = (rawDiff / Math.abs(baseVal)) * 100;
    const sign = pctChange > 0 ? '+' : '−';
    text = `(${sign}${Math.abs(pctChange).toFixed(0)}%)`;
  } else {
    const sign = rawDiff > 0 ? '+' : '−';
    text = `(${sign}${Math.abs(rawDiff).toFixed(1)})`;
  }
  return { dir, text };
}

// ---- view -------------------------------------------------------------------

export class CompareView {
  constructor(container, data) {
    this.container = container;
    this.root = null;
    this.setData(data);
  }

  // Normalize incoming data into a flat, defensive scenario list.
  _scenarios(data) {
    const d = data && typeof data === 'object' ? data : {};
    const list = [];
    const base = d.baseline && typeof d.baseline === 'object' ? d.baseline : null;
    if (base) {
      list.push({
        name: (typeof base.name === 'string' && base.name.trim()) ? base.name : '現行',
        role: '現行',
        kpis: (base.kpis && typeof base.kpis === 'object') ? base.kpis : {},
        png_url: (typeof base.png_url === 'string' && base.png_url) ? base.png_url : null,
      });
    }
    const alts = Array.isArray(d.alternatives) ? d.alternatives : [];
    alts.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      list.push({
        name: (typeof a.name === 'string' && a.name.trim()) ? a.name : `提案${i + 1}`,
        role: '提案',
        kpis: (a.kpis && typeof a.kpis === 'object') ? a.kpis : {},
        png_url: (typeof a.png_url === 'string' && a.png_url) ? a.png_url : null,
      });
    });
    return list;
  }

  setData(data) {
    const scenarios = this._scenarios(data);

    // Remove any previously rendered root.
    if (this.root && this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }

    const root = document.createElement('div');
    root.className = 'compare-view';
    root.style.fontFamily = 'inherit';
    root.style.color = 'var(--ink, #1f2733)';

    if (!scenarios.length) {
      const empty = document.createElement('p');
      empty.className = 'compare-empty';
      empty.style.color = 'var(--muted, #6b7785)';
      empty.style.padding = '16px';
      empty.textContent = '比較するシナリオがありません。';
      root.appendChild(empty);
      this.container.appendChild(root);
      this.root = root;
      return;
    }

    root.appendChild(this._buildTable(scenarios));
    root.appendChild(this._buildThumbnails(scenarios));

    const note = document.createElement('p');
    note.className = 'compare-note';
    note.style.fontSize = '12px';
    note.style.color = 'var(--muted, #6b7785)';
    note.style.margin = '10px 2px 0';
    note.textContent = '現行を基準に、緑＝改善 / 赤＝悪化。';
    root.appendChild(note);

    this.container.appendChild(root);
    this.root = root;
  }

  // Mid-fetch skeleton — visually distinct from the empty "no scenarios" state
  // so an in-flight comparison never reads as a false dead-end. Uses theme
  // tokens only (no hardcoded colour); stepped opacity reads as "loading".
  setLoading() {
    if (this.root && this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }

    const root = document.createElement('div');
    root.className = 'compare-view compare-loading';
    root.style.fontFamily = 'inherit';
    root.style.color = 'var(--ink-primary)';
    root.setAttribute('aria-busy', 'true');
    root.setAttribute('aria-label', '比較データを読み込み中');

    for (let i = 0; i < 5; i += 1) {
      const bar = document.createElement('div');
      bar.className = 'compare-skel-row';
      bar.style.height = 'var(--sp-5)';
      bar.style.marginBottom = 'var(--sp-2)';
      bar.style.borderRadius = 'var(--r-sm)';
      bar.style.background = 'var(--bg-sunken)';
      bar.style.opacity = i === 0 ? '0.9' : String(0.75 - i * 0.1);
      root.appendChild(bar);
    }

    const note = document.createElement('p');
    note.className = 'compare-note';
    note.style.fontSize = 'var(--fs-xs)';
    note.style.color = 'var(--ink-tertiary)';
    note.style.margin = 'var(--sp-3) 2px 0';
    note.textContent = '比較を読み込んでいます…';
    root.appendChild(note);

    this.container.appendChild(root);
    this.root = root;
  }

  _buildTable(scenarios) {
    const baseKpis = scenarios[0].kpis;

    const table = document.createElement('table');
    table.className = 'compare-table';
    table.setAttribute('aria-label', '現行と提案のKPI比較');

    // Header row: metric column + one column per scenario.
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.scope = 'col';
    corner.textContent = '指標';
    this._styleHeadCell(corner, true);
    hr.appendChild(corner);

    scenarios.forEach((s, i) => {
      const th = document.createElement('th');
      th.scope = 'col';
      this._styleHeadCell(th, false);
      th.className = i === 0 ? 'compare-baseline' : 'compare-alt';

      const role = document.createElement('div');
      role.textContent = s.role;
      role.style.fontSize = '11px';
      role.style.fontWeight = '400';
      role.style.opacity = '.85';
      const name = document.createElement('div');
      name.textContent = s.name;
      name.style.fontWeight = '700';
      th.appendChild(role);
      th.appendChild(name);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    METRICS.forEach((metric) => {
      const tr = document.createElement('tr');
      if (metric.headline) tr.className = 'compare-headline';

      const labelCell = document.createElement('th');
      labelCell.scope = 'row';
      labelCell.textContent = metric.unit ? `${metric.label} (${metric.unit})` : metric.label;
      tr.appendChild(labelCell);

      const baseVal = metric.get(baseKpis);

      scenarios.forEach((s, i) => {
        const td = document.createElement('td');

        const valSpan = document.createElement('span');
        valSpan.className = 'compare-value';
        valSpan.textContent = metric.fmt(s.kpis);
        td.appendChild(valSpan);

        // Verdict cell coloring by can_handle_demand (color + weight from CSS classes).
        if (metric.verdict) {
          td.style.textAlign = 'left';
          const ok = s.kpis.can_handle_demand;
          if (ok === true) {
            td.classList.add('compare-better');
          } else if (ok === false) {
            td.classList.add('compare-worse');
          }
        }

        // Delta coloring/annotation for alternatives vs baseline. Color, pill,
        // and weight all come from the .compare-better/.compare-worse[.compare-delta]
        // CSS classes; a direction glyph (↑/↓) keeps better/worse from being
        // color-only.
        if (i > 0 && !metric.verdict && metric.polarity !== 0) {
          const altVal = metric.get(s.kpis);
          const delta = computeDelta(metric, baseVal, altVal);
          if (delta.dir) {
            const cls = delta.dir === 'better' ? 'compare-better' : 'compare-worse';
            const glyph = delta.dir === 'better' ? '↑' : '↓';
            td.classList.add(cls);
            valSpan.classList.add(cls);
            const dspan = document.createElement('span');
            dspan.className = 'compare-delta ' + cls;
            dspan.textContent = glyph + ' ' + delta.text;
            td.appendChild(document.createTextNode(' '));
            td.appendChild(dspan);
          }
        }

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // Head-cell layout only. Color/background/typography come from the
  // `.compare-table thead th` rules in styles.css (theme-aware cyan look);
  // we intentionally set no hardcoded colors here.
  _styleHeadCell(el, _isCorner) {
    el.style.verticalAlign = 'bottom';
  }

  _buildThumbnails(scenarios) {
    const withImg = scenarios.filter((s) => s.png_url);
    const wrap = document.createElement('div');
    wrap.className = 'compare-thumbs';
    wrap.style.display = 'flex';
    wrap.style.gap = '12px';
    wrap.style.flexWrap = 'wrap';
    wrap.style.marginTop = '14px';

    if (!withImg.length) return wrap; // graceful: nothing to show

    scenarios.forEach((s) => {
      if (!s.png_url) return;
      // Visual chrome (border / radius / background / caption) comes from the
      // `.compare-thumb` rules in styles.css; only flex sizing + a reflow-guard
      // aspect ratio stay inline (layout the stylesheet doesn't own).
      const fig = document.createElement('figure');
      fig.className = 'compare-thumb';
      fig.style.flex = '1 1 240px';
      fig.style.minWidth = '180px';
      // Reserve space before the PNG decodes so image loads don't reflow the row.
      fig.style.aspectRatio = '4 / 3';

      const cap = document.createElement('figcaption');
      cap.textContent = `${s.role}：${s.name}`;
      fig.appendChild(cap);

      const img = document.createElement('img');
      img.src = s.png_url;
      img.alt = `${s.name} の提案図`;
      img.loading = 'lazy';
      img.addEventListener('error', () => { fig.style.display = 'none'; });
      fig.appendChild(img);

      wrap.appendChild(fig);
    });
    return wrap;
  }

  dispose() {
    if (this.root && this.root.parentNode === this.container) {
      this.container.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
  }
}
