// pickseq.js — ピック順序最適化: 棚距離でピック順序を最適化（2-opt）し、
// ナイーブ(並び順) / 貪欲(最近傍) / 最適化(2-opt) の巡回距離・所要時間を
// オーダー/まとめ/トータルのピックモード別に比較する自己完結ビュー。
// 解析的（DES不要）。EN comments / JA UI. Vanilla ES module, CSS-in-JS.
//
// 併設: 「経路方式比較」(POST …/routecompare) — 同じオーダー集合を S字/折り返し/
// 最大ギャップ/2-opt の各**経路規律**で歩いた総距離。ピック順序 (どの順に回るか
// を解く) の隣に、経路規律 (どう回れと指示するか) を置く。規律の入れ替えは
// 設備投資もレイアウト変更も要らないので、比較表がそのまま作業指示になる。
// 押されるまで叩かない (閉形式でも AisleGraph の構築が支配的) ＝ 既存表示は不変。
import { esc, api } from './util.js';
import { forkliftBusy } from './progress.js';
import { applyEdits } from './adopt.js';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

const METHOD_C = { naive: '#9aa4b0', greedy: '#1f78b4', optimized: '#e6550d' };

function injectStyle() {
  if (document.getElementById('ps-style')) return;
  const s = document.createElement('style');
  s.id = 'ps-style';
  s.textContent = `
  .ps{display:flex;flex-direction:column;gap:16px;width:100%;padding:4px 2px 28px;
    font-variant-numeric:tabular-nums}
  .ps-head h2{margin:0 0 3px;font-size:20px;font-weight:600;letter-spacing:-.012em;color:var(--ink-primary)}
  .ps-head .sub{font-size:12px;color:var(--ink-tertiary);line-height:1.55}
  /* 判定文: a quiet plate with an accent spine — it is a conclusion, not an alert,
     so it no longer paints a full accent-tinted block across the view. */
  .ps-verdict{position:relative;padding:12px 16px 12px 18px;border-radius:var(--r-card,10px);
    border:1px solid var(--line-hair);background:var(--bg-sunken);
    color:var(--ink-primary);font-size:13.5px;font-weight:600;line-height:1.6;overflow:hidden}
  .ps-verdict::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;
    background:var(--accent,#16C0DE)}
  .ps-hero{display:flex;gap:18px;flex-wrap:wrap;align-items:baseline}
  .ps-hero .big{font-size:34px;font-weight:700;letter-spacing:-.022em;
    color:var(--accent-ink,#0B7A90);font-variant-numeric:tabular-nums}
  .ps-hero .cap{font-size:12px;color:var(--ink-tertiary)}
  .ps-modes{display:flex;flex-direction:column;gap:16px}
  .ps-mode{border:1px solid var(--line-hair);border-radius:var(--r-card,10px);
    background:var(--bg-app);padding:16px 18px}
  .ps-mode h3{margin:0 0 12px;font-size:14px;font-weight:600;color:var(--ink-primary)}
  .ps-bars{display:flex;flex-direction:column;gap:8px}
  .ps-bar{display:grid;grid-template-columns:142px 1fr 140px;align-items:center;gap:14px;font-size:12.5px}
  .ps-bar .nm{color:var(--ink-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps-track{height:14px;border-radius:var(--r-xs,4px);background:var(--bg-sunken);
    border:1px solid var(--line-soft,var(--line-hair));overflow:hidden}
  /* display:block is LOAD-BEARING — .ps-fill is a <span>, and width/height are
     ignored on a non-replaced inline box, so every bar rendered as an empty
     track. (.ps-track only ever had a height because .ps-bar is a grid and
     blockified it; its child got no such rescue.) */
  .ps-fill{display:block;height:100%;border-radius:var(--r-xs,4px);transition:width .3s ease}
  .ps-bar .val{text-align:right;color:var(--ink-primary);font-variant-numeric:tabular-nums}
  .ps-cut{font-size:11px;color:var(--ok,#2E7D55);font-weight:700;margin-left:6px}
  /* ---- data table (shared by 手法別 and 経路方式比較) ---- */
  .ps-tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
  .ps-tbl th,.ps-tbl td{padding:10px 10px;text-align:right;font-variant-numeric:tabular-nums}
  .ps-tbl td{border-bottom:1px solid var(--line-soft,var(--line-hair));color:var(--ink-primary)}
  .ps-tbl th{color:var(--ink-tertiary);font-weight:600;font-size:11px;
    letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;
    border-bottom:1px solid var(--line-hair);padding-bottom:8px}
  .ps-tbl th .u{margin-left:5px;font-weight:400;letter-spacing:.02em;
    text-transform:none;color:var(--ink-faint)}
  .ps-tbl td.l,.ps-tbl th.l{text-align:left}
  /* Rank sits clear of the .rec spine (inset box-shadow on the same cell). */
  .ps-tbl th.ps-rank,.ps-tbl td.ps-rank{width:38px;text-align:left;padding-left:12px;
    color:var(--ink-tertiary);font-size:12px}
  .ps-tbl tr.rec .ps-rank{color:var(--accent-ink,#0B7A90);font-weight:700}
  .ps-tbl .ps-gap{color:var(--ink-secondary)}
  .ps-tbl tr.rec .ps-gap{color:var(--ink-tertiary)}
  .ps-tbl td:first-child:not(.ps-rank),.ps-tbl th:first-child:not(.ps-rank){padding-left:0}
  .ps-tbl td:last-child,.ps-tbl th:last-child{padding-right:0}
  .ps-tbl tbody tr:last-child td{border-bottom:0}
  .ps-tbl tbody tr:hover td{background:var(--bg-hover)}
  /* 最短/推奨 row: an accent spine + a faint band. The band alone (old rule) put
     four equally-loud rows on screen and the eye had to hunt for the winner. */
  .ps-tbl tr.rec td{background:color-mix(in srgb,var(--accent,#16C0DE) 7%,transparent)}
  .ps-tbl tr.rec td:first-child{box-shadow:inset 2px 0 0 var(--accent,#16C0DE)}
  .ps-tbl tr.rec td.l{font-weight:600}
  .ps-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:8px;vertical-align:middle}
  .ps-tag{font-size:10.5px;font-weight:700;line-height:1.5;border-radius:var(--r-pill,999px);
    padding:1px 9px;margin-left:8px;white-space:nowrap;
    color:var(--accent-ink,#0B7A90);background:var(--accent-tint,rgba(22,192,222,.12));
    border:1px solid color-mix(in srgb,var(--accent,#16C0DE) 34%,transparent)}
  .ps-empty{display:flex;gap:16px;align-items:center;
    padding:22px 24px;border:1px dashed var(--line-strong);border-radius:var(--r-card,10px);
    background:var(--bg-sunken);color:var(--ink-secondary);font-size:13px;line-height:1.7}
  .ps-empty-ic{flex:none;color:var(--ink-faint)}
  .ps-kicker{font-size:12px;font-weight:500;color:var(--ink-tertiary);margin-left:4px}
  /* 経路方式比較 (routecompare) — same card language as .ps-mode */
  .ps-rc{border:1px solid var(--line-hair);border-radius:var(--r-card,10px);
    background:var(--bg-app);padding:16px 18px 14px}
  .ps-rc h3{margin:0 0 3px;font-size:15px;font-weight:600;color:var(--ink-primary)}
  .ps-rc .sub{font-size:12px;color:var(--ink-tertiary);line-height:1.65;max-width:74ch}
  .ps-rc-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:14px 0 2px;min-height:32px}
  /* Buttons: ONE accent-filled action per table (the shortest route). Every
     other 採用 is a neutral ghost, so the recommendation is legible at a glance. */
  .ps-btn{padding:7px 15px;border-radius:var(--r-control,8px);
    border:1px solid color-mix(in srgb,var(--accent,#16C0DE) 62%,transparent);
    background:transparent;color:var(--accent-ink,#0B7A90);
    font:inherit;font-weight:600;font-size:12.5px;cursor:pointer;white-space:nowrap;
    transition:background var(--t-fast,.09s ease),border-color var(--t-fast,.09s ease)}
  .ps-btn:hover:not(:disabled){background:var(--accent-tint);border-color:var(--accent,#16C0DE)}
  .ps-btn:disabled{opacity:.55;cursor:default}
  .ps-btn.mini{padding:4px 12px;font-size:11.5px}
  .ps-btn.quiet{border-color:var(--line-strong);color:var(--ink-secondary);font-weight:500}
  .ps-btn.quiet:hover:not(:disabled){background:var(--bg-hover);border-color:var(--line-strong);
    color:var(--ink-primary)}
  .ps-btn.on{background:var(--accent);border-color:var(--accent);color:var(--ink-onAccent,#04222c);
    font-weight:700}
  .ps-btn.on:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
  .ps-rc-meta{font-size:12px;color:var(--ink-tertiary)}
  /* 前提: six always-open bullets buried the table. Folded by default; the count
     stays on the summary so nothing feels hidden. */
  .ps-fold{margin-top:14px;border-top:1px solid var(--line-soft,var(--line-hair));padding-top:10px}
  .ps-fold>summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:7px;
    font-size:12px;color:var(--ink-secondary);user-select:none}
  .ps-fold>summary::-webkit-details-marker{display:none}
  .ps-fold>summary::before{content:"";width:0;height:0;flex:none;
    border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;
    transition:transform var(--t-fast,.09s ease)}
  .ps-fold[open]>summary::before{transform:rotate(90deg)}
  .ps-fold>summary:hover{color:var(--ink-primary)}
  .ps-fold-n{color:var(--ink-faint);font-variant-numeric:tabular-nums}
  .ps-notes{margin:10px 0 2px;padding-left:18px;font-size:11.5px;color:var(--ink-tertiary);line-height:1.75}
  .ps-foot{font-size:11.5px;color:var(--ink-tertiary);line-height:1.7}
  `;
  document.head.appendChild(s);
}

export function mountPickseq(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'ps';
  el.innerHTML = '';
  el.appendChild(root);

  let data = null;
  let rc = null;         // last 経路方式比較 result (null = not run yet)
  let rcBusy = false;

  async function load() {
    const name = getProject();
    if (!name) { renderEmpty('プロジェクトを開くと、ピック順序の最適化効果を試算します。'); return; }
    renderEmpty('ピック順序を試算中…（棚距離で2-opt最適化）');
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/pickseq`);
      render();
    } catch (e) {
      renderEmpty('試算に失敗しました: ' + (e && e.message ? e.message : e));
    }
    // 経路方式比較 is independent of the pickseq payload (it never blocks and
    // falls back to the demand profile), so it is appended after EITHER outcome.
    appendRouteCompare();
  }

  // A route glyph (depot → picks) so the empty state reads as "this view draws a
  // tour", not as a failed panel. Decorative — hidden from assistive tech.
  const ROUTE_GLYPH = '<svg class="ps-empty-ic" width="34" height="34" viewBox="0 0 24 24"'
    + ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 19h4a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h4" stroke-dasharray="2.5 2.5"/>'
    + '<circle cx="4" cy="19" r="1.6"/><circle cx="12" cy="7" r="1.6"/>'
    + '<path d="M18 4.5 20.5 8 18 11.5 15.5 8Z"/></svg>';

  function renderEmpty(msg) {
    root.innerHTML = `<div class="ps-head"><h2>ピック順序最適化</h2>
      <div class="sub">棚距離でピック順序を2-optで最適化し、移動距離・所要時間を比較（実行不要）</div></div>
      <div class="ps-empty">${ROUTE_GLYPH}<span>${esc(msg)}</span></div>`;
  }

  function bar(mode, mid, length, maxLen, color, cut) {
    const pct = maxLen > 0 ? Math.max(2, (length / maxLen) * 100) : 0;
    const lbl = data.method_labels[mid] || mid;
    return `<div class="ps-bar">
      <span class="nm"><span class="ps-dot" style="background:${color}"></span>${esc(lbl)}</span>
      <span class="ps-track"><span class="ps-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="val">${fmt(length)} m${cut != null && cut > 0 ? `<span class="ps-cut">−${fmt(cut, 0)}%</span>` : ''}</span>
    </div>`;
  }

  function modeBlock(m) {
    const naive = m.methods.naive.length_m;
    const greedy = m.methods.greedy.length_m;
    const opt = m.methods.optimized.length_m;
    const maxLen = Math.max(naive, greedy, opt, 1);
    const cutG = naive > 0 ? (1 - greedy / naive) * 100 : 0;
    const cutO = naive > 0 ? (1 - opt / naive) * 100 : 0;
    const rows = ['naive', 'greedy', 'optimized'].map((mid) => {
      const r = m.methods[mid];
      const rec = mid === 'optimized';
      return `<tr class="${rec ? 'rec' : ''}">
        <td class="l"><span class="ps-dot" style="background:${METHOD_C[mid]}"></span>${esc(data.method_labels[mid] || mid)}${rec ? '<span class="ps-tag">推奨</span>' : ''}</td>
        <td>${fmt(r.length_m)}</td>
        <td>${fmt(r.time_s / 60, 1)}</td>
        <td>${fmt(r.n_picks)}</td>
      </tr>`;
    }).join('');
    return `<div class="ps-mode">
      <h3>${esc(m.label)}</h3>
      <div class="ps-bars">
        ${bar(m, 'naive', naive, maxLen, METHOD_C.naive, null)}
        ${bar(m, 'greedy', greedy, maxLen, METHOD_C.greedy, cutG)}
        ${bar(m, 'optimized', opt, maxLen, METHOD_C.optimized, cutO)}
      </div>
      <table class="ps-tbl">
        <thead><tr><th class="l">手法</th><th>距離<span class="u">m</span></th>
          <th>所要<span class="u">分</span></th><th>ピック数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function render() {
    if (!data.has_data) { renderEmpty(data.verdict); return; }
    const recJp = { order: 'シングル', multi: 'マルチ', total: 'トータル' }[data.recommend_mode] || 'シングル';
    root.innerHTML =
      `<div class="ps-head"><h2>ピック順序最適化 <span class="ps-kicker">2-opt・解析的</span></h2>
        <div class="sub">棚距離（${data.wall_aware ? '壁考慮グラフ' : 'マンハッタン'}）でピック順序を最適化。ナイーブ／貪欲／2-optを ${esc(String(data.n_orders))} オーダーで比較。</div></div>
      <div class="ps-verdict">${esc(data.verdict)}</div>
      <div class="ps-hero">
        <div><div class="big">−${fmt(data.headline_reduction_pct, 0)}%</div><div class="cap">移動距離の削減（${esc(recJp)}ピック・2-opt vs 並び順）</div></div>
      </div>
      <div class="ps-modes">${data.modes.map(modeBlock).join('')}</div>
      <div class="ps-foot">距離=巡回路長（最近傍を2-optで改善）。所要=移動/歩行速度＋ピック手扱い。④検証のDESで裏取りします。</div>`;
  }

  // ---- 経路方式比較 (POST …/routecompare) ----------------------------------
  //
  // 「どの順に回るか」(上の 2-opt) の次に来る問いが「どう回れと指示するか」。
  // S字/折り返し/最大ギャップ は現場が守れる規律で、2-opt はその上限。同一の
  // オーダー集合・同一デポ・同一距離尺度で歩かせるので、差は規律だけに由来する。
  // 採用は `process.routing_policy` への1フィールド書込み (既存の POST /apply の
  // dotted-path 経路をそのまま使う) — エンジンは次の実行からその規律で歩く。

  function appendRouteCompare() {
    if (!getProject()) return;                      // no project → nothing to compare
    if (root.querySelector('[data-rc]')) return;    // already mounted on this render
    const sec = document.createElement('div');
    sec.className = 'ps-rc';
    sec.setAttribute('data-rc', '');
    root.appendChild(sec);
    renderRouteCompare();
  }

  // Rows are ordered shortest-first so the table reads as a ranking, and only the
  // winner carries a filled 採用; the rest are neutral ghosts (four identical
  // accent buttons gave the eye no answer to "which one should I press?").
  function policyRows(pol, best) {
    const ids = Object.keys(pol).sort((a, b) => {
      const va = pol[a] && typeof pol[a].total_m === 'number' ? pol[a].total_m : Infinity;
      const vb = pol[b] && typeof pol[b].total_m === 'number' ? pol[b].total_m : Infinity;
      return va - vb;
    });
    return ids.map((id, i) => {
      const p = pol[id] || {};
      const isBest = id === best;
      const label = p.label || id;
      return `<tr class="${isBest ? 'rec' : ''}">
        <td class="ps-rank">${i + 1}</td>
        <td class="l">${esc(label)}${isBest ? '<span class="ps-tag">最短</span>' : ''}</td>
        <td>${fmt(p.total_m)}</td>
        <td>${fmt(p.per_order_m, 1)}</td>
        <td class="ps-gap">${p.vs_best_pct ? '+' + fmt(p.vs_best_pct, 1) + '%' : '—'}</td>
        <td><button class="ps-btn mini${isBest ? ' on' : ' quiet'}" data-adopt="${esc(id)}"
          aria-label="${esc(label)}を採用">採用</button></td>
      </tr>`;
    }).join('');
  }

  function renderRouteCompare() {
    const sec = root.querySelector('[data-rc]');
    if (!sec) return;
    const head = `<h3>経路方式比較</h3>
      <div class="sub">同じオーダー集合を S字／折り返し／最大ギャップ／2-opt の各経路規律で歩かせ、
        総移動距離を比較します（閉形式・DES不要）。規律の入れ替えは設備投資もレイアウト変更も不要です。</div>`;
    if (!rc) {
      sec.innerHTML = `${head}
        <div class="ps-rc-bar"><button class="ps-btn" data-rcgo>経路方式を比較する</button>
          <span class="ps-rc-meta">押すと計算します（数秒）</span></div>`;
      wireRouteCompare();
      return;
    }
    const pol = (rc.policies && typeof rc.policies === 'object') ? rc.policies : {};
    const notes = (Array.isArray(rc.assumptions) && rc.assumptions.length)
      ? `<details class="ps-fold"><summary>計算の前提
          <span class="ps-fold-n">(${rc.assumptions.length})</span></summary>
          <ul class="ps-notes">${rc.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        </details>` : '';
    const table = Object.keys(pol).length
      ? `<div style="overflow-x:auto"><table class="ps-tbl">
          <thead><tr><th class="ps-rank"></th><th class="l">経路方式</th>
            <th>総距離<span class="u">m</span></th><th>1件あたり<span class="u">m</span></th>
            <th>最短との差</th><th></th></tr></thead>
          <tbody>${policyRows(pol, rc.best)}</tbody>
        </table></div>`
      : '<div class="ps-empty">比較できる経路方式がありませんでした。</div>';
    const meta = rc.has_data
      ? `<span class="ps-rc-meta">対象 ${esc(String(rc.n_orders))} オーダー</span>` : '';
    sec.innerHTML = `${head}
      <div class="ps-rc-bar"><button class="ps-btn quiet" data-rcgo>再計算</button>${meta}</div>
      ${table}${notes}`;
    wireRouteCompare();
  }

  function wireRouteCompare() {
    const sec = root.querySelector('[data-rc]');
    if (!sec) return;
    const go = sec.querySelector('[data-rcgo]');
    if (go) go.addEventListener('click', () => runRouteCompare());
    sec.querySelectorAll('[data-adopt]').forEach((b) => {
      b.addEventListener('click', () => adoptPolicy(b.dataset.adopt));
    });
  }

  async function runRouteCompare() {
    const name = getProject();
    if (!name || rcBusy) return;
    rcBusy = true;
    const sec = root.querySelector('[data-rc]');
    const bar = sec && sec.querySelector('.ps-rc-bar');
    const busy = bar ? forkliftBusy('経路方式を比較中…', bar) : null;
    try {
      rc = await api(`/api/projects/${encodeURIComponent(name)}/routecompare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      renderRouteCompare();
    } catch (e) {
      if (busy) busy.stop();
      if (bar) bar.innerHTML = '<button class="ps-btn" data-rcgo>経路方式を比較する</button>'
        + `<span class="ps-rc-meta">比較に失敗しました: ${esc(e && e.message ? e.message : String(e))}</span>`;
      wireRouteCompare();
    } finally {
      rcBusy = false;
      if (busy) busy.stop();
    }
  }

  // 採用: one dotted-path edit through the SAME POST /apply the rest of the app
  // uses (pickrate.js の「推奨方式で設計→」と同じ流儀)。エンジンは
  // `process.routing_policy` を build 時に読むので、次の▶実行から効く。
  async function adoptPolicy(id) {
    const name = getProject();
    if (!name || !id) return;
    const label = ((rc && rc.policies && rc.policies[id]) || {}).label || id;
    try {
      // 応答の applied/skipped を検証してから成功と言う（adopt.js の共通ガード）。
      await applyEdits(name, { 'process.routing_policy': id });
      toast(`経路方式「${label}」を採用しました。④検証の▶実行で裏取りできます。`, 'ok');
      document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: {} }));
    } catch (e) {
      toast('採用できませんでした: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  load();

  return {
    dispose() { el.innerHTML = ''; },
    refresh() { load(); },
  };
}
