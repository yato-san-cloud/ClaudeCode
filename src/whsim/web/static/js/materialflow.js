// materialflow.js — ②分析「マテリアルフロー」.
//
// 画面の主役は **工程キャンバス**（`js/materialflow/canvas.js`）。ホワイトボードに
// 描く業務フローと同じ「箱と矢印」を、そのまま直接いじれる面にした:
//   ・工程を作る … 空白をダブルクリック
//   ・つなぐ     … 工程カードを別のカードへドラッグ
//   ・1本の流れを設計する … 矢印をクリック → 搬送手段・使用設備・荷姿(容器/台車)・
//                          入数・分岐率（入数はその場でカタログに保存＝別画面に行かない）
// これまでの sankey が持っていた情報（リボン幅＝物量）は、矢印の太さとして残っている。
// 表（工程エディタ）は一括編集用の補助ビューとして「表で編集」から出す。
//
// 荷役物量（1日平均）の作成はこれまでどおり:
//   ・実データ(サンプル/出荷取込/基礎物量)から自動充填
//   ・不足は手入力 or 生成(比率推計) → そのまま「タイムチャートで人員配置」へ
//
// フローの実体は whsim/flowgraph.py の唯一のフローグラフ（GET/POST
// /api/projects/{name}/flow）。③設計フローとは `whsim:flow-changed` で相互ライブ反映。
// EN comments / JA UI.

import { esc } from './util.js';
import {
  TRANSPORTS, TRANSPORT_JA, ROLE_JA, ROLES_FALLBACK, equipForTransport,
} from './materialflow/vocab.js';
import { mountFlowCanvas } from './materialflow/canvas.js';
import { fetchCatalogue } from './materialflow/loadunits.js';

// Badge tints are HTML inline styles, so theme tokens (CSS vars) resolve fine.
const SRC = { data: { t: '実データ', c: '#2ee6a0' }, manual: { t: '手入力', c: 'var(--ink-tertiary,#8195a8)' },
              generated: { t: '生成', c: '#f5b05a' }, bi: { t: '基礎物量', c: '#34e3ff' },
              none: { t: '未入力', c: '#8195a8' } };

const MIXED = '__mixed';   // sentinel: this process is fed by several different means

function injectStyle() {
  if (document.getElementById('mf-style')) return;
  const s = document.createElement('style');
  s.id = 'mf-style';
  s.textContent = `
  .mf{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 24px}
  /* 5 slots around a STABLE canvas host: 上部/キャンバス/表/読み取り値/物量カード。
     An empty slot must not leave a gap, and each stacked slot keeps its own rhythm. */
  .mf>div:empty{display:none}
  .mf>[data-mf-top]{display:flex;flex-direction:column;gap:12px}
  .mf>[data-mf-meta]{display:flex;flex-direction:column;gap:12px}
  .mf>[data-mf-cards]{display:flex;flex-direction:column;gap:6px}
  .mf-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .mf-btn{padding:9px 15px;border-radius:10px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent);color:var(--accent,#16C0DE);font-weight:600;cursor:pointer;font:inherit}
  .mf-btn.primary{background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  /* The button TIERS (primary / neutral ghost / the 基礎物量 bridge) are owned by
     the global stylesheet's #materialflow rules — this only groups them and
     tightens the padding so five sources read as one control, not five decisions. */
  .mf-bar .mf-grp .mf-btn{padding:9px 12px}
  .mf-grp{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:12px;padding:6px 10px 6px 6px}
  .mf-grp-l{order:-1;font-size:var(--fs-micro,10.5px);letter-spacing:.06em;color:var(--ink-tertiary,#8195a8);
    padding:0 4px 0 6px;white-space:nowrap}
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
  /* 工程エディタ (完全フリー工程 — キャンバスの補助として「表で編集」で開く) */
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

  let flow = [];                 // [{id, section, unit, productivity, driver, depends, role, zone}]
  const vol = {};                // {id: number}
  const src = {};                // {id: 'data'|'manual'|'generated'|'bi'|'none'}
  let drivers = [];              // [{id,label,unit}] volume-source catalogue (from API)
  let editing = false;           // 表で編集 (工程エディタ) open?
  let editFlow = null;           // working copy while editing (cancel restores `flow`)
  // Live 工程→エリア chain from the designer's spatial flow (process.stages).
  // Reflected in real time via the `whsim:flow-changed` bus + an initial fetch.
  let stages = [];               // [{id,label,method,zone_type,area_ok,area_warn}]
  // ── the ONE flow graph (GET/POST …/flow) ────────────────────────────────
  // `graph` is the resolved graph: nodes (with role), edges (搬送手段/使用設備/
  // 荷姿/分岐率), the equipment an edge may name, and the diagnostics. Absent or
  // older server ⇒ stays empty and everything falls back to depends-only.
  let graph = emptyGraph();
  let editEdges = null;          // working copy of edges while editing (table view)
  let flowDirty = false;         // did the user touch 搬送手段/使用設備 in the table?
  let graphSeq = 0;              // drop out-of-order /flow responses
  let loadUnits = null;          // 荷姿 catalogue {list,key} | null (未対応サーバ)
  let luProject = null;          // which project the catalogue was read for
  let canvas = null;             // the node-graph canvas (mounted once)
  let shell = false;

  function emptyGraph() {
    return { nodes: [], edges: [], equipment: [], roles: [], authored: false, diagnostics: [] };
  }

  async function getJSON(url, opt) {
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  const apiBase = () => `/api/projects/${encodeURIComponent(getProject())}`;
  const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });

  function manHours(p) { return (vol[p.id] || 0) / Math.max(1, p.productivity); }

  // ── flow graph: load / lookup / save ──────────────────────────────────────
  // never-blocks: no project, an older server (404) or a bare model all resolve to
  // the empty graph, and every consumer below treats that as "順番だけ分かっている".
  async function loadGraph() {
    const name = getProject();
    if (!name) { graph = emptyGraph(); return; }
    const seq = ++graphSeq;
    try {
      const g = await getJSON(`${apiBase()}/flow`);
      if (seq !== graphSeq) return;
      graph = {
        nodes: Array.isArray(g.nodes) ? g.nodes : [],
        edges: Array.isArray(g.edges) ? g.edges : [],
        equipment: Array.isArray(g.equipment) ? g.equipment : [],
        roles: Array.isArray(g.roles) && g.roles.length ? g.roles : ROLES_FALLBACK,
        authored: !!g.authored,
        diagnostics: Array.isArray(g.diagnostics) ? g.diagnostics : [],
      };
      // The flow payload mirrors the 荷姿 catalogue so the edge popover needs no
      // second fetch; an older server simply omits it (→ standalone fetch below).
      if (Array.isArray(g.load_units) && g.load_units.length) {
        loadUnits = { list: g.load_units, key: (loadUnits && loadUnits.key) || 'load_units' };
        luProject = name;
      }
    } catch (_e) {
      if (seq === graphSeq) graph = emptyGraph();
    }
  }

  // 荷姿カタログ (whsim/loadunit.py). Absent ⇒ the edge popover drops the 荷姿
  // section entirely — quietly, because an older server is not the user's problem.
  async function loadLoadUnits() {
    const name = getProject();
    if (!name) { loadUnits = null; luProject = null; return; }
    if (loadUnits && luProject === name) return;
    loadUnits = await fetchCatalogue(name);
    luProject = name;
  }

  const nodeById = (id) => (graph.nodes || []).find((n) => n.id === id) || null;
  // The role the engine would use today: authored value, else the graph's guess.
  const guessedRole = (id) => { const n = nodeById(id); return n ? (n.role || '') : ''; };

  // The edges feeding a process, from the working copy (table editor) or the graph.
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

  // Persist the table editor's authored edges. Renames are remapped first (an edge
  // naming a just-renamed process would otherwise be dropped server-side), then
  // 分岐率 is normalised per 前工程 so a split always adds up to 100%.
  async function saveEdgesFromTable(rename) {
    const name = getProject();
    if (!name || !editEdges) return;
    const alive = new Set(flow.map((p) => p.id));
    const rows = editEdges.map((e) => ({
      src: rename[e.src] || e.src || '',
      dst: rename[e.dst] || e.dst || '',
      transport: e.transport || 'manual',
      equipment_ref: e.equipment_ref || '',
      share: Number(e.share) > 0 ? Number(e.share) : 1,
      container_ref: e.container_ref || '',
      carrier_ref: e.carrier_ref || '',
    })).filter((e) => e.dst && alive.has(e.dst) && (!e.src || alive.has(e.src)));
    const bySrc = {};
    rows.forEach((e) => { if (e.src) bySrc[e.src] = (bySrc[e.src] || 0) + e.share; });
    rows.forEach((e) => { if (e.src && bySrc[e.src] > 0) e.share /= bySrc[e.src]; });
    await getJSON(`${apiBase()}/flow`, jsonPost({ edges: rows }));
  }

  // Broadcast so ③設計フロー (and any other flow surface) re-reads the graph.
  // `stages` rides along because that is what the existing bus carries.
  function announceFlow() {
    document.dispatchEvent(new CustomEvent('whsim:flow-changed',
      { detail: { stages, source: 'materialflow' } }));
  }

  // ── the node canvas ───────────────────────────────────────────────────────
  // The canvas owns direct manipulation; persistence goes back through these
  // callbacks so this module stays the single owner of loading + broadcasting.
  const canvasCtx = {
    toast,
    getProject,
    openTable: () => (editing ? cancelEdit() : enterEdit()),
    // Attribute-only save (搬送手段・使用設備・荷姿・分岐率): topology is unchanged,
    // so only the 診断 come back — the canvas keeps its edge objects, and the open
    // popover keeps editing the very leg the user clicked.
    async patchEdges(rows) {
      const name = getProject();
      if (!name) throw new Error('プロジェクトが開いていません');
      await getJSON(`${apiBase()}/flow`, jsonPost({ edges: rows }));
      // Re-read so the CACHE (which every later render pushes to the canvas) is
      // honest, but hand the canvas only the fresh 診断 — replacing its edges here
      // would yank the object the open popover is editing.
      await loadGraph();
      if (canvas) canvas.setDiagnostics(graph.diagnostics);
      announceFlow();
    },
    // Topology save. BOTH endpoints rewrite the whole model, so they run in
    // sequence — 工程マスタ first, because an authored leg naming a brand-new (or
    // renamed) 工程 is dropped server-side unless that id already exists.
    async saveFlow({ processes, rename, edges }) {
      const name = getProject();
      if (!name) throw new Error('プロジェクトが開いていません');
      const map = rename || {};
      if (processes) {
        const payload = processes.map((p) => ({
          id: String(p.id || '').trim(), section: p.section || '出荷',
          driver: p.driver || 'out_lines', prod: p.productivity || 60, unit: p.unit || '行/h',
          depends: (p.depends || []).map((d) => map[d] || d),
          role: p.role || '', zone: p.zone || '',
        })).filter((p) => p.id);
        const r = await getJSON(`${apiBase()}/work-processes`, jsonPost({ processes: payload }));
        // A renamed 工程 keeps its 荷役物量 — otherwise a typo fix would zero the day.
        Object.entries(map).forEach(([o, n]) => {
          if (vol[o] != null) { vol[n] = vol[o]; src[n] = src[o]; delete vol[o]; delete src[o]; }
        });
        flow = r.processes || [];
        for (const p of flow) { if (vol[p.id] == null) { vol[p.id] = 0; src[p.id] = 'none'; } }
      }
      if (edges) {
        const alive = new Set(flow.map((p) => p.id));
        const rows = edges.filter((e) => e.dst && alive.has(e.dst) && (!e.src || alive.has(e.src)));
        await getJSON(`${apiBase()}/flow`, jsonPost({ edges: rows }));
      }
      await loadGraph();
      render();                 // → pushCanvas()
      loadStagesFromModel();
      if (processes) {
        document.dispatchEvent(new CustomEvent('whsim:model-changed',
          { detail: { reason: 'work-processes' } }));
      }
      announceFlow();
    },
    async resetEdges() {
      const name = getProject();
      if (!name) throw new Error('プロジェクトが開いていません');
      await getJSON(`${apiBase()}/flow`, jsonPost({ edges: [] }));
      await loadGraph();
      editEdges = (graph.edges || []).map((e) => ({ ...e }));
      flowDirty = false;
      pushCanvas();
      announceFlow();
    },
  };

  function pushCanvas() {
    if (!canvas) return;
    canvas.setTableLabel(editing ? '図に戻る' : '表で編集');
    canvas.setData({
      nodes: graph.nodes, edges: graph.edges, equipment: graph.equipment,
      loadUnits, roles: graph.roles, diagnostics: graph.diagnostics,
      processes: flow, drivers, volumes: vol,
    });
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
      const node = `<div class="mf-cnode${bad ? ' bad' : ''}" title="${esc(bad ? (s.area_warn || '') : '')}">
        <div class="mf-cn-stage">${esc(s.label)}</div>
        <div class="mf-cn-area">${bad ? '⚠ ' : ''}${esc(area)}</div>
        <span class="mf-cn-method" style="background:${mc}">${esc(METHOD_T[s.method] || s.method)}</span>
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
  // the canvas / input focus). Falls back to a full render if absent.
  function renderChain() {
    const host = root.querySelector('[data-mf-chain]');
    if (host) { host.innerHTML = chainHtml(); return; }
    if (flow.length) render();
  }

  function setBusy(on) {
    const pill = root.querySelector('[data-mf-recalc]');
    if (pill) pill.classList.toggle('on', !!on);
  }

  // ── shell: the canvas is mounted ONCE and must survive every re-render, so
  // the page is four independently rewritten slots around a stable host.
  //
  // Order matters: the canvas IS this screen, so only the action bar and its
  // one-line guidance sit above it. 工程→エリア and the KPI strip are readouts,
  // not controls — parked above they pushed the 48vh stage 200px down and put
  // its lower third below the fold, which is the opposite of 主役. ──
  function ensureShell() {
    if (shell) return;
    root.innerHTML = '<div data-mf-top></div><div data-mf-canvas></div>'
      + '<div data-mf-editor></div><div data-mf-meta></div><div data-mf-cards></div>';
    canvas = mountFlowCanvas(root.querySelector('[data-mf-canvas]'), canvasCtx);
    shell = true;
  }

  // The bar used to be six same-weight buttons in a row, so 「どれを押すのか」 had
  // to be read one label at a time. It is now two GROUPS with one primary total:
  // 「物量を入れる」(sources — where the numbers come from) and the forward CTA.
  // Which one is primary depends on the state: with no 物量 the job is to fill it,
  // once filled the job is to move on. 表で編集 lives on the canvas bar only —
  // it was drawn twice, and a duplicated control reads as two different things.
  function barHtml(full, anyVol) {
    const src = full && anyVol ? '' : ' primary';
    return `<div class="mf-bar">
        <span class="mf-grp" role="group" aria-label="荷役物量の取込元">
          <span class="mf-grp-l">物量を入れる</span>
          <button class="mf-btn${src}" data-act="fromproject" title="①取込で読み込んだ出荷実績から荷役物量を作成（再アップロード不要）">📥 取込データから</button>
          ${full ? '<button class="mf-btn" data-act="frombi" title="②基礎物量で組んだ荷姿換算後の物量を取り込む">基礎物量</button>' : ''}
          <button class="mf-btn" data-act="sample" title="まず動かしてみるためのダミー物量">サンプル</button>
          <button class="mf-btn" data-act="upload" title="手元の別の出荷CSV/Excelを取り込む">別ファイル</button>
          ${full ? '<button class="mf-btn" data-act="generate" title="入力済みの工程から比率で不足分を推計する">不足を生成</button>' : ''}
        </span>
        <input type="file" data-mf-file accept=".csv,.xlsx,.xls,.json" hidden/>
        <span class="mf-recalc" data-mf-recalc aria-live="polite">再計算中…</span>
        ${full ? '<button class="mf-btn primary" data-act="timetable" style="margin-left:auto">タイムチャートで人員配置 →</button>' : ''}
       </div>`;
  }

  function render() {
    ensureShell();
    const top = root.querySelector('[data-mf-top]');
    const ed = root.querySelector('[data-mf-editor]');
    const meta = root.querySelector('[data-mf-meta]');
    const cards = root.querySelector('[data-mf-cards]');

    if (!flow.length) {
      top.innerHTML = barHtml(false, false)
        + `<div class="mf-empty">
             <div class="mf-empty-title">工程フローがまだありません</div>
             <div class="mf-empty-body">①取込の出荷実績を取り込むと、工程ごとの荷役物量がここに表示されます。「📥 取込データから」で取込済みデータを反映、まずは試すならサンプルでも始められます。図のキャンバスをダブルクリックすれば、工程を1つずつ手で作ることもできます。</div>
             <button class="mf-btn primary" data-act="fromproject">取込データから始める</button>
           </div>`;
      ed.innerHTML = '';
      meta.innerHTML = '';
      cards.innerHTML = '';
      wire();
      pushCanvas();
      return;
    }

    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const anyVol = flow.some((p) => (vol[p.id] || 0) > 0);
    // ①取込済みの出荷実績から埋めるのが第一導線。まだ物量が無いときは
    // その一手をハイライトし、空の画面で迷わせない。
    const guide = anyVol ? '' :
      `<div class="mf-guide">①取込の出荷実績はまだ反映されていません。<b>「📥 取込データから」</b>`
      + `を押すと、取り込んだデータから工程ごとの荷役物量を自動作成します（再アップロード不要）。</div>`;

    top.innerHTML = barHtml(true, anyVol)
      + `<span class="mf-hint">工程ごとの荷役物量（1日平均）。図で工程と流れを組み、物量を入れて人員配置へ。</span>`
      + guide;

    meta.innerHTML = `<div data-mf-chain>${chainHtml()}</div>`
      + `<div class="mf-kpis">
           <div class="mf-kpi"><div class="l">総工数</div><div class="v"><span data-kpi="totalMH">${totalMH.toFixed(1)}</span> <small>人時/日</small></div></div>
           <div class="mf-kpi"><div class="l">入力済み工程</div><div class="v"><span data-kpi="filled">${filled}</span> <small>/ ${flow.length}</small></div></div>
           <div class="mf-kpi"><div class="l">工程数</div><div class="v">${flow.length}</div></div>
         </div>`;

    ed.innerHTML = editorHtml();

    const sections = [...new Set(flow.map((p) => p.section))];
    cards.innerHTML = sections.map((sec) => {
      const ps = flow.filter((p) => p.section === sec);
      const html = ps.map((p, i) => {
        const sc = SRC[src[p.id] || 'none'];
        const card = `<div class="mf-card" data-card="${esc(p.id)}">
          <span class="mf-badge" data-badge="${esc(p.id)}" style="background:${sc.c}">${sc.t}</span>
          <h4>${esc(p.id)}</h4>
          <div class="sub">${esc(p.unit)} ・ 生産性 ${esc(p.productivity)}</div>
          <input type="number" min="0" step="1" data-id="${esc(p.id)}" value="${vol[p.id] || 0}" aria-label="${esc(p.id)}の荷役物量"/>
          <div class="mf-mh" data-mh="${esc(p.id)}">≈ ${manHours(p).toFixed(1)} 人時/日</div>
        </div>`;
        return card + (i < ps.length - 1 ? '<div class="mf-arrow">→</div>' : '');
      }).join('');
      return `<div class="mf-sec">${esc(sec)}</div><div class="mf-flow">${html}</div>`;
    }).join('');

    wire();
    pushCanvas();
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
      const b = await getJSON(`${apiBase()}/analysis/bundle`);
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
      const r = await getJSON('/api/materialflow/generate', jsonPost({ base }));
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
      const sc = await getJSON('/api/materialflow/scenario', jsonPost({ volumes: vol }));
      document.dispatchEvent(new CustomEvent('whsim:load-timetable', { detail: { scenario: sc } }));
      toast('人員配置へ受け渡しました', 'ok');
    } catch (e) { toast('タイムチャートへの受け渡しに失敗しました: ' + e.message, 'error'); }
    finally { setBusy(false); }
  }

  // In-place update of just the affected card (man-hours + source badge) + KPIs +
  // the canvas ribbons — avoids a full rebuild on every keystroke (which would
  // destroy input focus/caret).
  function updateCard(id) {
    const p = flow.find((q) => q.id === id);
    if (!p) return;
    const mh = root.querySelector(`[data-mh="${CSS.escape(id)}"]`);
    if (mh) mh.textContent = `≈ ${manHours(p).toFixed(1)} 人時/日`;
    const badge = root.querySelector(`[data-badge="${CSS.escape(id)}"]`);
    if (badge) { const sc = SRC[src[id] || 'none']; badge.textContent = sc.t; badge.style.background = sc.c; }
    updateKpis();
    if (canvas) canvas.setVolumes(vol);
  }
  function updateKpis() {
    const totalMH = flow.reduce((s, p) => s + manHours(p), 0);
    const filled = flow.filter((p) => (vol[p.id] || 0) > 0).length;
    const t = root.querySelector('[data-kpi="totalMH"]'); if (t) t.textContent = totalMH.toFixed(1);
    const f = root.querySelector('[data-kpi="filled"]'); if (f) f.textContent = String(filled);
  }

  // ── 工程エディタ（表で編集: 一括で直したいときの補助ビュー） ──────────────

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

  // 混在 (MIXED) names no single means, so it can name no single machine either.
  const equipChoices = (t) => (t === MIXED ? [] : equipForTransport(graph.equipment, t));

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
      <div class="mfe-head">表で編集 <span class="mfe-sub">一括で直したいとき用。図（キャンバス）と同じ工程・同じ流れです</span></div>
      <div class="mfe-help">シミュ挙動＝この工程をシミュレーションのどの動きとして扱うか。「計上のみ」の工程は人員・原価には計上されますが、シミュレーションでは動きません。搬送手段＝前工程からこの工程へ物が届く手段（工程間搬送）で、使用設備まで指定できます。荷姿（容器・台車）は図の矢印をクリックして設定します。</div>
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

  // Opening the table pulls the flow graph first (roles + 搬送手段 must be the
  // live ones), then builds the working copies. never-blocks: a failed fetch just
  // means an empty graph, and the table still opens with 未設定/人手.
  async function enterEdit() {
    setBusy(true);
    try { await Promise.all([loadGraph(), loadLoadUnits()]); } finally { setBusy(false); }
    editFlow = flow.map((p) => ({
      id: p.id, _origId: p.id, section: p.section || '出荷', driver: p.driver || 'out_lines',
      productivity: p.productivity || 60, unit: p.unit || '行/h',
      depends: [...(p.depends || [])],
      // AUTHORED role/zone (not the name-based guess) so 未設定 stays 未設定
      role: p.role || '', zone: p.zone || '',
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
    setInbound(p._origId || p.id, { equipment_ref: val });
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
      const r = await getJSON(`${apiBase()}/work-processes`, jsonPost({ processes: payload }));
      Object.entries(rename).forEach(([o, n]) => {
        if (vol[o] != null) { vol[n] = vol[o]; src[n] = src[o]; delete vol[o]; delete src[o]; }
      });
      flow = r.processes || [];
      // keep volumes for surviving ids; new ids start at 0.
      for (const p of flow) { if (vol[p.id] == null) { vol[p.id] = 0; src[p.id] = 'none'; } }
      // 工程間搬送: persist only when the user actually authored it (or the project
      // already had authored edges — a rename must not orphan them). Untouched ⇒
      // the graph stays DERIVED, i.e. 「工程の順番どおり」のまま。
      let edgeErr = null;
      if (flowDirty || graph.authored) {
        try { await saveEdgesFromTable(rename); } catch (e2) { edgeErr = e2; }
      }
      editing = false; editFlow = null; editEdges = null; flowDirty = false;
      await loadGraph();
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
      await canvasCtx.resetEdges();
      render();
      toast('工程間の搬送手段を、工程の順番どおりの既定に戻しました。', 'ok');
    } catch (e) { toast('搬送手段のリセットに失敗: ' + (e && e.message ? e.message : e), 'error'); }
    finally { setBusy(false); }
  }
  async function resetProcesses() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    setBusy(true);
    try {
      const r = await getJSON(`${apiBase()}/work-processes`, jsonPost({ processes: [] }));
      flow = r.processes || [];
      // reset clears the master's role/zone too, so the working copy starts blank
      // (未設定 = 工程名からの自動判定) and the edges are re-read from the graph.
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
      const r = await getJSON(`${apiBase()}/timetable/from-bi`);
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
      if (editing) return;   // don't swap the data under an open table editor
      loadGraph().then(pushCanvas);
    }, 250);
  };
  document.addEventListener('whsim:flow-changed', onFlow);

  // Initial 工程→エリア from the saved model, so the chain shows even before the
  // designer is opened this session (live edits then refine it).
  async function loadStagesFromModel() {
    const name = getProject();
    if (!name) return;
    try {
      const m = await getJSON(`${apiBase()}/full`);
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

  // Load the work-process master: project-scoped (custom-aware) when a project is
  // open, else the global engine-default seed. Volumes reset per process.
  async function loadFlow() {
    const name = getProject();
    try {
      if (name) {
        const r = await getJSON(`${apiBase()}/work-processes`);
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
    // the graph + 荷姿 only decorate the canvas — fetched after the first paint and
    // applied in place, so a slow/absent endpoint never delays it.
    Promise.all([loadGraph(), loadLoadUnits()]).then(() => { if (!editing) pushCanvas(); });
  })();

  return {
    dispose() {
      document.removeEventListener('whsim:flow-changed', onFlow);
      clearTimeout(flowBusT);
      graphSeq += 1;            // ignore any /flow response still in flight
      if (canvas) { canvas.dispose(); canvas = null; }
      shell = false;
      el.innerHTML = '';
    },
    // re-pull the project's work-process master + 工程→エリア (on project change /
    // revisit), so a different project's custom processes show up.
    refresh() {
      if (editing) { loadStagesFromModel(); return; }  // don't clobber an open edit
      graph = emptyGraph(); loadUnits = null; luProject = null;
      loadFlow().then(() => {
        render();
        loadStagesFromModel();
        Promise.all([loadGraph(), loadLoadUnits()]).then(() => { if (!editing) pushCanvas(); });
      });
    },
    setStages: applyStages,
  };
}
