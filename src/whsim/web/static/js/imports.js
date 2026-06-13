// imports.js — the ①取込 upload handlers (ZIP / CAD / 棚間距離 / MapMaker地図CSV /
// MapMaker .rmpm / 出荷ETL / 入荷・在庫・商品マスタ table / 不足データ生成).
//
// Each handler posts a file to a `/api/projects/<name>/import-*` endpoint, then:
//   1. writes the detailed result into the shared #importLog (the hub's footer
//      log — also hosts the column-mapping correction UI for table imports),
//   2. writes a 1-line per-category status onto the ①取込 hub card via mark(),
//   3. records the success in the per-project 操作履歴 via hist.log(),
//   4. refreshes the project (headline / provenance / readiness).
//
// They read the shared SPA state (`S`) and `$`/`api`; the handful of cross-
// cutting shell helpers they call (`toast`, `openProject`, `mountDesigner`,
// `nudgeToDesign`, `setBtnBusy`, `cody`) stay in app.js and are injected once
// via `initImports(deps)`.
import { S } from './state.js';
import { $, api, esc } from './util.js';
import { hist } from './history.js';
import { forkliftBusy } from './progress.js';
import { openImportDock } from './importpreview.js';

// Replace the plain "…中…" line in the hub footer with a forklift-shuttle busy
// strip so the wait reads as 「処理してる感」. The success/error path overwrites
// #importLog (innerHTML), so the strip is cleared automatically.
function busyLog(label) {
  const host = $('importLog');
  if (host) forkliftBusy(label, host);
}

// Shell helpers that remain in app.js, injected at boot. Defaults are no-ops so a
// missing wire-up fails loud (via the empty-project guards) rather than crashing.
let toast = () => {};
let openProject = async () => {};
let mountDesigner = async () => {};
let nudgeToDesign = () => {};
let setBtnBusy = () => {};
let cody = () => {};

export function initImports(deps) {
  ({ toast, openProject, mountDesigner, nudgeToDesign, setBtnBusy, cody } = deps);
}

// ---- hub status line --------------------------------------------------------
// One-line "last import" status on the matching ①取込 hub card. The hub renders
// `[data-ihub-status="<cat>"]` slots (cats: actual / items / layout); writing is
// best-effort so the handlers also work if the hub isn't mounted.
function mark(cat, ok, text) {
  const el = document.querySelector(`[data-ihub-status="${cat}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-ok', ok === true);
  el.classList.toggle('is-err', ok === false);
}
const noProject = (cat) => {
  $('importLog').textContent = '先にプロジェクトを作成してください。';
  if (cat) mark(cat, false, '先にプロジェクトを作成してください。');
};

// ---- import ----------------------------------------------------------------
export async function uploadZip(file) {
  if (!S.project) { noProject('layout'); return; }
  const fd = new FormData(); fd.append('file', file);
  busyLog('ZIPを取り込み中…');
  mark('layout', null, `${file.name} を取り込み中…`);
  try {
    const r = await api(`/api/projects/${S.project}/import`, { method: 'POST', body: fd });
    const updated = r.updated.join(', ') || 'なし';
    const lines = [`<span class="ok">取り込み: ${esc(updated)}</span>`];
    for (const w of r.warnings) lines.push(`<span class="warn">! ${esc(w)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    $('provenance').textContent = r.provenance_summary;
    mark('layout', true, `✓ ${file.name} — ${updated}`);
    hist.log('🗂️', `ZIP一括取込: ${file.name}（${updated}）`, 'overview', 'layout');
    S.hasData = true;
    await openProject(S.project); // refresh headline values (also refreshes readiness)
    if (S.dataanalysis) S.dataanalysis.refresh();
    toast('データを取り込みました。', 'ok');
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('layout', false, '✕ ' + file.name + ' — ' + e.message);
    toast('取り込みに失敗しました: ' + e.message, 'error');
  }
}

export async function uploadDistances(file) {
  if (!S.project) { noProject('layout'); return; }
  const fd = new FormData(); fd.append('file', file);
  busyLog('棚間距離を取込中…');
  mark('layout', null, `${file.name} を取込中…`);
  try {
    const r = await api(`/api/projects/${S.project}/import-distances`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">棚間距離: ${r.count}件取込（実測距離で動線を補正）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${esc(w)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    mark('layout', true, `✓ ${file.name} — 棚間距離${r.count}件`);
    hist.log('📏', `棚間距離を取込: ${file.name}（${r.count}件）`, 'design', 'layout');
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('layout', false, '✕ ' + file.name + ' — ' + e.message);
    toast('取り込みに失敗しました: ' + e.message, 'error');
  }
}

export async function uploadMapcsv(file) {
  if (!S.project) { noProject('layout'); return; }
  const fd = new FormData(); fd.append('file', file);
  busyLog('MapMaker地図を解析中…');
  mark('layout', null, `${file.name} を解析中…`);
  try {
    const r = await api(`/api/projects/${S.project}/import-mapcsv`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">地図取込: 棚${r.shelves}・壁${r.walls}・ステーション${r.stations}` +
      ` → ロケーション${r.locations}件生成（${r.stats && r.stats.units || 'm'}）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${esc(w)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    mark('layout', true, `✓ ${file.name} — 棚${r.shelves}・壁${r.walls}`);
    hist.log('🗺️', `MapMaker地図を取込: ${file.name}（棚${r.shelves}）`, 'design', 'layout');
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`地図を取り込みました（棚${r.shelves}）。`);
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('layout', false, '✕ ' + file.name + ' — ' + e.message);
    toast('地図取込に失敗しました: ' + e.message, 'error');
  }
}

// MapMaker native .rmpm / .rmpm.json layout (richer than the CSV: shelf names).
export async function uploadRmpm(file) {
  if (!S.project) { noProject('layout'); return; }
  const fd = new FormData(); fd.append('file', file);
  busyLog('MapMakerレイアウトを解析中…');
  mark('layout', null, `${file.name} を解析中…`);
  try {
    const r = await api(`/api/projects/${S.project}/import-rmpm`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">レイアウト取込: 棚${r.shelves}・壁${r.walls}・ステーション${r.stations}` +
      ` → ロケーション${r.locations}件生成（${r.stats && r.stats.units || 'm'}）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${esc(w)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    mark('layout', true, `✓ ${file.name} — 棚${r.shelves}・ロケ${r.locations}`);
    hist.log('🗺️', `MapMakerレイアウトを取込: ${file.name}（棚${r.shelves}）`, 'design', 'layout');
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`MapMakerレイアウトを取り込みました（棚${r.shelves}）。`);
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('layout', false, '✕ ' + file.name + ' — ' + e.message);
    toast('取込に失敗しました: ' + e.message, 'error');
  }
}

// ---- 出荷実績 ETL (/import/shipments) ----------------------------------------
// Reads a shipments CSV/Excel, auto-maps columns, and ingests it as the
// project's outbound orders (real calendar weekday/hour survive via arrival_s).
// Optional 商品マスタ file enriches SKUs (入数/名前/ABC).
//
// Smooth default: imports IMMEDIATELY with auto-mapping (mapping=null lets the
// server auto-detect). To review/correct, call `reviewShipments(file)` which
// opens the bottom dock and re-imports with the chosen mapping. Returns a result
// object `{ ok, summary }` so the queue UI can chip-mark each file.
export async function uploadShipments(file, itemsFile = null, mapping = null) {
  if (!S.project) { noProject('actual'); return { ok: false }; }
  const fd = new FormData();
  fd.append('shipments', file);
  if (itemsFile) fd.append('items', itemsFile);
  busyLog('出荷実績を取込中…');
  mark('actual', null, `${file.name} を取込中…`);
  try {
    let url = `/api/projects/${S.project}/import/shipments`;
    if (mapping) url += '?mapping=' + encodeURIComponent(JSON.stringify(mapping));
    const r = await api(url, { method: 'POST', body: fd });
    if (!r || !r.ok) {
      const msg = (r && r.message) || '取り込める明細がありませんでした。';
      $('importLog').innerHTML = `<span class="warn">! ${esc(msg)}</span>`;
      mark('actual', false, `✕ ${file.name} — ${msg}`);
      toast(msg, 'error');
      return { ok: false, summary: msg };
    }
    const s = r.summary || {};
    const parts = [];
    if (s.orders != null) parts.push(`注文${s.orders}件`);
    if (s.lines != null) parts.push(`明細${s.lines}行`);
    if (s.skus != null) parts.push(`SKU${s.skus}`);
    const summary = parts.join(' / ') || '取込完了';
    const lines = [`<span class="ok">出荷実績: ${esc(summary)}</span>`];
    if (r.message) lines.push(`<span class="ok">${esc(r.message)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    mark('actual', true, `✓ ${file.name} — ${summary}`);
    hist.log('📦', `出荷実績を取込: ${file.name}（${summary}）`, 'dataanalysis', 'actual');
    S.hasData = true;
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.dataanalysis) S.dataanalysis.refresh();
    toast('出荷実績を取り込みました。②分析で物量を確認できます。', 'ok');
    return { ok: true, summary };
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('actual', false, '✕ ' + file.name + ' — ' + e.message);
    toast('取込に失敗しました: ' + e.message, 'error');
    return { ok: false, summary: e.message };
  }
}

// Open the bottom preview dock for an 出荷実績 file; commit re-imports with the
// chosen mapping. Non-blocking — the dock stays open while the user tunes.
export function reviewShipments(file) {
  if (!S.project) { noProject('actual'); return; }
  openImportDock({
    project: S.project, file, kind: 'shipments',
    onCommit: (mapping) => uploadShipments(file, null, mapping),
  });
}

// ---- unified 入荷/出荷/商品マスタ・在庫 import with editable column mapping ----
// `cat` is the ①取込 hub status slot to write (出荷/入荷/在庫 each have their own
// row now); kind=master is shared by the 在庫 row (cat 'stock') and the 商品マスタ
// card (cat 'items'), so callers pass it explicitly.
const TABLE_JP = { shipments: '出荷実績', inbound: '入荷実績', master: '商品マスタ・在庫' };
const TABLE_CAT = { shipments: 'actual', inbound: 'inbound', master: 'stock' };
const TABLE_ICON = { shipments: '📦', inbound: '🚚', master: '🏷️' };
// Smooth default: import immediately with auto-mapping (mapping=null). To review,
// call `reviewTable(...)` which opens the dock. Returns `{ ok, summary }`.
export async function uploadTable(file, kind = 'shipments', cat = null, mapping = null) {
  if (!S.project) { noProject(cat || TABLE_CAT[kind] || 'actual'); return { ok: false }; }
  const tkind = TABLE_JP[kind] ? kind : 'shipments';
  return doTableImport(file, tkind, cat, mapping);
}
async function doTableImport(file, kind, catArg, mapping) {
  const cat = catArg || TABLE_CAT[kind] || 'actual';
  const fd = new FormData(); fd.append('file', file);
  let url = `/api/projects/${S.project}/import-table?kind=${kind}`;
  if (mapping) url += '&mapping=' + encodeURIComponent(JSON.stringify(mapping));
  busyLog('取込中…');
  mark(cat, null, `${file.name} を取込中…`);
  try {
    const r = await api(url, { method: 'POST', body: fd });
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    const cnt = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(' / ');
    $('importLog').innerHTML = `<span class="ok">${esc(TABLE_JP[kind])}を取込（${esc(cnt || '0')}）</span>`;
    mark(cat, true, `✓ ${file.name} — ${TABLE_JP[kind]}（${cnt || '0'}）`);
    hist.log(TABLE_ICON[kind] || '📄',
      `${TABLE_JP[kind]}を取込: ${file.name}（${cnt || '0'}）`,
      kind === 'master' ? 'overview' : 'dataanalysis', cat);
    if (kind !== 'master') S.hasData = true;
    await openProject(S.project);
    if (S.dataanalysis) S.dataanalysis.refresh();
    toast('取込しました。', 'ok');
    return { ok: true, summary: cnt || '0' };
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark(cat, false, '✕ ' + file.name + ' — ' + e.message);
    toast('取込に失敗しました: ' + e.message, 'error');
    return { ok: false, summary: e.message };
  }
}

// Open the bottom preview dock for an 入荷/在庫/商品マスタ file; commit re-imports.
export function reviewTable(file, kind = 'shipments', cat = null) {
  if (!S.project) { noProject(cat || TABLE_CAT[kind] || 'actual'); return; }
  const tkind = TABLE_JP[kind] ? kind : 'shipments';
  openImportDock({
    project: S.project, file, kind: tkind,
    onCommit: (mapping) => uploadTable(file, tkind, cat, mapping),
  });
}

export async function generateMissing() {
  if (!S.project) { noProject('items'); return; }
  setBtnBusy($('genMissingBtn'), true, '生成中…');
  try {
    const r = await api(`/api/projects/${S.project}/generate-missing`, { method: 'POST' });
    const gen = (r.generated && r.generated.length) ? r.generated : [];
    const lines = gen.length
      ? gen.map(g => `<span class="ok">＋ ${esc(g)}</span>`)
      : ['<span class="warn">生成できる不足データはありませんでした。</span>'];
    $('importLog').innerHTML = lines.join('\n');
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    if (gen.length) {
      mark('items', true, `✓ 不足データを生成（${gen.join('、')}）`);
      hist.log('✨', `不足データを生成（${gen.join('、')}）`, 'overview', 'items');
    } else {
      mark('items', true, '✓ 生成できる不足データはありませんでした');
    }
    await openProject(S.project);  // refresh headline/provenance/readiness
    toast('不足データを生成しました。', 'ok');
    cody('excited', '不足していたマスタを実データから補ったよ。これで実行できる。');
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('items', false, '✕ 生成に失敗 — ' + e.message);
    toast('生成に失敗しました: ' + e.message, 'error');
  } finally { setBtnBusy($('genMissingBtn'), false); }
}

export async function uploadCad(file) {
  if (!S.project) { noProject('layout'); return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'CAD図面を解析中…';
  mark('layout', null, `${file.name} を解析中…`);
  try {
    const r = await api(`/api/projects/${S.project}/import-cad`, { method: 'POST', body: fd });
    const ext = r.bounds ? r.bounds.width.toFixed(0) + '×' + r.bounds.depth.toFixed(0) + 'm' : '—';
    const lines = [`<span class="ok">図面取込: 壁${r.walls}本 / ゾーン${r.zones}個 / 外形 ${ext}</span>`];
    for (const w of (r.warnings || [])) lines.push(`<span class="warn">! ${esc(w)}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    mark('layout', true, `✓ ${file.name} — 壁${r.walls}・外形${ext}`);
    hist.log('📐', `CAD図面を取込: ${file.name}（壁${r.walls}）`, 'design', 'layout');
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`図面を取り込みました（壁${r.walls}）。`);
  } catch (e) {
    $('importLog').textContent = 'エラー: ' + e.message;
    mark('layout', false, '✕ ' + file.name + ' — ' + e.message);
    toast('取り込みに失敗しました: ' + e.message, 'error');
  }
}
