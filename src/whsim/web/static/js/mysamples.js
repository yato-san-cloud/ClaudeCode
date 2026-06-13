// mysamples.js — the sidebar「マイサンプル」block: a LOCAL-ONLY library of saved
// project snapshots. Saving freezes the current project into a gitignored
// `samples/` dir (never uploaded); opening instantiates a fresh project from it.
//
// The user's real customer set (layout + WMS data) thus becomes one-click
// reusable without ever committing sensitive data to the repo.
//
// Shell helpers (openProject / refreshProjects / toast / modalConfirm) are
// injected once via initMySamples(deps); the block self-refreshes after a save.
import { $, api, modalConfirm } from './util.js';

let openProject = async () => {};
let refreshProjects = async () => {};
let toast = () => {};

export function initMySamples(deps) {
  ({ openProject, refreshProjects, toast } = deps);
  injectStyle();
}

function injectStyle() {
  if (document.getElementById('mys-style')) return;
  const s = document.createElement('style');
  s.id = 'mys-style';
  s.textContent = `
  .mys{margin-top:10px}
  .mys-h{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;
    letter-spacing:.04em;color:var(--ink-tertiary,#8195a8);text-transform:uppercase;margin-bottom:6px}
  .mys-h .mys-count{font-weight:600;text-transform:none;letter-spacing:0}
  .mys-list{display:flex;flex-direction:column;gap:5px}
  .mys-item{display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:9px;
    border:1px solid var(--line-hair,rgba(120,140,170,.16));background:var(--bg-panel,#f7f6f3)}
  .mys-item:hover{border-color:var(--line-strong,rgba(120,140,170,.3))}
  .mys-main{flex:1;min-width:0;cursor:pointer}
  .mys-name{font-size:12px;font-weight:600;color:var(--ink-primary,#16202e);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mys-meta{font-size:10px;color:var(--ink-tertiary,#8195a8);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mys-del{flex:0 0 auto;border:none;background:none;cursor:pointer;font-size:13px;
    color:var(--ink-tertiary,#8195a8);padding:2px 4px;border-radius:6px;line-height:1}
  .mys-del:hover{color:var(--bad,#c4453f);background:color-mix(in srgb,var(--bad,#c4453f) 10%,transparent)}
  .mys-empty{font-size:10.5px;color:var(--ink-tertiary,#8195a8);line-height:1.5}
  .mys-item.busy{opacity:.6;pointer-events:none}
  `;
  document.head.appendChild(s);
}

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

function metaLine(m) {
  const s = m.stats || {};
  const bits = [];
  if (s.shelves) bits.push(`棚${fmt(s.shelves)}`);
  if (s.orders) bits.push(`注文${fmt(s.orders)}`);
  if (s.zones && !s.shelves) bits.push(`ゾーン${fmt(s.zones)}`);
  return bits.join(' ・ ') || 'スナップショット';
}

export async function refreshMySamples() {
  const host = $('mySamples');
  if (!host) return;
  let items = [];
  try { items = await api('/api/samples'); } catch (_e) { items = []; }
  if (!Array.isArray(items) || !items.length) {
    // Block stays present (so the save action has a home) but minimal when empty.
    host.innerHTML =
      `<div class="mys"><div class="mys-h">マイサンプル</div>
         <div class="mys-empty">プロジェクトを ⋯ メニューの「マイサンプルとして保存」で登録すると、ここから1クリックで再現できます（PC内のみ・非公開）。</div>
       </div>`;
    return;
  }
  host.innerHTML =
    `<div class="mys">
       <div class="mys-h">マイサンプル <span class="mys-count">(${items.length})</span></div>
       <div class="mys-list">${items.map((m) =>
    `<div class="mys-item" data-id="${esc(m.id)}">
         <div class="mys-main" title="このサンプルで新規プロジェクトを作成">
           <div class="mys-name">${esc(m.label || m.id)}</div>
           <div class="mys-meta">${esc(metaLine(m))}</div>
         </div>
         <button type="button" class="mys-del" title="このサンプルを削除" aria-label="削除">✕</button>
       </div>`).join('')}</div>
     </div>`;
  host.querySelectorAll('.mys-item').forEach((row) => {
    const id = row.dataset.id;
    const main = row.querySelector('.mys-main');
    if (main) main.onclick = () => openSample(id, row);
    const del = row.querySelector('.mys-del');
    if (del) del.onclick = (e) => { e.stopPropagation(); deleteSample(id); };
  });
}

async function openSample(id, row) {
  if (row) row.classList.add('busy');
  try {
    const r = await api(`/api/samples/${encodeURIComponent(id)}/instantiate`, { method: 'POST' });
    await refreshProjects(r.name);
    await openProject(r.name);
    toast(`マイサンプルから「${r.name}」を作成しました。`, 'ok');
  } catch (e) {
    toast('サンプルの展開に失敗しました: ' + (e && e.message ? e.message : e), 'error');
    if (row) row.classList.remove('busy');
  }
}

async function deleteSample(id) {
  if (!(await modalConfirm({
    title: 'マイサンプルを削除',
    message: 'このマイサンプルを削除します。元のプロジェクトには影響しません。よろしいですか？',
    okLabel: '削除', cancelLabel: 'キャンセル', danger: true,
  }))) return;
  try {
    await api(`/api/samples/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshMySamples();
    toast('マイサンプルを削除しました。', 'ok');
  } catch (e) { toast('削除に失敗しました: ' + (e && e.message ? e.message : e), 'error'); }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
