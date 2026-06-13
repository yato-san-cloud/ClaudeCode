// slotting.js — ③設計「棚割り」: 解析的な スロッティング最適化 + 保管戦略.
// 加重歩行距離 Σ(pick_freq × distance) を最小化する velocity×distance グリーディの
// BEFORE/AFTER を棒で見せ、上位の移動と、フリーロケ vs 固定ロケ(リザーブ＋アクティブ)の
// 推奨＋補充トレードオフを並べる。「最適化して適用」で POST→再読込。
// Vanilla ES module, CSS-in-JS. EN comments / JA UI. Consumes $/api/esc from util.
import { esc, api } from './util.js';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (n) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%');

const MODE_JP = {
  reserve_active: 'リザーブ＋アクティブ',
  free: 'フリーロケ',
  fixed: '固定ロケ',
};
const MODE_C = { reserve_active: '#e6550d', free: '#1f78b4', fixed: '#9aa4b0' };

function injectStyle() {
  if (document.getElementById('sl-style')) return;
  const s = document.createElement('style');
  s.id = 'sl-style';
  s.textContent = `
  .sl{display:flex;flex-direction:column;gap:14px;width:100%;padding:4px 2px 24px}
  .sl-head h2{margin:0 0 2px;font-size:18px;color:var(--ink-primary)}
  .sl-head .sub{font-size:12px;color:var(--ink-tertiary)}
  .sl-cards{display:flex;gap:12px;flex-wrap:wrap}
  .sl-card{flex:1 1 180px;background:var(--bg-panel);border:1px solid var(--line-hair);
    border-radius:12px;padding:12px 14px}
  .sl-card .k{font-size:11px;color:var(--ink-tertiary)}
  .sl-card .v{font-size:24px;font-weight:800;color:var(--ink-primary);font-variant-numeric:tabular-nums}
  .sl-card .u{font-size:12px;color:var(--ink-secondary);margin-left:3px}
  .sl-card.good .v{color:var(--good,#2f9e44)}
  .sl-bars{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:12px;
    padding:14px 16px;display:flex;flex-direction:column;gap:10px}
  .sl-barrow{display:flex;align-items:center;gap:10px;font-size:12px}
  .sl-barrow .lbl{width:64px;color:var(--ink-secondary);flex:0 0 auto}
  .sl-bartrack{flex:1 1 auto;height:22px;background:var(--bg-sunken);border-radius:6px;overflow:hidden}
  .sl-barfill{height:100%;border-radius:6px;transition:width .5s ease}
  .sl-barrow .val{width:120px;text-align:right;flex:0 0 auto;font-variant-numeric:tabular-nums;color:var(--ink-primary)}
  .sl-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .sl-tbl th,.sl-tbl td{padding:7px 10px;border-bottom:1px solid var(--line-hair);text-align:right;font-variant-numeric:tabular-nums}
  .sl-tbl th{color:var(--ink-secondary);font-weight:700;border-bottom:2px solid var(--line-hair)}
  .sl-tbl td.l,.sl-tbl th.l{text-align:left}
  .sl-tag{font-size:10px;font-weight:700;color:#fff;border-radius:999px;padding:1px 8px}
  .sl-strat{display:flex;gap:14px;flex-wrap:wrap;align-items:stretch}
  .sl-strat .pane{flex:1 1 240px;background:var(--bg-panel);border:1px solid var(--line-hair);
    border-radius:12px;padding:14px 16px}
  .sl-strat .pane h3{margin:0 0 8px;font-size:14px;color:var(--ink-primary)}
  .sl-mix{display:flex;height:16px;border-radius:6px;overflow:hidden;margin:6px 0 10px}
  .sl-mix span{display:block}
  .sl-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--ink-secondary)}
  .sl-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:middle}
  .sl-trade{font-size:13px;color:var(--ink-primary);line-height:1.6}
  .sl-rec{padding:8px 12px;border-radius:10px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 12%,transparent);font-weight:700;font-size:13.5px;color:var(--ink-primary)}
  .sl-btn{padding:9px 16px;border-radius:9px;border:none;background:var(--accent,#16C0DE);
    color:var(--ink-onAccent,#04222c);font-weight:800;cursor:pointer;font:inherit}
  .sl-btn[disabled]{opacity:.5;cursor:default}
  .sl-empty{padding:16px;border:1px dashed var(--line-strong);border-radius:12px;background:var(--bg-panel);
    color:var(--ink-secondary);font-size:13px}
  `;
  document.head.appendChild(s);
}

export function mountSlotting(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'sl';
  el.innerHTML = '';
  el.appendChild(root);

  let data = null;
  let busy = false;

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを開くと、棚割りを最適化します。'); return; }
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/slotting`);
      render();
    } catch (e) {
      renderEmpty('試算に失敗しました: ' + (e && e.message ? e.message : e));
    }
  }

  function renderEmpty(msg) {
    root.innerHTML = `<div class="sl-head"><h2>棚割り（スロッティング最適化）</h2>
      <div class="sub">加重歩行距離 Σ(出荷頻度 × 距離) を最小化し、保管戦略を提案</div></div>
      <div class="sl-empty">${esc(msg)}</div>`;
  }

  function barsBlock(o) {
    const max = Math.max(o.before_weighted_distance, o.after_weighted_distance, 1);
    const bar = (lbl, v, color) => `
      <div class="sl-barrow"><span class="lbl">${lbl}</span>
        <span class="sl-bartrack"><span class="sl-barfill" style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span>
        <span class="val">${fmt(v)} m·件</span></div>`;
    return `<div class="sl-bars">
      ${bar('現状', o.before_weighted_distance, 'var(--ink-tertiary,#9aa4b0)')}
      ${bar('最適化後', o.after_weighted_distance, 'var(--accent,#16C0DE)')}
      <div class="sub" style="font-size:11px;color:var(--ink-tertiary)">加重歩行距離＝Σ(SKUの出荷頻度 × ピック面/梱包台までの距離)。低いほど良い。</div>
    </div>`;
  }

  function movesTable(o) {
    if (!o.moves || !o.moves.length) {
      return '<div class="sl-empty">移動なし：すでに最適配置か、ロケーション／商品が不足しています。</div>';
    }
    const rows = o.moves.map((m) => `<tr>
      <td class="l">${esc(m.name)}<br><span style="font-size:11px;color:var(--ink-tertiary)">${esc(m.sku)}</span></td>
      <td>${fmt(m.pick_freq, 3)}</td>
      <td class="l">${esc(m.from || '—')} → <b>${esc(m.to)}</b></td>
      <td style="color:${m.delta_dist < 0 ? 'var(--good,#2f9e44)' : 'var(--ink-secondary)'}">${fmt(m.delta_dist, 1)}</td>
    </tr>`).join('');
    return `<div style="overflow-x:auto"><table class="sl-tbl">
      <tr><th class="l">SKU</th><th>出荷頻度</th><th class="l">移動 (from→to)</th><th>Δ距離</th></tr>
      ${rows}
    </table></div>
    <div class="sub" style="font-size:11px;color:var(--ink-tertiary)">上位${o.moves.length}件 / 全${fmt(o.moves_total)}件。Δ距離が負＝歩行短縮。</div>`;
  }

  function strategyBlock(s) {
    if (!s || !s.available) {
      return `<div class="sl-empty">${esc((s && s.message) || '保管戦略：商品データを取り込むと提案します。')}</div>`;
    }
    const c = s.counts || {};
    const tot = c.total || 1;
    const seg = (key) => {
      const v = c[key] || 0;
      return v ? `<span style="width:${(v / tot * 100).toFixed(1)}%;background:${MODE_C[key]}" title="${MODE_JP[key]} ${v}"></span>` : '';
    };
    const legend = ['reserve_active', 'free', 'fixed'].map((k) =>
      `<span><i style="background:${MODE_C[k]}"></i>${MODE_JP[k]} ${fmt(c[k] || 0)}</span>`).join('');
    const t = s.tradeoff || {};
    return `<div class="sl-strat">
      <div class="pane">
        <h3>保管戦略の推奨</h3>
        <div class="sl-rec">推奨：${esc(s.recommended_mode_jp || s.recommended_mode)}</div>
        <div class="sl-mix">${seg('reserve_active')}${seg('free')}${seg('fixed')}</div>
        <div class="sl-legend">${legend}</div>
      </div>
      <div class="pane">
        <h3>リザーブ＋アクティブ／補充</h3>
        <div class="sl-trade">
          アクティブ（ピック面）SKU：<b>${fmt(s.reserve_active_split && s.reserve_active_split.active_skus)}</b><br>
          補充移動：<b>${fmt(s.replenishment && s.replenishment.moves_per_day, 1)}</b> 回/日<br>
          出荷の <b>${pct(t.walk_reduction_share)}</b> をゴールデンゾーンに固定
        </div>
        <div class="sl-trade" style="margin-top:8px;color:var(--ink-secondary);font-size:12.5px">${esc(t.summary || '')}</div>
      </div>
    </div>`;
  }

  function render() {
    const o = data.optimization || {};
    const s = data.strategy || {};
    const redPct = o.reduction_pct || 0;
    root.innerHTML = `
      <div class="sl-head"><h2>棚割り <span style="font-size:12px;font-weight:500;color:var(--ink-tertiary)">スロッティング最適化・解析的</span></h2>
        <div class="sub">velocity×distance グリーディで Σ(出荷頻度 × 距離) を最小化。重厚なDESは④検証で裏取り。</div></div>
      <div class="sl-cards">
        <div class="sl-card good"><div class="k">歩行短縮</div><div class="v">${pct(redPct)}</div><span class="u"></span></div>
        <div class="sl-card"><div class="k">割付SKU / ロケーション</div><div class="v">${fmt(o.placed)}<span class="u">/ ${fmt(o.locations)}</span></div></div>
        <div class="sl-card"><div class="k">移動SKU数</div><div class="v">${fmt(o.moves_total)}<span class="u">件</span></div></div>
        ${o.unplaced ? `<div class="sl-card"><div class="k">容量不足・未割付</div><div class="v">${fmt(o.unplaced)}<span class="u">SKU</span></div></div>` : ''}
      </div>
      ${barsBlock(o)}
      <div><button class="sl-btn" data-act="apply"${busy ? ' disabled' : ''}>${busy ? '適用中…' : '最適化して適用'}</button></div>
      <h3 style="margin:6px 0 0;font-size:14px;color:var(--ink-primary)">上位の棚割り変更</h3>
      ${movesTable(o)}
      ${strategyBlock(s)}`;
    const btn = root.querySelector('[data-act=apply]');
    if (btn) btn.addEventListener('click', apply);
  }

  async function apply() {
    const name = getProject();
    if (!name || busy) return;
    busy = true; render();
    try {
      const r = await api(`/api/projects/${encodeURIComponent(name)}/slotting/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      toast(r.message || '最適化を適用しました。', 'ok');
      document.dispatchEvent(new CustomEvent('whsim:design-changed', { detail: { source: 'slotting' } }));
    } catch (e) {
      toast('適用に失敗しました: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      busy = false;
      await load();  // refresh: BEFORE now equals the applied state, moves clear
    }
  }

  load();

  return {
    dispose() { el.innerHTML = ''; },
    refresh() { load(); },
  };
}
