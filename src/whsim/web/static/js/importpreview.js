// importpreview.js — the 取込プレビュー / 項目の紐付け BOTTOM DOCK (not a modal).
//
// Dropping an 実績データ file imports immediately with auto-mapping (smooth, non-
// blocking — see imports.js). To REVIEW or CORRECT a mapping the user opens this
// dock: a drawer pinned to the viewport bottom, spanning the content width,
// drag-resizable (drag its top edge), collapsible (header toggle), and NON-
// blocking — the page above stays fully usable, so several files can be tuned in
// turn without a stack of modals. It shows the ACTUAL data (first rows of the
// real columns), the field→column mapping selects, the live 件数, and a
// 「この内容で取込」 button that re-imports with the chosen mapping.
//
//   openImportDock({ project, file, kind, label, onCommit }) -> void
// Opens (or re-targets) the singleton dock for `file`. `onCommit(mapping)` is
// invoked when the user confirms; it should perform the real import and may
// return a Promise — the dock shows a busy state until it settles, then closes.
// Read-only until then: the preview endpoint never writes to the project.
//
// `closeImportDock()` collapses/hides the dock. Dock height persists in
// localStorage; prefers-reduced-motion is respected.
import { $, api, esc } from './util.js';

const KIND_JP = { shipments: '出荷実績', inbound: '入荷実績', master: '商品マスタ・在庫' };
const LS_HEIGHT = 'whsim-importdock-h';
const MIN_H = 180;
const DEFAULT_H = 340;

function injectStyle() {
  if (document.getElementById('ipv-style')) return;
  const s = document.createElement('style');
  s.id = 'ipv-style';
  s.textContent = `
  /* Bottom dock drawer — pinned to the viewport bottom, content-width, non-modal.
     Mirrors the scorecard side-dock idea but as a bottom version the user opens/
     closes at will and freely resizes by dragging the top edge. */
  .ipv-dock{position:fixed;left:0;right:0;bottom:0;z-index:8200;display:flex;flex-direction:column;
    background:var(--bg-panel,#121a24);border-top:1px solid var(--line-strong,rgba(120,140,170,.3));
    box-shadow:0 -18px 50px rgba(0,0,0,.32);color:var(--ink-primary,#eaf2f8);
    font-family:var(--font-sans,inherit);
    transition:transform var(--dur-3,240ms) cubic-bezier(.16,1,.3,1)}
  .ipv-dock[hidden]{display:none}
  .ipv-dock.collapsed{transform:translateY(calc(100% - var(--ipv-head-h,44px)))}
  /* drag handle on the very top edge */
  .ipv-grip{position:absolute;top:0;left:0;right:0;height:8px;cursor:ns-resize;z-index:2;
    touch-action:none}
  .ipv-grip::after{content:"";position:absolute;left:50%;top:3px;transform:translateX(-50%);
    width:46px;height:3px;border-radius:3px;background:var(--line-strong,rgba(120,140,170,.45))}
  .ipv-grip:hover::after{background:var(--accent,#16C0DE)}
  .ipv-dhead{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:11px 16px 9px;
    border-bottom:1px solid var(--line-hair,rgba(120,140,170,.16));cursor:pointer;user-select:none}
  .ipv-dhead .ipv-caret{font-size:11px;color:var(--ink-tertiary,#8ea4b6);width:12px;
    transition:transform var(--dur-2,160ms) ease}
  .ipv-dock.collapsed .ipv-caret{transform:rotate(-90deg)}
  .ipv-title{font-size:14px;font-weight:700;white-space:nowrap}
  .ipv-file{font-size:12px;color:var(--ink-tertiary,#8ea4b6);white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;flex:1;min-width:0}
  .ipv-x{border:none;background:transparent;color:var(--ink-secondary,#b6c6d4);
    font-size:19px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px;flex:0 0 auto}
  .ipv-x:hover{background:var(--line-hair,rgba(120,140,170,.16))}
  .ipv-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 16px 14px;display:flex;
    flex-direction:column;gap:12px}
  .ipv-dock.collapsed .ipv-body,.ipv-dock.collapsed .ipv-foot{visibility:hidden}
  /* mapping editor */
  .ipv-map-h{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--ink-tertiary,#8ea4b6);
    text-transform:uppercase}
  .ipv-maps{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
  .ipv-mrow{display:flex;align-items:center;gap:8px;background:var(--bg-sunken,rgba(120,140,170,.1));
    border:1px solid var(--line-hair,rgba(120,140,170,.16));border-radius:10px;padding:7px 10px}
  .ipv-mlabel{font-size:12.5px;font-weight:600;white-space:nowrap}
  .ipv-mlabel .req{color:var(--bad,#ff6b7d);margin-left:2px}
  .ipv-mrow select{margin-left:auto;max-width:130px;font:inherit;font-size:12px;padding:3px 6px;
    border-radius:7px;border:1px solid var(--line-strong,rgba(120,140,170,.3));
    background:var(--bg-app,#0e1620);color:var(--ink-primary,#eaf2f8)}
  .ipv-mrow.miss{border-color:var(--warn,#f5b05a)}
  .ipv-mrow.ok{border-color:var(--ok-line,rgba(52,227,160,.4))}
  /* counts readout */
  .ipv-counts{display:flex;flex-wrap:wrap;gap:8px}
  .ipv-chip{display:inline-flex;align-items:baseline;gap:5px;font-size:12px;
    background:var(--accent-tint,rgba(22,192,222,.14));color:var(--accent-ink,#16C0DE);
    border-radius:999px;padding:3px 11px;font-weight:600}
  .ipv-chip b{font-variant-numeric:tabular-nums}
  /* data preview table */
  /* min-width:0 lets this flex child shrink below the table width so its OWN
     overflow:auto produces the horizontal scrollbar (wide, many-column files)
     instead of the table overflowing the fixed dock. */
  .ipv-prev-wrap{flex:1;min-width:0;min-height:90px;overflow:auto;
    border:1px solid var(--line-hair,rgba(120,140,170,.16));border-radius:10px}
  .ipv-tbl{border-collapse:collapse;font-size:12px;width:max-content;min-width:100%}
  .ipv-tbl th,.ipv-tbl td{padding:5px 10px;border-bottom:1px solid var(--line-hair,rgba(120,140,170,.12));
    border-right:1px solid var(--line-hair,rgba(120,140,170,.08));white-space:nowrap;text-align:left}
  .ipv-tbl thead th{position:sticky;top:0;background:var(--bg-panel,#121a24);z-index:1;
    color:var(--ink-secondary,#b6c6d4);font-weight:600}
  .ipv-tbl thead th.mapped{color:var(--accent-ink,#16C0DE)}
  .ipv-tbl thead th .tag{display:block;font-size:9.5px;font-weight:700;color:var(--accent,#16C0DE);
    text-transform:none;letter-spacing:0}
  .ipv-tbl td.mapped{background:color-mix(in srgb,var(--accent,#16C0DE) 6%,transparent)}
  .ipv-tbl tbody tr:hover td{background:var(--bg-sunken,rgba(120,140,170,.08))}
  .ipv-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:10px 16px;
    border-top:1px solid var(--line-hair,rgba(120,140,170,.16))}
  .ipv-foot .ipv-note{font-size:11.5px;color:var(--ink-tertiary,#8ea4b6)}
  .ipv-btn{margin-left:0;padding:8px 16px;border-radius:10px;border:1px solid var(--line-strong,rgba(120,140,170,.3));
    background:transparent;color:var(--ink-secondary,#b6c6d4);font:inherit;font-weight:700;font-size:13px;cursor:pointer}
  .ipv-btn:hover{border-color:var(--accent,#16C0DE);color:var(--ink-primary,#eaf2f8)}
  .ipv-btn.primary{margin-left:auto;background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  .ipv-btn.primary:hover{filter:brightness(1.06)}
  .ipv-btn:disabled{opacity:.5;cursor:default}
  .ipv-busy{font-size:12px;color:var(--ink-tertiary,#8ea4b6)}
  @media (prefers-reduced-motion:reduce){.ipv-dock{transition:none}.ipv-caret{transition:none}}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

function countsHtml(counts, kind) {
  const c = counts || {};
  const chip = (lab, v) => (v == null ? '' : `<span class="ipv-chip"><span>${lab}</span><b>${fmt(v)}</b></span>`);
  if (kind === 'master') return chip('商品', c.items) + chip('SKU', c.skus);
  if (kind === 'inbound') return chip('明細', c.inbound_lines) + chip('SKU', c.skus) + chip('数量', c.units);
  return chip('注文', c.orders) + chip('明細', c.lines) + chip('SKU', c.skus) + chip('数量', c.units);
}

// ---- singleton dock ---------------------------------------------------------
let dock = null;       // the root element (built once, reused)
let els = null;        // cached child handles
let session = 0;       // bumped each time a new file is targeted (cancels stale loads)
let ctx = null;        // { project, file, kind, onCommit }

function readHeight() {
  const v = parseInt(localStorage.getItem(LS_HEIGHT) || '', 10);
  return Number.isFinite(v) && v >= MIN_H ? v : DEFAULT_H;
}
function applyHeight(h) {
  const max = Math.max(MIN_H, window.innerHeight - 80);
  const clamped = Math.min(max, Math.max(MIN_H, Math.round(h)));
  dock.style.height = clamped + 'px';
  return clamped;
}

function buildDock() {
  injectStyle();
  dock = document.createElement('section');
  dock.className = 'ipv-dock';
  dock.setAttribute('role', 'region');
  dock.setAttribute('aria-label', '取込プレビュー');
  dock.hidden = true;
  dock.innerHTML =
    `<div class="ipv-grip" role="separator" aria-orientation="horizontal"
          aria-label="高さを変更（ドラッグ）" tabindex="0"></div>
     <div class="ipv-dhead" data-toggle role="button" tabindex="0" aria-expanded="true">
       <span class="ipv-caret" aria-hidden="true">▼</span>
       <span class="ipv-title">取込プレビュー</span>
       <span class="ipv-file" data-file></span>
       <button type="button" class="ipv-x" data-close aria-label="閉じる">×</button>
     </div>
     <div class="ipv-body" data-body><div class="ipv-busy">読み込み中…</div></div>
     <div class="ipv-foot">
       <span class="ipv-note">この内容で取り込みます。マッピングを直して再取込できます。</span>
       <span class="ipv-busy" data-busy></span>
       <button type="button" class="ipv-btn" data-cancel>閉じる</button>
       <button type="button" class="ipv-btn primary" data-commit disabled>この内容で取込</button>
     </div>`;
  document.body.appendChild(dock);
  applyHeight(readHeight());

  els = {
    grip: dock.querySelector('.ipv-grip'),
    head: dock.querySelector('[data-toggle]'),
    caret: dock.querySelector('.ipv-caret'),
    file: dock.querySelector('[data-file]'),
    body: dock.querySelector('[data-body]'),
    busy: dock.querySelector('[data-busy]'),
    commit: dock.querySelector('[data-commit]'),
  };

  // measure header height so the collapsed transform leaves it peeking.
  const setHeadVar = () => {
    const h = dock.querySelector('.ipv-dhead');
    if (h) dock.style.setProperty('--ipv-head-h', h.offsetHeight + 'px');
  };
  setHeadVar();

  // header toggle (collapse/expand) — but not when the × is clicked.
  els.head.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return;
    toggleCollapsed();
  });
  els.head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(); }
  });
  dock.querySelector('[data-close]').onclick = (e) => { e.stopPropagation(); closeImportDock(); };
  dock.querySelector('[data-cancel]').onclick = () => closeImportDock();

  // Esc collapses the dock when focus is inside it (non-blocking: doesn't steal
  // global Esc otherwise).
  dock.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dock.classList.contains('collapsed')) {
      e.stopPropagation(); setCollapsed(true);
    }
  });

  wireResize();
}

function toggleCollapsed() { setCollapsed(!dock.classList.contains('collapsed')); }
function setCollapsed(on) {
  dock.classList.toggle('collapsed', on);
  els.head.setAttribute('aria-expanded', String(!on));
}

// Drag the top grip to resize. Pointer events so mouse + touch both work.
function wireResize() {
  let startY = 0, startH = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    // dragging up (smaller clientY) grows the dock.
    const h = startH + (startY - e.clientY);
    applyHeight(h);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    localStorage.setItem(LS_HEIGHT, String(parseInt(dock.style.height, 10) || DEFAULT_H));
  };
  els.grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (dock.classList.contains('collapsed')) setCollapsed(false);
    dragging = true;
    startY = e.clientY;
    startH = dock.getBoundingClientRect().height;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  // keyboard resize on the grip (Up/Down arrows)
  els.grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = dock.getBoundingClientRect().height;
    const next = applyHeight(cur + (e.key === 'ArrowUp' ? 32 : -32));
    localStorage.setItem(LS_HEIGHT, String(next));
  });
}

// ---- preview state (per-session) --------------------------------------------
let data = null;          // last preview payload {columns, mapping, counts, preview}
let mapping = {};         // fieldKey -> column|null
let recomputing = false;
let recomputeTimer = 0;

async function fetchPreview(mp) {
  const fd = new FormData();
  fd.append('file', ctx.file);
  let url = `/api/projects/${encodeURIComponent(ctx.project)}/import-preview?kind=${encodeURIComponent(ctx.kind)}`;
  if (mp) url += '&mapping=' + encodeURIComponent(JSON.stringify(mp));
  return api(url, { method: 'POST', body: fd });
}

function columnField() {
  const m = {};
  for (const [, info] of Object.entries((data && data.mapping) || {})) {
    if (info.column) m[info.column] = info.label;
  }
  return m;
}

function renderBody() {
  const cols = (data.preview && data.preview.columns) || data.columns || [];
  const rows = (data.preview && data.preview.rows) || [];
  const colF = columnField();
  const fields = Object.entries(data.mapping || {});
  const opts = (sel) => ['<option value="">（なし）</option>']
    .concat(cols.map((c) => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`)).join('');
  const maps = fields.map(([key, info]) => {
    const cls = info.required ? (info.column ? 'ok' : 'miss') : '';
    return `<div class="ipv-mrow ${cls}">
      <span class="ipv-mlabel">${esc(info.label)}${info.required ? '<span class="req">*</span>' : ''}</span>
      <select data-field="${esc(key)}">${opts(info.column)}</select>
    </div>`;
  }).join('');
  const thead = cols.map((c) => {
    const f = colF[c];
    return `<th class="${f ? 'mapped' : ''}">${esc(c)}${f ? `<span class="tag">→ ${esc(f)}</span>` : ''}</th>`;
  }).join('');
  const tbody = rows.map((r) =>
    `<tr>${r.map((v, i) => `<td class="${colF[cols[i]] ? 'mapped' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('');
  // Preview reads only the top rows (fast, like a BI tool) — say so honestly; the
  // real totals are computed on 取込 (which reads the whole file).
  const pv = data.preview || {};
  const readN = pv.preview_rows != null ? pv.preview_rows : (pv.total_rows || rows.length);
  const more = (data.sampled || pv.sampled)
    ? `<div class="ipv-note" style="padding:6px 2px">先頭 ${fmt(readN)} 行のみ読み込んでプレビュー（マッピング用）。件数は概算で、実際の総数は取込時に算出します。</div>`
    : (readN > rows.length
      ? `<div class="ipv-note" style="padding:6px 2px">先頭 ${rows.length} 行を表示（全 ${fmt(readN)} 行）</div>` : '');

  els.body.innerHTML =
    `<div class="ipv-map-h">項目の紐付け（必要なら直してください。<b>*</b>は必須）</div>
     <div class="ipv-maps">${maps}</div>
     <div class="ipv-map-h">取り込まれる件数（このマッピングの場合）</div>
     <div class="ipv-counts" data-counts>${countsHtml(data.counts, ctx.kind)}</div>
     <div class="ipv-map-h">データプレビュー</div>
     <div class="ipv-prev-wrap"><table class="ipv-tbl"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>
     ${more}`;
  els.body.querySelectorAll('select[data-field]').forEach((sel) => {
    sel.onchange = () => {
      mapping[sel.dataset.field] = sel.value || null;
      scheduleRecompute();
    };
  });
  refreshCommitState();
}

function scheduleRecompute() {
  if (recomputeTimer) clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 280);
}
async function recompute() {
  if (recomputing) return;
  recomputing = true;
  const mySession = session;
  els.busy.textContent = '再計算中…';
  try {
    const next = await fetchPreview(mapping);
    if (mySession !== session) return;  // a different file took over
    data = next;
    mapping = {};
    for (const [k, info] of Object.entries(data.mapping || {})) mapping[k] = info.column || null;
    renderBody();
  } catch (e) {
    if (mySession === session) els.busy.textContent = '再計算に失敗: ' + (e && e.message ? e.message : e);
  } finally {
    recomputing = false;
    if (mySession === session) els.busy.textContent = '';
  }
}

function missingRequired() {
  return Object.values((data && data.mapping) || {}).some((i) => i.required && !i.column);
}
function refreshCommitState() {
  els.commit.disabled = !data || missingRequired();
  els.commit.title = els.commit.disabled ? '必須項目（*）の列を指定してください' : '';
}

// Open (or re-target) the dock for a file. Non-blocking: returns immediately.
export function openImportDock({ project, file, kind = 'shipments', label = '', onCommit } = {}) {
  if (!dock) buildDock();
  ctx = { project, file, kind, onCommit };
  session += 1;
  const mySession = session;

  dock.hidden = false;
  setCollapsed(false);
  els.file.textContent = `${label || KIND_JP[kind] || ''}：${file.name}`;
  els.body.innerHTML = '<div class="ipv-busy">読み込み中…</div>';
  els.busy.textContent = '';
  data = null; mapping = {};
  refreshCommitState();

  els.commit.onclick = async () => {
    if (els.commit.disabled) return;
    const mp = { ...mapping };
    els.commit.disabled = true;
    els.busy.textContent = '取込中…';
    try {
      await Promise.resolve(ctx.onCommit && ctx.onCommit(mp));
      if (mySession === session) closeImportDock();
    } catch (e) {
      if (mySession === session) {
        els.busy.textContent = '取込に失敗: ' + (e && e.message ? e.message : e);
        refreshCommitState();
      }
    }
  };

  (async () => {
    try {
      const next = await fetchPreview(null);
      if (mySession !== session) return;  // superseded
      data = next;
      mapping = {};
      for (const [k, info] of Object.entries(data.mapping || {})) mapping[k] = info.column || null;
      renderBody();
    } catch (e) {
      if (mySession === session) {
        els.body.innerHTML = `<div class="ipv-busy">プレビューに失敗しました: ${esc(e && e.message ? e.message : e)}</div>`;
      }
    }
  })();
}

export function closeImportDock() {
  if (!dock) return;
  session += 1;  // cancel any in-flight load/commit
  dock.hidden = true;
  ctx = null; data = null; mapping = {};
}
