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

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));

const METHOD_C = { naive: '#9aa4b0', greedy: '#1f78b4', optimized: '#e6550d' };

function injectStyle() {
  if (document.getElementById('ps-style')) return;
  const s = document.createElement('style');
  s.id = 'ps-style';
  s.textContent = `
  .ps{display:flex;flex-direction:column;gap:14px;width:100%;padding:4px 2px 24px}
  .ps-head h2{margin:0 0 2px;font-size:18px;color:var(--ink-primary)}
  .ps-head .sub{font-size:12px;color:var(--ink-tertiary)}
  .ps-verdict{padding:10px 14px;border-radius:11px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 12%,transparent);color:var(--ink-primary);font-size:13.5px;font-weight:600}
  .ps-hero{display:flex;gap:18px;flex-wrap:wrap;align-items:baseline}
  .ps-hero .big{font-size:34px;font-weight:800;color:var(--accent,#16C0DE);font-variant-numeric:tabular-nums}
  .ps-hero .cap{font-size:12px;color:var(--ink-tertiary)}
  .ps-modes{display:flex;flex-direction:column;gap:16px}
  .ps-mode{border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-panel);padding:12px 14px}
  .ps-mode h3{margin:0 0 8px;font-size:14px;color:var(--ink-primary)}
  .ps-bars{display:flex;flex-direction:column;gap:7px}
  .ps-bar{display:grid;grid-template-columns:96px 1fr 120px;align-items:center;gap:10px;font-size:12.5px}
  .ps-bar .nm{color:var(--ink-secondary)}
  .ps-track{height:16px;border-radius:8px;background:var(--bg-sunken);overflow:hidden}
  .ps-fill{height:100%;border-radius:8px;transition:width .3s ease}
  .ps-bar .val{text-align:right;color:var(--ink-primary);font-variant-numeric:tabular-nums}
  .ps-cut{font-size:11px;color:var(--good,#2e7d32);font-weight:700;margin-left:6px}
  .ps-tbl{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
  .ps-tbl th,.ps-tbl td{padding:6px 9px;border-bottom:1px solid var(--line-hair);text-align:right;font-variant-numeric:tabular-nums}
  .ps-tbl th{color:var(--ink-secondary);font-weight:700;border-bottom:2px solid var(--line-hair)}
  .ps-tbl td.l,.ps-tbl th.l{text-align:left}
  .ps-tbl tr.rec{background:color-mix(in srgb,var(--accent,#16C0DE) 9%,transparent)}
  .ps-dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .ps-tag{font-size:10px;font-weight:700;color:#fff;border-radius:999px;padding:1px 7px;margin-left:6px;background:var(--accent,#16C0DE)}
  .ps-empty{padding:16px;border:1px dashed var(--line-strong);border-radius:12px;background:var(--bg-panel);
    color:var(--ink-secondary);font-size:13px}
  /* 経路方式比較 (routecompare) — same card language as .ps-mode */
  .ps-rc{border:1px solid var(--line-hair);border-radius:12px;background:var(--bg-panel);padding:12px 14px}
  .ps-rc h3{margin:0 0 2px;font-size:14px;color:var(--ink-primary)}
  .ps-rc .sub{font-size:11.5px;color:var(--ink-tertiary);line-height:1.6}
  .ps-rc-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 2px;min-height:30px}
  .ps-btn{padding:7px 14px;border-radius:9px;border:1px solid var(--accent,#16C0DE);
    background:color-mix(in srgb,var(--accent,#16C0DE) 14%,transparent);color:var(--accent,#16C0DE);
    font:inherit;font-weight:700;font-size:12.5px;cursor:pointer}
  .ps-btn:hover{background:color-mix(in srgb,var(--accent,#16C0DE) 24%,transparent)}
  .ps-btn:disabled{opacity:.55;cursor:default}
  .ps-btn.mini{padding:3px 10px;font-size:11px;border-radius:7px}
  .ps-rc-meta{font-size:11.5px;color:var(--ink-tertiary)}
  .ps-notes{margin:10px 0 0;padding-left:18px;font-size:11px;color:var(--ink-tertiary);line-height:1.65}
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

  function renderEmpty(msg) {
    root.innerHTML = `<div class="ps-head"><h2>ピック順序最適化</h2>
      <div class="sub">棚距離でピック順序を2-optで最適化し、移動距離・所要時間を比較（実行不要）</div></div>
      <div class="ps-empty">${esc(msg)}</div>`;
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
        <tr><th class="l">手法</th><th>距離 m</th><th>所要 分</th><th>ピック数</th></tr>
        ${rows}
      </table>
    </div>`;
  }

  function render() {
    if (!data.has_data) { renderEmpty(data.verdict); return; }
    const recJp = { order: 'シングル', multi: 'マルチ', total: 'トータル' }[data.recommend_mode] || 'シングル';
    root.innerHTML =
      `<div class="ps-head"><h2>ピック順序最適化 <span style="font-size:12px;font-weight:500;color:var(--ink-tertiary)">2-opt・解析的</span></h2>
        <div class="sub">棚距離（${data.wall_aware ? '壁考慮グラフ' : 'マンハッタン'}）でピック順序を最適化。ナイーブ／貪欲／2-optを ${esc(String(data.n_orders))} オーダーで比較。</div></div>
      <div class="ps-verdict">${esc(data.verdict)}</div>
      <div class="ps-hero">
        <div><div class="big">−${fmt(data.headline_reduction_pct, 0)}%</div><div class="cap">移動距離の削減（${esc(recJp)}ピック・2-opt vs 並び順）</div></div>
      </div>
      <div class="ps-modes">${data.modes.map(modeBlock).join('')}</div>
      <div class="sub" style="font-size:11px;color:var(--ink-tertiary)">距離=巡回路長（最近傍を2-optで改善）。所要=移動/歩行速度＋ピック手扱い。④検証のDESで裏取りします。</div>`;
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

  function policyRows(pol, best) {
    return Object.keys(pol).map((id) => {
      const p = pol[id] || {};
      const isBest = id === best;
      return `<tr class="${isBest ? 'rec' : ''}">
        <td class="l">${esc(p.label || id)}${isBest ? '<span class="ps-tag">最短</span>' : ''}</td>
        <td>${fmt(p.total_m)}</td>
        <td>${fmt(p.per_order_m, 1)}</td>
        <td>${p.vs_best_pct ? '+' + fmt(p.vs_best_pct, 1) + '%' : '—'}</td>
        <td><button class="ps-btn mini" data-adopt="${esc(id)}">採用</button></td>
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
    const notes = Array.isArray(rc.assumptions)
      ? `<ul class="ps-notes">${rc.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
    const table = Object.keys(pol).length
      ? `<div style="overflow-x:auto"><table class="ps-tbl">
          <tr><th class="l">経路方式</th><th>総距離 m</th><th>1件あたり m</th><th>最短との差</th><th></th></tr>
          ${policyRows(pol, rc.best)}
        </table></div>`
      : '<div class="ps-empty">比較できる経路方式がありませんでした。</div>';
    const meta = rc.has_data
      ? `<span class="ps-rc-meta">対象 ${esc(String(rc.n_orders))} オーダー</span>` : '';
    sec.innerHTML = `${head}
      <div class="ps-rc-bar"><button class="ps-btn" data-rcgo>再計算</button>${meta}</div>
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
      await api(`/api/projects/${encodeURIComponent(name)}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: { 'process.routing_policy': id } }),
      });
      toast(`経路方式「${label}」を採用しました。④検証の▶実行で裏取りできます。`, 'ok');
    } catch (e) {
      toast('採用に失敗しました: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  load();

  return {
    dispose() { el.innerHTML = ''; },
    refresh() { load(); },
  };
}
