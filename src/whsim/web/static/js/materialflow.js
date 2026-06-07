// materialflow.js — マテリアルフロー画面（荷役物量の作成）.
// 工程フロー(入荷検品→格納→ピッキング→検品→梱包→出荷)に荷役物量を：
//   ・実データ(サンプル/出荷取込)から自動充填
//   ・不足は手入力 or 生成(比率推計)で作成
// → そのまま「タイムチャートで人員配置」へ渡す（whsim.analysis.staffing と同契約）。

// Badge tints are HTML inline styles, so theme tokens (CSS vars) resolve fine.
// 手入力 is a neutral/secondary tone — NOT the cyan accent, which is reserved.
const SRC = { data: { t: '実データ', c: '#2ee6a0' }, manual: { t: '手入力', c: 'var(--ink-tertiary,#8195a8)' },
              generated: { t: '生成', c: '#f5b05a' }, none: { t: '未入力', c: '#8195a8' } };

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

  // Toggle the "再計算中…" pill around any solve/fetch round-trip.
  function setBusy(on) {
    const pill = root.querySelector('[data-mf-recalc]');
    if (pill) pill.classList.toggle('on', !!on);
  }

  function renderEmpty() {
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

    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload">出荷データから取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
        <button class="mf-btn" data-act="generate">不足を生成</button>
        <span class="mf-recalc" data-mf-recalc aria-live="polite">再計算中…</span>
        <button class="mf-btn primary" data-act="timetable" style="margin-left:auto">タイムチャートで人員配置 →</button>
       </div>
       <span class="mf-hint">工程ごとの荷役物量（1日平均）。データから取込・不足は手入力/生成し、人員配置へ。</span>
       <div class="mf-kpis">
         <div class="mf-kpi"><div class="l">総工数</div><div class="v"><span data-kpi="totalMH">${totalMH.toFixed(1)}</span> <small>人時/日</small></div></div>
         <div class="mf-kpi"><div class="l">入力済み工程</div><div class="v"><span data-kpi="filled">${filled}</span> <small>/ ${flow.length}</small></div></div>
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
    // base = known process volumes mapped back to their measured drivers
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

  // In-place update of just the affected card (man-hours + source badge) plus the
  // KPI numbers — avoids a full innerHTML rebuild on every keystroke (which would
  // destroy input focus/caret).
  function updateCard(id) {
    const p = flow.find((q) => q.id === id);
    if (!p) return;
    const mh = root.querySelector(`[data-mh="${id}"]`);
    if (mh) mh.textContent = `≈ ${manHours(p).toFixed(1)} 人時/日`;
    const badge = root.querySelector(`[data-badge="${id}"]`);
    if (badge) { const sc = SRC[src[id] || 'none']; badge.textContent = sc.t; badge.style.background = sc.c; }
    updateKpis();
  }
  function updateKpis() {
    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const t = root.querySelector('[data-kpi="totalMH"]'); if (t) t.textContent = totalMH.toFixed(1);
    const f = root.querySelector('[data-kpi="filled"]'); if (f) f.textContent = String(filled);
  }

  // Delegated listeners on root (one set, survives in-place updates; no per-node onX).
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
    if (wired) return;          // delegated handlers attach to root once
    wired = true;
    root.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-id]');
      if (!inp) return;
      const id = inp.dataset.id;
      vol[id] = Math.max(0, parseFloat(inp.value) || 0);
      src[id] = 'manual';
      updateCard(id);           // in-place: preserves focus/caret
    });
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'sample') fromBundle(getJSON('/api/analysis/sample'), 'サンプル');
      else if (act === 'upload') { const fi = root.querySelector('[data-mf-file]'); if (fi) fi.click(); }
      else if (act === 'generate') generate();
      else if (act === 'timetable') toTimetable();
    });
  }

  (async () => {
    try {
      const seed = await getJSON('/api/materialflow/seed');
      flow = seed.flow || [];
      for (const p of flow) { vol[p.id] = 0; src[p.id] = 'none'; }
    } catch (e) {
      toast('工程フローの取得に失敗しました: ' + e.message, 'error');
    }
    render();   // renders the empty-state panel + CTA when flow is empty
  })();

  return { dispose() { el.innerHTML = ''; }, refresh() {} };
}
