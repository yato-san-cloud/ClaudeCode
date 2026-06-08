// dataanalysis.js — WMS 実データ分析タブ (3PL エンジン統合のフロント).
// サンプル or アップロード → /api/analysis/* → KPI・インサイト・チャートを描画.
// 自己完結 (テーマは CSS 変数を参照、無ければフォールバック値).
import { esc } from './util.js';

// Insight-card border colours, keyed by severity. Resolved from the theme
// status tokens (critical→--bad, warning→--warn, info→--accent/--info) to
// concrete hex so inline styles stay theme-consistent; rebuilt on themechange.
const SEV = {
  critical: { c: '#FF5A78', t: '重大' },
  warning:  { c: '#F5B05A', t: '注意' },
  info:     { c: '#34E3FF', t: '情報' },
};
function refreshSevColors() {
  SEV.critical.c = cssColor('--bad', '#FF5A78');
  SEV.warning.c = cssColor('--warn', '#F5B05A');
  SEV.info.c = cssColor('--info', cssColor('--accent', '#34E3FF'));
}
// SVG <path>/<rect> paint attributes do NOT resolve CSS var(), so resolve the
// shared ABC-rank tokens (--rank-a/b/c — identical to analysis.js) to concrete
// colours. Refreshed on the document `themechange` event (see mountDataAnalysis).
function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
  return v || fallback;
}
// Mutable rank palette; rebuilt on themechange so SVG fills track light/dark.
let RANK_C = { A: '#1C5FA8', B: '#5B9BD5', C: '#B9D3EE' };
function refreshRankColors() {
  RANK_C = {
    A: cssColor('--rank-a', '#1C5FA8'),
    B: cssColor('--rank-b', '#5B9BD5'),
    C: cssColor('--rank-c', '#B9D3EE'),
  };
}

// SVG <path>/<rect> paint attributes do NOT resolve CSS var(), so resolve the
// brand accent to a concrete colour once and feed it to the chart builders.
// Refreshed on the document `themechange` event (see mountDataAnalysis).
function accentColor() {
  return cssColor('--accent', '#34E3FF'); // cyan brand; flip handled by the token itself
}

function injectStyle() {
  if (document.getElementById('da-style')) return;
  const s = document.createElement('style');
  s.id = 'da-style';
  s.textContent = `
  .da{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  .da-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .da-bar .da-btn{padding:var(--sp-2) var(--sp-4);border-radius:10px;border:1px solid var(--accent);
    background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);
    font-weight:600;cursor:pointer;font:inherit}
  .da-bar .da-btn.primary{background:var(--accent);color:var(--ink-onAccent);border:none}
  .da-bar .da-btn:hover{filter:brightness(1.07)}
  .da-bar .da-hint{font-size:var(--fs-xs);color:var(--ink-tertiary,#8195a8)}
  .da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .da-kpi{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:13px 15px;transition:border-color var(--dur-1) var(--ease-out)}
  .da-kpi:hover{border-color:var(--line-strong)}
  .da-kpi .l{font-size:var(--fs-micro);letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);
    text-transform:uppercase;margin-bottom:7px}
  .da-kpi .v{font-size:var(--fs-title);font-weight:700;color:var(--ink-primary,#16202e);line-height:1.05}
  .da-kpi .v small{font-size:var(--fs-sm);font-weight:500;color:var(--ink-secondary,#52677c)}
  .da-cards{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-3)}
  @media(max-width:900px){.da-cards{grid-template-columns:1fr}}
  .da-card{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:14px;padding:var(--sp-5)}
  .da-card h3{margin:0 0 14px;font-size:var(--fs-body);font-weight:600;color:var(--ink-primary,#16202e)}
  .da-ins{display:flex;flex-direction:column;gap:9px}
  .da-i{display:flex;gap:11px;padding:11px 13px;border-radius:11px;border:1px solid var(--line,rgba(120,140,170,.18));
    background:var(--bg-app,#fff);border-left-width:4px}
  .da-i .ico{font-size:var(--fs-section);line-height:1.3}
  .da-i .ti{font-weight:600;color:var(--ink-primary,#16202e);font-size:var(--fs-sm)}
  .da-i .de{font-size:var(--fs-xs);color:var(--ink-secondary,#52677c);margin-top:3px;line-height:1.5}
  .da-i .su{font-size:var(--fs-micro);color:var(--ink-tertiary,#8195a8);margin-top:5px}
  .da-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    min-height:300px;text-align:center;color:var(--ink-tertiary,#8195a8)}
  .da-empty b{font-size:var(--fs-title);color:var(--ink-primary,#16202e)}
  .da-src{font-size:var(--fs-micro);color:var(--ink-tertiary,#8195a8);font-family:monospace}
  .da-err{display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:var(--sp-3);min-height:240px;text-align:center;
    border:1px solid var(--line-hair,rgba(120,140,170,.18));border-radius:var(--r-3,14px);
    background:var(--bg-sunken,#f7f6f3);padding:var(--sp-6)}
  .da-err b{font-size:var(--fs-section);color:var(--ink-primary,#16202e)}
  .da-err .da-err-msg{font-size:var(--fs-sm);color:var(--ink-secondary,#52677c);
    font-family:monospace;max-width:48ch;word-break:break-word}
  .da-err .da-retry{padding:var(--sp-2) var(--sp-5);border-radius:10px;border:none;
    background:var(--accent);color:var(--ink-onAccent);font-weight:600;cursor:pointer;font:inherit;
    transition:filter var(--dur-1,.12s) var(--ease-out,ease)}
  .da-err .da-retry:hover{filter:brightness(1.07)}
  @media(prefers-reduced-motion:reduce){.da-err .da-retry{transition:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(0) + '%');
function svg(w, h, body, label) {
  const a11y = label ? ` role="img" aria-label="${esc(label)}"` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block"${a11y}>${body}</svg>`;
}

// daily quantity line/area
function trendChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 200, P = 28;
  const xs = rows.map((r) => r.qty || 0);
  const max = Math.max(1, ...xs);
  const step = (W - 2 * P) / Math.max(1, rows.length - 1);
  const pts = rows.map((r, i) => [P + i * step, H - P - (r.qty / max) * (H - 2 * P)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `M${P} ${H - P} ` + pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ` L${(W - P).toFixed(1)} ${H - P} Z`;
  const ac = accentColor();
  return svg(W, H,
    `<path d="${area}" fill="${ac}" opacity="0.12"/>` +
    `<path d="${line}" fill="none" stroke="${ac}" stroke-width="2"/>` +
    `<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line,#ccd)" stroke-width="1"/>` +
    `<text x="${P}" y="16" font-size="11" fill="var(--ink-tertiary,#889)">最大 ${fmt(max)}</text>`,
    `物量推移（日次）折れ線グラフ。最大 ${fmt(max)} ピース、${rows.length} 日分。`);
}

// ABC: top-N SKU bars colored by rank
function abcChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const top = rows.slice(0, 15);
  const W = 560, rowH = 20, H = top.length * rowH + 16;
  const max = Math.max(1, ...top.map((r) => r.qty));
  const bars = top.map((r, i) => {
    const w = (r.qty / max) * (W - 130);
    const y = 8 + i * rowH;
    return `<text x="0" y="${y + 12}" font-size="10.5" fill="var(--ink-secondary,#567)">${r.sku}</text>` +
      `<rect x="64" y="${y + 3}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${RANK_C[r.rank] || '#888'}"/>` +
      `<text x="${(70 + w).toFixed(1)}" y="${y + 12}" font-size="10" fill="var(--ink-tertiary,#889)">${fmt(r.qty)}</text>`;
  }).join('');
  return svg(W, H, bars, `ABC分析。上位${top.length}SKUの物量を順位別に表示した横棒グラフ。`);
}

// peak: weekday bars
function weekdayChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 180, P = 26;
  const max = Math.max(1, ...rows.map((r) => r.qty));
  const bw = (W - 2 * P) / rows.length;
  const ac = accentColor();
  const bars = rows.map((r, i) => {
    const h = (r.qty / max) * (H - 2 * P);
    const x = P + i * bw, y = H - P - h;
    return `<rect x="${(x + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${ac}" opacity="0.85"/>` +
      `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--ink-secondary,#567)">${r.weekday}</text>`;
  }).join('');
  return svg(W, H, bars, '曜日別ピーク物量の棒グラフ。');
}

function hourChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 160, P = 24;
  const max = Math.max(1, ...rows.map((r) => r.qty));
  const bw = (W - 2 * P) / rows.length;
  const ac = accentColor();
  const bars = rows.map((r, i) => {
    const h = (r.qty / max) * (H - 2 * P);
    const x = P + i * bw, y = H - P - h;
    const lbl = r.hour % 6 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" font-size="9" text-anchor="middle" fill="var(--ink-tertiary,#889)">${r.hour}</text>` : '';
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${ac}" opacity="0.55"/>${lbl}`;
  }).join('');
  return svg(W, H, bars, '時間帯別ピーク物量の棒グラフ（0〜23時）。');
}

function kpiCards(k) {
  if (!k) return '';
  const cards = [
    ['総出荷ピース', fmt(k.total_pcs_out)],
    ['総出荷ライン', fmt(k.total_lines_out)],
    ['総オーダー', fmt(k.total_orders)],
    ['稼働SKU', `${fmt(k.sku_active)}<small> / ${fmt(k.sku_master)}</small>`],
    ['上位10%SKU集中', pct(k.top10_sku_share)],
    ['平均在庫回転', k.avg_turnover != null ? Number(k.avg_turnover).toFixed(2) : '—'],
    ['デッドストック率', pct(k.dead_sku_rate)],
    ['ピーク', `${k.peak_weekday || '—'}<small> ${fmt(k.peak_day_qty)}</small>`],
  ];
  return `<div class="da-grid">${cards.map(([l, v]) =>
    `<div class="da-kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>`;
}

function insightList(ins) {
  if (!ins || !ins.length) return '<div class="da-empty">指摘事項はありません。</div>';
  return `<div class="da-ins">${ins.map((i) => {
    const sv = SEV[i.severity] || SEV.info;
    return `<div class="da-i" style="border-left-color:${sv.c}">
      <div class="ico">${i.icon || '•'}</div>
      <div><div class="ti">${i.title}</div>
        ${i.detail ? `<div class="de">${i.detail}</div>` : ''}
        ${i.suggestion ? `<div class="su">💡 ${i.suggestion}</div>` : ''}</div></div>`;
  }).join('')}</div>`;
}

// 24-hour total required-headcount area chart.
function headcountChart(hours) {
  if (!hours || !hours.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 150, P = 24;
  const max = Math.max(1, ...hours);
  const bw = (W - 2 * P) / hours.length;
  const ac = accentColor();
  const bars = hours.map((v, i) => {
    const h = (v / max) * (H - 2 * P);
    const x = P + i * bw, y = H - P - h;
    const lbl = i % 6 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" font-size="9" text-anchor="middle" fill="var(--ink-tertiary,#889)">${i}</text>` : '';
    return `<rect x="${(x + 0.6).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1.2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${ac}" opacity="0.8"/>` +
      (v > 0 && v === max ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="9" text-anchor="middle" fill="var(--ink-secondary,#567)">${v}</text>` : '') + lbl;
  }).join('');
  return svg(W, H, bars, `時間帯別の必要人員（合計）棒グラフ。最大 ${max} 名。`);
}

function staffingCard(s) {
  if (!s || !s.processes || !s.processes.length) return '';
  const rows = s.processes.map((p) =>
    `<tr><td>${p.id}</td><td style="text-align:right">${fmt(p.daily_volume)}</td>` +
    `<td style="text-align:right;color:var(--ink-tertiary,#889)">${p.productivity}${p.unit}</td>` +
    `<td style="text-align:right;font-weight:700">${p.peak_headcount} 名</td>` +
    `<td style="text-align:right">${p.man_hours} 人時</td></tr>`).join('');
  return `<div class="da-card" style="grid-column:1/-1">
    <h3>工程別 必要人員（実データ由来・平均日）</h3>
    <div class="da-grid" style="margin-bottom:12px">
      <div class="da-kpi"><div class="l">ピーク人員</div><div class="v">${s.peak_headcount} <small>名</small></div></div>
      <div class="da-kpi"><div class="l">総工数</div><div class="v">${fmt(s.total_man_hours)} <small>人時/日</small></div></div>
      <div class="da-kpi"><div class="l">対象稼働日数</div><div class="v">${fmt(s.operating_days)} <small>日</small></div></div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--fs-xs)">
      <thead><tr style="color:var(--ink-tertiary,#889);text-align:left">
        <th>工程</th><th style="text-align:right">日量</th><th style="text-align:right">生産性</th>
        <th style="text-align:right">ピーク</th><th style="text-align:right">工数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3 style="margin:16px 0 6px">時間帯別 必要人員（合計）</h3>
    ${headcountChart(s.total_headcount_by_hour)}
    <div style="margin-top:12px"><button class="da-btn" data-act="to-timetable">タイムチャートで人員配置を見る →</button></div>
  </div>`;
}

function render(el, b) {
  el.innerHTML =
    `<div class="da-bar">
       <button class="da-btn primary" data-act="sample">▶ サンプルで試す</button>
       <button class="da-btn" data-act="upload">出荷データを取り込む</button>
       <input type="file" data-da-file accept=".csv,.xlsx,.xls,.json" hidden />
       <span class="da-hint">出荷WMSデータ(CSV/Excel)から物量推移・ABC・ピーク・在庫を分析</span>
       ${b && b.source ? `<span class="da-src" style="margin-left:auto">source: ${b.source}</span>` : ''}
     </div>` +
    (b
      ? kpiCards(b.kpis) +
        `<div class="da-cards">
           <div class="da-card"><h3>自動インサイト</h3>${insightList(b.insights)}</div>
           <div class="da-card"><h3>物量推移（日次）</h3>${trendChart(b.trend_daily)}</div>
           <div class="da-card"><h3>ABC分析（上位SKU）</h3>${abcChart(b.abc_sku)}</div>
           <div class="da-card"><h3>曜日別ピーク</h3>${weekdayChart(b.peak && b.peak.by_weekday)}</div>
           <div class="da-card" style="grid-column:1/-1"><h3>時間帯別ピーク</h3>${hourChart(b.peak && b.peak.by_hour)}</div>
           ${staffingCard(b.staffing)}
         </div>`
      : `<div class="da-empty"><b>WMSデータを分析</b>
           <div>「サンプルで試す」ですぐ確認、または出荷データを取り込んでください。</div></div>`);
}

export function mountDataAnalysis(el, opts = {}) {
  injectStyle();
  refreshRankColors();
  refreshSevColors();
  const root = document.createElement('div');
  root.className = 'da';
  el.innerHTML = '';
  el.appendChild(root);
  let bundle = null;
  const toast = opts.toast || (() => {});

  // `makePromise` is a thunk (not a bare promise) so the same fetch can be
  // re-invoked by the error-state 再試行 button.
  async function load(makePromise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
    const bar = root.querySelector('.da-hint');
    if (bar) bar.textContent = label;
    try {
      bundle = await makePromise();
      render(root, bundle);
      wire();
    } catch (e) {
      toast('分析に失敗しました: ' + e.message, 'error');
      renderError(e, makePromise, label);
    }
  }
  // Replace the body (keeping the toolbar) with a token-styled error panel so
  // the view is never left blank/stuck on a failed fetch.
  function renderError(e, makePromise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = false));
    const bar = root.querySelector('.da-hint');
    if (bar) bar.textContent = 'エラーが発生しました';
    let panel = root.querySelector('.da-err');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'da-err';
      root.appendChild(panel);
    }
    panel.innerHTML =
      `<b>読み込めませんでした</b>` +
      `<div class="da-err-msg">${esc(e && e.message ? e.message : e)}</div>` +
      `<button type="button" class="da-retry">再試行</button>`;
    panel.querySelector('.da-retry').onclick = () => {
      panel.remove();
      load(makePromise, label);
    };
  }
  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  function wire() {
    const fileInput = root.querySelector('[data-da-file]');
    root.querySelector('[data-act="sample"]').onclick = () =>
      load(() => getJSON('/api/analysis/sample'), 'サンプルデータを分析中…');
    root.querySelector('[data-act="upload"]').onclick = () => fileInput.click();
    const ttBtn = root.querySelector('[data-act="to-timetable"]');
    if (ttBtn) ttBtn.onclick = () => document.dispatchEvent(new CustomEvent(
      'whsim:load-timetable', { detail: { scenario: bundle && bundle.timetable_scenario } }));
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (!f) return;
      load(() => {
        const fd = new FormData();
        fd.append('shipments', f);
        return getJSON('/api/analysis/upload', { method: 'POST', body: fd });
      }, `「${f.name}」を分析中…`);
    };
  }
  render(root, bundle);
  wire();

  // SVG paint attributes bake in the accent colour resolved at build time, so a
  // light↔dark flip needs a re-render to pick up the new --accent. Re-render the
  // current bundle (no refetch) and re-wire on the document `themechange` event;
  // the listener is removed in dispose() to avoid leaks across remounts.
  const onTheme = () => { refreshRankColors(); refreshSevColors(); render(root, bundle); wire(); };
  document.addEventListener('themechange', onTheme);

  return {
    dispose() {
      document.removeEventListener('themechange', onTheme);
      el.innerHTML = '';
    },
    refresh() {},
  };
}
