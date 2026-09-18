// materialflow/popover.js — キャンバス上の吹き出し（矢印＝1本の流れ / 工程カード）。
//
// The anti-SLC move lives here: everything a leg needs — 搬送手段, 使用設備, 荷姿
// (容器・台車), 入数, 分岐率 — is edited IN PLACE on the arrow you clicked. The
// 入数 chip writes straight to the 荷姿 catalogue (POST /loadunits), so nobody is
// ever sent to a separate master screen to type "30".
//
// EN comments / JA UI. Every data-derived string goes through esc().

import { esc } from '../util.js';
import {
  TRANSPORTS, TRANSPORT_JA, ROLE_JA, ROLES_FALLBACK, equipForTransport,
} from './vocab.js';
import {
  convert, chainText, unitsOfKind, unitById, saveCatalogue,
  capacityKey, capacityOf, withCapacity, heldLabel,
} from './loadunits.js';

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const fmt = (n) => (n == null || !Number.isFinite(+n) ? '—' : Math.round(+n).toLocaleString('ja-JP'));

// ---------------------------------------------------------------------------
// The panel shell: one reusable anchored card per canvas. Esc closes it, a click
// outside closes it, and it is clamped inside the stage so it can never be drawn
// half off-screen.
// ---------------------------------------------------------------------------
export function createPopover(stage) {
  const el = document.createElement('div');
  el.className = 'mfc-pop';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  stage.appendChild(el);
  let closeCb = null;

  function place(x, y) {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const w = el.offsetWidth || 296, h = el.offsetHeight || 200;
    const left = Math.max(8, Math.min(x + 14, sw - w - 8));
    const top = Math.max(8, Math.min(y + 10, sh - h - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function close() {
    if (el.hidden) return;
    el.hidden = true;
    el.innerHTML = '';
    const cb = closeCb; closeCb = null;
    if (cb) cb();
  }

  function open({ x, y, title, html, wire, onClose }) {
    closeCb = null;                       // the previous panel is being replaced
    el.innerHTML = `<div class="mfc-pop-h"><span class="t">${esc(title || '')}</span>`
      + '<button type="button" class="mfc-pop-close" data-pop="close" '
      + 'aria-label="閉じる" title="閉じる">×</button></div>' + html;
    el.setAttribute('aria-label', title || '設定');
    el.hidden = false;
    place(x, y);
    closeCb = onClose || null;
    // wire() fills the 荷姿 chips / 換算 rows, so the card is taller AFTER it runs:
    // re-clamp, otherwise the footer (削除) hangs off the bottom of the canvas.
    if (wire) wire(el, { close, place: () => place(x, y) });
    place(x, y);
    const first = el.querySelector('select,input,button:not([data-pop="close"])');
    if (first) { try { first.focus(); } catch (_e) { /* noop */ } }
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-pop="close"]')) { e.stopPropagation(); close(); }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  return { el, open, close, isOpen: () => !el.hidden };
}

// ---------------------------------------------------------------------------
// helpers shared by the two panels
// ---------------------------------------------------------------------------
function options(list, cur) {
  return list.map((o) => `<option value="${esc(o.value)}"`
    + `${String(o.value) === String(cur) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}

function transportOptions(cur) {
  return options(TRANSPORTS.map((t) => ({ value: t, label: TRANSPORT_JA[t] })), cur);
}

function equipOptions(equipment, transport, cur) {
  const choices = equipForTransport(equipment, transport);
  const list = [{ value: '', label: '指定なし' }]
    .concat(choices.map((c) => ({ value: c.id, label: c.label || c.id })));
  // Keep a binding to a machine that is no longer placed — 診断 warns about it,
  // we must not silently drop the user's decision.
  if (cur && !choices.some((c) => c.id === cur)) list.push({ value: cur, label: `${cur}（未配置）` });
  return options(list, cur || '');
}

function unitOptions(list, kind, cur) {
  const rows = unitsOfKind(list, kind);
  const opts = [{ value: '', label: '指定なし' }]
    .concat(rows.map((u) => ({ value: u.id, label: u.name || u.id })));
  if (cur && !rows.some((u) => u.id === cur)) opts.push({ value: cur, label: `${cur}（一覧に無し）` });
  return options(opts, cur || '');
}

// 「30 点/オリコン」「14 オリコン/カゴ台車」— the 入数 as a chip you can click and
// retype. What a 台車 is counted in depends on the 容器 the leg names, so the
// carrier chip re-reads `containerRef` on every render.
function chipHtml(cat, unit, kind, containerRef) {
  if (!unit) return '';
  const held = capacityKey(unit, containerRef);
  const cap = capacityOf(unit, containerRef);
  const prov = unit.provisional ? '<span class="mfc-prov">仮値</span>' : '';
  return `<button type="button" class="mfc-chip" data-cap="${esc(kind)}"
    title="入数を編集（クリックして入力）">${esc(fmt(cap))} ${esc(heldLabel(cat, held))}/${esc(unit.name || unit.id)}</button>${prov}`;
}

// ---------------------------------------------------------------------------
// 矢印の吹き出し — 1本の流れを設計する唯一の場所
// ---------------------------------------------------------------------------
/**
 * @param {Object} c  {edge, srcLabel, dstLabel, equipment, loadUnits:{list,key}|null,
 *                     project, getVolume, volumeUnit, onPatch, onDelete, onUnitsSaved, toast}
 */
export function buildEdgePanel(c) {
  const e = c.edge;
  const cat = c.loadUnits && Array.isArray(c.loadUnits.list) ? c.loadUnits.list : null;
  const title = `${c.srcLabel || '外部'} → ${c.dstLabel || ''}`;
  const t = e.transport || 'manual';
  const share = Math.round(Math.max(0, Math.min(1, num(e.share, 1))) * 100);
  // 分岐率 changes the volume on THIS leg, so it is read live rather than frozen.
  const vol = () => (c.getVolume ? num(c.getVolume(), 0) : num(c.volume, 0));

  const volHtml = () => (vol() > 0
    ? `この流れの物量 <b>${esc(fmt(vol()))}</b>${esc(c.volumeUnit || '')}/日`
    : '物量が未入力です（下のカードに入力すると、矢印の太さと換算に反映されます）');

  const loadSection = cat ? `
    <div class="mfc-sec">荷姿</div>
    <div class="mfc-row2">
      <div class="mfc-row"><label for="mfc-cont">容器</label>
        <select id="mfc-cont" data-f="container_ref">${unitOptions(cat, 'container', e.container_ref)}</select></div>
      <div class="mfc-row"><label for="mfc-carr">台車</label>
        <select id="mfc-carr" data-f="carrier_ref">${unitOptions(cat, 'carrier', e.carrier_ref)}</select></div>
    </div>
    <div class="mfc-chips" data-chips></div>
    <div class="mfc-chain" data-chain>荷姿を選ぶと、入数からの換算がここに出ます。</div>` : '';

  const html = `
    <div class="mfc-note" data-vol>${volHtml()}</div>
    <div class="mfc-sec">運び方</div>
    <div class="mfc-row"><label for="mfc-tr">搬送手段</label>
      <select id="mfc-tr" data-f="transport">${transportOptions(t)}</select></div>
    <div class="mfc-row" data-eqrow><label for="mfc-eq">使用設備</label>
      <select id="mfc-eq" data-f="equipment_ref">${equipOptions(c.equipment, t, e.equipment_ref)}</select></div>
    ${loadSection}
    <div class="mfc-sec">流れの配分</div>
    <div class="mfc-row"><label for="mfc-sh">分岐率（%）— 前工程から出る量のうち、この流れが受け持つ割合</label>
      <input id="mfc-sh" type="number" min="0" max="100" step="1" value="${share}" data-f="share"/></div>
    <div class="mfc-pop-foot">
      ${e.derived ? '<span class="mfc-note" style="margin:0">工程の順番から自動で引かれた流れです。</span>' : ''}
      ${e.src ? '<button type="button" class="mfc-pop-btn danger" data-act="del">この流れを削除</button>' : ''}
    </div>`;

  function wire(el, pop) {
    let chainT = 0;

    const equipRow = el.querySelector('[data-eqrow]');
    const equipSel = equipRow && equipRow.querySelector('select');
    const chips = el.querySelector('[data-chips]');
    const chainEl = el.querySelector('[data-chain]');
    const volEl = el.querySelector('[data-vol]');

    // 人手 names no machine, so the 使用設備 select has nothing to offer.
    function syncEquip(means) {
      if (!equipSel) return;
      equipSel.disabled = !equipForTransport(c.equipment, means).length && !e.equipment_ref;
    }

    function renderChips() {
      if (!chips || !cat) return;
      const cUnit = unitById(cat, e.container_ref);
      const rUnit = unitById(cat, e.carrier_ref);
      const parts = [chipHtml(cat, cUnit, 'container', ''),
                     chipHtml(cat, rUnit, 'carrier', e.container_ref || '')].filter(Boolean);
      chips.innerHTML = parts.length ? parts.join('')
        : '<span class="mfc-note" style="margin:0">容器・台車を選ぶと、入数をここで直せます。</span>';
    }

    function refreshChain() {
      if (!chainEl || !cat) return;
      if (!e.container_ref && !e.carrier_ref) {
        chainEl.textContent = '荷姿を選ぶと、入数からの換算がここに出ます。';
        return;
      }
      if (!(vol() > 0)) {
        chainEl.textContent = '物量を入力すると、入数からの換算がここに出ます。';
        return;
      }
      clearTimeout(chainT);
      chainT = setTimeout(async () => {
        const r = await convert(c.project, {
          pieces: vol(), container: e.container_ref || '', carrier: e.carrier_ref || '',
        });
        if (!chainEl.isConnected) return;
        const txt = r ? chainText(r.chain) : '';
        if (!txt) { chainEl.textContent = '換算を取得できませんでした。'; return; }
        chainEl.innerHTML = esc(txt)
          + (r && r.provisional ? ' <span class="mfc-prov">仮値</span>' : '');
      }, 220);
    }

    // 入数 chip → inline number input → straight into the catalogue.
    async function commitCapacity(kind, value) {
      const id = kind === 'container' ? e.container_ref : e.carrier_ref;
      const unit = unitById(cat, id);
      if (!unit) return;
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) { renderChips(); return; }
      // Rewrite ONLY the pairing on screen: editing 「14 オリコン/カゴ台車」 must not
      // wipe the same 台車's ケース入数.
      const held = capacityKey(unit, kind === 'carrier' ? (e.container_ref || '') : '');
      const next = cat.map((u) => (u.id === id
        ? { ...u, capacity: withCapacity(u, held, v), provisional: false } : u));
      try {
        const saved = await saveCatalogue(c.project, next, (c.loadUnits && c.loadUnits.key) || 'load_units');
        if (c.onUnitsSaved) c.onUnitsSaved(saved);
        cat.length = 0; cat.push(...saved.list);
        renderChips();
        refreshChain();
        if (c.toast) c.toast(`「${unit.name || unit.id}」の入数を ${fmt(v)} に更新しました。`, 'ok');
      } catch (err) {
        renderChips();
        if (c.toast) c.toast('入数の保存に失敗しました: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    el.addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-cap]');
      if (chip) {
        const kind = chip.dataset.cap;
        const id = kind === 'container' ? e.container_ref : e.carrier_ref;
        const unit = unitById(cat, id);
        if (!unit) return;
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '1'; inp.step = '1';
        inp.className = 'mfc-chip-in';
        inp.value = String(capacityOf(unit, kind === 'carrier' ? (e.container_ref || '') : ''));
        inp.setAttribute('aria-label', `${unit.name || unit.id}の入数`);
        chip.replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const finish = (ok) => {
          if (done) return; done = true;
          if (ok) commitCapacity(kind, inp.value); else renderChips();
        };
        inp.addEventListener('keydown', (k) => {
          if (k.key === 'Enter') { k.preventDefault(); finish(true); }
          else if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); finish(false); }
        });
        inp.addEventListener('blur', () => finish(true));
        return;
      }
      const del = ev.target.closest('[data-act="del"]');
      if (del) { pop.close(); if (c.onDelete) c.onDelete(); }
    });

    el.addEventListener('change', (ev) => {
      const f = ev.target.closest('[data-f]');
      if (!f) return;
      const key = f.dataset.f;
      if (key === 'transport') {
        const v = f.value;
        const keep = equipForTransport(c.equipment, v).some((q) => q.id === e.equipment_ref);
        c.onPatch({ transport: v, equipment_ref: keep ? (e.equipment_ref || '') : '' });
        if (equipSel) equipSel.innerHTML = equipOptions(c.equipment, v, e.equipment_ref);
        syncEquip(v);
        return;
      }
      if (key === 'share') {
        c.onPatch({ share: Math.max(0, Math.min(100, num(f.value, 100))) / 100 });
        if (volEl) volEl.innerHTML = volHtml();
        refreshChain();
        return;
      }
      if (key === 'container_ref' || key === 'carrier_ref') {
        c.onPatch({ [key]: f.value });
        renderChips();
        refreshChain();
        return;
      }
      c.onPatch({ [key]: f.value });
    });

    syncEquip(t);
    renderChips();
    refreshChain();
  }

  return { title, html, wire };
}

// ---------------------------------------------------------------------------
// 工程カードの吹き出し — 名前・シミュ挙動・物量ドライバ・生産性
// ---------------------------------------------------------------------------
/**
 * @param {Object} c  {proc, node, roles, drivers, others, onSave, onDelete, onLink}
 */
export function buildNodePanel(c) {
  const p = c.proc || {};
  const guess = (c.node && c.node.role) || '';
  const roles = (c.roles && c.roles.length) ? c.roles : ROLES_FALLBACK;
  const cur = p.role || '';
  const auto = guess && guess !== 'none' ? `（自動:${ROLE_JA[guess] || guess}）` : '（自動判定）';
  const roleOpts = [`<option value=""${cur === '' ? ' selected' : ''}>未設定${esc(auto)}</option>`]
    .concat(roles.map((r) => `<option value="${esc(r)}"${cur === r ? ' selected' : ''}>`
      + `${esc(ROLE_JA[r] || r)}</option>`))
    .concat([`<option value="none"${cur === 'none' ? ' selected' : ''}>計上のみ（シミュ対象外）</option>`]);
  if (cur && cur !== 'none' && !roles.includes(cur)) {
    roleOpts.push(`<option value="${esc(cur)}" selected>${esc(ROLE_JA[cur] || cur)}</option>`);
  }
  const drvOpts = (c.drivers || []).map((d) => ({ value: d.id, label: d.label }));
  const others = (c.others || []).filter((o) => o !== p.id);

  const html = `
    <div class="mfc-row"><label for="mfc-nm">工程名</label>
      <input id="mfc-nm" type="text" value="${esc(p.id || '')}" data-f="id"/></div>
    <div class="mfc-row2">
      <div class="mfc-row"><label for="mfc-sec">セクション</label>
        <input id="mfc-sec" type="text" value="${esc(p.section || '')}" data-f="section"/></div>
      <div class="mfc-row"><label for="mfc-role">シミュ挙動</label>
        <select id="mfc-role" data-f="role">${roleOpts.join('')}</select></div>
    </div>
    <div class="mfc-row"><label for="mfc-drv">物量ドライバ（物量の出所）</label>
      <select id="mfc-drv" data-f="driver">${options(drvOpts, p.driver || '')}</select></div>
    <div class="mfc-row"><label for="mfc-prod">生産性（${esc(p.unit || '行/h')}）— 実測・想定があればそちらが優先されます</label>
      <input id="mfc-prod" type="number" min="1" step="1" value="${num(p.productivity, 60)}" data-f="productivity"/></div>
    ${others.length ? `<div class="mfc-sec">つなぐ</div>
      <div class="mfc-row"><label for="mfc-link">次の工程へつなぐ（図ではカードを別のカードへドラッグ）</label>
        <select id="mfc-link">${options([{ value: '', label: '選択してください' }]
    .concat(others.map((o) => ({ value: o, label: o }))), '')}</select></div>` : ''}
    <div class="mfc-pop-foot">
      <button type="button" class="mfc-pop-btn primary" data-act="save">保存</button>
      ${others.length ? '<button type="button" class="mfc-pop-btn" data-act="link">つなぐ</button>' : ''}
      <button type="button" class="mfc-pop-btn danger" data-act="del" style="margin-left:auto">工程を削除</button>
    </div>`;

  function wire(el, pop) {
    const patch = {};
    el.addEventListener('input', (ev) => {
      const f = ev.target.closest('[data-f]');
      if (!f) return;
      patch[f.dataset.f] = f.dataset.f === 'productivity' ? Math.max(1, num(f.value, 60)) : f.value;
    });
    el.addEventListener('change', (ev) => {
      const f = ev.target.closest('[data-f]');
      if (f) patch[f.dataset.f] = f.dataset.f === 'productivity' ? Math.max(1, num(f.value, 60)) : f.value;
    });
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-act="save"]')) { pop.close(); if (c.onSave) c.onSave(patch); return; }
      if (ev.target.closest('[data-act="del"]')) { pop.close(); if (c.onDelete) c.onDelete(); return; }
      if (ev.target.closest('[data-act="link"]')) {
        const sel = el.querySelector('#mfc-link');
        const to = sel && sel.value;
        if (to) { pop.close(); if (c.onLink) c.onLink(to); }
      }
    });
  }

  return { title: `工程: ${p.id || ''}`, html, wire };
}
