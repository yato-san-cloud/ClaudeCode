// materialflow.js — マテリアルフロー画面（荷役物量の作成）.
// 工程フロー(入荷検品→格納→ピッキング→検品→梱包→出荷)に荷役物量を：
//   ・実データ(サンプル/出荷取込)から自動充填
//   ・不足は手入力 or 生成(比率推計)で作成
// → そのまま「タイムチャートで人員配置」へ渡す（whsim.analysis.staffing と同契約）。
//
// 物量の流れは ECharts の sankey 図で可視化（工程間の辺に、人時を太さに）。
// 入力カードはそのまま編集可能；値を変えると sankey は in-place に更新（入力フォーカス
// を壊さない）。テーマは CSS 変数を getComputedStyle で参照し themechange で再描画。
//
// 工程エディタは「順番」だけでなく「どう運ぶか」も持つ（whsim/flowgraph.py の唯一の
// フローグラフ = GET/POST /api/projects/{name}/flow）:
//   ・シミュ挙動 (role)   — 自由に名付けた業務工程を、エンジンのどの動きに載せるか
//   ・搬送手段 (transport) — その工程へ物が届く手段（辺の属性）＋ 使用設備 (equipment_ref)
// 辺は sankey の色にも反映され、「どれだけ流れるか」に加えて「どう運ぶか」が図で読める。
import * as echarts from 'echarts';

// Badge tints are HTML inline styles, so theme tokens (CSS vars) resolve fine.
const SRC = { data: { t: '実データ', c: '#2ee6a0' }, manual: { t: '手入力', c: 'var(--ink-tertiary,#8195a8)' },
              generated: { t: '生成', c: '#f5b05a' }, bi: { t: '基礎物量', c: '#34e3ff' },
              none: { t: '未入力', c: '#8195a8' } };
// Per-process node colours in the sankey, keyed by 工程セクション.
const SECTION_HEX = { 入荷: '#5B9BD5', 出荷: '#16C0DE' };

// ── the ONE flow graph の語彙 (whsim/flowgraph.py と対応) ──────────────────
// transport: how goods reach a process. Values are the server's; labels are 業務用語.
const TRANSPORTS = ['manual', 'conveyor', 'agv', 'forklift', 'asrs'];
const TRANSPORT_JA = { manual: '人手', conveyor: 'コンベア', agv: 'AGV',
                       forklift: 'フォークリフト', asrs: '自動倉庫' };
// Sankey link colour per 搬送手段 — CSS custom properties injected below, so the
// palette follows the theme (no hard-coded hex in the drawing code).
const TRANSPORT_VAR = { manual: '--mf-tr-manual', conveyor: '--mf-tr-conveyor',
                        agv: '--mf-tr-agv', forklift: '--mf-tr-forklift', asrs: '--mf-tr-asrs' };
// role: which engine behaviour a freely-named business process drives. The list
// itself comes from the API (`roles`); this is only the display vocabulary.
const ROLE_JA = { receive: '入荷', putaway: '格納', pick: 'ピッキング', pack: '梱包',
                  ship: '出荷', inspect: '検品', none: '計上のみ' };
const ROLES_FALLBACK = ['receive', 'putaway', 'pick', 'pack', 'ship'];
const MIXED = '__mixed';   // sentinel: this process is fed by several different means

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  /* 搬送手段パレット: theme-aware tokens (light default / dark override), read by
     the sankey through getComputedStyle so a themechange repaints the links. */
  :root{--mf-tr-manual:#7A8899;--mf-tr-conveyor:#2E7D55;--mf-tr-agv:#1F78B4;
        --mf-tr-forklift:#B7791F;--mf-tr-asrs:#7A4FBF}
  html[data-theme="dark"]{--mf-tr-manual:#9AAABC;--mf-tr-conveyor:#2EE6A0;--mf-tr-agv:#5CB8FF;
        --mf-tr-forklift:#F5B05A;--mf-tr-asrs:#B694FF}
  .mf{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  .mf-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .mf-btn{padding:9px 15px;border-radius:10px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent);color:var(--accent,#16C0DE);font-weight:600;cursor:pointer;font:inherit}
  .mf-btn.primary{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  .mf-btn:hover{filter:brightness(1.07)} .mf-btn:disabled{opacity:.5;cursor:default}
  .mf-btn:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
  @media(prefers-reduced-motion:reduce){.mf-btn{transition:none}}
  .mf-hint{font-size:12px;color:var(--ink-tertiary,#8195a8)}
  /* zero-volume guidance: shown when 工程はあるが荷役物量が未入力のとき、
     どのボタンを押せばよいかを一言で案内する（空の画面で手が止まらないように）。*/
  .mf-guide{font-size:13px;line-height:1.55;color:var(--ink-secondary,#52677c);
    background:color-mix(in srgb,var(--accent,#16C0DE) 8%,transparent);
    border:1px solid color-mix(in srgb,var(--accent,#16C0DE) 30%,transparent);
    border-radius:10px;padding:9px 13px}
  .mf-guide b{color:var(--ink-primary,#16202e)}
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
  /* 搬送手段の凡例（サンキーのリボン色＝運び方）*/
  .mf-legend{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:2px 0 6px}
  .mf-lg{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--ink-secondary,#52677c)}
  .mf-lg i{width:14px;height:4px;border-radius:2px;display:inline-block}
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
  /* 設計の注意（警告のみ。実行は止めない）*/
  .mf-diag{background:var(--warn-tint,#fbf3e4);border:1px solid var(--warn-line,#efdfbe);
    border-radius:11px;padding:9px 13px}
  .mf-diag-h{display:flex;align-items:baseline;gap:8px;font-size:12.5px;font-weight:700;
    color:var(--warn-ink,#8a5a12)}
  .mf-diag-sub{font-size:11px;font-weight:500;color:var(--ink-tertiary,#8195a8)}
  .mf-diag-l{margin:5px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:2px}
  .mf-diag-l li{font-size:12px;line-height:1.5;color:var(--ink-secondary,#52677c)}
  /* 工程エディタ (完全フリー工程) */
  .mfe{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:13px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;overflow-x:auto}
  .mfe-head{font-size:13px;font-weight:700;color:var(--ink-primary,#16202e)}
  .mfe-head .mfe-sub{font-size:11px;font-weight:500;color:var(--ink-tertiary,#8195a8);margin-left:8px}
  .mfe-help{font-size:11px;line-height:1.6;color:var(--ink-tertiary,#8195a8)}
  .mfe-row{display:grid;
    grid-template-columns:42px 1fr .6fr 1.15fr .8fr .42fr 1.45fr 1.65fr 26px;
    gap:7px;align-items:center;min-width:900px}
  .mfe-tr{display:flex;gap:4px;min-width:0}
  .mfe-tr select{flex:1 1 0;min-width:0}
  .mfe-in[disabled]{opacity:.5}
  .mfe-gh{font-size:10.5px;color:var(--ink-tertiary,#8195a8);padding:2px 0 0}
  .mfe-ord{display:flex;flex-direction:column;gap:1px}
  .mfe-mv{border:1px solid var(--line,#ccd);background:var(--bg-app,#fff);border-radius:5px;
    color:var(--ink-secondary,#52677c);font-size:10px;line-height:1.1;cursor:pointer;padding:0 4px}
  .mfe-mv:disabled{opacity:.35;cursor:default}
  .mfe-in{width:100%;background:var(--bg-app,#fff);border:1px solid var(--line,#ccd);border-radius:7px;
    padding:6px 8px;font:inherit;font-size:12.5px;color:var(--ink-primary,#16202e)}
  .mfe-in:focus{outline:none;border-color:var(--accent,#16C0DE)}
  .mfe-num{text-align:right}
  .mfe-deps{display:flex;gap:3px;flex-wrap:wrap}
  .mfe-dep{border:1px solid var(--line,#ccd);background:var(--bg-app,#fff);border-radius:999px;
    color:var(--ink-tertiary,#8195a8);font-size:10.5px;cursor:pointer;padding:2px 8px}
  .mfe-dep.on{background:var(--accent-tint,#E4F8FC);border-color:var(--accent,#16C0DE);
    color:var(--accent-ink,var(--accent,#16C0DE));font-weight:700}
  .mfe-nodep{font-size:11px;color:var(--ink-faint,#aab)}
  .mfe-del{border:none;background:transparent;color:var(--ink-tertiary,#8195a8);font-size:16px;
    line-height:1;cursor:pointer;padding:0}
  .mfe-del:hover{color:#e3401c}
  .mfe-foot{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;min-width:900px}
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
  let drivers = [];              // [{id,label,unit}] volume-source catalogue (from API)
  let editing = false;           // 工程エディタ open?
  let editFlow = null;           // working copy while editing (cancel restores `flow`)
  // Live 工程→エリア chain from the designer's spatial flow (process.stages).
  // Reflected in real time via the `whsim:flow-changed` bus + an initial fetch.
  let stages = [];               // [{id,label,method,zone_type,area_ok,area_warn}]
  // ── the ONE flow graph (GET/POST …/flow) ────────────────────────────────
  // `graph` is the resolved graph: nodes (with role), edges (搬送手段/使用設備/分岐率),
  // the equipment an edge may name, and the diagnostics. Absent/older server ⇒
  // stays empty and everything falls back to the depends-only behaviour.
  let graph = emptyGraph();
  let editEdges = null;          // working copy of edges while editing
  let flowDirty = false;         // did the user touch 搬送手段/使用設備 this session?
  let procMeta = {};             // id → {role, zone} as AUTHORED in the master
  let metaLoaded = false;
  let graphSeq = 0;              // drop out-of-order /flow responses

  function emptyGraph() {
    return { nodes: [], edges: [], equipment: [], roles: [], authored: false, diagnostics: [] };
  }

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

  // ── flow graph: load / lookup / save ──────────────────────────────────────
  // never-blocks: no project, an older server (404) or a bare model all resolve to
  // the empty graph, and every consumer below treats that as "順番だけ分かっている".
  async function loadGraph() {
    const name = getProject();
    if (!name) { graph = emptyGraph(); return; }
    const seq = ++graphSeq;
    try {
      const g = await getJSON(`/api/projects/${encodeURIComponent(name)}/flow`);
      if (seq !== graphSeq) return;
      graph = {
        nodes: Array.isArray(g.nodes) ? g.nodes : [],
        edges: Array.isArray(g.edges) ? g.edges : [],
        equipment: Array.isArray(g.equipment) ? g.equipment : [],
        roles: Array.isArray(g.roles) && g.roles.length ? g.roles : ROLES_FALLBACK,
        authored: !!g.authored,
        diagnostics: Array.isArray(g.diagnostics) ? g.diagnostics : [],
      };
    } catch (_e) {
      if (seq === graphSeq) graph = emptyGraph();
    }
  }

  // Pull both halves the editor needs: the graph (roles as resolved + edges) and
  // the master's AUTHORED role/zone (so 未設定 stays 未設定 instead of being frozen
  // into whatever the name-based guess happened to be).
  async function ensureFlowData(force) {
    const jobs = [loadGraph()];
    if (force || !metaLoaded) jobs.push(loadStagesFromModel());
    await Promise.all(jobs);
  }

  const nodeById = (id) => (graph.nodes || []).find((n) => n.id === id) || null;
  // The role the engine would use today: authored value, else the graph's guess.
  const guessedRole = (id) => { const n = nodeById(id); return n ? (n.role || '') : ''; };

  // Physical objects an edge may name for a given 搬送手段. コンベア legs bind to a
  // drawn belt; the others bind to placed equipment. 人手 needs no machine.
  function equipChoices(transport) {
    const list = graph.equipment || [];
    if (transport === 'conveyor') return list.filter((e) => e.kind === 'conveyor');
    if (!transport || transport === 'manual' || transport === MIXED) return [];
    return list.filter((e) => e.kind !== 'conveyor');
  }

  // The edges feeding a process, from the working copy (editor) or the graph.
  const inboundOf = (key) => (editEdges || graph.edges || []).filter((e) => e.dst === key);
  // What the two selects should show for a process: the shared 搬送手段/使用設備 of
  // its inbound legs, or MIXED when its legs disagree (混在, never silently picked).
  function inboundState(key) {
    const ins = inboundOf(key);
    if (!ins.length) return { transport: 'manual', equipment_ref: '', missing: true };
    const t = [...new Set(ins.map((e) => e.transport || 'manual'))];
    const q = [...new Set(ins.map((e) => e.equipment_ref || ''))];
    return { transport: t.length > 1 ? MIXED : t[0],
             equipment_ref: q.length > 1 ? '' : q[0], missing: false };
  }
  // Write a change onto every leg arriving at this process (材料は同じ工程に同じ
  // 手段で届く、が既定の読み). No inbound leg yet ⇒ author the entry leg.
  function setInbound(key, patch) {
    if (!editEdges) editEdges = (graph.edges || []).map((e) => ({ ...e }));
    const ins = editEdges.filter((e) => e.dst === key);
    if (!ins.length) {
      editEdges.push({ src: '', dst: key, transport: 'manual', equipment_ref: '',
                       share: 1, derived: false, ...patch });
    } else {
      ins.forEach((e) => Object.assign(e, patch, { derived: false }));
    }
    flowDirty = true;
  }

  // Persist the authored edges. Renames are remapped first (an edge naming a
  // process that was just renamed would otherwise be dropped server-side), then
  // 分岐率 is normalised per 前工程 so a split always adds up to 100%.
  async function saveEdges(rename) {
    const name = getProject();
    if (!name || !editEdges) return;
    const alive = new Set(flow.map((p) => p.id));
    const rows = editEdges.map((e) => ({
      src: rename[e.src] || e.src || '',
      dst: rename[e.dst] || e.dst || '',
      transport: e.transport || 'manual',
      equipment_ref: e.equipment_ref || '',
      share: Number(e.share) > 0 ? Number(e.share) : 1,
    })).filter((e) => e.dst && alive.has(e.dst) && (!e.src || alive.has(e.src)));
    const bySrc = {};
    rows.forEach((e) => { if (e.src) bySrc[e.src] = (bySrc[e.src] || 0) + e.share; });
    rows.forEach((e) => { if (e.src && bySrc[e.src] > 0) e.share = e.share / bySrc[e.src]; });
    await getJSON(`/api/projects/${encodeURIComponent(name)}/flow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edges: rows }),
    });
  }

  // Broadcast so ③設計フロー (and any other flow surface) re-reads the graph.
  // `stages` rides along because that is what the existing bus carries.
  function announceFlow() {
    document.dispatchEvent(new CustomEvent('whsim:flow-changed',
      { detail: { stages, source: 'materialflow' } }));
  }

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

  const trColor = (t) => cssColor(TRANSPORT_VAR[t] || TRANSPORT_VAR.manual, '#7A8899');

  // The legs to draw: the authored/derived flow graph when we have it, else the
  // depends-only fallback (no project / older server) with everything as 人手.
  function flowLegs() {
    const byId = {}; flow.forEach((f) => { byId[f.id] = f; });
    const fromGraph = (graph.edges || []).filter((e) => e.dst && byId[e.dst]);
    if (fromGraph.length) {
      return fromGraph.map((e) => ({
        src: e.src && byId[e.src] ? e.src : '', dst: e.dst,
        transport: TRANSPORT_JA[e.transport] ? e.transport : 'manual',
        share: Number(e.share) > 0 ? Number(e.share) : 1,
      }));
    }
    const legs = [];
    flow.forEach((f) => {
      const ups = (f.depends || []).filter((d) => byId[d]);
      if (!ups.length) legs.push({ src: '', dst: f.id, transport: 'manual', share: 1 });
      ups.forEach((d) => legs.push({ src: d, dst: f.id, transport: 'manual', share: 1 }));
    });
    return legs;
  }

  // Build the sankey option from the current flow + volumes. Nodes are processes
  // (value = 荷役物量); links follow the flow graph (前工程→この工程), weighted by
  // the downstream process man-hours × 分岐率 so ribbon thickness reads as "work
  // passed along the flow", and COLOURED by 搬送手段 so the diagram also shows HOW
  // the goods move. Legs with no 前工程 get a virtual section entry node.
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
    // links: weight = downstream man-hours × 分岐率 (min 0.5 so a 0-volume leg still
    // draws a hairline); colour = 搬送手段. Self-loops are dropped (sankey needs a DAG).
    const links = [];
    const entries = new Set();
    flowLegs().forEach((leg) => {
      const f = byId[leg.dst];
      if (!f || leg.src === leg.dst) return;
      let source = leg.src;
      if (!source) { source = `${f.section}（入口）`; entries.add(source); }
      const w = Math.max(0.5, manHours(f) * leg.share);
      links.push({ source, target: leg.dst, value: w,
        transport: leg.transport, share: leg.share,
        lineStyle: { color: hexAlpha(trColor(leg.transport), 0.42) } });
    });
    // section entry nodes (so 前工程のない工程 still have an inbound ribbon)
    entries.forEach((name) => nodes.push({
      name,
      itemStyle: { color: hexAlpha(SECTION_HEX[name.replace('（入口）', '')] || p.accent, 0.5) },
      label: { color: p.ink2, fontFamily: p.fontMono, fontSize: 10 },
    }));
    return {
      animation: !reduceMotion(),
      tooltip: {
        trigger: 'item',
        backgroundColor: p.panel, borderColor: p.lineStrong, borderWidth: 1,
        textStyle: { color: p.ink, fontSize: 12, fontFamily: p.fontSans },
        extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.16);',
        formatter: (d) => {
          if (d.dataType === 'edge') {
            const t = TRANSPORT_JA[d.data.transport] || TRANSPORT_JA.manual;
            const sh = d.data.share == null ? 1 : Number(d.data.share);
            const split = sh < 0.999 ? ` ・ 分岐率 ${(sh * 100).toFixed(0)}%` : '';
            return `${esc(d.data.source)} → ${esc(d.data.target)}<br>搬送手段 ${esc(t)}${split}`
              + `<br>人時 ${Number(d.data.value).toFixed(1)}`;
          }
          const f = byId[d.name];
          if (!f) return esc(d.name);
          const n = nodeById(f.id);
          const only = n && !n.simulated ? '<br>計上のみ（シミュレーション対象外）' : '';
          return `<b>${esc(d.name)}</b><br>荷役物量 ${fmt(vol[f.id] || 0)} ${f.unit ? `(${esc(f.unit)})` : ''}`
            + `<br>人時 ${manHours(f).toFixed(1)}${only}`;
        },
      },
      series: [{
        type: 'sankey', left: 8, right: 110, top: 12, bottom: 12,
        nodeWidth: 16, nodeGap: 12, draggable: false,
        emphasis: { focus: 'adjacency' },
        data: nodes, links,
        label: { color: p.ink, fontFamily: p.fontSans, fontSize: 11 },
        // NOT 'gradient': every ribbon carries its own 搬送手段 colour, and a
        // source→target blend would wash that encoding out.
        lineStyle: { curveness: 0.5, opacity: 0.55 },
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

  // Legend for the ribbon colours — only the 搬送手段 actually used, so a 人手だけ
  // の倉庫に AGV の凡例が並ぶことはない。
  function legendHtml() {
    const used = [...new Set(flowLegs().map((l) => l.transport))];
    if (!used.length) return '';
    const items = TRANSPORTS.filter((t) => used.includes(t)).map((t) =>
      `<span class="mf-lg"><i style="background:var(${TRANSPORT_VAR[t]})"></i>${esc(TRANSPORT_JA[t])}</span>`).join('');
    return `<span class="mf-lg" style="color:var(--ink-tertiary)">搬送手段</span>${items}`;
  }
  function renderLegend() {
    const host = root.querySelector('[data-mf-legend]');
    if (host) host.innerHTML = legendHtml();
  }

  // 設計の注意: warnings from the flow graph (未接続の工程・配置されていない設備・
  // 分岐率の合計 など). Advisory only — nothing here blocks a run.
  function diagHtml() {
    const ds = (graph.diagnostics || []).filter((d) => d && d.message);
    if (!ds.length) return '';
    const items = ds.map((d) => `<li>${esc(d.message)}</li>`).join('');
    return `<div class="mf-diag">
      <div class="mf-diag-h">⚠ フローの注意 ${ds.length}件
        <span class="mf-diag-sub">このままでも実行できます（設計を見直す目安です）</span></div>
      <ul class="mf-diag-l">${items}</ul></div>`;
  }
  function renderDiag() {
    const host = root.querySelector('[data-mf-diag]');
    if (host) host.innerHTML = diagHtml();
  }

  // Everything that reads the flow graph, refreshed in place (no innerHTML rebuild
  // of the page → typing / selects keep focus).
  function renderGraphBits() {
    renderDiag();
    renderLegend();
    if (root.querySelector('[data-mf-sankey]')) updateSankey();
  }

  function renderEmpty() {
    disposeSankey();
    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn primary" data-act="fromproject" title="①取込で読み込んだ出荷実績から荷役物量を作成">📥 取込データから</button>
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload" title="手元の別の出荷CSV/Excelを取り込む">別ファイルを取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
       </div>
       <div class="mf-empty">
         <div class="mf-empty-title">工程フローがまだありません</div>
         <div class="mf-empty-body">①取込の出荷実績を取り込むと、工程ごとの荷役物量がここに表示されます。「📥 取込データから」で取込済みデータを反映、まずは試すならサンプルでも始められます。</div>
         <button class="mf-btn primary" data-act="fromproject">取込データから始める</button>
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
    // ①取込済みの出荷実績から埋めるのが第一導線。まだ物量が無いときは
    // その一手をハイライトし、空の画面で迷わせない。
    const guide = anyVol ? '' :
      `<div class="mf-guide">①取込の出荷実績はまだ反映されていません。<b>「📥 取込データから」</b>`
      + `を押すと、取り込んだデータから工程ごとの荷役物量を自動作成します（再アップロード不要）。</div>`;
    root.innerHTML =
      `<div class="mf-bar">
        <button class="mf-btn primary" data-act="fromproject" title="①取込で読み込んだ出荷実績から荷役物量を作成（再アップロード不要）">📥 取込データから</button>
        <button class="mf-btn" data-act="frombi">基礎物量を取込</button>
        <button class="mf-btn" data-act="sample">サンプル物量を取込</button>
        <button class="mf-btn" data-act="upload" title="手元の別の出荷CSV/Excelを追加で取り込む">別ファイルを取込</button>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
        <button class="mf-btn" data-act="generate">不足を生成</button>
        <button class="mf-btn" data-act="editproc">${editing ? '編集中…' : '工程を編集'}</button>
        <span class="mf-recalc" data-mf-recalc aria-live="polite">再計算中…</span>
        <button class="mf-btn primary" data-act="timetable" style="margin-left:auto">タイムチャートで人員配置 →</button>
       </div>
       <span class="mf-hint">工程ごとの荷役物量（1日平均）。データから取込・不足は手入力/生成し、人員配置へ。</span>
       ${guide}
       ${editorHtml()}
       <div data-mf-diag>${diagHtml()}</div>
       <div data-mf-chain>${chainHtml()}</div>
       <div class="mf-kpis">
         <div class="mf-kpi"><div class="l">総工数</div><div class="v"><span data-kpi="totalMH">${totalMH.toFixed(1)}</span> <small>人時/日</small></div></div>
         <div class="mf-kpi"><div class="l">入力済み工程</div><div class="v"><span data-kpi="filled">${filled}</span> <small>/ ${flow.length}</small></div></div>
         <div class="mf-kpi"><div class="l">工程数</div><div class="v">${flow.length}</div></div>
       </div>
       <div class="mf-sankey-wrap">
         <div class="mf-sankey-h"><h3>マテリアルフロー</h3><span class="sub">工程間の流れ（リボン幅 = 人時 / 色 = 搬送手段）</span></div>
         <div class="mf-legend" data-mf-legend>${anyVol ? legendHtml() : ''}</div>
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

  // ①取込で読み込んだ出荷実績 (project の解析バンドル) から荷役物量を直接充填する。
  // 「別ファイルを取込」が新規ファイルのアップロードなのに対し、こちらは 取込済みの
  // データをそのまま使う — 営業が最初に押すべき導線。bi 保存も再アップロードも不要。
  async function fromProject() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    root.querySelectorAll('[data-act]').forEach((b) => (b.disabled = true));
    setBusy(true);
    try {
      const b = await getJSON(`/api/projects/${encodeURIComponent(name)}/analysis/bundle`);
      const procs = (b && b.staffing && b.staffing.processes) || [];
      const map = {};
      let n = 0;
      procs.forEach((p) => {
        map[p.id] = p.daily_volume;
        if ((p.daily_volume || 0) > 0) n += 1;
      });
      if (!n) {
        render();
        toast('取込済みの出荷データが見つかりません。①取込で出荷実績を読み込んでください。', 'info');
        return;
      }
      setVolumes(map, 'data');
      render();
      toast(`取込データから ${n} 工程に荷役物量を反映しました。`, 'ok');
    } catch (e) {
      toast('取込に失敗しました: ' + (e && e.message ? e.message : e), 'error');
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

  // ── 工程エディタ (完全フリー工程: add / rename / reorder / depend / delete) ──

  // シミュ挙動: which engine behaviour this freely-named process drives. ""(未設定)
  // keeps the name-based auto-判定 the server does, so the option spells out what
  // that judgement currently is instead of hiding it.
  function roleOptions(cur, guess) {
    const list = (graph.roles && graph.roles.length) ? graph.roles : ROLES_FALLBACK;
    const auto = guess && guess !== 'none'
      ? `（自動:${ROLE_JA[guess] || guess}）` : '（自動判定）';
    const out = [`<option value=""${cur === '' ? ' selected' : ''}>未設定${esc(auto)}</option>`];
    list.forEach((r) => out.push(
      `<option value="${esc(r)}"${cur === r ? ' selected' : ''}>${esc(ROLE_JA[r] || r)}</option>`));
    out.push(`<option value="none"${cur === 'none' ? ' selected' : ''}>計上のみ（シミュ対象外）</option>`);
    // a value this build does not know (e.g. 検品) must survive a round-trip
    if (cur && cur !== 'none' && !list.includes(cur)) {
      out.push(`<option value="${esc(cur)}" selected>${esc(ROLE_JA[cur] || cur)}</option>`);
    }
    return out.join('');
  }

  function transportOptions(cur) {
    const out = TRANSPORTS.map((t) =>
      `<option value="${t}"${cur === t ? ' selected' : ''}>${esc(TRANSPORT_JA[t])}</option>`);
    if (cur === MIXED) out.unshift(`<option value="${MIXED}" selected>混在</option>`);
    return out.join('');
  }

  function equipOptions(transport, cur) {
    const choices = equipChoices(transport);
    const out = [`<option value=""${cur ? '' : ' selected'}>指定なし</option>`];
    choices.forEach((c) => out.push(
      `<option value="${esc(c.id)}"${c.id === cur ? ' selected' : ''}>${esc(c.label || c.id)}</option>`));
    // keep a binding to a machine that is no longer placed (診断で警告される)
    if (cur && !choices.some((c) => c.id === cur)) {
      out.push(`<option value="${esc(cur)}" selected>${esc(cur)}（未配置）</option>`);
    }
    return out.join('');
  }

  function editorHtml() {
    if (!editing) return '';
    const ef = editFlow || [];
    const driverOpts = (sel) => drivers.map((d) =>
      `<option value="${esc(d.id)}"${d.id === sel ? ' selected' : ''}>${esc(d.label)}</option>`).join('');
    const rows = ef.map((p, i) => {
      const deps = ef.filter((q) => q.id !== p.id).map((q) => {
        const on = (p.depends || []).includes(q.id);
        return `<button type="button" class="mfe-dep${on ? ' on' : ''}" data-edep="${i}" data-depid="${esc(q.id)}">${esc(q.id)}</button>`;
      }).join('');
      // 搬送手段 describes the leg INTO this process — keyed by the id the saved
      // edges still use (_origId), so an in-flight rename keeps its binding.
      const st = inboundState(p._origId || p.id);
      const noEquip = !equipChoices(st.transport).length && !st.equipment_ref;
      return `<div class="mfe-row">
        <span class="mfe-ord">
          <button type="button" class="mfe-mv" data-emove="${i}" data-dir="-1" title="上へ"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="mfe-mv" data-emove="${i}" data-dir="1" title="下へ"${i === ef.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
        <input class="mfe-in" data-efield="id" data-i="${i}" value="${esc(p.id)}" aria-label="工程名"/>
        <input class="mfe-in" data-efield="section" data-i="${i}" value="${esc(p.section || '')}" aria-label="セクション"/>
        <select class="mfe-in" data-efield="role" data-i="${i}" aria-label="シミュ挙動"
          title="この工程をシミュレーションでどの動きとして扱うか">${roleOptions(p.role || '', guessedRole(p._origId || p.id))}</select>
        <select class="mfe-in" data-efield="driver" data-i="${i}" aria-label="物量ドライバ">${driverOpts(p.driver)}</select>
        <input class="mfe-in mfe-num" type="number" min="1" step="1" data-efield="productivity" data-i="${i}" value="${p.productivity || 60}" aria-label="生産性"/>
        <span class="mfe-deps">${deps || '<span class="mfe-nodep">—</span>'}</span>
        <span class="mfe-tr">
          <select class="mfe-in" data-etr="${i}" aria-label="搬送手段"
            title="前工程からこの工程へ物が届く手段">${transportOptions(st.transport)}</select>
          <select class="mfe-in" data-eeq="${i}" aria-label="使用設備"
            title="その搬送に使う設備"${noEquip ? ' disabled' : ''}>${equipOptions(st.transport, st.equipment_ref)}</select>
        </span>
        <button type="button" class="mfe-del" data-edel="${i}" title="工程を削除">×</button>
      </div>`;
    }).join('');
    return `<div class="mfe">
      <div class="mfe-head">工程の編集 <span class="mfe-sub">ドライバ＝物量の出所 / 生産性＝既定値（実測・想定が優先）/ 依存＝前工程</span></div>
      <div class="mfe-help">シミュ挙動＝この工程をシミュレーションのどの動きとして扱うか。「計上のみ」の工程は人員・原価には計上されますが、シミュレーションでは動きません。搬送手段＝前工程からこの工程へ物が届く手段（工程間搬送）で、使用設備まで指定できます。</div>
      <div class="mfe-row mfe-gh"><span></span><span>工程名</span><span>セクション</span><span>シミュ挙動</span><span>物量ドライバ</span><span>生産性</span><span>前工程（依存）</span><span>搬送手段・使用設備</span><span></span></div>
      ${rows}
      <div class="mfe-foot">
        <button class="mf-btn" data-act="addproc">＋ 工程を追加</button>
        <button class="mf-btn" data-act="resetproc">標準フローに戻す</button>
        <button class="mf-btn" data-act="resetedges" title="工程間搬送を工程の順番どおりの既定に戻す">搬送手段を自動に戻す</button>
        <span style="margin-left:auto"></span>
        <button class="mf-btn" data-act="canceledit">キャンセル</button>
        <button class="mf-btn primary" data-act="saveproc">保存</button>
      </div>
    </div>`;
  }

  // Opening the editor pulls the flow graph first (roles + 搬送手段 must be the
  // live ones), then builds the working copies. never-blocks: a failed fetch just
  // means an empty graph, and the editor still opens with 未設定/人手.
  async function enterEdit() {
    setBusy(true);
    try { await ensureFlowData(true); } finally { setBusy(false); }
    editFlow = flow.map((p) => ({
      id: p.id, _origId: p.id, section: p.section || '出荷', driver: p.driver || 'out_lines',
      productivity: p.productivity || 60, unit: p.unit || '行/h',
      depends: [...(p.depends || [])],
      // AUTHORED role/zone (not the name-based guess) so 未設定 stays 未設定
      role: (procMeta[p.id] || {}).role || '',
      zone: (procMeta[p.id] || {}).zone || '',
    }));
    editEdges = (graph.edges || []).map((e) => ({ ...e }));
    flowDirty = false;
    editing = true; render();
  }
  function cancelEdit() {
    editing = false; editFlow = null; editEdges = null; flowDirty = false; render();
  }
  function addProcess() {
    let n = 1, id = '新工程';
    const ids = new Set((editFlow || []).map((p) => p.id));
    while (ids.has(id)) { n += 1; id = `新工程${n}`; }
    // _origId is the stable key its 搬送手段 edge is filed under while editing.
    (editFlow = editFlow || []).push(
      { id, _origId: id, section: '出荷', driver: 'out_lines', productivity: 60,
        unit: '行/h', depends: [], role: '', zone: '' });
    render();
  }
  function deleteProcess(i) {
    const row = editFlow[i];
    const gone = row && row.id;
    const key = row && (row._origId || row.id);
    editFlow.splice(i, 1);
    if (gone) editFlow.forEach((p) => { p.depends = (p.depends || []).filter((d) => d !== gone); });
    // its 工程間搬送 goes with it, else the save would post a dangling leg
    if (key && editEdges) editEdges = editEdges.filter((e) => e.src !== key && e.dst !== key);
    render();
  }
  // 搬送手段 of the leg INTO row i. Changing the means re-scopes the 使用設備 list,
  // so the equipment <select> is rebuilt in place (no full render → keeps focus).
  function setTransport(i, val) {
    const p = editFlow && editFlow[i];
    if (!p || val === MIXED) return;
    const key = p._origId || p.id;
    const cur = inboundState(key);
    const ok = equipChoices(val).some((c) => c.id === cur.equipment_ref);
    setInbound(key, { transport: val, equipment_ref: ok ? cur.equipment_ref : '' });
    refreshEquipCell(i);
  }
  function setEquipment(i, val) {
    const p = editFlow && editFlow[i];
    if (!p) return;
    const key = p._origId || p.id;
    setInbound(key, { equipment_ref: val });
  }
  function refreshEquipCell(i) {
    const p = editFlow && editFlow[i];
    const sel = root.querySelector(`[data-eeq="${i}"]`);
    if (!p || !sel) return;
    const st = inboundState(p._origId || p.id);
    sel.innerHTML = equipOptions(st.transport, st.equipment_ref);
    sel.disabled = !equipChoices(st.transport).length && !st.equipment_ref;
  }
  function moveProcess(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= editFlow.length) return;
    [editFlow[i], editFlow[j]] = [editFlow[j], editFlow[i]];
    render();
  }
  function toggleDep(i, depid) {
    const p = editFlow[i]; if (!p) return;
    const set = new Set(p.depends || []);
    if (set.has(depid)) set.delete(depid); else set.add(depid);
    p.depends = [...set]; render();
  }
  function editField(i, field, val) {
    const p = editFlow[i]; if (!p) return;
    if (field === 'productivity') { p.productivity = Math.max(1, parseFloat(val) || 60); return; }
    if (field === 'driver') {
      p.driver = val;
      const d = drivers.find((x) => x.id === val);
      if (d && d.unit) p.unit = d.unit;  // keep unit in step with the driver
      return;
    }
    p[field] = val;   // id / section (free text) / role (シミュ挙動)
  }
  async function saveProcesses() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    // Renames: a process whose id changed in-edit must have downstream depends that
    // referenced its OLD id remapped to the new one, else the save-side prune would
    // silently orphan that precedence edge. Build old→new from _origId.
    const rename = {};
    (editFlow || []).forEach((p) => {
      const id = (p.id || '').trim();
      if (p._origId && id && p._origId !== id) rename[p._origId] = id;
    });
    const payload = (editFlow || []).map((p) => ({
      id: (p.id || '').trim(), section: p.section || '出荷', driver: p.driver || 'out_lines',
      prod: p.productivity || 60, unit: p.unit || '行/h',
      depends: (p.depends || []).map((d) => rename[d] || d),
      // シミュ挙動 + 床の割当は master 側の持ち物。zone は編集していないので、
      // 保存で消さないようそのまま書き戻す。
      role: p.role || '', zone: p.zone || '',
    })).filter((p) => p.id);
    setBusy(true);
    try {
      const r = await getJSON(`/api/projects/${encodeURIComponent(name)}/work-processes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processes: payload }),
      });
      flow = r.processes || [];
      // keep volumes for surviving ids; new ids start at 0.
      for (const p of flow) { if (vol[p.id] == null) { vol[p.id] = 0; src[p.id] = 'none'; } }
      // 工程間搬送: persist only when the user actually authored it (or the project
      // already had authored edges — a rename must not orphan them). Untouched ⇒
      // the graph stays DERIVED, i.e. 「工程の順番どおり」のまま。
      let edgeErr = null;
      if (flowDirty || graph.authored) {
        try { await saveEdges(rename); } catch (e2) { edgeErr = e2; }
      }
      editing = false; editFlow = null; editEdges = null; flowDirty = false;
      await loadGraph();
      metaLoaded = false;
      render();
      loadStagesFromModel();
      document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: { reason: 'work-processes' } }));
      announceFlow();
      if (edgeErr) {
        toast('工程は保存しましたが、搬送手段の保存に失敗しました: '
          + (edgeErr && edgeErr.message ? edgeErr.message : edgeErr), 'error');
      } else {
        toast(`工程を保存しました（${flow.length}工程）。原価・タイムチャートにも反映されます。`, 'ok');
      }
    } catch (e) { toast('工程の保存に失敗: ' + (e && e.message ? e.message : e), 'error'); }
    finally { setBusy(false); }
  }

  // 搬送手段を自動に戻す: clear the authored edges so the graph falls back to
  // 「工程の順番どおり」(derived). Immediate — it touches no process field.
  async function resetEdges() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    setBusy(true);
    try {
      await getJSON(`/api/projects/${encodeURIComponent(name)}/flow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edges: [] }),
      });
      await loadGraph();
      editEdges = (graph.edges || []).map((e) => ({ ...e }));
      flowDirty = false;
      render();
      announceFlow();
      toast('工程間の搬送手段を、工程の順番どおりの既定に戻しました。', 'ok');
    } catch (e) { toast('搬送手段のリセットに失敗: ' + (e && e.message ? e.message : e), 'error'); }
    finally { setBusy(false); }
  }
  async function resetProcesses() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    setBusy(true);
    try {
      const r = await getJSON(`/api/projects/${encodeURIComponent(name)}/work-processes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processes: [] }),
      });
      flow = r.processes || [];
      // reset clears the master's role/zone too, so the working copy starts blank
      // (未設定 = 工程名からの自動判定) and the edges are re-read from the graph.
      procMeta = {}; metaLoaded = false;
      editFlow = flow.map((p) => ({ ...p, _origId: p.id, role: '', zone: '',
        depends: [...(p.depends || [])] }));
      await loadGraph();
      editEdges = (graph.edges || []).map((e) => ({ ...e }));
      flowDirty = false;
      render();
      loadStagesFromModel();
      announceFlow();
      toast('標準フローに戻しました。', 'ok');
    } catch (e) { toast('リセットに失敗: ' + (e && e.message ? e.message : e), 'error'); }
    finally { setBusy(false); }
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
      // editor fields: update the working copy live (no re-render → keep focus).
      const ef = e.target.closest('[data-efield]');
      if (ef) { editField(parseInt(ef.dataset.i, 10), ef.dataset.efield, ef.value); return; }
      const inp = e.target.closest('input[data-id]');
      if (!inp) return;
      const id = inp.dataset.id;
      vol[id] = Math.max(0, parseFloat(inp.value) || 0);
      src[id] = 'manual';
      updateCard(id);
    });
    // driver / シミュ挙動 <select> fire 'change'; 搬送手段・使用設備 write flow edges.
    root.addEventListener('change', (e) => {
      const tr = e.target.closest('select[data-etr]');
      if (tr) { setTransport(parseInt(tr.dataset.etr, 10), tr.value); return; }
      const eq = e.target.closest('select[data-eeq]');
      if (eq) { setEquipment(parseInt(eq.dataset.eeq, 10), eq.value); return; }
      const ef = e.target.closest('select[data-efield]');
      if (ef) editField(parseInt(ef.dataset.i, 10), ef.dataset.efield, ef.value);
    });
    root.addEventListener('click', (e) => {
      // editor controls
      const mv = e.target.closest('[data-emove]');
      if (mv) { moveProcess(parseInt(mv.dataset.emove, 10), parseInt(mv.dataset.dir, 10)); return; }
      const del = e.target.closest('[data-edel]');
      if (del) { deleteProcess(parseInt(del.dataset.edel, 10)); return; }
      const dep = e.target.closest('[data-edep]');
      if (dep) { toggleDep(parseInt(dep.dataset.edep, 10), dep.dataset.depid); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'fromproject') fromProject();
      else if (act === 'sample') fromBundle(getJSON('/api/analysis/sample'), 'サンプル');
      else if (act === 'upload') { const fi = root.querySelector('[data-mf-file]'); if (fi) fi.click(); }
      else if (act === 'frombi') fromBI();
      else if (act === 'generate') generate();
      else if (act === 'timetable') toTimetable();
      else if (act === 'editproc') (editing ? cancelEdit() : enterEdit());
      else if (act === 'addproc') addProcess();
      else if (act === 'resetproc') resetProcesses();
      else if (act === 'resetedges') resetEdges();
      else if (act === 'canceledit') cancelEdit();
      else if (act === 'saveproc') saveProcesses();
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
  // Same bus, two payloads: `stages` (③設計フロー) refreshes the chain strip, and
  // ANY flow edit (ours excluded — we already refreshed) re-reads the flow graph so
  // 搬送手段の色・診断 follow the design live. Debounced: the designer emits on drag.
  let flowBusT = 0;
  const onFlow = (e) => {
    const d = (e && e.detail) || {};
    if (Array.isArray(d.stages)) applyStages(d.stages);
    if (d.source === 'materialflow') return;
    clearTimeout(flowBusT);
    flowBusT = setTimeout(() => {
      if (editing) return;   // don't swap the data under an open editor
      loadGraph().then(renderGraphBits);
    }, 250);
  };
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
      // AUTHORED role/zone per work process (the graph's role may be a name-based
      // guess; the editor must not freeze a guess into an explicit setting).
      procMeta = {};
      (proc.work_processes || []).forEach((w) => {
        if (w && w.id) procMeta[w.id] = { role: w.role || '', zone: w.zone || '' };
      });
      metaLoaded = true;
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

  // Load the work-process master: project-scoped (custom-aware) when a project is
  // open, else the global engine-default seed. Volumes reset per process.
  async function loadFlow() {
    const name = getProject();
    try {
      if (name) {
        const r = await getJSON(`/api/projects/${encodeURIComponent(name)}/work-processes`);
        flow = r.processes || [];
        drivers = r.drivers || [];
      } else {
        const seed = await getJSON('/api/materialflow/seed');
        flow = seed.flow || [];
      }
      for (const p of flow) { if (vol[p.id] == null) { vol[p.id] = 0; src[p.id] = 'none'; } }
    } catch (e) {
      toast('工程フローの取得に失敗しました: ' + e.message, 'error');
    }
  }

  (async () => {
    await loadFlow();
    render();
    loadStagesFromModel();
    // the graph only decorates (link colours + diagnostics) — fetched after the
    // first paint and applied in place, so a slow/absent endpoint never delays it.
    loadGraph().then(() => { if (!editing) renderGraphBits(); });
  })();

  return {
    dispose() {
      document.removeEventListener('themechange', onTheme);
      document.removeEventListener('whsim:flow-changed', onFlow);
      clearTimeout(flowBusT);
      graphSeq += 1;            // ignore any /flow response still in flight
      disposeSankey();
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener('resize', resizeSankey);
      el.innerHTML = '';
    },
    // re-pull the project's work-process master + 工程→エリア (on project change /
    // revisit), so a different project's custom processes show up.
    refresh() {
      if (editing) { loadStagesFromModel(); return; }  // don't clobber an open edit
      graph = emptyGraph(); procMeta = {}; metaLoaded = false;
      loadFlow().then(() => {
        render();
        loadStagesFromModel();
        loadGraph().then(() => { if (!editing) renderGraphBits(); });
      });
    },
    setStages: applyStages,
  };
}
