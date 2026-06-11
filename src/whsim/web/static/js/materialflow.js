// materialflow.js — マテリアルフロー画面（荷役物量の作成）.
// 工程フロー(入荷検品→格納→ピッキング→検品→梱包→出荷)に荷役物量を：
//   ・実データ(サンプル/出荷取込)から自動充填
//   ・不足は手入力 or 生成(比率推計)で作成
// → そのまま「タイムチャートで人員配置」へ渡す（whsim.analysis.staffing と同契約）。
//
// 物量の流れは ECharts の sankey 図で可視化（工程の depends を辺に、人時を太さに）。
// 入力カードはそのまま編集可能；値を変えると sankey は in-place に更新（入力フォーカス
// を壊さない）。テーマは CSS 変数を getComputedStyle で参照し themechange で再描画。
import * as echarts from 'echarts';

// Badge tints are HTML inline styles, so theme tokens (CSS vars) resolve fine.
const SRC = { data: { t: '実データ', c: '#2ee6a0' }, manual: { t: '手入力', c: 'var(--ink-tertiary,#8195a8)' },
              generated: { t: '生成', c: '#f5b05a' }, bi: { t: '基礎物量', c: '#34e3ff' },
              none: { t: '未入力', c: '#8195a8' } };
// Per-process node colours in the sankey, keyed by 工程セクション.
const SECTION_HEX = { 入荷: '#5B9BD5', 出荷: '#16C0DE' };

const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function cssColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function hexAlpha(hex, a) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) h = '16C0DE';
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function injectStyle() {
  if (document.getElementById('mf-style')) return;
  const s = document.createElement('style');
  s.id = 'mf-style';
  s.textContent = `
  .mf{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  .mf-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .mf-btn{padding:9px 15px;border-radius:10px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent);color:var(--accent,#16C0DE);font-weight:600;cursor:pointer;font:inherit}
  .mf-btn.primary{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  .mf-btn:hover{filter:brightness(1.07)} .mf-btn:disabled{opacity:.5;cursor:default}
  .mf-btn:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  @media(prefers-reduced-motion:reduce){.mf-btn{transition:none}}
  .mf-hint{font-size:12px;color:var(--ink-tertiary,#8195a8)}
  .mf-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .mf-kpi{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));border-radius:12px;padding:13px 15px}
  .mf-kpi .l{font-size:10.5px;letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);text-transform:uppercase;margin-bottom:7px}
  .mf-kpi .v{font-size:22px;font-weight:700;color:var(--ink-primary,#16202e)}
  .mf-kpi .v small{font-size:13px;font-weight:500;color:var(--ink-secondary,#52677c)}
  .mf-sankey-wrap{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:13px;padding:12px 14px}
  .mf-sankey-h{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
  .mf-sankey-h h3{margin:0;font-size:13.5px;font-weight:600;color:var(--ink-primary,#16202e)}
  .mf-sankey-h .sub{font-size:11px;color:var(--ink-tertiary,#8195a8)}
  .mf-sankey{width:100%;height:260px}
  .mf-sankey-empty{display:flex;align-items:center;justify-content:center;height:120px;
    color:var(--ink-tertiary,#8195a8);font-size:12px}
  .mf-sec{font-family:var(--font-display,inherit);font-weight:700;font-size:12px;letter-spacing:.1em;color:var(--ink-tertiary,#8195a8);margin:6px 0 2px}
  .mf-flow{display:flex;gap:6px;flex-wrap:wrap;align-items:stretch}
  .mf-card{flex:1 1 150px;min-width:150px;background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:13px;padding:13px;display:flex;flex-direction:column;gap:7px;position:relative}
  .mf-card h4{margin:0;font-size:13.5px;color:var(--ink-primary,#16202e)}
  .mf-card .sub{font-size:11px;color:var(--ink-tertiary,#8195a8)}
  .mf-card input{width:100%;background:var(--bg-app,#fff);border:1px solid var(--line,#ccd);border-radius:8px;
    padding:8px 10px;font:inherit;font-size:15px;font-weight:700;color:var(--ink-primary,#16202e);text-align:right}
  .mf-card input:focus{outline:none;border-color:var(--accent,#16C0DE)}
  .mf-badge{position:absolute;top:9px;right:10px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:5px;color:var(--ink-onAccent,#04222c)}
  .mf-mh{font-size:11px;color:var(--ink-secondary,#52677c)}
  .mf-arrow{display:flex;align-items:center;color:var(--ink-faint,#aab);font-size:18px;flex:0 0 auto}
  @media(max-width:900px){.mf-arrow{display:none}}
  .mf-recalc{display:inline-flex;align-items:center;font-size:var(--fs-micro,11px);
    color:var(--ink-onAccent,#04222c);background:var(--accent,#16C0DE);
    border-radius:var(--r-pill,999px);padding:var(--sp-1,4px) var(--sp-2,8px);
    white-space:nowrap;opacity:0;pointer-events:none;
    transition:opacity var(--dur-2,160ms) var(--ease-out,ease)}
  .mf-recalc.on{opacity:1}
  .mf-empty{display:flex;flex-direction:column;align-items:flex-start;gap:var(--sp-2,8px);
    padding:var(--sp-4,16px);border:1px dashed var(--line-strong,var(--line,rgba(120,140,170,.18)));
    border-radius:var(--r-lg,12px);background:var(--bg-panel,#f7f6f3);margin-top:var(--sp-2,8px)}
  .mf-empty-title{font-weight:700;color:var(--ink-primary,#16202e);font-size:var(--fs-section,15px)}
  .mf-empty-body{color:var(--ink-secondary,#52677c);font-size:var(--fs-sm,13px);max-width:48ch}
  @media(prefers-reduced-motion:reduce){.mf-recalc{transition:none}}
  .mf-chain-wrap{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));border-radius:13px;padding:11px 14px}
  .mf-chain-h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--ink-primary,#16202e);margin-bottom:9px}
  .mf-chain-sub{font-size:11px;font-weight:500;color:var(--ink-tertiary,#8195a8)}
  .mf-chain-badge{margin-left:auto;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px}
  .mf-chain-badge.ok{color:#0a7d3d;background:rgba(29,185,84,.13)}
  .mf-chain-badge.bad{color:#c0341a;background:rgba(227,64,28,.12)}
  .mf-chain{display:flex;align-items:stretch;gap:5px;flex-wrap:wrap}
  .mf-cnode{flex:1 1 96px;min-width:88px;border:1.5px solid var(--line,rgba(120,140,170,.25));border-radius:10px;
    padding:8px 9px;display:flex;flex-direction:column;gap:3px;background:var(--bg-app,#fff)}
  .mf-cnode.bad{border-color:#e3401c;background:rgba(227,64,28,.05)}
  .mf-cn-stage{font-size:12.5px;font-weight:700;color:var(--ink-primary,#16202e)}
  .mf-cn-area{font-size:11px;color:var(--ink-secondary,#52677c)}
  .mf-cnode.bad .mf-cn-area{color:#c0341a;font-weight:600}
  .mf-cn-method{align-self:flex-start;font-size:10px;font-weight:700;color:#fff;padding:1px 7px;border-radius:999px;margin-top:1px}
  .mf-carrow{display:flex;align-items:center;color:var(--ink-faint,#aab);font-size:16px;flex:0 0 auto}
  .mf-chain-empty{font-size:12px;color:var(--ink-tertiary,#8195a8);padding:4px 0}
  @media(max-width:900px){.mf-carrow{display:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString());

// 作業方法バッジの色 + ゾーン種別の和名（designerと同じ語彙）。
const METHOD_C = { manual: '#9aa4b0', agv: '#1f78b4', conveyor: '#33a02c', asrs: '#6a3d9a' };
const METHOD_T = { manual: '人手', agv: 'AGV', conveyor: 'コンベア', asrs: '自動倉庫' };
const ZTYPE_T = { receiving: '入荷', storage: '保管', picking: 'ピッキング',
                  packing: '梱包', shipping: '出荷', staging: '一時保管', office: '事務' };

export function mountMaterialFlow(el, opts = {}) {
  injectStyle();
  const toast = opts.toast || (() => {});
  const getProject = opts.getProject || (() => null);
  const root = document.createElement('div');
  root.className = 'mf';
  el.innerHTML = '';
  el.appendChild(root);

  let flow = [];                 // [{id, section, unit, productivity, driver, depends}]
  const vol = {};                // {id: number}
  const src = {};                // {id: 'data'|'manual'|'generated'|'none'}
  // Live 工程→エリア chain from the designer's spatial flow (process.stages).
  // Reflected in real time via the `whsim:flow-changed` bus + an initial fetch.
  let stages = [];               // [{id,label,method,zone_type,area_ok,area_warn}]

  // ── sankey ECharts instance + theme/resize plumbing ──────────────────
  let sankey = null;
  let ro = null;
  function disposeSankey() {
    if (sankey) { try { sankey.dispose(); } catch (_) { /* noop */ } sankey = null; }
  }
  const resizeSankey = () => { if (sankey) { try { sankey.resize(); } catch (_) { /* noop */ } } };
  window.addEventListener('resize', resizeSankey);
  if (typeof ResizeObserver !== 'undefined') ro = new ResizeObserver(() => resizeSankey());

  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }

  function manHours(p) { return (vol[p.id] || 0) / Math.max(1, p.productivity); }

  // 工程→エリア chain (mirrors the designer's spatial flow). Each node shows the
  // 工程, its assigned エリア種別, and 作業方法; broken legs (未割当/種別不一致)
  // read red so a design error is visible HERE too, not just in the editor.
  function chainHtml() {
    if (!stages.length) {
      return `<div class="mf-chain-wrap"><div class="mf-chain-h">工程→エリア</div>`
        + `<div class="mf-chain-empty">③設計「レイアウト」のフロータブで工程にエリアを割り当てると、ここに連鎖が表示されます。</div></div>`;
    }
    const issues = stages.filter((s) => !s.area_ok).length;
    const nodes = stages.map((s, i) => {
      const mc = METHOD_C[s.method] || '#9aa4b0';
      const area = s.zone_type ? (ZTYPE_T[s.zone_type] || s.zone_type) : '未割当';
      const bad = !s.area_ok;
      const node = `<div class="mf-cnode${bad ? ' bad' : ''}" title="${bad ? (s.area_warn || '') : ''}">
        <div class="mf-cn-stage">${s.label}</div>
        <div class="mf-cn-area">${bad ? '⚠ ' : ''}${area}</div>
        <span class="mf-cn-method" style="background:${mc}">${METHOD_T[s.method] || s.method}</span>
      </div>`;
      return node + (i < stages.length - 1 ? '<div class="mf-carrow">→</div>' : '');
    }).join('');
    const badge = issues
      ? `<span class="mf-chain-badge bad">⚠ エリア連鎖 ${issues}件の問題</span>`
      : `<span class="mf-chain-badge ok">✓ エリア連鎖OK</span>`;
    return `<div class="mf-chain-wrap"><div class="mf-chain-h">工程→エリア <span class="mf-chain-sub">（③設計のフローと同期）</span>${badge}</div>`
      + `<div class="mf-chain">${nodes}</div></div>`;
  }

  // Re-render only the chain strip in place (live bus updates shouldn't disturb
  // the sankey canvas / input focus). Falls back to a full render if absent.
  function renderChain() {
    const host = root.querySelector('[data-mf-chain]');
    if (host) { host.innerHTML = chainHtml(); return; }
    if (flow.length) render();
  }

  function setBusy(on) {
    const pill = root.querySelector('[data-mf-recalc]');
    if (pill) pill.classList.toggle('on', !!on);
  }

  // Build the sankey option from the current flow + volumes. Nodes are processes
  // (value = 荷役物量); links follow each process's `depends` (upstream→this),
  // weighted by the downstream process man-hours so the ribbon thickness reads as
  // "work passed along the flow". Processes with no depends get a virtual section
  // source so they still appear as flow entry points.
  function sankeyOption() {
    const p = {
      ink: cssColor('--ink-primary', '#37352F'),
      ink2: cssColor('--ink-secondary', 'rgba(55,53,47,0.65)'),
      ink3: cssColor('--ink-tertiary', 'rgba(55,53,47,0.45)'),
      line: cssColor('--line-hair', 'rgba(55,53,47,0.16)'),
      panel: cssColor('--bg-app', '#FFFFFF'),
      lineStrong: cssColor('--line-strong', 'rgba(55,53,47,0.16)'),
      accent: cssColor('--accent', '#16C0DE'),
      fontSans: cssColor('--font-sans', 'sans-serif'),
      fontMono: cssColor('--font-mono', 'monospace'),
    };
    const byId = {}; flow.forEach((f) => { byId[f.id] = f; });
    const nodes = flow.map((f) => ({
      name: f.id,
      itemStyle: { color: SECTION_HEX[f.section] || p.accent, borderColor: 'transparent' },
      label: { color: p.ink, fontFamily: p.fontSans, fontSize: 11 },
      value: vol[f.id] || 0,
    }));
    // section entry nodes (so depends-less processes have an inbound ribbon)
    const sections = [...new Set(flow.map((f) => f.section))];
    sections.forEach((sec) => nodes.push({
      name: `${sec}（入口）`,
      itemStyle: { color: hexAlpha(SECTION_HEX[sec] || p.accent, 0.5) },
      label: { color: p.ink2, fontFamily: p.fontMono, fontSize: 10 },
    }));
    // links: edge weight = the downstream process man-hours (min 0.5 so 0-volume
    // edges still draw a hairline). Carry both endpoints' volumes for the tooltip.
    const links = [];
    flow.forEach((f) => {
      const mh = manHours(f);
      const w = Math.max(0.5, mh);
      const deps = (f.depends && f.depends.length) ? f.depends : [`${f.section}（入口）`];
      deps.forEach((d) => {
        if (d !== `${f.section}（入口）` && !byId[d]) return;   // skip dangling deps
        links.push({ source: d, target: f.id, value: w,
          lineStyle: { color: hexAlpha(SECTION_HEX[f.section] || p.accent, 0.32) } });
      });
    });
    return {
      animation: !reduceMotion(),
      tooltip: {
        trigger: 'item',
        backgroundColor: p.panel, borderColor: p.lineStrong, borderWidth: 1,
        textStyle: { color: p.ink, fontSize: 12, fontFamily: p.fontSans },
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);',
        formatter: (d) => {
          if (d.dataType === 'edge') return `${d.data.source} → ${d.data.target}<br>人時 ${Number(d.data.value).toFixed(1)}`;
          const f = byId[d.name];
          if (!f) return d.name;
          return `<b>${d.name}</b><br>荷役物量 ${fmt(vol[f.id] || 0)} ${f.unit ? `(${f.unit})` : ''}<br>人時 ${manHours(f).toFixed(1)}`;
        },
      },
      series: [{
        type: 'sankey', left: 8, right: 110, top: 12, bottom: 12,
        nodeWidth: 16, nodeGap: 12, draggable: false,
        emphasis: { focus: 'adjacency' },
        data: nodes, links,
        label: { color: p.ink, fontFamily: p.fontSans, fontSize: 11 },
        lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.5 },
        itemStyle: { borderWidth: 0 },
      }],
    };
  }

  // (Re)build or in-place update the sankey. `inPlace` avoids touching surrounding
  // DOM (preserves input focus) — used on every keystroke; full mount on render.
  function updateSankey() {
    const node = root.querySelector('[data-mf-sankey]');
    if (!node) return;
    if (!flow.length) { disposeSankey(); return; }
    if (!sankey) {
      sankey = echarts.init(node, null, { renderer: 'canvas' });
      if (ro) ro.observe(node);
    }
    sankey.setOption(sankeyOption(), true);
  }

  function renderEmpty() {
    disposeSankey();
    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload">出荷データから取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
       </div>
       <div class="mf-empty">
         <div class="mf-empty-title">工程フローがまだありません</div>
         <div class="mf-empty-body">サンプル物量、または出荷データを取り込むと、工程ごとの荷役物量がここに表示されます。</div>
         <button class="mf-btn primary" data-act="sample">サンプル物量で始める</button>
       </div>`;
    wire();
  }

  function render() {
    if (!flow.length) { renderEmpty(); return; }
    disposeSankey();   // about to rebuild the DOM the canvas lives in
    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const sections = [...new Set(flow.map((p) => p.section))];
    const flowHtml = sections.map((sec) => {
      const ps = flow.filter((p) => p.section === sec);
      const cards = ps.map((p, i) => {
        const sc = SRC[src[p.id] || 'none'];
        const card = `<div class="mf-card" data-card="${p.id}">
          <span class="mf-badge" data-badge="${p.id}" style="background:${sc.c}">${sc.t}</span>
          <h4>${p.id}</h4>
          <div class="sub">${p.unit} ・ 生産性 ${p.productivity}</div>
          <input type="number" min="0" step="1" data-id="${p.id}" value="${vol[p.id] || 0}" aria-label="${p.id}の荷役物量"/>
          <div class="mf-mh" data-mh="${p.id}">≈ ${manHours(p).toFixed(1)} 人時/日</div>
        </div>`;
        return card + (i < ps.length - 1 ? '<div class="mf-arrow">→</div>' : '');
      }).join('');
      return `<div class="mf-sec">${sec}</div><div class="mf-flow">${cards}</div>`;
    }).join('');

    const anyVol = flow.some((p) => (vol[p.id] || 0) > 0);
    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload">出荷データから取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
        <button class="mf-btn" data-act="frombi">基礎物量を取込</button>
        <button class="mf-btn" data-act="generate">不足を生成</button>
        <span class="mf-recalc" data-mf-recalc aria-live="polite">再計算中…</span>
        <button class="mf-btn primary" data-act="timetable" style="margin-left:auto">タイムチャートで人員配置 →</button>
       </div>
       <span class="mf-hint">工程ごとの荷役物量（1日平均）。データから取込・不足は手入力/生成し、人員配置へ。</span>
       <div data-mf-chain>${chainHtml()}</div>
       <div class="mf-kpis">
         <div class="mf-kpi"><div class="l">総工数</div><div class="v"><span data-kpi="totalMH">${totalMH.toFixed(1)}</span> <small>人時/日</small></div></div>
         <div class="mf-kpi"><div class="l">入力済み工程</div><div class="v"><span data-kpi="filled">${filled}</span> <small>/ ${flow.length}</small></div></div>
         <div class="mf-kpi"><div class="l">工程数</div><div class="v">${flow.length}</div></div>
       </div>
       <div class="mf-sankey-wrap">
         <div class="mf-sankey-h"><h3>マテリアルフロー</h3><span class="sub">工程間の流れ（リボン幅 = 人時）</span></div>
         ${anyVol ? '<div class="mf-sankey" data-mf-sankey></div>'
           : '<div class="mf-sankey-empty">荷役物量を入力すると、工程間の流れがここに描画されます。</div>'}
       </div>
       ${flowHtml}`;
    wire();
    if (anyVol) updateSankey();
  }

  function setVolumes(map, source) {
    for (const p of flow) {
      if (map[p.id] != null) { vol[p.id] = Math.round(map[p.id]); src[p.id] = source; }
    }
  }

  async function fromBundle(promise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
    setBusy(true);
    try {
      const b = await promise;
      const procs = (b.staffing && b.staffing.processes) || [];
      const map = {};
      procs.forEach((p) => { map[p.id] = p.daily_volume; });
      setVolumes(map, 'data');
      render();
      toast(label + 'から荷役物量を取り込みました。', 'ok');
    } catch (e) {
      toast('取込に失敗しました: ' + e.message, 'error');
      render();
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    const base = {};
    for (const p of flow) if ((vol[p.id] || 0) > 0) base[p.driver] = vol[p.id];
    if (!Object.keys(base).length) { toast('元になる物量を1つ以上入力してください。', 'info'); return; }
    setBusy(true);
    try {
      const r = await getJSON('/api/materialflow/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base }),
      });
      for (const p of flow) {
        if ((vol[p.id] || 0) <= 0 && r.volumes[p.id] != null) {
          vol[p.id] = Math.round(r.volumes[p.id]); src[p.id] = 'generated';
        }
      }
      render();
      toast('不足していた工程の荷役物量を生成しました。', 'ok');
    } catch (e) { toast('生成に失敗しました: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  async function toTimetable() {
    setBusy(true);
    try {
      const sc = await getJSON('/api/materialflow/scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volumes: vol }),
      });
      document.dispatchEvent(new CustomEvent('whsim:load-timetable', { detail: { scenario: sc } }));
      toast('人員配置へ受け渡しました', 'ok');
    } catch (e) { toast('タイムチャートへの受け渡しに失敗しました: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  // In-place update of just the affected card (man-hours + source badge) + KPIs +
  // the sankey — avoids a full innerHTML rebuild on every keystroke (which would
  // destroy input focus/caret). If the sankey wasn't present yet (first non-zero
  // volume), a full render() builds it.
  function updateCard(id) {
    const p = flow.find((q) => q.id === id);
    if (!p) return;
    const mh = root.querySelector(`[data-mh="${id}"]`);
    if (mh) mh.textContent = `≈ ${manHours(p).toFixed(1)} 人時/日`;
    const badge = root.querySelector(`[data-badge="${id}"]`);
    if (badge) { const sc = SRC[src[id] || 'none']; badge.textContent = sc.t; badge.style.background = sc.c; }
    updateKpis();
    const node = root.querySelector('[data-mf-sankey]');
    if (node) updateSankey();
    else if (flow.some((q) => (vol[q.id] || 0) > 0)) render();   // first non-zero → draw it
  }
  function updateKpis() {
    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const t = root.querySelector('[data-kpi="totalMH"]'); if (t) t.textContent = totalMH.toFixed(1);
    const f = root.querySelector('[data-kpi="filled"]'); if (f) f.textContent = String(filled);
  }

  // Delegated listeners on root (one set, survives in-place updates).
  let wired = false;
  function wire() {
    const fileInput = root.querySelector('[data-mf-file]');
    if (fileInput) {
      fileInput.onchange = () => {
        const f = fileInput.files[0];
        if (!f) return;
        const fd = new FormData(); fd.append('shipments', f);
        fromBundle(getJSON('/api/analysis/upload', { method: 'POST', body: fd }), `「${f.name}」`);
      };
    }
    if (wired) return;
    wired = true;
    root.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-id]');
      if (!inp) return;
      const id = inp.dataset.id;
      vol[id] = Math.max(0, parseFloat(inp.value) || 0);
      src[id] = 'manual';
      updateCard(id);
    });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'sample') fromBundle(getJSON('/api/analysis/sample'), 'サンプル');
      else if (act === 'upload') { const fi = root.querySelector('[data-mf-file]'); if (fi) fi.click(); }
      else if (act === 'frombi') fromBI();
      else if (act === 'generate') generate();
      else if (act === 'timetable') toTimetable();
    });
  }

  // 基礎物量 (②分析) で保存した 仮値派生の基礎物量 (bi.json → from-bi) を工程
  // カードに流し込む — the BI→マテリアルフロー bridge. Untouched processes keep
  // their current value; pulled ones are badged 基礎物量.
  async function fromBI() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    try {
      const r = await getJSON(`/api/projects/${encodeURIComponent(name)}/timetable/from-bi`);
      if (!r || !r.available || !r.volumes) {
        toast('基礎物量がまだありません。②分析→基礎物量で「基礎物量を保存」してください。', 'info');
        return;
      }
      let n = 0;
      for (const p of flow) {
        const v = r.volumes[p.id];
        if (v != null && v > 0) { vol[p.id] = Math.round(v); src[p.id] = 'bi'; n += 1; }
      }
      render();
      toast(`基礎物量を ${n} 工程に反映しました。`, 'ok');
    } catch (e) {
      toast('取込に失敗: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  // Theme flip: sankey paints are resolved at build time, so rebuild from the
  // fresh tokens (no refetch). Only when a canvas is actually mounted.
  const onTheme = () => { if (sankey) updateSankey(); };
  document.addEventListener('themechange', onTheme);

  // Live link: the designer broadcasts its 工程→エリア state on every flow edit.
  function applyStages(next) {
    stages = Array.isArray(next) ? next : [];
    renderChain();
  }
  const onFlow = (e) => applyStages(e && e.detail && e.detail.stages);
  document.addEventListener('whsim:flow-changed', onFlow);

  // Initial 工程→エリア from the saved model, so the chain shows even before the
  // designer is opened this session (live edits then refine it).
  async function loadStagesFromModel() {
    const name = getProject();
    if (!name) return;
    try {
      const m = await getJSON(`/api/projects/${encodeURIComponent(name)}/full`);
      const mm = m.model || m;
      const proc = (mm && mm.process) || {};
      const byId = {}; (proc.stages || []).forEach((s) => { byId[s.id] = s; });
      const zById = {}; ((mm.layout || {}).zones || []).forEach((z) => { zById[z.id] = z; });
      const order = [];
      const seen = new Set();
      for (const id of (proc.flow || [])) { if (byId[id] && !seen.has(id)) { order.push(byId[id]); seen.add(id); } }
      for (const s of (proc.stages || [])) { if (!seen.has(s.id)) order.push(s); }
      const STAGE_OK = { receive: ['receiving'], putaway: ['storage', 'staging'],
        pick: ['storage', 'picking'], pack: ['packing'], ship: ['shipping', 'staging'] };
      applyStages(order.map((s) => {
        const z = s.zone ? zById[s.zone] : null;
        const exp = STAGE_OK[s.id];
        const ok = !!z && (!exp || exp.includes(z.type));
        return { id: s.id, label: s.label || s.id, method: s.method || 'manual',
          zone: s.zone || null, zone_type: z ? z.type : null,
          area_ok: ok, area_warn: !z ? '未割当' : (!ok ? '種別不一致' : null) };
      }));
    } catch (_e) { /* no model yet: the empty-state hint stays */ }
  }

  (async () => {
    try {
      const seed = await getJSON('/api/materialflow/seed');
      flow = seed.flow || [];
      for (const p of flow) { vol[p.id] = 0; src[p.id] = 'none'; }
    } catch (e) {
      toast('工程フローの取得に失敗しました: ' + e.message, 'error');
    }
    render();
    loadStagesFromModel();
  })();

  return {
    dispose() {
      document.removeEventListener('themechange', onTheme);
      document.removeEventListener('whsim:flow-changed', onFlow);
      disposeSankey();
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener('resize', resizeSankey);
      el.innerHTML = '';
    },
    // re-pull the saved 工程→エリア (used when the project changes / on revisit).
    refresh() { loadStagesFromModel(); },
    setStages: applyStages,
  };
}
