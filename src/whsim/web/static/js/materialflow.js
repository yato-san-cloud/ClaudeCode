// materialflow.js — マテリアルフロー画面（荷役物量の作成）.
// 工程フロー(入荷検品→格納→ピッキング→検品→梱包→出荷)に荷役物量を：
//   ・実データ(サンプル/出荷取込)から自動充填
//   ・不足は手入力 or 生成(比率推計)で作成
// → そのまま「タイムチャートで人員配置」へ渡す（whsim.analysis.staffing と同契約）。

const SRC = { data: { t: '実データ', c: '#2ee6a0' }, manual: { t: '手入力', c: '#2f7bff' },
              generated: { t: '生成', c: '#f5b05a' }, none: { t: '未入力', c: '#8195a8' } };

function injectStyle() {
  if (document.getElementById('mf-style')) return;
  const s = document.createElement('style');
  s.id = 'mf-style';
  s.textContent = `
  .mf{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  .mf-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .mf-btn{padding:9px 15px;border-radius:10px;border:1px solid var(--accent,#2f7bff);
    background:color-mix(in srgb,var(--accent,#2f7bff) 14%,transparent);color:var(--accent,#2f7bff);font-weight:600;cursor:pointer;font:inherit}
  .mf-btn.primary{background:var(--accent,#2f7bff);color:#04222c;border:none}
  .mf-btn:hover{filter:brightness(1.07)} .mf-btn:disabled{opacity:.5;cursor:default}
  .mf-hint{font-size:12px;color:var(--ink-tertiary,#8195a8)}
  .mf-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .mf-kpi{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));border-radius:12px;padding:13px 15px}
  .mf-kpi .l{font-size:10.5px;letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);text-transform:uppercase;margin-bottom:7px}
  .mf-kpi .v{font-size:22px;font-weight:700;color:var(--ink-primary,#16202e)}
  .mf-kpi .v small{font-size:13px;font-weight:500;color:var(--ink-secondary,#52677c)}
  .mf-sec{font-family:var(--font-display,inherit);font-weight:700;font-size:12px;letter-spacing:.1em;color:var(--ink-tertiary,#8195a8);margin:6px 0 2px}
  .mf-flow{display:flex;gap:6px;flex-wrap:wrap;align-items:stretch}
  .mf-card{flex:1 1 150px;min-width:150px;background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:13px;padding:13px;display:flex;flex-direction:column;gap:7px;position:relative}
  .mf-card h4{margin:0;font-size:13.5px;color:var(--ink-primary,#16202e)}
  .mf-card .sub{font-size:11px;color:var(--ink-tertiary,#8195a8)}
  .mf-card input{width:100%;background:var(--bg-app,#fff);border:1px solid var(--line,#ccd);border-radius:8px;
    padding:8px 10px;font:inherit;font-size:15px;font-weight:700;color:var(--ink-primary,#16202e);text-align:right}
  .mf-card input:focus{outline:none;border-color:var(--accent,#2f7bff)}
  .mf-badge{position:absolute;top:9px;right:10px;font-size:9px;font-weight:700;padding:2px 6px;border-radius:5px;color:#04222c}
  .mf-mh{font-size:11px;color:var(--ink-secondary,#52677c)}
  .mf-arrow{display:flex;align-items:center;color:var(--ink-faint,#aab);font-size:18px;flex:0 0 auto}
  @media(max-width:900px){.mf-arrow{display:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString());

export function mountMaterialFlow(el, opts = {}) {
  injectStyle();
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'mf';
  el.innerHTML = '';
  el.appendChild(root);

  let flow = [];                 // [{id, section, unit, productivity, driver, depends}]
  const vol = {};                // {id: number}
  const src = {};                // {id: 'data'|'manual'|'generated'|'none'}

  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }

  function manHours(p) { return (vol[p.id] || 0) / Math.max(1, p.productivity); }

  function render() {
    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const sections = [...new Set(flow.map((p) => p.section))];
    const flowHtml = sections.map((sec) => {
      const ps = flow.filter((p) => p.section === sec);
      const cards = ps.map((p, i) => {
        const sc = SRC[src[p.id] || 'none'];
        const card = `<div class="mf-card">
          <span class="mf-badge" style="background:${sc.c}">${sc.t}</span>
          <h4>${p.id}</h4>
          <div class="sub">${p.unit} ・ 生産性 ${p.productivity}</div>
          <input type="number" min="0" step="1" data-id="${p.id}" value="${vol[p.id] || 0}" aria-label="${p.id}の荷役物量"/>
          <div class="mf-mh">≈ ${manHours(p).toFixed(1)} 人時/日</div>
        </div>`;
        return card + (i < ps.length - 1 ? '<div class="mf-arrow">→</div>' : '');
      }).join('');
      return `<div class="mf-sec">${sec}</div><div class="mf-flow">${cards}</div>`;
    }).join('');

    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload">出荷データから取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
        <button class="mf-btn" data-act="generate">不足を生成</button>
        <button class="mf-btn primary" data-act="timetable" style="margin-left:auto">タイムチャートで人員配置 →</button>
       </div>
       <span class="mf-hint">工程ごとの荷役物量（1日平均）。データから取込・不足は手入力/生成し、人員配置へ。</span>
       <div class="mf-kpis">
         <div class="mf-kpi"><div class="l">総工数</div><div class="v">${totalMH.toFixed(1)} <small>人時/日</small></div></div>
         <div class="mf-kpi"><div class="l">入力済み工程</div><div class="v">${filled} <small>/ ${flow.length}</small></div></div>
         <div class="mf-kpi"><div class="l">工程数</div><div class="v">${flow.length}</div></div>
       </div>
       ${flowHtml}`;
    wire();
  }

  function setVolumes(map, source) {
    for (const p of flow) {
      if (map[p.id] != null) { vol[p.id] = Math.round(map[p.id]); src[p.id] = source; }
    }
  }

  async function fromBundle(promise, label) {
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
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
    }
  }

  async function generate() {
    // base = known process volumes mapped back to their measured drivers
    const base = {};
    for (const p of flow) if ((vol[p.id] || 0) > 0) base[p.driver] = vol[p.id];
    if (!Object.keys(base).length) { toast('元になる物量を1つ以上入力してください。', 'info'); return; }
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
  }

  async function toTimetable() {
    try {
      const sc = await getJSON('/api/materialflow/scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ volumes: vol }),
      });
      document.dispatchEvent(new CustomEvent('whsim:load-timetable', { detail: { scenario: sc } }));
    } catch (e) { toast('タイムチャートへの受け渡しに失敗しました: ' + e.message, 'error'); }
  }

  function wire() {
    root.querySelectorAll('input[data-id]').forEach((inp) => {
      inp.onchange = () => {
        const id = inp.dataset.id;
        vol[id] = Math.max(0, parseFloat(inp.value) || 0);
        src[id] = 'manual';
        render();
      };
    });
    const fileInput = root.querySelector('[data-mf-file]');
    root.querySelector('[data-act="sample"]').onclick = () =>
      fromBundle(getJSON('/api/analysis/sample'), 'サンプル');
    root.querySelector('[data-act="upload"]').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (!f) return;
      const fd = new FormData(); fd.append('shipments', f);
      fromBundle(getJSON('/api/analysis/upload', { method: 'POST', body: fd }), `「${f.name}」`);
    };
    root.querySelector('[data-act="generate"]').onclick = generate;
    root.querySelector('[data-act="timetable"]').onclick = toTimetable;
  }

  (async () => {
    try {
      const seed = await getJSON('/api/materialflow/seed');
      flow = seed.flow || [];
      for (const p of flow) { vol[p.id] = 0; src[p.id] = 'none'; }
    } catch (_e) { /* show empty */ }
    render();
  })();

  return { dispose() { el.innerHTML = ''; }, refresh() {} };
}
