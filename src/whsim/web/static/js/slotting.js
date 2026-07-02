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
  .sl-aff{background:var(--bg-panel);border:1px solid var(--line-hair);border-radius:12px;padding:12px 16px;
    display:flex;flex-direction:column;gap:8px}
  .sl-aff .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .sl-aff input[type=range]{flex:1 1 180px;accent-color:var(--accent,#16C0DE)}
  .sl-aff .wv{font-variant-numeric:tabular-nums;font-weight:800;min-width:44px;text-align:right;color:var(--ink-primary)}
  .sl-aff .metric{font-size:12.5px;color:var(--ink-secondary)}
  .sl-aff .metric b{color:var(--good,#2f9e44)}
  .sl-note{font-size:11px;color:var(--ink-tertiary);line-height:1.5}
  .sl-cls{font-size:10px;font-weight:800;color:#fff;border-radius:5px;padding:1px 6px}
  .sl-spark{display:inline-flex;align-items:flex-end;gap:2px;height:20px}
  .sl-spark i{display:block;width:6px;background:var(--accent,#16C0DE);border-radius:1px;opacity:.85}
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
  let affinity = 0;  // 併買アフィニティ 0-1 (slider)

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを開くと、棚割りを最適化します。'); return; }
    try {
      const q = `affinity_weight=${affinity}&include_seasonality=1`;
      data = await api(`/api/projects/${encodeURIComponent(name)}/slotting?${q}`);
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

  function affinityBlock(a) {
    const wv = Math.round(affinity * 100);
    const slider = `<div class="sl-aff">
      <div class="row">
        <span style="font-weight:700;color:var(--ink-primary)">併買アフィニティ</span>
        <input type="range" min="0" max="100" step="5" value="${wv}" data-act="aff"${busy ? ' disabled' : ''}>
        <span class="wv">${wv}%</span>
      </div>`;
    let body;
    if (!a || !a.available) {
      body = `<div class="sl-note">${esc((a && a.message) || '出荷オーダー（明細）を取り込むと、同一オーダーで一緒に取られるSKUを近接配置します。')}</div>`;
    } else {
      const red = a.tour_reduction_pct || 0;
      body = `<div class="metric">同時ピック距離（推定）：
        <b>${fmt(a.tour_before_est)}</b> → <b>${fmt(a.tour_after_est)}</b> m・件
        （<b>${pct(red)}</b> 短縮 ・ Δ ${fmt(a.tour_delta_est)}）</div>
        <div class="sl-note">併買ペア ${fmt(a.pairs_considered)} 組を考慮。0% は従来のCOI/ABC結果と一致します。
        ツアー距離は同一オーダー内SKU間の隣接性に基づく推定値です。</div>`;
    }
    return slider + body + '</div>';
  }

  function spark(trend) {
    if (!trend || !trend.length) return '';
    const max = Math.max(...trend.map((t) => t.qty), 1);
    const bars = trend.map((t) => `<i style="height:${Math.max(2, t.qty / max * 20).toFixed(0)}px" title="${esc(t.month)}: ${fmt(t.qty)}"></i>`).join('');
    return `<span class="sl-spark">${bars}</span>`;
  }

  function seasonalityBlock(se) {
    if (!se || !se.available) {
      return `<div class="sl-empty">${esc((se && se.message) || '季節入替候補：日付つき出荷データを取り込むと、月次のABC変動を提案します。')}</div>`;
    }
    if (!se.rows || !se.rows.length) {
      return `<div class="sl-empty">観測 ${fmt(se.months_observed)} ヶ月：ABCクラスが変動したSKUはありません。</div>`;
    }
    const cls = (k) => `<span class="sl-cls" style="background:${k === 'A' ? '#e6550d' : k === 'B' ? '#3182bd' : '#9aa4b0'}">${k}</span>`;
    const rows = se.rows.map((r) => `<tr>
      <td class="l">${esc(r.sku)}</td>
      <td class="l">${cls(r.old_class)} → ${cls(r.new_class)}</td>
      <td class="l">${r.direction === 'up' ? '▲ 昇格（要ゴールデンゾーン）' : '▼ 降格（前面を空けられる）'}</td>
      <td class="l">${spark(r.trend)}</td>
    </tr>`).join('');
    return `<h3 style="margin:6px 0 0;font-size:14px;color:var(--ink-primary)">季節入替候補（${esc(se.first_month)}→${esc(se.last_month)}）</h3>
      <div style="overflow-x:auto"><table class="sl-tbl">
      <tr><th class="l">SKU</th><th>クラス変化</th><th class="l">傾向</th><th class="l">月次</th></tr>
      ${rows}</table></div>
      <div class="sl-note">観測期間の月次傾向に基づく候補です（自動では入れ替えません）。</div>`;
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
      ${affinityBlock(data.affinity)}
      <div><button class="sl-btn" data-act="apply"${busy ? ' disabled' : ''}>${busy ? '適用中…' : '最適化して適用'}</button></div>
      <h3 style="margin:6px 0 0;font-size:14px;color:var(--ink-primary)">上位の棚割り変更</h3>
      ${movesTable(o)}
      ${seasonalityBlock(data.seasonality)}
      ${strategyBlock(s)}`;
    const btn = root.querySelector('[data-act=apply]');
    if (btn) btn.addEventListener('click', apply);
    const sl = root.querySelector('[data-act=aff]');
    if (sl) {
      const wv = sl.parentElement.querySelector('.wv');
      sl.addEventListener('input', () => { if (wv) wv.textContent = sl.value + '%'; });
      sl.addEventListener('change', () => { affinity = Number(sl.value) / 100; load(); });
    }
  }

  async function apply() {
    const name = getProject();
    if (!name || busy) return;
    busy = true; render();
    try {
      const r = await api(`/api/projects/${encodeURIComponent(name)}/slotting/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ affinity_weight: affinity }),
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
