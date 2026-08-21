// workcompare.js — ⑤提案「作業方法比較」: シングル/マルチ/ゾーン/トータル を実行比較.
// deep-research の指針: 全方式は「移動 vs 仕分け」のトレードオフの一点。4プリセットを
// SimPyで実行し、①横並びKPI（シングルオーダーをベースラインにデルタ）②移動vs仕分けの散布図
// （x=移動/件, y=仕分/件, バブル=¥/件）③注文プロファイルからの推奨、を出す。
// バックエンド: POST /workmethod/compare（純: whsim.workmethod + scenario runner）。
// 「この方式で設計」で選んだ方式をモデルのピッキング工程に反映。EN comments / JA UI.
import { esc, api } from './util.js';
import * as echarts from 'echarts';
import { startRunProgress } from './progress.js';
// 採用の誠実性ガード（applied/skipped を見てから成功と言う）は全画面で1つ。
import { applyEdits } from './adopt.js';
// The ⚡自動掃引 section was extracted to a cohesive sub-module (facade precedent:
// designer/*.js). It owns its own state and re-renders the panel via a callback.
import { createSweepPanel } from './workcompare/sweep_panel.js';

const fmt = (n, d = 0) => (n == null || isNaN(n) ? '—'
  : Number(n).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yen = (n) => (n == null || isNaN(n) ? '—' : '¥' + Math.round(n).toLocaleString('ja-JP'));
const pctStr = (g) => (g == null ? '' : (g >= 0 ? '+' : '') + Math.round(g * 100) + '%');
// completion_rate は 0–1 でも % でも届きうる（KPI源が2系統）ので比率に正規化。
const ratio = (v) => (v == null || isNaN(v) ? null : (Math.abs(v) <= 1 ? Number(v) : Number(v) / 100));
const reduceMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches;
function tok(name, fb) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
const COLORS = { discrete: '#16C0DE', multi: '#2ee6a0', zone: '#9b6bff', total: '#f5b05a' };

function injectStyle() {
  if (document.getElementById('wc-style')) return;
  const s = document.createElement('style');
  s.id = 'wc-style';
  s.textContent = `
  #workcompare.panel{overflow:auto}
  .wc{display:flex;flex-direction:column;gap:16px;max-width:1120px;margin:0 auto;width:100%;
    padding:8px 2px 40px;color:var(--ink-primary);font-family:var(--font-sans)}
  .wc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .wc-head h2{font-size:var(--fs-title,17px);margin:0}
  .wc-head .sub{font-size:var(--fs-sm,12.5px);color:var(--ink-secondary)}
  .wc-run{margin-left:auto;padding:9px 18px;border:none;border-radius:10px;cursor:pointer;
    background:var(--accent);color:var(--ink-onAccent,#04222c);font:inherit;font-weight:700}
  .wc-run:hover{background:var(--accent-hover)} .wc-run:disabled{opacity:.55;cursor:wait}
  .wc-rec{padding:11px 15px;border:1px solid var(--accent);border-left:4px solid var(--accent);
    border-radius:12px;background:var(--accent-tint,rgba(22,192,222,.06));font-size:13px}
  .wc-rec b{color:var(--accent-ink,var(--accent))}
  .wc-ec{width:100%;height:320px}
  .wc-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-sm,12.5px)}
  .wc-tbl th,.wc-tbl td{padding:8px 10px;border-bottom:1px solid var(--line-hair);text-align:right;white-space:nowrap}
  .wc-tbl th:first-child,.wc-tbl td:first-child{text-align:left}
  .wc-tbl th{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary);font-weight:700}
  .wc-tbl .num{font-family:var(--font-mono)}
  .wc-tbl tr.rec td{background:var(--accent-tint,rgba(22,192,222,.08))}
  .wc-sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .wc-d-up{color:#34c97a;font-size:11px} .wc-d-dn{color:var(--warn,#f5b05a);font-size:11px}
  /* 中立デルタ: 「安くなった」と読ませてはいけない差分（完了率が低い行の ¥/件）。 */
  .wc-d-flat{color:var(--ink-tertiary);font-size:11px;cursor:help}
  .wc-warn{color:var(--warn,#f5b05a);font-weight:700}
  .wc-adopt{padding:5px 12px;border-radius:8px;border:1px solid var(--accent);background:transparent;
    color:var(--accent);font:inherit;font-weight:700;font-size:12px;cursor:pointer}
  .wc-adopt:hover{background:var(--accent-tint-2,rgba(22,192,222,.14))}
  .wc-empty{padding:40px;text-align:center;color:var(--ink-tertiary)}
  /* Pre-run explainer — deliberately the SAME shape as ⑤シナリオ比較's
     (.compare-empty-card): icon → title → what it does → the things it will
     compare → CTA → time estimate. A blank panel with one sentence gave the
     salesperson nothing to decide on; these two screens now teach the same way. */
  .wc-empty-card{max-width:580px;margin:8px auto;padding:var(--sp-6,24px);text-align:center;
    border:1px solid var(--line-hair);border-radius:var(--r-lg,12px);
    background:var(--surface-1,rgba(127,127,127,.04))}
  .wc-empty-card .ce-icon{font-size:30px;line-height:1;margin-bottom:var(--sp-3,12px)}
  .wc-empty-card .ce-title{margin:0 0 var(--sp-2,8px);font-size:var(--fs-md,16px);
    font-weight:700;color:var(--ink-primary)}
  .wc-empty-card .ce-desc{margin:0;font-size:var(--fs-sm,13.5px);line-height:1.7;
    color:var(--ink-secondary)}
  .wc-empty-card .ce-steps{display:flex;gap:var(--sp-2,8px);justify-content:center;
    flex-wrap:wrap;list-style:none;margin:var(--sp-4,16px) 0 0;padding:0}
  .wc-empty-card .ce-steps li{font-size:var(--fs-xs,12px);font-weight:600;
    padding:4px 12px;border-radius:var(--r-pill,999px);border:1px solid var(--line-hair);
    color:var(--ink-secondary);background:var(--bg-panel)}
  .wc-empty-card .ce-cta{margin-top:var(--sp-4,16px);font:inherit;font-size:var(--fs-sm,14px);
    font-weight:700;padding:10px 22px;border-radius:var(--r-pill,999px);cursor:pointer;
    border:1px solid var(--accent);background:var(--accent);color:var(--accent-on,#04121A)}
  .wc-empty-card .ce-cta:hover{filter:brightness(1.06)}
  .wc-empty-card .ce-cta:disabled{opacity:.55;cursor:default}
  .wc-empty-card .ce-cta:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .wc-empty-card .ce-time{display:block;margin-top:var(--sp-3,12px);
    font-size:var(--fs-micro,11px);color:var(--ink-tertiary)}
  .wc-note{font-size:var(--fs-micro,10.5px);color:var(--ink-tertiary)}
  .wc-sweep-btn{padding:9px 16px;border:1px solid var(--accent);border-radius:10px;cursor:pointer;
    background:transparent;color:var(--accent);font:inherit;font-weight:700}
  .wc-sweep-btn:hover{background:var(--accent-tint,rgba(22,192,222,.1))} .wc-sweep-btn:disabled{opacity:.55;cursor:wait}
  .wc-sweep{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--line-hair);
    border-radius:12px;background:var(--surface-1,rgba(127,127,127,.04))}
  .wc-sweep h3{margin:0;font-size:var(--fs-sm,13px)}
  .wc-sweep .meta{font-size:var(--fs-micro,10.5px);color:var(--ink-secondary)}
  .wc-sweep tr.best td{background:var(--accent-tint,rgba(22,192,222,.1));font-weight:600}
  .wc-badge-ng{color:var(--warn,#f5b05a);font-weight:700}
  .wc-badge-ok{color:#34c97a;font-weight:700}
  `;
  document.head.appendChild(s);
}

export function mountWorkCompare(el, opts = {}) {
  injectStyle();
  const getProject = opts.getProject || (() => null);
  const toast = opts.toast || (() => {});
  const root = document.createElement('div');
  root.className = 'wc';
  el.innerHTML = '';
  el.appendChild(root);

  let chart = null;
  let ro = null;
  let data = null;
  let running = false;
  // ⚡自動掃引 panel (state + render/wire/adopt) lives in ./workcompare/sweep_panel.js.
  // It shares the facade's formatting vocabulary (fmt/yen/COLORS/WORK_PRESETS) and
  // re-renders the whole panel through `rerender` — behaviour is unchanged.
  const sweepPanel = createSweepPanel({
    getProject, toast, root,
    rerender: () => render(),
    COLORS, WORK_PRESETS, fmt, yen,
  });
  // The analytic recommendation handed over from ③設計「生産性試算」(pickrate).
  // We highlight it and, after the DES run, reconcile 解析推奨 vs DES推奨.
  let analyticPick = null;   // {id, label}
  function disposeChart() { if (chart) { try { chart.dispose(); } catch (_) { /* noop */ } chart = null; } }

  async function run() {
    const name = getProject();
    if (!name) { toast('先にプロジェクトを選択してください。', 'error'); return; }
    if (running) return;
    running = true;
    renderRunning();
    const prog = startRunProgress({ getProject: () => name,
      onCancel: () => api(`/api/projects/${encodeURIComponent(name)}/run/cancel`, { method: 'POST' }).catch(() => {}),
      title: '4方式をDESで比較実行中…', sub: 'シングルオーダー・マルチオーダー・ゾーン（リレー）・トータルをそれぞれ回して移動vs仕分けを実測します。' });
    try {
      data = await api(`/api/projects/${encodeURIComponent(name)}/workmethod/compare`, { method: 'POST' });
      // The request is over, so drop the busy flag BEFORE anything re-renders:
      // headHtml() reads `running`, and every branch below paints the head. It
      // used to be cleared in `finally` — after the paint — which left the
      // finished screen showing a disabled 「比較を実行中…」 button.
      running = false;
      if (data && data.cancelled) {
        prog.stop('cancelled');
        // 中止 is a normal outcome, not a dead end — offer the way back in.
        root.innerHTML = headHtml() + noticeHtml('比較を中止しました',
          '途中までの計算結果は保存していません。もう一度実行すると最初から4方式を回します。',
          'もう一度実行');
        wireHead(); wireNotice();
        return;
      }
      render();
    } catch (e) {
      data = null;
      running = false;   // same reason as above: the head is painted right below
      root.innerHTML = headHtml() + noticeHtml('比較を実行できませんでした',
        `${e && e.message ? e.message : e}　設計や実行結果は失われていません。`, '再実行');
      wireHead(); wireNotice();
    } finally { running = false; prog.stop(); }
  }

  function headHtml() {
    return `<div class="wc-head"><h2>作業方法比較</h2>
      <span class="sub">シングル / マルチ / ゾーン / トータル を実行して「移動 vs 仕分け」で比べる</span>
      <button type="button" class="wc-sweep-btn" data-sweep${sweepPanel.isSweeping() ? ' disabled' : ''}>${sweepPanel.isSweeping() ? '掃引中…' : '⚡ 自動掃引（解析）'}</button>
      <button type="button" class="wc-run" data-run${running ? ' disabled' : ''}>${running ? '比較を実行中…' : '▶ 4方式を比較実行'}</button></div>`;
  }
  function wireHead() {
    const b = root.querySelector('[data-run]');
    if (b) b.onclick = () => run();
    const s = root.querySelector('[data-sweep]');
    if (s) s.onclick = () => sweepPanel.runSweep();
  }

  // Cancelled / failed notice — same card as the empty state so an interrupted
  // comparison lands somewhere recognisable with one obvious way forward.
  function noticeHtml(title, body, cta) {
    return `<div class="wc-empty-card">
      <div class="ce-icon" aria-hidden="true">⚠️</div>
      <h3 class="ce-title">${esc(title)}</h3>
      <p class="ce-desc">${esc(body)}</p>
      <button type="button" class="ce-cta" data-empty-cta>${esc(cta)}</button>
    </div>`;
  }
  function wireNotice() {
    const ec = root.querySelector('[data-empty-cta]');
    if (ec) ec.onclick = () => { if (!running) run(); };
  }

  // Pre-run explainer. Mirrors ⑤シナリオ比較's empty card so ④ and ⑤ teach the
  // same way: what will run, what it will be judged on, and how long it takes.
  // The four chips are the four METHOD_PRESETS the endpoint actually runs.
  function emptyHtml() {
    return `<div class="wc-empty-card">
      <div class="ce-icon" aria-hidden="true">⚖️</div>
      <h3 class="ce-title">作業方法比較はまだ実行されていません</h3>
      <p class="ce-desc">「▶ 4方式を比較実行」を押すと、4つの作業方法をそれぞれ重厚なDES
        （離散事象シミュレーション）で実行し、<b>移動 vs 仕分け</b>のトレードオフを
        ¥/件・処理能力・人員・稼働率で横並びに比べます。歩き回る方式と、
        まとめて仕分ける方式のどちらが有利かは物量とレイアウトで変わるため、実測で決めます。</p>
      <ul class="ce-steps">
        <li>都度（シングル）</li><li>マルチオーダー</li><li>ゾーン（リレー）</li><li>種まき（トータル）</li>
      </ul>
      <button type="button" class="ce-cta" data-empty-cta>▶ 4方式を比較実行</button>
      <span class="ce-time">所要時間の目安：数十秒　／　結果はこの画面で比較し、採用すると設計に反映されます</span>
    </div>`;
  }
  function renderRunning() {
    disposeChart();
    root.innerHTML = headHtml() + '<div class="wc-empty">4方式をSimPyで実行中… （シングル／マルチ／ゾーン／トータル）</div>';
    wireHead();
  }

  function render() {
    disposeChart();
    const d = data || {};
    const methods = d.methods || [];
    if (!methods.length) {
      const ap = analyticPick
        ? `<div class="wc-rec">解析（生産性試算）の推奨は <b>${esc(analyticPick.label)}</b>。`
          + `「▶ 4方式を比較実行」でDESを回し、移動/仕分け以外（混雑・待ち）も含めて裏取りします。</div>`
        : '';
      root.innerHTML = headHtml() + ap + sweepPanel.sweepHtml() + emptyHtml();
      wireHead(); sweepPanel.wireSweep();
      // The card's CTA drives the SAME [data-run] button wireHead() just wired,
      // so the busy/disabled state can never disagree between the two.
      const ec = root.querySelector('[data-empty-cta]');
      if (ec) {
        ec.onclick = () => { if (!running) run(); };
        if (running) ec.disabled = true;
      }
      return;
    }
    const rec = d.recommend || {};
    const recRow = (m) => (m.id === rec.id);
    // baton reconciliation: did the heavyweight DES agree with the fast analytic?
    let reconcile = '';
    if (analyticPick && rec.id) {
      const agree = analyticPick.id === rec.id;
      const desName = (methods.find((m) => m.id === rec.id) || {}).label || rec.name || rec.id;
      reconcile = `<div class="wc-rec" style="border-left-color:${agree ? 'var(--accent)' : 'var(--warn,#f5b05a)'}">`
        + `解析（生産性試算）の推奨：<b>${esc(analyticPick.label)}</b> → DES検証の推奨：<b>${esc(desName)}</b>`
        + `　<b>${agree ? '✓ 一致（裏取りOK）' : '⚠ 不一致 — 移動/仕分け以外（混雑・待ち）が効いています'}</b></div>`;
    }
    root.innerHTML = headHtml()
      + reconcile
      + (rec.name ? `<div class="wc-rec">注文プロファイルからの推奨：<b>${esc(rec.name)}</b> — ${esc(rec.reason || '')}</div>` : '')
      + '<div class="wc-ec" data-ec></div>'
      + '<table class="wc-tbl"><thead><tr>'
      + '<th>作業方法</th><th>¥/件</th><th>処理(件/時)</th><th>完了率</th><th>人員</th><th>稼働率</th>'
      + '<th>移動/件(m)</th><th>仕分/件(s)</th><th>採用</th></tr></thead><tbody>'
      + methods.map((m) => {
        const k = m.kpis; const dl = m.delta || {};
        // ¥/件 は **完了した注文** で割った値。捌けていない方式（完了率が低い）は
        // 未完了ぶんのコストが分子から落ちるので「安く見える」— その緑の▼は改善
        // ではないので、中立色にして理由を添える（緑のままだと嘘になる）。
        const comp = ratio(k.completion_rate);
        const partial = comp != null && comp < 0.9;
        const dcost = m.id === d.baseline_id ? '<span class="wc-note">基準</span>'
          : partial
            ? `<span class="wc-d-flat" title="完了率${fmt(comp * 100)}%: 完了分のみで割った値のため、`
              + `安く見えているだけの可能性があります">${pctStr(dl.cost_per_order)} ⚠</span>`
            : `<span class="${dl.cost_per_order <= 0 ? 'wc-d-up' : 'wc-d-dn'}">${pctStr(dl.cost_per_order)}</span>`;
        const apTag = (analyticPick && analyticPick.id === m.id)
          ? ' <span class="wc-note" style="color:var(--accent);font-weight:700">解析推奨</span>' : '';
        return `<tr class="${recRow(m) ? 'rec' : ''}">`
          + `<td><span class="wc-sw" style="background:${COLORS[m.id] || '#888'}"></span>${esc(m.label)}${apTag}</td>`
          + `<td class="num">${m.currency || '¥'}${fmt(k.cost_per_order, 1)} ${dcost}</td>`
          + `<td class="num">${fmt(k.throughput_per_hr, 0)}</td>`
          + `<td class="num${partial ? ' wc-warn' : ''}">${comp == null ? '—' : `${fmt(comp * 100)}%`}</td>`
          + `<td class="num">${fmt(k.headcount)}名</td>`
          + `<td class="num">${fmt(k.picker_utilization * 100)}%</td>`
          + `<td class="num">${fmt(m.travel_per_order_m, 0)}</td>`
          + `<td class="num">${fmt(m.sort_per_order_s, 1)}</td>`
          + `<td><button type="button" class="wc-adopt" data-adopt="${esc(m.id)}">この方式で設計 →</button></td>`
          + '</tr>';
      }).join('')
      + '</tbody></table>'
      + '<div class="wc-note">※ 散布図：左下ほど移動・仕分けが少ない。トータルは移動最小だが仕分け工数が立つ＝トレードオフ。'
      + '「この方式で設計」でモデルのピッキング工程に反映し、再実行・原価へ繋がります。</div>'
      + '<div class="wc-note">※ ¥/件・納期遵守率の分母は <b>完了した注文のみ</b>です'
      + '（未完了ぶんは分子・分母の両方から落ちます）。完了率が低い行は ⚠ を付けています —'
      + 'まず捌けているか（完了率）を見てからコストを比べてください。</div>'
      + sweepPanel.sweepHtml();
    buildScatter(root.querySelector('[data-ec]'), methods, rec.id);
    wireHead();
    sweepPanel.wireSweep();
    root.querySelectorAll('[data-adopt]').forEach((b) => { b.onclick = () => adopt(b.dataset.adopt); });
  }

  function buildScatter(node, methods, recId) {
    if (!node) return;
    const ink = tok('--ink-secondary', '#52677c');
    const line = tok('--line-hair', 'rgba(120,140,170,.18)');
    const costs = methods.map((m) => m.kpis.cost_per_order || 1);
    const cmin = Math.min(...costs), cmax = Math.max(...costs);
    const bubble = (c) => 18 + (cmax > cmin ? (c - cmin) / (cmax - cmin) : 0) * 34;
    chart = echarts.init(node, null, { renderer: 'canvas' });
    chart.setOption({
      animation: !reduceMotion(),
      grid: { left: 56, right: 24, top: 16, bottom: 48 },
      tooltip: {
        formatter: (p) => {
          const m = p.data.m;
          return `<b>${esc(m.label)}</b><br>移動 ${fmt(m.travel_per_order_m, 0)} m/件`
            + `<br>仕分 ${fmt(m.sort_per_order_s, 1)} s/件<br>¥/件 ${fmt(m.kpis.cost_per_order, 1)}`;
        },
      },
      xAxis: { name: '移動/件 (m)  →多い', nameLocation: 'middle', nameGap: 28,
        nameTextStyle: { color: ink }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line } } },
      yAxis: { name: '仕分/件 (s)  →多い', nameLocation: 'middle', nameGap: 38,
        nameTextStyle: { color: ink }, axisLabel: { color: ink },
        splitLine: { lineStyle: { color: line } } },
      series: [{
        type: 'scatter',
        data: methods.map((m) => ({
          value: [m.travel_per_order_m, m.sort_per_order_s], m,
          symbolSize: bubble(m.kpis.cost_per_order || 1),
          itemStyle: { color: COLORS[m.id] || '#888',
            borderColor: m.id === recId ? '#fff' : 'transparent', borderWidth: m.id === recId ? 2 : 0,
            opacity: 0.85 },
          label: { show: true, position: 'right', formatter: m.label, color: ink, fontSize: 11 },
        })),
      }],
    }, true);
    if (typeof ResizeObserver !== 'undefined') {
      ro = ro || new ResizeObserver(() => { try { chart && chart.resize(); } catch (_e) { /* noop */ } });
      ro.observe(node);
    }
  }

  // この方式で設計: write the chosen preset's work axes onto the pick stage via the
  // dotted-path apply endpoint, so the model's ピッキング工程 becomes that method.
  async function adopt(mid) {
    const name = getProject();
    const m = (data && data.methods || []).find((x) => x.id === mid);
    if (!name || !m) return;
    try {
      const work = WORK_PRESETS[mid];
      if (!work) { toast('方式が見つかりません。', 'error'); return; }
      // Resolve the ピッキング工程's index from the model (id=="pick"); index 2 is
      // only the usual case, and writing onto the wrong stage is invisible.
      const full = await api(`/api/projects/${encodeURIComponent(name)}/full`);
      const stages = (full && full.process && full.process.stages) || [];
      const idx = stages.findIndex((s) => s && s.id === 'pick');
      if (idx < 0) { toast('ピッキング工程が見つかりませんでした。', 'error'); return; }
      // applyEdits verifies applied/skipped: /apply is tolerant, so a bad path
      // returns 200 with nothing written — never say 反映 without checking.
      await applyEdits(name, { [`process.stages.${idx}.work`]: work });
      toast(`「${m.label}」をピッキング工程に反映しました。実行で効果を確認できます。`, 'ok');
      document.dispatchEvent(new CustomEvent('whsim:model-changed', { detail: {} }));
    } catch (e) { toast('反映に失敗: ' + (e && e.message ? e.message : e), 'error'); }
  }

  const onTheme = () => { if (data) render(); };
  document.addEventListener('themechange', onTheme);
  render();   // initial empty state with the run button

  return {
    refresh() { /* keep last result across revisits */ },
    // baton from ③設計「生産性試算」: highlight that method and, if not yet run,
    // auto-start the DES comparison so 解析→DES is one click.
    setAnalyticPick(pick) {
      analyticPick = pick && pick.id ? pick : null;
      if (analyticPick && !data && !running) { run(); return; }
      render();
    },
    dispose() {
      document.removeEventListener('themechange', onTheme);
      if (ro) { ro.disconnect(); ro = null; }
      disposeChart();
      el.innerHTML = '';
    },
  };
}

// 5-axis presets mirrored from whsim.workmethod.METHOD_PRESETS (for 採用 write-back).
// ③生産性試算 (pickrate.js) の採用もここを import する — 同じ方式を2画面で別の
// 辞書として持つと、比べた方式と採用される方式がズレる。
// zone は **sequential**（サーバの METHOD_PRESETS と同じリレー）: 'parallel' と
// 書いていた頃は、DESで比べたゾーン（逐次リレー）とは別物が採用されていた。
export const WORK_PRESETS = {
  discrete: { orders_per_trip: 1, zoning: 'none', consolidation: 'pick', release: 'continuous' },
  multi: { orders_per_trip: 8, zoning: 'none', consolidation: 'pick', release: 'continuous' },
  zone: { orders_per_trip: 4, zoning: 'sequential', consolidation: 'pick', release: 'continuous' },
  total: { orders_per_trip: 16, zoning: 'none', consolidation: 'sort', release: 'continuous' },
};
