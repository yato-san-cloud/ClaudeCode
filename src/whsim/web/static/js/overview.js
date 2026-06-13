// overview.js — ①取込: the single-screen import hub.
//
// One screen, no page scroll (verified at 1500×950): a compact case-status band
// on top (project / 実データ% / readiness chips / next-step CTA) over a grid of
// four import-category cards — 実績データ / 商品マスタ / レイアウト・図面 /
// テンプレ・基本条件 — each with a drop zone that auto-routes files by
// extension, a file picker, and a one-line "last import" status that the
// handlers in imports.js write via `[data-ihub-status]`.
//
// Persistent nodes (#keyfigBody → headline fields + 反映, #importLog → detailed
// log incl. the column-mapping correction UI, and the hidden file inputs) live
// in #ihubAssets (index.html) and are ADOPTED into the hub with appendChild, so
// app.js's ID-based wiring (renderHeadline → #headline, #applyBtn) and the
// imports.js writes (#importLog) keep working untouched. Before any innerHTML
// rebuild they are parked back into #ihubAssets (adopted nodes are otherwise
// destroyed by the rebuild).
//
// opts: { getState(): {project,hasData,hasRun}, getProject(): Promise<modelJSON>,
//         switchTo(view), createSample(), toast(msg,kind) } — app.js supplies.
import { esc } from './util.js';
import {
  uploadZip, uploadCad, uploadDistances, uploadMapcsv, uploadRmpm,
  uploadTable, uploadShipments, generateMissing,
} from './imports.js';
import { hist, relTime } from './history.js';

const IHUB_CSS = `
/* ①取込 hub fills the stage exactly: the panel is a non-scrolling flex column;
   any overflow scrolls INSIDE a card body, never the page. */
#overview.panel.active{display:flex;flex-direction:column;overflow:hidden}
#overviewDash{flex:1;min-height:0;display:flex;flex-direction:column}
.ihub{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;width:100%;
  max-width:1440px;margin:0 auto;color:var(--ink-primary);font-family:var(--font-sans)}
/* --- status band ----------------------------------------------------------- */
.ihub-band{flex:0 0 auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  background:var(--bg-panel);border:1px solid var(--line-hair);
  border-radius:var(--r-lg);padding:10px 16px;box-shadow:var(--sh-xs)}
.ihub-id{flex:0 1 auto;min-width:0}
.ihub-name{font-size:17px;font-weight:700;line-height:1.2;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:240px}
.ihub-tmpl{font-size:10.5px;color:var(--ink-tertiary);margin-top:1px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:240px}
.ihub-prov{flex:0 0 auto}
.ihub-pct{font-size:10.5px;color:var(--ink-secondary);white-space:nowrap}
.ihub-pct b{font-size:15px;color:var(--accent-ink);font-weight:700}
.ihub-meter{height:6px;width:140px;border-radius:var(--r-pill);background:var(--bg-sunken);
  border:1px solid var(--line-hair);overflow:hidden;margin-top:4px}
.ihub-meter span{display:block;height:100%;background:var(--accent);
  border-radius:var(--r-pill);transition:width var(--dur-3) var(--ease-out)}
.ihub-checks{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:160px}
.ihub-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
  padding:3px 10px;border-radius:var(--r-pill);border:1px solid var(--line-soft);
  background:var(--bg-sunken);color:var(--ink-tertiary);white-space:nowrap}
.ihub-chip i{font-style:normal;font-weight:800;font-size:10px}
.ihub-chip.on{background:var(--ok-tint);border-color:var(--ok-line);color:var(--ok-ink)}
.ihub-nextwrap{display:flex;align-items:center;gap:10px;flex:0 0 auto;margin-left:auto}
.ihub-next-k{font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--accent-ink);
  text-transform:uppercase;white-space:nowrap}
.ihub-next{padding:8px 18px;border:none;border-radius:var(--r-md);cursor:pointer;
  background:var(--accent);color:var(--ink-onAccent);font:inherit;font-weight:700;
  font-size:13px;white-space:nowrap;box-shadow:var(--sh-sm);
  transition:background var(--dur-1) var(--ease-out)}
.ihub-next:hover{background:var(--accent-hover)}
.ihub-next:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* --- category card grid ----------------------------------------------------- */
.ihub-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:1280px){.ihub-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:680px){.ihub-grid{grid-template-columns:1fr}}
.ihub-card{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden;
  background:var(--bg-panel);border:1px solid var(--line-hair);
  border-radius:var(--r-lg);padding:12px;box-shadow:var(--sh-xs)}
.ihub-card.is-hot{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-tint)}
.ihub-ch{display:flex;gap:9px;align-items:flex-start;flex:0 0 auto}
.ihub-ico{font-size:19px;line-height:1.15;flex:0 0 auto}
.ihub-t{font-size:13.5px;font-weight:700;line-height:1.25}
.ihub-d{font-size:10.5px;color:var(--ink-tertiary);margin-top:1px;line-height:1.45}
.ihub-cb{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  display:flex;flex-direction:column;gap:8px;margin-top:9px}
.ihub-drop{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:5px;min-height:56px;padding:8px;text-align:center;
  border:1.5px dashed var(--line-strong);border-radius:var(--r-md);
  background:var(--bg-sunken);cursor:pointer;
  transition:border-color var(--dur-1) var(--ease-out),background var(--dur-1) var(--ease-out)}
.ihub-drop:hover{border-color:var(--accent)}
.ihub-drop.drag{border-color:var(--accent);background:var(--accent-tint)}
.ihub-drop:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ihub-drop-t{font-size:11px;font-weight:600;color:var(--ink-secondary);line-height:1.4}
.ihub-pick{border:1px solid var(--line-strong);background:var(--bg-app);
  color:var(--ink-primary);font:inherit;font-size:11px;font-weight:600;
  padding:3px 12px;border-radius:var(--r-pill);cursor:pointer}
.ihub-pick:hover{border-color:var(--accent)}
/* 実績データ card: 出荷/入荷/在庫 are three always-visible stacked drop rows
   (no kind toggle — the vertical space was there, so each kind keeps its own
   target + its own "last import" status line). */
.ihub-rowwrap{display:flex;flex-direction:column;gap:2px}
.ihub-drop-row{flex-direction:row;align-items:center;gap:8px;min-height:36px;
  padding:5px 9px;text-align:left}
.ihub-drop-row .ihub-drop-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.ihub-row-ico{flex:0 0 auto;font-size:14px;line-height:1}
.ihub-rst{font-size:10px;line-height:1.5;color:var(--ink-tertiary);margin:0 2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:15px}
.ihub-rst.is-ok{color:var(--ok-ink)}
.ihub-rst.is-err{color:var(--bad)}
.ihub-mini{display:flex;flex-wrap:wrap;gap:4px}
.ihub-mini button{flex:0 0 auto;border:1px solid var(--line-soft);background:transparent;
  color:var(--ink-secondary);font:inherit;font-size:10.5px;font-weight:600;
  padding:3px 9px;border-radius:var(--r-pill);cursor:pointer}
.ihub-mini button:hover{border-color:var(--accent);color:var(--ink-primary)}
.ihub-gen{flex:0 0 auto;border:1px solid var(--accent);background:var(--accent-tint);
  color:var(--accent-ink);font:inherit;font-size:11.5px;font-weight:600;
  padding:6px 10px;border-radius:var(--r-md);cursor:pointer}
.ihub-gen:hover{filter:brightness(1.04)}
.ihub-st{flex:0 0 auto;margin-top:8px;padding-top:6px;min-height:16px;
  border-top:1px dashed var(--line-soft);font-size:10.5px;line-height:1.5;
  color:var(--ink-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ihub-st.is-ok{color:var(--ok-ink)}
.ihub-st.is-err{color:var(--bad)}
/* テンプレ・基本条件 card hosts the adopted #keyfigBody (headline fields). */
.ihub-card [data-adopt] #headline{max-width:none}
.ihub-card #applyBtn{width:100%;margin-top:6px}
/* --- footer log (detail record / column-mapping UI from imports.js) --------- */
.ihub-foot{flex:0 0 auto;max-height:128px;overflow-y:auto;overscroll-behavior:contain}
.ihub-foot .log{margin:0}
/* --- empty state (no project) ----------------------------------------------- */
.ihub-empty{flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;text-align:center;padding:24px;color:var(--ink-secondary)}
.ihub-empty-h{font-size:17px;font-weight:700;color:var(--ink-primary);margin-bottom:8px}
.ihub-empty p{font-size:13px;line-height:1.7;margin:0}
.ihub-empty-sample{margin-top:16px;font-size:15px;padding:11px 24px;border:none;
  border-radius:var(--r-md);background:var(--accent);color:var(--ink-onAccent);
  font-weight:700;cursor:pointer;box-shadow:var(--sh-sm)}
.ihub-empty-sample:hover{background:var(--accent-hover)}
.ihub-empty-or{font-size:12px;color:var(--ink-tertiary);margin-top:12px}
@media (prefers-reduced-motion: reduce){
  .ihub-next,.ihub-kind,.ihub-drop{transition:none}
}
`;

function injectStyle() {
  if (document.getElementById('ihub-style')) return;
  const s = document.createElement('style');
  s.id = 'ihub-style';
  s.textContent = IHUB_CSS;
  document.head.appendChild(s);
}

// Persistent nodes adopted into the hub (and parked back before rebuilds).
const ASSET_IDS = ['keyfigBody', 'importLog'];

// File-extension router per category drop zone.
const TABLE_EXT = /\.(csv|xlsx|xls|json)$/;

export function mountOverview(el, opts = {}) {
  injectStyle();
  const getState = opts.getState || (() => ({}));
  const getProject = opts.getProject || (async () => null);
  const switchTo = opts.switchTo || (() => {});
  const createSample = typeof opts.createSample === 'function' ? opts.createSample : null;
  const toast = opts.toast || (() => {});

  const root = document.createElement('div');
  root.className = 'ihub';
  el.innerHTML = '';
  el.appendChild(root);

  let mode = null;          // 'empty' | 'hub' — what the DOM is built for
  let pendingKind = 'shipments'; // which 実績 row opened the shared tableInput picker

  // ---- persistent-node adoption --------------------------------------------
  function parkAssets() {
    const park = document.getElementById('ihubAssets');
    if (!park) return;
    for (const id of ASSET_IDS) {
      const n = document.getElementById(id);
      if (n && n.parentNode !== park) park.appendChild(n);
    }
  }
  function adopt(slotName, id) {
    const slot = root.querySelector(`[data-adopt="${slotName}"]`);
    const n = document.getElementById(id);
    if (slot && n) slot.appendChild(n);
  }

  // ---- file routing ----------------------------------------------------------
  // One upload call per 実績 kind (the rows are explicit now — no toggle state).
  function uploadActual(kind, f) {
    if (kind === 'shipments') return uploadShipments(f);
    if (kind === 'inbound') return uploadTable(f, 'inbound');
    return uploadTable(f, 'master', 'stock'); // 在庫実績 row (INVENTORY columns)
  }
  // Rows accept MULTIPLE files (e.g. 12 monthly 出荷実績 at once) — uploaded
  // sequentially so the log/status stay readable and the server isn't slammed.
  async function dropRoute(cat, files) {
    const list = Array.from(files || []);
    if (!list.length) return undefined;
    const f = list[0];
    const n = String(f.name || '').toLowerCase();
    if (cat === 'layout') {
      if (n.endsWith('.dxf')) return uploadCad(f);
      if (n.endsWith('.rmpm') || n.endsWith('.rmpm.json')) return uploadRmpm(f);
      if (n.endsWith('.zip')) return uploadZip(f);
      if (n.endsWith('.json')) return uploadRmpm(f);  // MapMaker JSON export
      if (n.endsWith('.csv')) return uploadMapcsv(f); // MapMaker 地図CSV
      return toast('未対応の形式です（.dxf / .rmpm / .json / 地図CSV / .zip）。', 'error');
    }
    if (cat === 'actual' || cat === 'inbound' || cat === 'stock') {
      const kind = cat === 'actual' ? 'shipments' : cat === 'inbound' ? 'inbound' : 'master';
      for (const file of list) {
        const fn = String(file.name || '').toLowerCase();
        if (fn.endsWith('.zip')) { await uploadZip(file); continue; }
        if (!TABLE_EXT.test(fn)) {
          toast(`${file.name}: CSV / Excel（.csv / .xlsx / .xls）をドロップしてください。`, 'error');
          continue;
        }
        await uploadActual(kind, file);
      }
      return undefined;
    }
    if (cat === 'items') {
      if (TABLE_EXT.test(n)) return uploadTable(f, 'master', 'items');
      return toast('CSV / Excel（.csv / .xlsx / .xls）をドロップしてください。', 'error');
    }
    return undefined;
  }

  // Hidden file inputs (persistent in #ihubAssets) → upload routes. Wired once;
  // value reset after each pick so the same file can be re-imported.
  function wireInputs() {
    const routes = {
      fileInput: (f) => uploadZip(f),
      cadInput: (f) => uploadCad(f),
      distInput: (f) => uploadDistances(f),
      mapcsvInput: (f) => uploadMapcsv(f),
      rmpmInput: (f) => uploadRmpm(f),
      tableInput: (f) => uploadActual(pendingKind, f),
      itemsInput: (f) => uploadTable(f, 'master', 'items'),
    };
    for (const [id, fn] of Object.entries(routes)) {
      const inp = document.getElementById(id);
      if (!inp) continue;
      inp.onchange = async () => {
        // tableInput allows multiple (monthly files) — upload sequentially.
        const files = Array.from(inp.files || []);
        inp.value = '';
        for (const f of files) await fn(f);
      };
    }
  }

  // ---- derive view state -----------------------------------------------------
  function derive(st, prov) {
    const sub = (prov && prov.provenance && prov.provenance.subtrees) || {};
    const isReal = (k) => sub[k] === 'imported' || sub[k] === 'interview';
    const isGen = (k) => sub[k] === 'generated';
    const realPct = prov && prov.provenance
      ? Math.round((prov.provenance.confidence || 0) * 100) : 0;
    return {
      project: st.project || null,
      template: (prov && prov.provenance && prov.provenance.template_id) || '—',
      realPct: Math.max(0, Math.min(100, realPct)),
      summary: (prov && prov.provenance_summary) || '',
      hasData: !!st.hasData || realPct > 0,
      hasOrders: isReal('orders'),
      hasItems: isReal('items') || isGen('items'),
      hasLayout: isReal('layout') || isReal('locations'),
      hasRun: !!st.hasRun,
    };
  }

  function nextAction(d) {
    if (!d.hasData && !d.hasOrders) {
      return { label: '出荷実績を取り込む ↓', act: 'focus', cat: 'actual' };
    }
    if (!d.hasItems) return { label: '不足データを生成', act: 'generate' };
    if (!d.hasRun) return { label: '設計を始める →', nav: 'design' };
    return { label: '結果を確認 →', nav: 'analysis' };
  }

  // ---- build: empty state ----------------------------------------------------
  function buildEmpty() {
    parkAssets();
    root.innerHTML =
      `<div class="ihub-empty">
         <div class="ihub-empty-h">はじめましょう</div>
         <p>手元にデータが無くても大丈夫。サンプルの倉庫で、取込→分析→検証→提案までを今すぐ試せます。</p>
         ${createSample ? '<button class="ihub-empty-sample" data-act="sample">✨ サンプルでためす</button>' : ''}
         <p class="ihub-empty-or">または左サイドバーの「プロジェクト」で、名前とテンプレートを選んで新規作成。</p>
       </div>`;
    const b = root.querySelector('[data-act="sample"]');
    if (b) b.onclick = () => runSample(b);
  }

  // ---- build: hub skeleton (per project; statuses prefilled from 履歴) --------
  function buildHub() {
    parkAssets();
    // The 実績データ card carries a status line per ROW, so no card-level slot.
    const card = (cat, ico, title, descr, body) =>
      `<section class="ihub-card" data-cat="${cat}">
         <header class="ihub-ch">
           <span class="ihub-ico" aria-hidden="true">${ico}</span>
           <div><div class="ihub-t">${esc(title)}</div><div class="ihub-d">${esc(descr)}</div></div>
         </header>
         <div class="ihub-cb">${body}</div>
         ${cat === 'base' || cat === 'actual' ? ''
    : `<div class="ihub-st" data-ihub-status="${cat}">未取込</div>`}
       </section>`;

    const drop = (cat, label, pick) =>
      `<div class="ihub-drop" data-drop="${cat}" tabindex="0" role="button"
            aria-label="${esc(label)}（ドラッグ&ドロップまたはファイル選択）">
         <span class="ihub-drop-t">${esc(label)}</span>
         <button type="button" class="ihub-pick" data-pick="${pick}">ファイルを選択</button>
       </div>`;

    // 出荷/入荷/在庫: stacked rows, each its own drop target + status line —
    // no toggle to flip (タブ切替が面倒, per direct user feedback).
    const actualRow = (cat, ico, label, kind) =>
      `<div class="ihub-rowwrap">
         <div class="ihub-drop ihub-drop-row" data-drop="${cat}" tabindex="0" role="button"
              aria-label="${esc(label)}（ドラッグ&ドロップまたはファイル選択）">
           <span class="ihub-row-ico" aria-hidden="true">${ico}</span>
           <span class="ihub-drop-t">${esc(label)}</span>
           <button type="button" class="ihub-pick" data-pickkind="${kind}">選択</button>
         </div>
         <div class="ihub-rst" data-ihub-status="${cat}">未取込</div>
       </div>`;

    root.innerHTML =
      `<div class="ihub-band">
         <div class="ihub-id">
           <div class="ihub-name" data-f="name"></div>
           <div class="ihub-tmpl">テンプレ: <b data-f="tmpl"></b></div>
         </div>
         <div class="ihub-prov" data-f="provtip">
           <div class="ihub-pct">実データ <b data-f="pct">0%</b></div>
           <div class="ihub-meter"><span data-f="meter" style="width:0%"></span></div>
         </div>
         <div class="ihub-checks" data-f="checks" aria-label="準備状況"></div>
         <div class="ihub-nextwrap">
           <span class="ihub-next-k">次の一手</span>
           <button type="button" class="ihub-next" data-f="next"></button>
         </div>
       </div>
       <div class="ihub-grid">
         ${card('actual', '📦', '実績データ', '出荷・入荷・在庫（CSV / Excel・複数まとめてドロップ可）',
    actualRow('actual', '📦', '出荷実績', 'shipments')
          + actualRow('inbound', '🚚', '入荷実績', 'inbound')
          + actualRow('stock', '📊', '在庫実績', 'master'))}
         ${card('items', '🏷️', '商品マスタ', '品番・入数・名称・ABC（CSV / Excel）',
    drop('items', 'CSV / Excel をドロップ', 'itemsInput')
          + `<button type="button" id="genMissingBtn" class="ihub-gen"
               title="不足している商品マスタ・ピック頻度・在庫を実データから生成">✨ 不足データを生成</button>`)}
         ${card('layout', '🗺️', 'レイアウト・図面', 'DXF・MapMaker・棚間距離・顧客ZIP',
    drop('layout', '.dxf / .rmpm / 地図CSV / .zip をドロップ（拡張子で自動判別）', 'rmpmInput')
          + `<div class="ihub-mini" aria-label="個別に選んで取込">
               <button type="button" data-pick="cadInput" title="CAD図面（DXF）を取込">DXF図面</button>
               <button type="button" data-pick="rmpmInput" title="MapMakerレイアウト（.rmpm / .rmpm.json）を取込">.rmpm</button>
               <button type="button" data-pick="mapcsvInput" title="MapMaker地図CSVを取込">地図CSV</button>
               <button type="button" data-pick="distInput" title="棚間距離マトリクス（CSV/JSON）を取込">棚間距離</button>
               <button type="button" data-pick="fileInput" title="顧客データZIPを一括取込">ZIP一括</button>
             </div>`)}
         ${card('base', '⚙️', 'テンプレ・基本条件', 'キー数値を確認して「反映」',
    '<div data-adopt="keyfig"></div>')}
       </div>
       <div class="ihub-foot" data-adopt="log"></div>`;

    adopt('keyfig', 'keyfigBody');
    adopt('log', 'importLog');
    wireHub();
    prefillStatuses();
  }

  function wireHub() {
    // 実績 row pick buttons share #tableInput; remember which row opened it.
    root.querySelectorAll('[data-pickkind]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();  // don't double-trigger via the surrounding dropzone
        pendingKind = b.dataset.pickkind || 'shipments';
        const inp = document.getElementById('tableInput');
        if (inp) inp.click();
      };
    });
    // pick buttons → hidden persistent inputs
    root.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();  // don't double-trigger via the surrounding dropzone
        const inp = document.getElementById(b.dataset.pick);
        if (inp) inp.click();
      };
    });
    // drop zones: click = pick, drag&drop = auto-route by extension
    root.querySelectorAll('.ihub-drop').forEach((dz) => {
      const cat = dz.dataset.drop;
      const pick = dz.querySelector('.ihub-pick');
      dz.onclick = () => { if (pick) pick.click(); };
      dz.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (pick) pick.click(); }
      };
      ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault(); dz.classList.add('drag');
      }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault(); dz.classList.remove('drag');
      }));
      dz.addEventListener('drop', (e) => {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) dropRoute(cat, files);
      });
    });
    // 不足データを生成 (imports.js owns the busy state via #genMissingBtn)
    const gen = root.querySelector('#genMissingBtn');
    if (gen) gen.onclick = () => generateMissing();
    // next-step CTA (re-bound on every patch with the current action)
  }

  // Prefill each card's status line from the latest matching 履歴 entry, so the
  // "last import" survives reloads (live imports then overwrite via mark()).
  function prefillStatuses() {
    for (const cat of ['actual', 'inbound', 'stock', 'items', 'layout']) {
      const st = root.querySelector(`[data-ihub-status="${cat}"]`);
      if (!st) continue;
      const e = hist.latest(cat);
      if (e) {
        st.textContent = `✓ ${e.text}（${relTime(e.t || 0)}）`;
        st.classList.add('is-ok');
      } else {
        st.textContent = '未取込（テンプレの仮値で動作中）';
      }
    }
  }

  function patch(d) {
    const f = (k) => root.querySelector(`[data-f="${k}"]`);
    const name = f('name'); if (name) name.textContent = d.project || '';
    const tmpl = f('tmpl'); if (tmpl) tmpl.textContent = d.template;
    const pct = f('pct'); if (pct) pct.textContent = `${d.realPct}%`;
    const meter = f('meter'); if (meter) meter.style.width = `${d.realPct}%`;
    const tip = f('provtip'); if (tip) tip.title = d.summary;
    const checks = f('checks');
    if (checks) {
      const items = [
        ['実績データ', d.hasOrders || d.hasData],
        ['商品マスタ', d.hasItems],
        ['レイアウト', d.hasLayout],
        ['実行', d.hasRun],
      ];
      checks.innerHTML = items.map(([lab, on]) =>
        `<span class="ihub-chip${on ? ' on' : ''}" title="${esc(lab)}: ${on ? '済' : '未'}">`
        + `<i aria-hidden="true">${on ? '✓' : '·'}</i>${esc(lab)}</span>`).join('');
    }
    const next = f('next');
    if (next) {
      const na = nextAction(d);
      next.textContent = na.label;
      next.onclick = () => {
        if (na.nav) { switchTo(na.nav); return; }
        if (na.act === 'generate') { generateMissing(); return; }
        if (na.act === 'focus' && na.cat) {
          const card = root.querySelector(`.ihub-card[data-cat="${na.cat}"]`);
          if (card) {
            card.classList.add('is-hot');
            const dz = card.querySelector('.ihub-drop');
            if (dz) dz.focus();
            setTimeout(() => card.classList.remove('is-hot'), 2400);
          }
        }
      };
    }
  }

  // ---- render ------------------------------------------------------------------
  async function render() {
    const st = getState();
    if (!st.project) {
      if (mode !== 'empty') { buildEmpty(); mode = 'empty'; }
      return;
    }
    let prov = null;
    try { prov = await getProject(); } catch (_e) { /* tolerant: render provisional */ }
    const cur = getState();
    if (!cur.project) return;  // project closed while the fetch was in flight
    if (mode !== 'hub') { buildHub(); mode = 'hub'; }
    patch(derive(cur, prov));
  }

  // First-run "✨ サンプルでためす": build + open the bundled demo project via the
  // host-supplied createSample, then re-render to the populated hub.
  async function runSample(btn) {
    if (!createSample) return;
    if (btn) { btn.disabled = true; btn.dataset.l = btn.textContent; btn.textContent = '用意中…'; }
    try {
      await createSample();
      toast('サンプルを用意しました。', 'ok');
      await render();
    } catch (e) {
      toast('サンプルの用意に失敗しました: ' + (e && e.message ? e.message : ''), 'error');
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.l || '✨ サンプルでためす'; }
    }
  }

  wireInputs();
  render();
  return {
    refresh() { render(); },
    dispose() { parkAssets(); el.innerHTML = ''; },
  };
}
