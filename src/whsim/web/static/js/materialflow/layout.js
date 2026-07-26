// materialflow/layout.js — 工程キャンバスの自動レイアウト（純関数）。
//
// Left→right layering by LONGEST PATH (a 工程 sits one column right of its latest
// upstream), then a few barycentre sweeps to reduce crossings. Pure: it takes the
// resolved graph and gives back positions — no DOM, no fetch, no schema field.
// Positions are a VIEW concern and are kept in memory by canvas.js; the model
// never learns about them.
//
// never-blocks: a cyclic 依存 (which the master should not have, but might) is
// bounded by the relaxation pass count, so this always terminates.

export const NODE_W = 172;
export const NODE_H = 66;
export const GAP_X = 74;
export const GAP_Y = 26;

// Layer each node: depth = 1 + max(depth of upstream). Entry edges (src === '')
// carry no ordering information and are ignored here.
function layerOf(ids, preds) {
  const depth = new Map(ids.map((i) => [i, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;
    for (const id of ids) {
      let d = 0;
      for (const p of preds.get(id) || []) d = Math.max(d, (depth.get(p) || 0) + 1);
      if (d > (depth.get(id) || 0)) { depth.set(id, Math.min(d, ids.length - 1)); changed = true; }
    }
    if (!changed) break;
  }
  return depth;
}

// Stable sort by barycentre: a node moves next to the average row of the
// neighbours it is being ordered against; a node with no such neighbour keeps
// its current row (so hand-authored order survives where the graph says nothing).
function sweep(layers, index, neighbours) {
  for (const layer of layers) {
    const bary = new Map();
    layer.forEach((id, i) => {
      const ns = (neighbours.get(id) || []).filter((n) => index.has(n));
      bary.set(id, ns.length ? ns.reduce((s, n) => s + index.get(n), 0) / ns.length : i);
    });
    layer.sort((a, b) => (bary.get(a) - bary.get(b)) || 0);
    layer.forEach((id, i) => index.set(id, i));
  }
}

/**
 * Auto-layout the flow graph.
 * @param {Array} nodes  [{id,…}]
 * @param {Array} edges  [{src,dst,…}]
 * @returns {{pos:Object, layers:Array<Array<string>>, depth:Map}}
 */
export function autoLayout(nodes, edges) {
  const ids = (nodes || []).map((n) => String((n && n.id) || '')).filter(Boolean);
  const known = new Set(ids);
  const preds = new Map(ids.map((i) => [i, []]));
  const succs = new Map(ids.map((i) => [i, []]));
  for (const e of (edges || [])) {
    if (!e || !e.src || !e.dst || e.src === e.dst) continue;
    if (!known.has(e.src) || !known.has(e.dst)) continue;
    if (!preds.get(e.dst).includes(e.src)) preds.get(e.dst).push(e.src);
    if (!succs.get(e.src).includes(e.dst)) succs.get(e.src).push(e.dst);
  }

  const depth = layerOf(ids, preds);
  const layers = [];
  for (const id of ids) {
    const d = depth.get(id) || 0;
    if (!layers[d]) layers[d] = [];
    layers[d].push(id);
  }
  for (let i = 0; i < layers.length; i += 1) if (!layers[i]) layers[i] = [];

  const index = new Map();
  layers.forEach((layer) => layer.forEach((id, i) => index.set(id, i)));
  // Alternate down/up sweeps: ordering against upstream then downstream settles
  // quickly and is stable for the small graphs a 工程マスタ actually has.
  for (let s = 0; s < 4; s += 1) {
    sweep(layers, index, preds);
    sweep(layers.slice().reverse(), index, succs);
  }

  const rows = Math.max(1, ...layers.map((l) => l.length));
  const pos = {};
  layers.forEach((layer, l) => {
    const top = ((rows - layer.length) * (NODE_H + GAP_Y)) / 2;
    layer.forEach((id, i) => {
      pos[id] = { x: l * (NODE_W + GAP_X), y: top + i * (NODE_H + GAP_Y) };
    });
  });
  return { pos, layers, depth };
}

/** Would adding src→dst close a loop? (depends must stay a DAG for 人員設計.) */
export function wouldCycle(edges, src, dst) {
  if (!src || !dst) return false;
  if (src === dst) return true;
  const out = new Map();
  for (const e of (edges || [])) {
    if (!e || !e.src || !e.dst) continue;
    if (!out.has(e.src)) out.set(e.src, []);
    out.get(e.src).push(e.dst);
  }
  // Reachable from dst? Then src→dst would close the loop.
  const seen = new Set([dst]);
  const stack = [dst];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === src) return true;
    for (const n of (out.get(cur) || [])) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  return false;
}
