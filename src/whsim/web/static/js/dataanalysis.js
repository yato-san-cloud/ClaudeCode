// dataanalysis.js — WMS 実データ分析タブ (3PL エンジン統合のフロント).
// サンプル or アップロード → /api/analysis/* → KPI・インサイト・チャートを描画.
// 自己完結 (テーマは CSS 変数を参照、無ければフォールバック値).

const SEV = {
  critical: { c: '#ff5a78', t: '重大' },
  warning:  { c: '#f5b05a', t: '注意' },
  info:     { c: '#2f7bff', t: '情報' },
};
const RANK_C = { A: '#ff5a78', B: '#f5b05a', C: '#2ee6a0' };

function injectStyle() {
  if (document.getElementById('da-style')) return;
  const s = document.createElement('style');
  s.id = 'da-style';
  s.textContent = `
  .da{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  .da-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .da-bar .da-btn{padding:9px 16px;border-radius:10px;border:1px solid var(--accent,#2f7bff);
    background:color-mix(in srgb,var(--accent,#2f7bff) 14%,transparent);color:var(--accent,#2f7bff);
    font-weight:600;cursor:pointer;font:inherit}
  .da-bar .da-btn.primary{background:var(--accent,#2f7bff);color:#04222c;border:none}
  .da-bar .da-btn:hover{filter:brightness(1.07)}
  .da-bar .da-hint{font-size:12px;color:var(--ink-tertiary,#8195a8)}
  .da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .da-kpi{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:13px 15px}
  .da-kpi .l{font-size:10.5px;letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);
    text-transform:uppercase;margin-bottom:7px}
  .da-kpi .v{font-size:23px;font-weight:700;color:var(--ink-primary,#16202e);line-height:1.05}
  .da-kpi .v small{font-size:13px;font-weight:500;color:var(--ink-secondary,#52677c)}
  .da-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:900px){.da-cards{grid-template-columns:1fr}}
  .da-card{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:14px;padding:18px}
  .da-card h3{margin:0 0 14px;font-size:14px;font-weight:600;color:var(--ink-primary,#16202e)}
  .da-ins{display:flex;flex-direction:column;gap:9px}
  .da-i{display:flex;gap:11px;padding:11px 13px;border-radius:11px;border:1px solid var(--line,rgba(120,140,170,.18));
    background:var(--bg-app,#fff);border-left-width:4px}
  .da-i .ico{font-size:17px;line-height:1.3}
  .da-i .ti{font-weight:600;color:var(--ink-primary,#16202e);font-size:13.5px}
  .da-i .de{font-size:12px;color:var(--ink-secondary,#52677c);margin-top:3px;line-height:1.5}
  .da-i .su{font-size:11.5px;color:var(--ink-tertiary,#8195a8);margin-top:5px}
  .da-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    min-height:300px;text-align:center;color:var(--ink-tertiary,#8195a8)}
  .da-empty b{font-size:18px;color:var(--ink-primary,#16202e)}
  .da-src{font-size:11px;color:var(--ink-tertiary,#8195a8);font-family:monospace}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const pct = (n) => (n == null ? '—' : (n * 100).toFixed(0) + '%');

function svg(w, h, body) {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block">${body}</svg>`;
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
  const ac = 'var(--accent,#2f7bff)';
  return svg(W, H,
    `<path d="${area}" fill="${ac}" opacity="0.12"/>` +
    `<path d="${line}" fill="none" stroke="${ac}" stroke-width="2"/>` +
    `<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line,#ccd)" stroke-width="1"/>` +
    `<text x="${P}" y="16" font-size="11" fill="var(--ink-tertiary,#889)">最大 ${fmt(max)}</text>`);
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
  return svg(W, H, bars);
}

// peak: weekday bars
function weekdayChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 180, P = 26;
  const max = Math.max(1, ...rows.map((r) => r.qty));
  const bw = (W - 2 * P) / rows.length;
  const bars = rows.map((r, i) => {
    const h = (r.qty / max) * (H - 2 * P);
    const x = P + i * bw, y = H - P - h;
    return `<rect x="${(x + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="var(--accent,#2f7bff)" opacity="0.85"/>` +
      `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="var(--ink-secondary,#567)">${r.weekday}</text>`;
  }).join('');
  return svg(W, H, bars);
}

function hourChart(rows) {
  if (!rows || !rows.length) return '<div class="da-empty">データなし</div>';
  const W = 560, H = 160, P = 24;
  const max = Math.max(1, ...rows.map((r) => r.qty));
  const bw = (W - 2 * P) / rows.length;
  const bars = rows.map((r, i) => {
    const h = (r.qty / max) * (H - 2 * P);
    const x = P + i * bw, y = H - P - h;
    const lbl = r.hour % 6 === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 7}" font-size="9" text-anchor="middle" fill="var(--ink-tertiary,#889)">${r.hour}</text>` : '';
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#9b6bff" opacity="0.8"/>${lbl}`;
  }).join('');
  return svg(W, H, bars);
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
         </div>`
      : `<div class="da-empty"><b>WMSデータを分析</b>
           <div>「サンプルで試す」ですぐ確認、または出荷データを取り込んでください。</div></div>`);
}

export function mountDataAnalysis(el, opts = {}) {
  injectStyle();
  const root = document.createElement('div');
  root.className = 'da';
  el.innerHTML = '';
  el.appendChild(root);
  let bundle = null;
  const toast = opts.toast || (() => {});

  async function load(promise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
    const bar = root.querySelector('.da-hint');
    if (bar) bar.textContent = label;
    try {
      bundle = await promise;
      render(root, bundle);
      wire();
    } catch (e) {
      toast('分析に失敗しました: ' + e.message, 'error');
      if (bar) bar.textContent = 'エラー: ' + e.message;
      root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = false));
    }
  }
  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  function wire() {
    const fileInput = root.querySelector('[data-da-file]');
    root.querySelector('[data-act="sample"]').onclick = () =>
      load(getJSON('/api/analysis/sample'), 'サンプルデータを分析中…');
    root.querySelector('[data-act="upload"]').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (!f) return;
      const fd = new FormData();
      fd.append('shipments', f);
      load(getJSON('/api/analysis/upload', { method: 'POST', body: fd }), `「${f.name}」を分析中…`);
    };
  }
  render(root, bundle);
  wire();
  return {
    dispose() { el.innerHTML = ''; },
    refresh() {},
  };
}
