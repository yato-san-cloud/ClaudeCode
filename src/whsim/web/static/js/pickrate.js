// pickrate.js — ③設計「生産性試算」: 解析的(動作時間)なピッキング生産性.
// SLC流のステップ②: レイアウト幾何(MapMaker距離) × 動作時間で、オーダー/マルチ/
// トータルの生産性を DES なしで即比較する。重厚なシミュレーション(④検証)の前に、
// 「どの作業方式が速いか」をこの場で当てる。EN comments / JA UI.
import { esc, api } from './util.js';
import * as echarts from 'echarts';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function tok(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}

const METHOD_C = { discrete: '#9aa4b0', multi: '#1f78b4', zone: '#33a02c', total: '#e6550d' };

// editable motion-time standards (query params to GET /pickrate).
const FIELDS = [
  { key: 'walk_speed_mps', label: '歩行速度', unit: 'm/s', def: 1.2, step: 0.1 },
  { key: 'handle_s_per_line', label: '手扱い/行', unit: '秒', def: 6, step: 0.5 },
  { key: 'sort_s_per_line', label: '仕分け/行', unit: '秒', def: 4, step: 0.5 },
  { key: 'labour_cost_per_hour', label: '人件費', unit: '円/h', def: 2000, step: 100 },
];

function injectStyle() {
  if (document.getElementById('pr-style')) return;
  const s = document.createElement('style');
  s.id = 'pr-style';
  s.textContent = `
  .pr{display:flex;flex-direction:column;gap:14px;width:100%;padding:4px 2px 24px}
  .pr-head h2{margin:0 0 2px;font-size:18px;color:var(--ink-primary)}
  .pr-head .sub{font-size:12px;color:var(--ink-tertiary)}
  .pr-geo{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--ink-secondary);
    background:var(--bg-sunken);border:1px solid var(--line-hair);border-radius:10px;padding:8px 12px}
  .pr-geo b{color:var(--ink-primary);font-variant-numeric:tabular-nums}
  .pr-knobs{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  .pr-knob{display:flex;flex-direction:column;gap:3px}
  .pr-knob label{font-size:11px;color:var(--ink-tertiary)}
  .pr-knob input{width:96px;padding:6px 8px;border:1px solid var(--line-hair);border-radius:8px;
    background:var(--bg-app);color:var(--ink-primary);font:inherit;font-size:14px;text-align:right}
  .pr-knob input:focus{outline:none;border-color:var(--accent,#16C0DE)}
  .pr-verdict{padding:10px 14px;border-radius:11px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 12%,transparent);color:var(--ink-primary);font-size:13.5px;font-weight:600}
  .pr-chart{width:100%;height:300px;background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:12px}
  .pr-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .pr-tbl th,.pr-tbl td{padding:8px 10px;border-bottom:1px solid var(--line-hair);text-align:right;font-variant-numeric:tabular-nums}
  .pr-tbl th{color:var(--ink-secondary);font-weight:700;text-align:right;border-bottom:2px solid var(--line-hair)}
  .pr-tbl td.l,.pr-tbl th.l{text-align:left}
  .pr-tbl tr.best{background:color-mix(in srgb,var(--accent,#16C0DE) 10%,transparent)}
  .pr-dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .pr-tag{font-size:10px;font-weight:700;color:#fff;border-radius:999px;padding:1px 7px;margin-left:6px}
  .pr-empty{padding:16px;border:1px dashed var(--line-strong);border-radius:12px;background:var(--bg-panel);
    color:var(--ink-secondary);font-size:13px}
  .pr-btn{padding:8px 14px;border-radius:9px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent);color:var(--accent,#16C0DE);font-weight:700;cursor:pointer;font:inherit}
  .pr-btn.primary{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  `;
  document.head.appendChild(s);
}

export function mountPickrate(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'pr';
  el.innerHTML = '';
  el.appendChild(root);

  let chart = null;
  let ro = null;
  let data = null;
  let debounce = 0;
  const knob = {};
  FIELDS.forEach((f) => { knob[f.key] = f.def; });

  function disposeChart() { if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; } }

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを開くと、レイアウトから生産性を試算します。'); return; }
    const q = FIELDS.map((f) => `${f.key}=${encodeURIComponent(knob[f.key])}`).join('&');
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/pickrate?${q}`);
      render();
    } catch (e) {
      renderEmpty('試算に失敗しました: ' + (e && e.message ? e.message : e));
    }
  }

  function renderEmpty(msg) {
    disposeChart();
    root.innerHTML = `<div class="pr-head"><h2>生産性試算</h2>
      <div class="sub">MapMaker距離×動作時間で、シングル/マルチ/トータルを解析（実行不要）</div></div>
      <div class="pr-empty">${esc(msg)}</div>`;
  }

  function scatterOption() {
    const ink = tok('--ink-primary', '#222'), line = tok('--line-hair', '#ddd');
    const ms = data.methods;
    return {
      animation: !reduceMotion(),
      grid: { left: 58, right: 22, top: 22, bottom: 46 },
      tooltip: {
        trigger: 'item',
        formatter: (d) => {
          const m = ms[d.dataIndex];
          return `<b>${m.label}</b><br>移動 ${m.travel_per_order_m} m/件<br>`
            + `仕分け ${m.sort_per_order_s} 秒/件<br>生産性 ${m.lines_per_hour} 行/h<br>`
            + `¥${m.cost_per_order}/件`;
        },
      },
      xAxis: { name: '移動 m/件', nameLocation: 'middle', nameGap: 26,
        axisLine: { lineStyle: { color: line } }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line, opacity: 0.4 } } },
      yAxis: { name: '仕分け 秒/件', nameLocation: 'middle', nameGap: 38,
        axisLine: { lineStyle: { color: line } }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line, opacity: 0.4 } } },
      series: [{
        type: 'scatter',
        symbolSize: (val) => Math.max(16, Math.min(60, 900 / Math.max(1, val[2]))),
        data: ms.map((m) => ({
          value: [m.travel_per_order_m, m.sort_per_order_s, m.cost_per_order],
          itemStyle: {
            color: METHOD_C[m.id] || '#888',
            borderColor: m.id === data.recommend_id ? '#fff' : 'transparent',
            borderWidth: m.id === data.recommend_id ? 3 : 0,
          },
          label: { show: true, formatter: m.label.replace(/（.*/, ''), position: 'top',
            color: ink, fontSize: 11 },
        })),
      }],
    };
  }

  function render() {
    disposeChart();
    const g = data.geometry;
    const knobs = FIELDS.map((f) => `<div class="pr-knob"><label>${f.label}(${f.unit})</label>
      <input type="number" step="${f.step}" data-k="${f.key}" value="${knob[f.key]}"/></div>`).join('');
    const rows = data.methods.map((m) => {
      const best = m.id === data.recommend_id;
      return `<tr class="${best ? 'best' : ''}">
        <td class="l"><span class="pr-dot" style="background:${METHOD_C[m.id] || '#888'}"></span>${esc(m.label)}${best ? '<span class="pr-tag" style="background:var(--accent,#16C0DE)">推奨</span>' : ''}</td>
        <td>${fmt(m.lines_per_hour, 1)}</td>
        <td>${fmt(m.orders_per_hour, 1)}</td>
        <td>${fmt(m.travel_per_order_m, 1)}</td>
        <td>${fmt(m.sort_per_order_s, 1)}</td>
        <td>${yen(m.cost_per_order)}</td>
        <td>${fmt(m.pickers)}</td>
      </tr>`;
    }).join('');
    root.innerHTML =
      `<div class="pr-head"><h2>生産性試算 <span style="font-size:12px;font-weight:500;color:var(--ink-tertiary)">解析的・動作時間ベース</span></h2>
        <div class="sub">レイアウトの幾何(MapMaker距離)×動作時間で全作業方式を即比較。重厚なDESは④検証で。</div></div>
      <div class="pr-geo">
        <span>ピック面積 <b>${fmt(g.pick_area_m2)}</b> ㎡</span>
        <span>搬出距離 <b>${fmt(g.depot_dist_m, 1)}</b> m</span>
        <span>平均 <b>${fmt(g.lines_per_order, 2)}</b> 行/オーダー</span>
        <span>出荷 <b>${fmt(g.daily_pick_lines)}</b> 行/日</span>
      </div>
      ${data.has_layout ? '' : '<div class="pr-empty">保管エリア(棚)がまだ無いので床全面で概算しています。③設計でレイアウトを作るとより正確になります。</div>'}
      <div class="pr-knobs">${knobs}
        <button class="pr-btn" data-act="adopt">推奨方式で設計→</button>
        <button class="pr-btn primary" data-act="verify">DESで裏取り→</button>
      </div>
      <div class="pr-verdict">${esc(data.verdict)}</div>
      <div class="pr-chart" data-chart></div>
      <div style="overflow-x:auto"><table class="pr-tbl">
        <tr><th class="l">作業方式</th><th>行/h</th><th>件/h</th><th>移動 m/件</th><th>仕分け 秒/件</th><th>¥/件</th><th>必要人数</th></tr>
        ${rows}
      </table></div>
      <div class="sub" style="font-size:11px;color:var(--ink-tertiary)">移動=√(面積×ピック数)の巡回近似＋搬出往復。バブル小=¥/件小。値は④検証のDESで裏取りします。</div>`;
    wire();
    const node = root.querySelector('[data-chart]');
    chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption(scatterOption());
    if (!ro && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { if (chart) chart.resize(); });
      ro.observe(node);
    }
  }

  function wire() {
    root.querySelectorAll('input[data-k]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k; const v = parseFloat(inp.value);
        if (!isNaN(v)) knob[k] = v;
        clearTimeout(debounce);
        debounce = setTimeout(load, 280);
      });
    });
    const adopt = root.querySelector('[data-act=adopt]');
    if (adopt) adopt.addEventListener('click', () => applyRecommended());
    const verify = root.querySelector('[data-act=verify]');
    if (verify) verify.addEventListener('click', () => verifyWithDES());
  }

  // baton to ④検証「作業方法比較」: hand the analytic recommendation over so the
  // DES comparison highlights it and reconciles 解析推奨 vs DES推奨.
  function verifyWithDES() {
    if (!data) return;
    const rec = (data.methods || []).find((m) => m.id === data.recommend_id);
    if (!rec) return;
    document.dispatchEvent(new CustomEvent('whsim:workcompare-focus',
      { detail: { id: rec.id, label: rec.label } }));
  }

  // adopt the recommended method into the pick stage's work axes (POST /apply),
  // mirroring the workcompare "この方式で設計→" handoff. Then nudge to layout.
  async function applyRecommended() {
    const name = getProject();
    if (!name || !data) return;
    const rec = (data.methods || []).find((m) => m.id === data.recommend_id);
    if (!rec) return;
    const WORK = { discrete: { orders_per_trip: 1, consolidation: 'pick' },
      multi: { orders_per_trip: 8, consolidation: 'pick' },
      zone: { orders_per_trip: 4, zoning: 'parallel', consolidation: 'pick' },
      total: { orders_per_trip: 16, consolidation: 'sort' } };
    const work = WORK[rec.id] || {};
    const edits = {};
    for (const [k, v] of Object.entries(work)) edits[`process.stages.2.work.${k}`] = v;
    try {
      await api(`/api/projects/${encodeURIComponent(name)}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      toast(`「${rec.label}」を採用しました。`, 'ok');
      document.dispatchEvent(new CustomEvent('whsim:nav', { detail: { view: 'design' } }));
    } catch (e) {
      toast('採用に失敗しました: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  load();

  return {
    dispose() {
      disposeChart();
      if (ro) { ro.disconnect(); ro = null; }
      el.innerHTML = '';
    },
    refresh() { load(); },
  };
}
