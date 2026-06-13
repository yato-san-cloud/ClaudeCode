// importpreview.js — the 取込プレビュー / 項目の紐付け modal.
//
// Dropping an 実績データ file used to import immediately and cram a tiny column-
// mapping editor into the bottom log strip (cut off, hard to use). Instead this
// opens a big dismissible window that shows the ACTUAL data (first rows of the
// real columns) alongside the field→column mapping, recomputing the resulting
// 件数 live as you adjust it. Confirm to import, or close to cancel.
//
//   pickImportMapping({ project, file, kind }) -> Promise<{mapping}|null>
// Resolves with the user-confirmed mapping (the caller then commits via its own
// import endpoint), or null if the user cancelled. Read-only until then: the
// preview endpoint never writes to the project.
import { $, api, esc } from './util.js';

const KIND_JP = { shipments: '出荷実績', inbound: '入荷実績', master: '商品マスタ・在庫' };

function injectStyle() {
  if (document.getElementById('ipv-style')) return;
  const s = document.createElement('style');
  s.id = 'ipv-style';
  s.textContent = `
  .ipv-ov{position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb,var(--bg-app,#0b1016) 55%,transparent);backdrop-filter:blur(3px);
    animation:ipv-fade .16s ease}
  @keyframes ipv-fade{from{opacity:0}to{opacity:1}}
  .ipv-card{width:min(1040px,95vw);max-height:90vh;display:flex;flex-direction:column;
    background:var(--bg-panel,#121a24);border:1px solid var(--line-strong,rgba(120,140,170,.3));
    border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.45);color:var(--ink-primary,#eaf2f8);
    font-family:var(--font-sans,inherit);overflow:hidden;animation:ipv-pop .2s cubic-bezier(.16,1,.3,1)}
  @keyframes ipv-pop{from{transform:translateY(10px) scale(.98);opacity:0}to{transform:none;opacity:1}}
  .ipv-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:14px 18px;
    border-bottom:1px solid var(--line-hair,rgba(120,140,170,.16))}
  .ipv-title{font-size:15px;font-weight:700}
  .ipv-file{font-size:12px;color:var(--ink-tertiary,#8ea4b6);white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;max-width:42ch}
  .ipv-x{margin-left:auto;border:none;background:transparent;color:var(--ink-secondary,#b6c6d4);
    font-size:20px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px}
  .ipv-x:hover{background:var(--line-hair,rgba(120,140,170,.16))}
  .ipv-body{flex:1;min-height:0;overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:14px}
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
  .ipv-prev-wrap{flex:1;min-height:120px;overflow:auto;border:1px solid var(--line-hair,rgba(120,140,170,.16));
    border-radius:10px}
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
  .ipv-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 18px;
    border-top:1px solid var(--line-hair,rgba(120,140,170,.16))}
  .ipv-foot .ipv-note{font-size:11.5px;color:var(--ink-tertiary,#8ea4b6)}
  .ipv-btn{margin-left:0;padding:9px 18px;border-radius:10px;border:1px solid var(--line-strong,rgba(120,140,170,.3));
    background:transparent;color:var(--ink-secondary,#b6c6d4);font:inherit;font-weight:700;font-size:13px;cursor:pointer}
  .ipv-btn:hover{border-color:var(--accent,#16C0DE);color:var(--ink-primary,#eaf2f8)}
  .ipv-btn.primary{margin-left:auto;background:var(--accent,#16C0DE);color:var(--ink-onAccent,#04222c);border:none}
  .ipv-btn.primary:hover{filter:brightness(1.06)}
  .ipv-btn:disabled{opacity:.5;cursor:default}
  .ipv-busy{font-size:12px;color:var(--ink-tertiary,#8ea4b6)}
  @media (prefers-reduced-motion:reduce){.ipv-ov,.ipv-card{animation:none}}
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

export function pickImportMapping({ project, file, kind = 'shipments' } = {}) {
  injectStyle();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'ipv-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', '取込プレビュー');

    let data = null;            // last preview payload {columns, mapping, counts, preview}
    let mapping = {};           // fieldKey -> column|null
    let recomputing = false;
    let recomputeTimer = 0;

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      resolve(result);
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });

    // POST the file (+ optional mapping) to the read-only preview endpoint.
    async function fetchPreview(mp) {
      const fd = new FormData();
      fd.append('file', file);
      let url = `/api/projects/${encodeURIComponent(project)}/import-preview?kind=${encodeURIComponent(kind)}`;
      if (mp) url += '&mapping=' + encodeURIComponent(JSON.stringify(mp));
      return api(url, { method: 'POST', body: fd });
    }

    function columnField() {
      // column name -> field label, for highlighting the matched columns.
      const m = {};
      for (const [k, info] of Object.entries((data && data.mapping) || {})) {
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
      const more = data.preview && data.preview.total_rows > rows.length
        ? `<div class="ipv-note" style="padding:6px 2px">先頭 ${rows.length} 行を表示（全 ${fmt(data.preview.total_rows)} 行）</div>` : '';

      body.innerHTML =
        `<div class="ipv-map-h">項目の紐付け（必要なら直してください。<b>*</b>は必須）</div>
         <div class="ipv-maps">${maps}</div>
         <div class="ipv-map-h">取り込まれる件数（このマッピングの場合）</div>
         <div class="ipv-counts" data-counts>${countsHtml(data.counts, kind)}</div>
         <div class="ipv-map-h">データプレビュー</div>
         <div class="ipv-prev-wrap"><table class="ipv-tbl"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>
         ${more}`;
      body.querySelectorAll('select[data-field]').forEach((sel) => {
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
      busy.textContent = '再計算中…';
      try {
        data = await fetchPreview(mapping);
        mapping = {};
        for (const [k, info] of Object.entries(data.mapping || {})) mapping[k] = info.column || null;
        renderBody();
      } catch (e) {
        busy.textContent = '再計算に失敗: ' + (e && e.message ? e.message : e);
      } finally { recomputing = false; busy.textContent = ''; }
    }

    function missingRequired() {
      return Object.values((data && data.mapping) || {}).some((i) => i.required && !i.column);
    }
    function refreshCommitState() {
      commitBtn.disabled = !data || missingRequired();
      commitBtn.title = commitBtn.disabled ? '必須項目（*）の列を指定してください' : '';
    }

    // ---- scaffold ----
    const card = document.createElement('div');
    card.className = 'ipv-card';
    card.innerHTML =
      `<div class="ipv-head">
         <span class="ipv-title">取込プレビュー</span>
         <span class="ipv-file" data-file></span>
         <button type="button" class="ipv-x" aria-label="閉じる">×</button>
       </div>
       <div class="ipv-body" data-body><div class="ipv-busy">読み込み中…</div></div>
       <div class="ipv-foot">
         <span class="ipv-note">この画面では取り込まれません。内容を確認して「この内容で取込」を押してください。</span>
         <span class="ipv-busy" data-busy></span>
         <button type="button" class="ipv-btn" data-cancel>閉じる</button>
         <button type="button" class="ipv-btn primary" data-commit disabled>この内容で取込</button>
       </div>`;
    ov.appendChild(card);
    document.body.appendChild(ov);

    const body = card.querySelector('[data-body]');
    const busy = card.querySelector('[data-busy]');
    const commitBtn = card.querySelector('[data-commit]');
    card.querySelector('.ipv-x').onclick = () => close(null);
    card.querySelector('[data-cancel]').onclick = () => close(null);
    card.querySelector('[data-file]').textContent =
      `${KIND_JP[kind] || ''}：${file.name}`;
    commitBtn.onclick = () => {
      if (commitBtn.disabled) return;
      close({ mapping: { ...mapping } });
    };

    // ---- initial load ----
    (async () => {
      try {
        data = await fetchPreview(null);
        mapping = {};
        for (const [k, info] of Object.entries(data.mapping || {})) mapping[k] = info.column || null;
        renderBody();
      } catch (e) {
        body.innerHTML = `<div class="ipv-busy">プレビューに失敗しました: ${esc(e && e.message ? e.message : e)}</div>`;
      }
    })();
  });
}
