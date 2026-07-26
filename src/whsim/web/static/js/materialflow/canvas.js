// materialflow/canvas.js — ②分析「マテリアルフロー」の工程キャンバス。
//
// 表で直してからサンキーを眺める、をやめて、ホワイトボードと同じ「箱と矢印」を
// 直接いじる面にする。これが唯一の操作面で、表は補助（一括編集）。
//
// The picture IS the model (whsim/flowgraph.py — the ONE flow graph):
//   ノード = 工程カード     … 名前 / シミュ挙動バッジ / 人時
//   矢印   = 物の流れ       … 太さ ∝ 物量（サンキーのリボン幅がここに残る）
//                             色 = 搬送手段 / 破線 = 工程順から自動、実線 = 指定済み
// 作る: 空白をダブルクリック（工程） / カードを別のカードへドラッグ（流れ）
// 直す: 矢印をクリック → 搬送手段・使用設備・荷姿(容器/台車)・入数・分岐率
// 消す: 選択して Del、またはホバーの ×
//
// Hand-rolled SVG: no new dependency, no bundler, no CDN. Every colour is a CSS
// custom property written into an inline `style`, so light/dark follow the theme
// with no repaint code at all.
//
// AUTHORING GRANULARITY. The server re-derives every destination the user has not
// spoken for (flowgraph.resolve), so an edit "authors" the whole INBOUND set of
// that destination and we POST only those legs — every other 工程 keeps its
// dashed, derived arrows. Deleting a leg also drops the matching `depends`, so a
// deletion is not silently re-derived on the next read.
//
// never-blocks: no project / no 工程 / empty graph / 404 all render a calm state.

import { esc, modalConfirm } from '../util.js';
import {
  TRANSPORTS, TRANSPORT_JA, ROLE_JA, trColor, injectCanvasStyle,
} from './vocab.js';
import { autoLayout, wouldCycle, NODE_W, NODE_H, GAP_X, GAP_Y } from './layout.js';
import { createPopover, buildEdgePanel, buildNodePanel } from './popover.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const fmt = (n) => (n == null || !Number.isFinite(+n) ? '—' : Math.round(+n).toLocaleString('ja-JP'));
const keyOf = (e) => `${e.src || ''}\u0000${e.dst || ''}`;
const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function sv(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
  return el;
}

const emptyData = () => ({
  nodes: [], edges: [], equipment: [], loadUnits: null, roles: [],
  diagnostics: [], processes: [], drivers: [], volumes: {},
});

export function mountFlowCanvas(host, ctx = {}) {
  injectCanvasStyle();
  const toast = ctx.toast || (() => {});
  const getProject = ctx.getProject || (() => null);

  let data = emptyData();
  const pos = {};                       // node id → {x,y}. VIEW state, never saved.
  let sel = null;                       // {type:'node'|'edge', key}
  const view = { k: 1, tx: 30, ty: 24 };
  let drag = null;
  let pan = null;
  let saveT = 0;
  let pendingPatch = false;             // a debounced attribute edit is in flight
  let alive = true;

  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'mfc';
  root.innerHTML = `
    <div class="mfc-bar">
      <button type="button" class="mfc-tool" data-t="fit" title="全体が入るように表示を合わせる">⤢ 全体表示</button>
      <button type="button" class="mfc-tool" data-t="tidy" title="工程の並びを自動で整える">⇄ 自動整列</button>
      <button type="button" class="mfc-tool" data-t="add" title="工程を追加（空白のダブルクリックでも追加できます）">＋ 工程</button>
      <button type="button" class="mfc-tool" data-t="reset" title="指定した搬送手段を消して、工程の順番どおりの流れに戻す">自動の流れに戻す</button>
      <span class="mfc-tip">空白をダブルクリックで工程を追加／カードを別のカードへドラッグでつなぐ／矢印をクリックで運び方と荷姿</span>
      <button type="button" class="mfc-tool" data-t="table" style="margin-left:auto"
        title="工程を表でまとめて編集">表で編集</button>
    </div>
    <div class="mfc-stage" data-stage>
      <svg class="mfc-svg" data-svg role="application" aria-label="工程フロー図（工程と物の流れ）">
        <g data-vp>
          <g data-edges></g>
          <g data-nodes></g>
          <path class="mfc-rubber" data-rubber style="display:none"></path>
        </g>
      </svg>
      <div class="mfc-legend" data-legend></div>
      <div class="mfc-hollow" data-hollow hidden></div>
    </div>
    <div class="mfc-diag" data-diag></div>`;
  host.appendChild(root);

  const stage = root.querySelector('[data-stage]');
  const svg = root.querySelector('[data-svg]');
  const vp = root.querySelector('[data-vp]');
  const gEdges = root.querySelector('[data-edges]');
  const gNodes = root.querySelector('[data-nodes]');
  const rubber = root.querySelector('[data-rubber]');
  const legend = root.querySelector('[data-legend]');
  const hollow = root.querySelector('[data-hollow]');
  const diagHost = root.querySelector('[data-diag]');
  const pop = createPopover(stage);

  const nodeEls = new Map();            // id → <g>
  let edgeRecs = [];                    // [{e,key,g,line,hit,halo,head,tail,xg}]

  // ---- lookups -------------------------------------------------------------
  const nodeById = (id) => data.nodes.find((n) => n.id === id) || null;
  const procById = (id) => data.processes.find((p) => p.id === id) || null;
  function manHours(id) {
    const p = procById(id);
    const v = num(data.volumes[id], 0);
    const prod = Math.max(1, num(p && p.productivity, 60));
    return v > 0 ? v / prod : 0;
  }
  function edgeVolume(e) {
    const v = num(data.volumes[e.src || e.dst], 0);
    if (!(v > 0)) return 0;
    const s = num(e.share, 1);
    return v * (s > 0 ? s : 1);
  }
  function volumeUnit(e) {
    const p = procById(e.src || e.dst);
    return (p && p.unit) ? String(p.unit).replace(/\/h$/, '') : '';
  }

  // ---- view ---------------------------------------------------------------
  function applyView() {
    vp.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
    stage.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
    stage.style.backgroundPosition = `${view.tx}px ${view.ty}px`;
  }
  function toWorld(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left - view.tx) / view.k, y: (ev.clientY - r.top - view.ty) / view.k };
  }
  function fit() {
    const ids = data.nodes.map((n) => n.id).filter((id) => pos[id]);
    if (!ids.length) { view.k = 1; view.tx = 30; view.ty = 24; applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of ids) {
      x0 = Math.min(x0, pos[id].x - 60); y0 = Math.min(y0, pos[id].y - 10);
      x1 = Math.max(x1, pos[id].x + NODE_W); y1 = Math.max(y1, pos[id].y + NODE_H);
    }
    const W = stage.clientWidth || 700, H = stage.clientHeight || 400;
    const k = Math.max(0.35, Math.min(1.25, (W - 36) / Math.max(1, x1 - x0),
      (H - 36) / Math.max(1, y1 - y0)));
    view.k = k;
    view.tx = (W - (x1 - x0) * k) / 2 - x0 * k;
    view.ty = (H - (y1 - y0) * k) / 2 - y0 * k;
    applyView();
  }
  // Bring one 工程 into view (used by the 診断 strip).
  function focusNode(id) {
    if (!pos[id]) return;
    const W = stage.clientWidth || 700, H = stage.clientHeight || 400;
    view.tx = W / 2 - (pos[id].x + NODE_W / 2) * view.k;
    view.ty = H / 2 - (pos[id].y + NODE_H / 2) * view.k;
    applyView();
    select({ type: 'node', key: id });
    const el = nodeEls.get(id);
    if (el) { try { el.focus(); } catch (_e) { /* noop */ } }
  }

  // ---- geometry ------------------------------------------------------------
  function anchors(e) {
    const b0 = pos[e.dst];
    if (!b0) return null;
    if (!e.src) {
      const b = { x: b0.x, y: b0.y + NODE_H / 2 };
      return { a: { x: b.x - 58, y: b.y }, b, dir: 1, entry: true };
    }
    const a0 = pos[e.src];
    if (!a0 || e.src === e.dst) return null;
    const dir = (b0.x + NODE_W / 2) >= (a0.x + NODE_W / 2) ? 1 : -1;
    return {
      a: { x: dir > 0 ? a0.x + NODE_W : a0.x, y: a0.y + NODE_H / 2 },
      b: { x: dir > 0 ? b0.x : b0.x + NODE_W, y: b0.y + NODE_H / 2 },
      dir, entry: false,
    };
  }
  function bez(g) {
    const bx = g.b.x - g.dir * 10;
    const h = Math.max(38, Math.abs(bx - g.a.x) * 0.42);
    return { p0: g.a, p1: { x: g.a.x + g.dir * h, y: g.a.y },
      p2: { x: bx - g.dir * h, y: g.b.y }, p3: { x: bx, y: g.b.y } };
  }
  const pathOf = (g) => {
    const b = bez(g);
    return `M ${b.p0.x} ${b.p0.y} C ${b.p1.x} ${b.p1.y}, ${b.p2.x} ${b.p2.y}, ${b.p3.x} ${b.p3.y}`;
  };
  const midOf = (g) => {
    const b = bez(g);
    return { x: (b.p0.x + 3 * b.p1.x + 3 * b.p2.x + b.p3.x) / 8,
      y: (b.p0.y + 3 * b.p1.y + 3 * b.p2.y + b.p3.y) / 8 };
  };
  function nodeAt(x, y, except) {
    for (const n of data.nodes) {
      if (n.id === except || !pos[n.id]) continue;
      const p = pos[n.id];
      if (x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H) return n.id;
    }
    return null;
  }

  // ---- positions -----------------------------------------------------------
  function ensurePositions() {
    const ids = data.nodes.map((n) => n.id);
    for (const k of Object.keys(pos)) if (!ids.includes(k)) delete pos[k];
    const missing = ids.filter((id) => !pos[id]);
    if (!missing.length) return;
    const L = autoLayout(data.nodes, data.edges);
    if (missing.length === ids.length) { Object.assign(pos, L.pos); return; }
    // Only the new 工程 are placed, so a hand-arranged canvas is not reshuffled.
    let maxX = 0;
    ids.forEach((id) => { if (pos[id]) maxX = Math.max(maxX, pos[id].x); });
    missing.forEach((id, i) => {
      pos[id] = L.pos[id] ? { ...L.pos[id] } : { x: maxX + NODE_W + GAP_X, y: i * (NODE_H + GAP_Y) };
    });
  }
  function tidy() {
    const L = autoLayout(data.nodes, data.edges);
    Object.keys(pos).forEach((k) => delete pos[k]);
    Object.assign(pos, L.pos);
    render();
    fit();
  }

  // ---- 診断 marks ----------------------------------------------------------
  function diagMarks() {
    const nodes = new Set(), edges = new Set();
    for (const d of (data.diagnostics || [])) {
      if (!d) continue;
      if (d.process) nodes.add(String(d.process));
      if (d.missing) nodes.add(String(d.missing));
      const ed = d.edge == null ? '' : String(d.edge);
      if (ed.includes('→')) {
        const [s, t] = ed.split('→');
        edges.add(`${s || ''}\u0000${t || ''}`);
        if (t) nodes.add(t);
      }
    }
    return { nodes, edges };
  }
  const diagTarget = (d) => String((d && (d.process || d.missing
    || (String(d.edge || '').includes('→') ? String(d.edge).split('→')[1] : ''))) || '');

  // ---- render --------------------------------------------------------------
  function nodeCard(n) {
    const p = procById(n.id) || {};
    const g = sv('g', { class: 'mfc-node', 'data-id': n.id, tabindex: '0',
      role: 'button', 'aria-label': `工程 ${n.id}` });
    g.appendChild(sv('rect', { class: 'mfc-node-bg', width: NODE_W, height: NODE_H, rx: 12 }));
    const name = sv('text', { class: 'mfc-nname', x: 12, y: 23 });
    name.textContent = clip(n.id, 11);
    g.appendChild(name);

    const label = n.simulated ? (ROLE_JA[n.role] || n.role || 'シミュ対象') : '計上のみ';
    if (!n.simulated) g.classList.add('is-calc');
    const bw = Math.max(38, label.length * 10.5 + 14);
    g.appendChild(sv('rect', { class: 'mfc-nbadge-bg', x: 11, y: 31, width: bw, height: 16, rx: 8 }));
    const bt = sv('text', { class: 'mfc-nbadge-tx', x: 11 + bw / 2, y: 42.5, 'text-anchor': 'middle' });
    bt.textContent = label;
    g.appendChild(bt);

    const mh = manHours(n.id);
    const mhT = sv('text', { class: 'mfc-nmh', x: NODE_W - 12, y: 42.5, 'text-anchor': 'end' });
    mhT.textContent = mh > 0 ? `${mh.toFixed(1)} 人時` : '—';
    g.appendChild(mhT);

    const sub = sv('text', { class: 'mfc-nsub', x: 12, y: 58 });
    sub.textContent = clip([p.section || n.section || '', n.zone || ''].filter(Boolean).join('・')
      || '（セクション未設定）', 15);
    g.appendChild(sub);

    const title = sv('title');
    title.textContent = `${n.id}\n物量 ${fmt(data.volumes[n.id] || 0)}${volumeUnit({ src: n.id })}/日`
      + `\n人時 ${mh.toFixed(1)}`;
    g.appendChild(title);
    g.setAttribute('transform', `translate(${pos[n.id].x},${pos[n.id].y})`);
    return g;
  }

  function edgeGroup(e, width) {
    const col = trColor(TRANSPORT_JA[e.transport] ? e.transport : 'manual');
    const g = sv('g', { class: `mfc-edge${e.derived ? ' is-derived' : ''}`, tabindex: '0',
      'data-key': keyOf(e), role: 'button',
      'aria-label': `流れ ${e.src || '外部'} から ${e.dst}`,
      // 搬送手段の色 と 物量の太さ は変数で子に配る（vocab.js の CSS が読む）。
      style: `--mf-c:${col};--mf-w:${width}px;--mf-wh:${width + 9}px` });
    const halo = sv('path', { class: 'mfc-edge-halo' });
    const line = sv('path', { class: 'mfc-edge-line' });
    const head = sv('path', { class: 'mfc-edge-head' });
    const hit = sv('path', { class: 'mfc-edge-hit' });
    g.appendChild(halo); g.appendChild(line); g.appendChild(head); g.appendChild(hit);
    let tail = null;
    if (!e.src) {
      tail = sv('circle', { class: 'mfc-edge-tail', r: 3.4 });
      g.appendChild(tail);
    }
    let xg = null;
    if (e.src) {                       // 外部からの入りは消せない（消す先が無い）
      xg = sv('g', { class: 'mfc-x', role: 'button', 'aria-label': 'この流れを削除' });
      xg.appendChild(sv('circle', { class: 'mfc-x-bg', r: 8.5 }));
      const t = sv('text', { class: 'mfc-x-tx', y: 3.8 });
      t.textContent = '×';
      xg.appendChild(t);
      const xt = sv('title');
      xt.textContent = 'この流れを削除';
      xg.appendChild(xt);
      g.appendChild(xg);
    }
    const v = edgeVolume(e);
    const title = sv('title');
    title.textContent = `${e.src || '外部'} → ${e.dst}\n搬送手段 ${TRANSPORT_JA[e.transport] || '人手'}`
      + (v > 0 ? `\n物量 ${fmt(v)}${volumeUnit(e)}/日` : '')
      + (num(e.share, 1) < 0.999 ? `\n分岐率 ${Math.round(num(e.share, 1) * 100)}%` : '')
      + (e.derived ? '\n（工程の順番から自動）' : '');
    g.appendChild(title);
    return { e, key: keyOf(e), g, line, hit, halo, head, tail, xg };
  }

  function updateEdgeGeom(rec) {
    const g = anchors(rec.e);
    if (!g) { rec.g.style.display = 'none'; return; }
    rec.g.style.display = '';
    const d = pathOf(g);
    rec.line.setAttribute('d', d);
    rec.hit.setAttribute('d', d);
    rec.halo.setAttribute('d', d);
    const s = 6.5, back = 11;
    rec.head.setAttribute('d', `M ${g.b.x} ${g.b.y} L ${g.b.x - g.dir * back} ${g.b.y - s} `
      + `L ${g.b.x - g.dir * back} ${g.b.y + s} Z`);
    if (rec.tail) { rec.tail.setAttribute('cx', g.a.x); rec.tail.setAttribute('cy', g.a.y); }
    // The × floats ABOVE the ribbon: sitting on the midpoint would make the most
    // natural place to click an arrow (its middle) delete the leg instead.
    if (rec.xg) { const m = midOf(g); rec.xg.setAttribute('transform', `translate(${m.x},${m.y - 16})`); }
  }

  function render() {
    ensurePositions();
    const marks = diagMarks();

    // edges first (under the cards)
    gEdges.textContent = '';
    edgeRecs = [];
    const vols = data.edges.map(edgeVolume);
    const vmax = Math.max(0, ...vols);
    data.edges.forEach((e, i) => {
      if (!e.dst || !pos[e.dst]) return;
      if (e.src && (!pos[e.src] || e.src === e.dst)) return;
      const v = vols[i];
      const w = (vmax > 0 && v > 0) ? 1.8 + 6.8 * Math.sqrt(v / vmax) : 2.1;
      const rec = edgeGroup(e, Math.round(w * 10) / 10);
      if (marks.edges.has(rec.key)) rec.g.classList.add('is-warn');
      if (sel && sel.type === 'edge' && sel.key === rec.key) rec.g.classList.add('is-sel');
      gEdges.appendChild(rec.g);
      edgeRecs.push(rec);
      updateEdgeGeom(rec);
    });

    // nodes
    gNodes.textContent = '';
    nodeEls.clear();
    for (const n of data.nodes) {
      if (!pos[n.id]) continue;
      const g = nodeCard(n);
      if (marks.nodes.has(n.id)) g.classList.add('is-warn');
      if (sel && sel.type === 'node' && sel.key === n.id) g.classList.add('is-sel');
      gNodes.appendChild(g);
      nodeEls.set(n.id, g);
    }

    renderLegend();
    renderDiag();
    renderHollow();
    applyView();
  }

  function renderLegend() {
    if (!data.nodes.length) { legend.hidden = true; return; }
    legend.hidden = false;
    const used = [];
    for (const e of data.edges) {
      const t = TRANSPORT_JA[e.transport] ? e.transport : 'manual';
      if (!used.includes(t)) used.push(t);
    }
    const items = TRANSPORTS.filter((t) => used.includes(t)).map((t) =>
      `<span class="mfc-lg"><i style="background:${trColor(t)}"></i>${esc(TRANSPORT_JA[t])}</span>`);
    const anyVol = Object.values(data.volumes || {}).some((v) => num(v, 0) > 0);
    items.push(`<span class="mfc-lg">${anyVol ? '太さ＝物量' : '物量を入力すると太さに反映'}</span>`);
    if (data.edges.some((e) => e.derived)) {
      items.push('<span class="mfc-lg"><i class="dash"></i>工程順から自動</span>');
    }
    legend.innerHTML = items.join('');
  }

  function renderDiag() {
    const list = (data.diagnostics || []).filter((d) => d && d.message);
    if (!list.length) { diagHost.innerHTML = ''; return; }
    const rows = list.map((d, i) =>
      `<button type="button" class="mfc-diag-row" data-diag="${i}">`
      + `<span class="mfc-diag-mark">⚠</span>`
      + `<span class="mfc-diag-msg">${esc(d.message)}</span></button>`).join('');
    diagHost.innerHTML = `<div class="mfc-diag-h">フローの注意 ${list.length}件`
      + `（このままでも実行できます。設計を見直す目安です）</div>${rows}`;
  }

  function renderHollow() {
    if (data.nodes.length) { hollow.hidden = true; return; }
    hollow.hidden = false;
    hollow.innerHTML = getProject()
      ? '<b>工程がまだありません</b><div>キャンバスをダブルクリックするか「＋ 工程」で、'
        + '最初の工程を作れます。</div>'
      : '<b>プロジェクトを開くと、工程の流れを図で編集できます</b>'
        + '<div>①取込でプロジェクトを作成・選択してください。</div>';
  }

  function select(next) {
    sel = next;
    nodeEls.forEach((el, id) => el.classList.toggle('is-sel', !!next && next.type === 'node' && next.key === id));
    edgeRecs.forEach((r) => r.g.classList.toggle('is-sel', !!next && next.type === 'edge' && next.key === r.key));
  }

  // ---- persistence ---------------------------------------------------------
  // Only the destinations the user has spoken for are POSTed; the rest stay
  // derived server-side (partial wiring is the normal case, see flowgraph.py).
  function authoredRows() {
    const dsts = new Set(data.edges.filter((e) => !e.derived && e.dst).map((e) => e.dst));
    return data.edges.filter((e) => e.dst && dsts.has(e.dst)).map((e) => ({
      src: e.src || '', dst: e.dst, transport: e.transport || 'manual',
      equipment_ref: e.equipment_ref || '', share: num(e.share, 1),
      container_ref: e.container_ref || '', carrier_ref: e.carrier_ref || '',
    }));
  }
  const authorInto = (dst) => data.edges.forEach((e) => { if (e.dst === dst) e.derived = false; });

  // 属性だけの編集（搬送手段・使用設備・荷姿・分岐率）は debounce して辺だけ保存する。
  // Topology is untouched, so the host only refreshes the 診断 — the open popover
  // keeps pointing at the very edge object the user is editing.
  function patchEdges() {
    clearTimeout(saveT);
    pendingPatch = true;
    saveT = setTimeout(async () => {
      if (!alive || !ctx.patchEdges) return;
      pendingPatch = false;
      try { await ctx.patchEdges(authoredRows()); } catch (err) {
        toast('流れの保存に失敗しました: ' + (err && err.message ? err.message : err), 'error');
      }
    }, 420);
  }

  // The master rows, as the screen holds them (POST shaping lives in materialflow.js).
  const masterRows = () => data.processes.map((p) => ({ ...p, depends: [...(p.depends || [])] }));

  // Topology changes (つなぐ / 外す / 工程の追加・削除・改名) touch BOTH the 工程
  // master and the authored legs. Both endpoints rewrite the whole model, so they
  // must never race: one call hands the host an ordered pair (master first, so the
  // legs can name the ids), and the host reloads the graph once at the end.
  async function commit({ master = null, rename = null, edges = false, msg = '' }) {
    if (!ctx.saveFlow) return;
    // A debounced attribute edit is FOLDED IN rather than dropped, so a fast
    // 選ぶ→つなぐ never loses the 搬送手段 the user just picked.
    const withEdges = edges || pendingPatch;
    clearTimeout(saveT);
    pendingPatch = false;
    try {
      await ctx.saveFlow({
        processes: master, rename: rename || {},
        edges: withEdges ? authoredRows() : null,
      });
      if (msg) toast(msg, 'ok');
    } catch (err) {
      toast('保存に失敗しました: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  // ---- mutations -----------------------------------------------------------
  // 前工程が同じ手段で届くのが既定の読み: a new leg inherits the destination's
  // existing 搬送手段 when its legs agree, else 人手.
  function inheritTransport(dst) {
    const ins = data.edges.filter((e) => e.dst === dst && e.transport);
    const set = new Set(ins.map((e) => e.transport));
    return set.size === 1 ? [...set][0] : 'manual';
  }
  // A split shares the source's flow: equal 分岐率 is the honest default, and the
  // popover lets the user retune it leg by leg.
  function rebalance(src) {
    const outs = data.edges.filter((e) => e.src === src);
    if (!outs.length) return 0;
    const share = 1 / outs.length;
    outs.forEach((e) => { e.share = share; authorInto(e.dst); });
    return outs.length;
  }

  async function linkNodes(src, dst) {
    if (!src || !dst || src === dst) return;
    if (data.edges.some((e) => e.src === src && e.dst === dst)) {
      toast('この2工程はすでにつながっています。', 'info');
      return;
    }
    if (wouldCycle(data.edges, src, dst)) {
      toast('前の工程へ戻る流れ（循環）は作れません。', 'info');
      return;
    }
    data.edges.push({ src, dst, transport: inheritTransport(dst), equipment_ref: '',
      share: 1, derived: false, container_ref: '', carrier_ref: '' });
    authorInto(dst);
    const n = rebalance(src);
    const rows = masterRows();
    const row = rows.find((p) => p.id === dst);
    if (row && !row.depends.includes(src)) row.depends.push(src);
    render();
    await commit({ master: rows, edges: true, msg: n > 1
      ? `「${src}」から「${dst}」へつなぎました（${n}本に分かれるので分岐率を${Math.round(100 / n)}%ずつにしました）。`
      : `「${src}」から「${dst}」へつなぎました。` });
  }

  async function deleteEdge(e) {
    if (!e || !e.src) return;
    const { src, dst } = e;
    const i = data.edges.indexOf(e);
    if (i >= 0) data.edges.splice(i, 1);
    // Author what remains, otherwise the server re-derives the leg we just cut.
    authorInto(dst);
    rebalance(src);
    const rows = masterRows();
    const row = rows.find((p) => p.id === dst);
    if (row) row.depends = row.depends.filter((d) => d !== src);
    if (sel && sel.type === 'edge' && sel.key === `${src}\u0000${dst}`) sel = null;
    pop.close();
    render();
    await commit({ master: rows, edges: true, msg: `「${src}」→「${dst}」の流れを外しました。` });
  }

  async function createProcess(name, at) {
    const id = String(name || '').trim();
    if (!id) return;
    if (data.processes.some((p) => p.id === id)) { toast('同じ名前の工程がすでにあります。', 'info'); return; }
    const rows = masterRows();
    const last = rows[rows.length - 1];
    rows.push({ id, section: (last && last.section) || '出荷', driver: 'out_lines',
      productivity: 60, unit: '行/h', depends: [], role: '', zone: '' });
    if (at) pos[id] = { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 };
    await commit({ master: rows, msg: `工程「${id}」を追加しました。` });
  }

  async function deleteProcess(id) {
    const ok = await modalConfirm({
      title: '工程を削除しますか',
      message: `「${id}」を工程マスタから削除します。この工程に出入りする流れも一緒に消えます。`,
      okLabel: '削除する', danger: true,
    });
    if (!ok) return;
    data.edges = data.edges.filter((e) => e.src !== id && e.dst !== id);
    const rows = masterRows().filter((p) => p.id !== id);
    rows.forEach((p) => { p.depends = p.depends.filter((d) => d !== id); });
    delete pos[id];
    if (sel && sel.type === 'node' && sel.key === id) sel = null;
    pop.close();
    render();
    await commit({ master: rows, edges: true, msg: `工程「${id}」を削除しました。` });
  }

  async function saveNode(id, patch) {
    const rows = masterRows();
    const row = rows.find((p) => p.id === id);
    if (!row) return;
    const rename = {};
    const nextId = String(patch.id == null ? row.id : patch.id).trim();
    if (nextId && nextId !== row.id) {
      if (rows.some((p) => p !== row && p.id === nextId)) {
        toast('同じ名前の工程がすでにあります。', 'info');
        return;
      }
      rename[row.id] = nextId;
      if (pos[row.id]) { pos[nextId] = pos[row.id]; delete pos[row.id]; }
      rows.forEach((p) => { p.depends = p.depends.map((d) => (d === row.id ? nextId : d)); });
      data.edges.forEach((e) => {
        if (e.src === row.id) e.src = nextId;
        if (e.dst === row.id) e.dst = nextId;
      });
      row.id = nextId;
    }
    if (patch.section != null) row.section = patch.section;
    if (patch.role != null) row.role = patch.role;
    if (patch.driver != null) {
      row.driver = patch.driver;
      const d = (data.drivers || []).find((q) => q.id === patch.driver);
      if (d && d.unit) row.unit = d.unit;      // keep the unit in step with the driver
    }
    if (patch.productivity != null) row.productivity = Math.max(1, num(patch.productivity, 60));
    const renamed = Object.keys(rename).length > 0;
    await commit({ master: rows, rename, edges: renamed,
      msg: `工程「${row.id}」を保存しました。` });
  }

  // ---- popovers ------------------------------------------------------------
  function popXY(ev) {
    const r = stage.getBoundingClientRect();
    if (ev && ev.clientX != null) return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    return { x: r.width / 2 - 150, y: 40 };
  }

  function openEdgePopover(rec, ev) {
    select({ type: 'edge', key: rec.key });
    const e = rec.e;
    const panel = buildEdgePanel({
      edge: e,
      srcLabel: e.src || '外部',
      dstLabel: e.dst,
      equipment: data.equipment,
      loadUnits: data.loadUnits,
      project: getProject(),
      getVolume: () => edgeVolume(e),
      volumeUnit: volumeUnit(e),
      toast,
      onUnitsSaved: (saved) => { data.loadUnits = saved; },
      onPatch: (patch) => {
        Object.assign(e, patch);
        e.derived = false;
        authorInto(e.dst);
        render();
        patchEdges();
      },
      onDelete: () => deleteEdge(e),
    });
    const p = popXY(ev);
    pop.open({ x: p.x, y: p.y, title: panel.title, html: panel.html, wire: panel.wire });
  }

  function openNodePopover(id, ev) {
    select({ type: 'node', key: id });
    const panel = buildNodePanel({
      proc: procById(id) || { id },
      node: nodeById(id) || {},
      roles: data.roles,
      drivers: data.drivers,
      others: data.processes.map((p) => p.id),
      onSave: (patch) => saveNode(id, patch),
      onDelete: () => deleteProcess(id),
      onLink: (to) => linkNodes(id, to),
    });
    const p = popXY(ev);
    pop.open({ x: p.x, y: p.y, title: panel.title, html: panel.html, wire: panel.wire });
  }

  // ---- inline 工程名 input (double-click on empty canvas) -------------------
  function askName(clientX, clientY, world) {
    const r = stage.getBoundingClientRect();
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'mfc-name-in';
    inp.placeholder = '工程名を入力';
    inp.setAttribute('aria-label', '新しい工程の名前');
    inp.style.left = `${Math.max(6, Math.min(clientX - r.left, r.width - 182))}px`;
    inp.style.top = `${Math.max(6, Math.min(clientY - r.top, r.height - 44))}px`;
    stage.appendChild(inp);
    inp.focus();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = inp.value;
      inp.remove();
      if (ok) createProcess(v, world);
    };
    inp.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') { k.preventDefault(); finish(true); }
      else if (k.key === 'Escape') { k.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---- pointer interaction -------------------------------------------------
  function setNodePos(id, p) {
    pos[id] = { x: p.x, y: p.y };
    const el = nodeEls.get(id);
    if (el) el.setAttribute('transform', `translate(${p.x},${p.y})`);
    edgeRecs.forEach((r) => { if (r.e.src === id || r.e.dst === id) updateEdgeGeom(r); });
  }
  function setTarget(id) {
    nodeEls.forEach((el, k) => el.classList.toggle('is-target', k === id));
    if (drag) drag.target = id || null;
  }
  function drawRubber(srcId, w) {
    const p = pos[srcId];
    if (!p) return;
    const a = { x: p.x + NODE_W, y: p.y + NODE_H / 2 };
    rubber.setAttribute('d', `M ${a.x} ${a.y} L ${w.x} ${w.y}`);
    rubber.style.display = '';
  }
  const hideRubber = () => { rubber.style.display = 'none'; };

  function onDown(ev) {
    if (ev.button !== 0) return;
    if (ev.target.closest('.mfc-pop')) return;
    if (ev.target.closest('.mfc-x')) return;          // × has its own click
    if (ev.target.closest('.mfc-edge')) { pop.close(); return; }
    const ng = ev.target.closest('.mfc-node');
    if (ng) {
      pop.close();
      const id = ng.getAttribute('data-id');
      if (!pos[id]) return;
      drag = { id, w0: toWorld(ev), p0: { ...pos[id] }, moved: false, mode: 'move',
        target: null, sx: ev.clientX, sy: ev.clientY };
      select({ type: 'node', key: id });
      try { svg.setPointerCapture(ev.pointerId); } catch (_e) { /* noop */ }
      ev.preventDefault();
      return;
    }
    pop.close();
    select(null);
    pan = { x0: ev.clientX, y0: ev.clientY, tx: view.tx, ty: view.ty };
    svg.classList.add('is-pan');
    try { svg.setPointerCapture(ev.pointerId); } catch (_e) { /* noop */ }
  }

  function onMove(ev) {
    if (drag) {
      if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < 4) return;
      drag.moved = true;
      const w = toWorld(ev);
      const hit = nodeAt(w.x, w.y, drag.id);
      if (hit) {
        // Dropping a card ON another card means "つなぐ": the card springs back
        // and a rubber band shows the connection that is about to be made.
        if (drag.mode !== 'link') { setNodePos(drag.id, drag.p0); drag.mode = 'link'; }
        setTarget(hit);
        drawRubber(drag.id, w);
      } else {
        if (drag.mode !== 'move') { drag.mode = 'move'; setTarget(null); hideRubber(); }
        setNodePos(drag.id, { x: drag.p0.x + (w.x - drag.w0.x), y: drag.p0.y + (w.y - drag.w0.y) });
      }
      return;
    }
    if (pan) {
      view.tx = pan.tx + (ev.clientX - pan.x0);
      view.ty = pan.ty + (ev.clientY - pan.y0);
      applyView();
    }
  }

  function onUp(ev) {
    if (drag) {
      const d = drag;
      drag = null;
      hideRubber();
      setTarget(null);
      if (d.mode === 'link' && d.target) linkNodes(d.id, d.target);
      else if (!d.moved) openNodePopover(d.id, ev);
      return;
    }
    if (pan) { pan = null; svg.classList.remove('is-pan'); }
  }

  function onWheel(ev) {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const w = { x: (px - view.tx) / view.k, y: (py - view.ty) / view.k };
    const k = Math.max(0.35, Math.min(2.4, view.k * Math.exp(-ev.deltaY * 0.0016)));
    view.k = k;
    view.tx = px - w.x * k;
    view.ty = py - w.y * k;
    applyView();
  }

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.mfc-node') || ev.target.closest('.mfc-edge')) return;
    if (!getProject()) { toast('先にプロジェクトを選択してください。', 'info'); return; }
    pop.close();
    askName(ev.clientX, ev.clientY, toWorld(ev));
  });

  // Clicks: edges open their popover, the × removes the leg.
  svg.addEventListener('click', (ev) => {
    const x = ev.target.closest('.mfc-x');
    if (x) {
      ev.stopPropagation();
      const rec = edgeRecs.find((r) => r.xg && r.xg.contains(ev.target));
      if (rec) deleteEdge(rec.e);
      return;
    }
    const eg = ev.target.closest('.mfc-edge');
    if (eg) {
      const rec = edgeRecs.find((r) => r.g === eg);
      if (rec) openEdgePopover(rec, ev);
    }
  });

  // Keyboard: Tab reaches every card and arrow, Enter opens it, Del removes it.
  svg.addEventListener('keydown', (ev) => {
    const ng = ev.target.closest && ev.target.closest('.mfc-node');
    const eg = ev.target.closest && ev.target.closest('.mfc-edge');
    if (ng) {
      const id = ng.getAttribute('data-id');
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openNodePopover(id, null); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteProcess(id); }
      else if (ev.key === 'Escape') pop.close();
      return;
    }
    if (eg) {
      const rec = edgeRecs.find((r) => r.g === eg);
      if (!rec) return;
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdgePopover(rec, null); }
      else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteEdge(rec.e); }
      else if (ev.key === 'Escape') pop.close();
    }
  });
  svg.addEventListener('focusin', (ev) => {
    const ng = ev.target.closest && ev.target.closest('.mfc-node');
    if (ng) { select({ type: 'node', key: ng.getAttribute('data-id') }); return; }
    const eg = ev.target.closest && ev.target.closest('.mfc-edge');
    if (eg) {
      const rec = edgeRecs.find((r) => r.g === eg);
      if (rec) select({ type: 'edge', key: rec.key });
    }
  });

  root.addEventListener('click', (ev) => {
    const d = ev.target.closest('[data-diag]');
    if (d) { focusNode(diagTarget((data.diagnostics || [])[+d.dataset.diag])); return; }
    const t = ev.target.closest('[data-t]');
    if (!t) return;
    const act = t.dataset.t;
    if (act === 'fit') fit();
    else if (act === 'tidy') tidy();
    else if (act === 'add') {
      if (!getProject()) { toast('先にプロジェクトを選択してください。', 'info'); return; }
      const r = stage.getBoundingClientRect();
      askName(r.left + 24, r.top + 24, { x: (24 - view.tx) / view.k, y: (24 - view.ty) / view.k });
    } else if (act === 'reset') resetEdges();
    else if (act === 'table' && ctx.openTable) ctx.openTable();
  });

  async function resetEdges() {
    if (!ctx.resetEdges) return;
    const ok = await modalConfirm({
      title: '自動の流れに戻しますか',
      message: '指定した搬送手段・使用設備・荷姿を消して、工程の順番どおりの流れに戻します。',
      okLabel: '戻す',
    });
    if (!ok) return;
    try {
      await ctx.resetEdges();
      toast('工程の順番どおりの流れに戻しました。', 'ok');
    } catch (err) {
      toast('リセットに失敗しました: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  // The panel can be mounted while hidden (width 0), so the first REAL width is
  // also the first honest chance to frame the graph.
  let lastW = 0;
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
    if (!alive) return;
    const w = stage.clientWidth;
    if (!lastW && w && data.nodes.length) { lastW = w; fit(); return; }
    lastW = w;
    applyView();
  }) : null;
  if (ro) ro.observe(stage);

  let firstFit = true;
  return {
    /** Push the resolved graph + the master + the volumes. Never throws. */
    setData(d) {
      const prev = data.nodes.map((n) => n.id);
      const next = { ...emptyData(), ...(d || {}) };
      data = {
        nodes: Array.isArray(next.nodes) ? next.nodes : [],
        edges: (Array.isArray(next.edges) ? next.edges : []).map((e) => ({ ...e })),
        equipment: Array.isArray(next.equipment) ? next.equipment : [],
        loadUnits: next.loadUnits && Array.isArray(next.loadUnits.list) ? next.loadUnits : null,
        roles: Array.isArray(next.roles) ? next.roles : [],
        diagnostics: Array.isArray(next.diagnostics) ? next.diagnostics : [],
        processes: Array.isArray(next.processes) ? next.processes : [],
        drivers: Array.isArray(next.drivers) ? next.drivers : [],
        volumes: next.volumes && typeof next.volumes === 'object' ? next.volumes : {},
      };
      // A selection that no longer resolves is simply dropped (never throws).
      if (sel && sel.type === 'node' && !data.nodes.some((n) => n.id === sel.key)) sel = null;
      if (sel && sel.type === 'edge' && !data.edges.some((e) => keyOf(e) === sel.key)) sel = null;
      pop.close();
      render();
      // Frame the graph on the first paint, and again when the whole cast changes
      // (a different project) — otherwise the new 工程 land off-screen under the
      // previous project's pan.
      const fresh = prev.length && !prev.some((id) => data.nodes.some((n) => n.id === id));
      if (data.nodes.length && (firstFit || fresh)) { firstFit = false; fit(); }
    },
    setVolumes(v) {
      data.volumes = (v && typeof v === 'object') ? v : {};
      render();
    },
    /** Fresh 診断 after an attribute-only save — leaves the edges (and the open
     *  popover's binding) exactly as they are. */
    setDiagnostics(list) {
      data.diagnostics = Array.isArray(list) ? list : [];
      render();
    },
    fit,
    /** Keep the toolbar honest about what the 表 toggle will do. */
    setTableLabel(text) {
      const b = root.querySelector('[data-t="table"]');
      if (b) b.textContent = text;
    },
    dispose() {
      alive = false;
      clearTimeout(saveT);
      if (ro) ro.disconnect();
      host.innerHTML = '';
    },
  };
}
