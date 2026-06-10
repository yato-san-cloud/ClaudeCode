// imports.js — the ①取込 upload handlers, extracted verbatim from app.js.
//
// These were the `// ---- import ----` section of app.js: the ZIP / CAD / 棚間距離 /
// MapMaker地図CSV / MapMaker .rmpm / 入荷・出荷・商品マスタ table importers plus the
// 不足データ生成 (generate-missing) action. They are a cohesive, low-coupling cluster:
// each posts a file to a `/api/projects/<name>/import-*` endpoint and writes the
// shared #importLog / #provenance, then refreshes the project.
//
// They read the shared SPA state (`S`) and `$`/`api`; the handful of cross-cutting
// shell helpers they call (`toast`, `openProject`, `mountDesigner`, `nudgeToDesign`,
// `setBtnBusy`, `cody`) stay in app.js and are injected once via `initImports(deps)`.
// This keeps app.js the owner of view-switch / project-lifecycle wiring while the
// upload bodies move out — behaviour is identical (same endpoints, same DOM ids,
// same toasts, same follow-up calls in the same order).
import { S } from './state.js';
import { $, api } from './util.js';

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

// ---- import ----------------------------------------------------------------
export async function uploadZip(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '取り込み中…';
  try {
    const r = await api(`/api/projects/${S.project}/import`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">取り込み: ${r.updated.join(', ') || 'なし'}</span>`];
    for (const w of r.warnings) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    $('provenance').textContent = r.provenance_summary;
    S.hasData = true;
    await openProject(S.project); // refresh headline values (also refreshes readiness)
    if (S.dataanalysis) S.dataanalysis.refresh();
    toast('データを取り込みました。', 'ok');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

export async function uploadDistances(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '棚間距離を取込中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-distances`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">棚間距離: ${r.count}件取込（実測距離で動線を補正）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

export async function uploadMapcsv(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'MapMaker地図を解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-mapcsv`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">地図取込: 棚${r.shelves}・壁${r.walls}・ステーション${r.stations}` +
      ` → ロケーション${r.locations}件生成（${r.stats && r.stats.units || 'm'}）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`地図を取り込みました（棚${r.shelves}）。`);
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('地図取込に失敗しました: ' + e.message, 'error'); }
}

// MapMaker native .rmpm.json layout (richer than the CSV: carries shelf names).
export async function uploadRmpm(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'MapMakerレイアウトを解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-rmpm`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">レイアウト取込: 棚${r.shelves}・壁${r.walls}・ステーション${r.stations}` +
      ` → ロケーション${r.locations}件生成（${r.stats && r.stats.units || 'm'}）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    await openProject(S.project); // refresh headline/provenance/readiness
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`MapMakerレイアウトを取り込みました（棚${r.shelves}）。`);
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取込に失敗しました: ' + e.message, 'error'); }
}

// ---- unified 入荷/出荷/商品マスタ import with editable column mapping ---------
let _tableFile = null, _tableKind = 'shipments';
export async function uploadTable(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  _tableFile = file; _tableKind = $('tableKind').value;
  await doTableImport(null);
}
async function doTableImport(mapping) {
  const fd = new FormData(); fd.append('file', _tableFile);
  let url = `/api/projects/${S.project}/import-table?kind=${_tableKind}`;
  if (mapping) url += '&mapping=' + encodeURIComponent(JSON.stringify(mapping));
  $('importLog').textContent = '取込中…';
  try {
    const r = await api(url, { method: 'POST', body: fd });
    renderTableMapping(r);
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    await openProject(S.project);
    toast('取込しました。', 'ok');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取込に失敗しました: ' + e.message, 'error'); }
}
function renderTableMapping(r) {
  const opts = (sel) => ['<option value="">（なし）</option>']
    .concat((r.columns || []).map(c => `<option${c === sel ? ' selected' : ''}>${c}</option>`)).join('');
  const rows = Object.entries(r.mapping || {}).map(([k, m]) =>
    `<div class="row" style="gap:6px;margin:3px 0;align-items:center">
       <span style="flex:1;font-size:12px">${m.label}${m.required ? ' <b style="color:var(--bad)">*</b>' : ''}</span>
       <select data-mapfield="${k}" style="flex:1">${opts(m.column)}</select>
     </div>`).join('');
  const cnt = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(' / ');
  $('importLog').innerHTML =
    `<span class="ok">取込（${cnt || '0'}）</span>
     <div style="margin-top:6px;font-size:11px;color:var(--muted-2)">列マッピング（必要なら直して再取込）</div>${rows}
     <button id="remapBtn" style="margin-top:6px;width:100%">この対応で再取込</button>`;
  $('remapBtn').onclick = () => {
    const mp = {};
    $('importLog').querySelectorAll('[data-mapfield]').forEach(s => { mp[s.dataset.mapfield] = s.value || null; });
    doTableImport(mp);
  };
}

export async function generateMissing() {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  setBtnBusy($('genMissingBtn'), true, '生成中…');
  try {
    const r = await api(`/api/projects/${S.project}/generate-missing`, { method: 'POST' });
    const lines = (r.generated && r.generated.length)
      ? r.generated.map(g => `<span class="ok">＋ ${g}</span>`)
      : ['<span class="warn">生成できる不足データはありませんでした。</span>'];
    $('importLog').innerHTML = lines.join('\n');
    if (r.provenance_summary) $('provenance').textContent = r.provenance_summary;
    await openProject(S.project);  // refresh headline/provenance/readiness
    toast('不足データを生成しました。', 'ok');
    cody('excited', '不足していたマスタを実データから補ったよ。これで実行できる。');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('生成に失敗しました: ' + e.message, 'error'); }
  finally { setBtnBusy($('genMissingBtn'), false); }
}

export async function uploadCad(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'CAD図面を解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-cad`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">図面取込: 壁${r.walls}本 / ゾーン${r.zones}個 / ` +
      `外形 ${r.bounds ? r.bounds.width.toFixed(0) + '×' + r.bounds.depth.toFixed(0) + 'm' : '—'}</span>`];
    for (const w of (r.warnings || [])) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    if (S.view === 'design') mountDesigner();
    nudgeToDesign(`図面を取り込みました（壁${r.walls}）。`);
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}
