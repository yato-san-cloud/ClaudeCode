// whsim frontend: design -> import -> confirm headline -> run -> animated replay.
import { Scene3D } from './js/view3d.js';
import { Designer } from './js/designer.js';
import { CompareView } from './js/compare.js';
import { ExportView } from './js/export.js';
import { mountAnalysis } from './js/analysis.js';
import { mountCody, codyAvatarSVG } from './js/cody.js';
import { mountChat } from './js/chat.js';
import { mountSettings } from './js/settings.js';
import { mountOnboarding } from './js/onboarding.js';
import { mountJourney, viewDesc } from './js/journey.js';
import { mountOverview } from './js/overview.js';
import { mountBI } from './js/bi.js';
import { mountBIAnalytics } from './js/bianalytics.js';
import { mountPhaseHint } from './js/phasehint.js';
import { mountTimetable } from './js/timetable.js';
import { mountStorage } from './js/storage.js';
import { mountCost } from './js/cost.js';
import { mountPickrate } from './js/pickrate.js';
import { mountWorkCompare } from './js/workcompare.js';
import { mountDataAnalysis } from './js/dataanalysis.js';
import { mountMaterialFlow } from './js/materialflow.js';
import { mountNotes } from './js/notes.js';
import { mountScorecard } from './js/scorecard.js';
import { startRunProgress } from './js/progress.js';
import { $, api, esc } from './js/util.js';
import { S } from './js/state.js';
import { initImports } from './js/imports.js';
import { mountHistory, hist } from './js/history.js';
import {
  initProjectMenu, closeProjMenu, openProjMenu, projDuplicate, projRename, projDelete,
  projSaveSample,
} from './js/projectmenu.js';
import { initMySamples, refreshMySamples } from './js/mysamples.js';
// 2D replay canvas renderer + shared playback clock (lifted verbatim from this
// shell). The shell still owns view switching, so it calls draw2d/fitCanvas/
// refreshPalette/loop and reuses JP_TO_TYPE for the 3D bottleneck spotlight.
import {
  draw2d, fitCanvas, refreshPalette, loop, JP_TO_TYPE,
} from './js/render2d.js';

// ---- toast notifications (small, accessible, Japanese) ---------------------
function toast(message, kind = 'info', ms = 4200) {
  const host = $('toastHost');
  if (!host) return;
  const t = document.createElement('div');
  t.className = 'toast ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : 'info');
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const body = document.createElement('span');
  body.className = 'toast-msg';
  body.textContent = String(message == null ? '' : message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '閉じる');
  close.textContent = '×';
  const dismiss = () => {
    if (!t.parentNode) return;
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 200);
  };
  close.onclick = dismiss;
  t.appendChild(body);
  t.appendChild(close);
  host.appendChild(t);
  if (ms > 0) setTimeout(dismiss, ms);
  return t;
}

// Toast with an inline primary action button (e.g. "③設計を開く →"). Clicking the
// action runs `onAction` then dismisses; the row keeps the standard × dismiss.
// Used to turn a passive "imported" confirmation into a one-tap next step so the
// new MapMaker/3D power is discoverable right where the salesperson lands.
function actionToast(message, actionLabel, onAction, kind = 'ok', ms = 9000) {
  const t = toast(message, kind, ms);
  if (!t) return null;
  const close = t.querySelector('.toast-close');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.onclick = () => {
    try { if (typeof onAction === 'function') onAction(); }
    finally {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 200);
    }
  };
  // Sit between the message and the × so the CTA reads as the primary affordance.
  if (close) t.insertBefore(btn, close); else t.appendChild(btn);
  return t;
}

// Post-import nudge: a layout import (MapMaker .rmpm / 地図CSV / CAD) lands the
// user on ①取込, but the value now lives in ③設計 (place/adjust shelves — "the
// drawn map is the routing truth") and ④検証 (the realistic 3D). Surface a
// one-tap path there instead of leaving them stranded on the import screen.
function nudgeToDesign(summary) {
  actionToast(summary + ' ③設計でレイアウトを調整できます。', '③設計を開く →',
    () => switchView('design'), 'ok');
}

// The shared SPA state `S` now lives in ./js/state.js (single singleton) so the
// extracted shell modules (imports.js / projectmenu.js) mutate the SAME object.

// The 2D replay canvas renderer, theme-aware palette, keyframe interpolation,
// and the shared playback clock (`loop`) now live in ./js/render2d.js (lifted
// verbatim). The shell imports draw2d / fitCanvas / refreshPalette / loop /
// JP_TO_TYPE from there and calls them at the same seams as before.

// ---- data flow -------------------------------------------------------------
async function loadTemplates() {
  const ts = await api('/api/templates');
  $('templateSelect').innerHTML = ts.map(t =>
    `<option value="${t.template_id}">${t.name || t.template_id}</option>`).join('');
}
async function refreshProjects(select) {
  const ps = await api('/api/projects');
  const sel = $('projectSelect');
  // Batch the rebuild into a fragment (one reflow instead of N appends).
  const frag = document.createDocumentFragment();
  const ph = document.createElement('option');
  ph.value = ''; ph.textContent = '（新規作成）';
  frag.appendChild(ph);
  ps.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    frag.appendChild(opt);
  });
  sel.replaceChildren(frag);
  if (select) sel.value = select;
  updateProjMenuState();
  if (S.onboarding && S.onboarding.refreshCTA) S.onboarding.refreshCTA();
}
function updateProjMenuState() {
  const btn = $('projMenuBtn');
  if (btn) btn.disabled = !S.project;
}
// Core create flow, shared by the sidebar button and the Cody chat.
async function doCreate(name, template) {
  await api('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template }),
  });
  // Record the creation (and pre-mark the project as "opened" so the openProject
  // call below doesn't add a redundant 「開きました」 row right after it).
  _lastOpened = name;
  hist.setProject(name);
  hist.log('✨', `プロジェクト「${name}」を作成しました`, 'overview', 'project');
  await refreshProjects(name);
  await openProject(name);
}
// Last project the 操作履歴 saw an open for — openProject() is also called as an
// internal refresh (after every import/apply), so only a genuine switch logs.
let _lastOpened = null;
async function openProject(name) {
  S.project = name;
  hist.setProject(name);
  if (name && name !== _lastOpened) {
    _lastOpened = name;
    hist.log('📂', `プロジェクト「${name}」を開きました`, 'overview', 'project');
  }
  const m = await api(`/api/projects/${name}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
  $('provenance').textContent = m.provenance_summary;
  $('runBtn').disabled = false;
  $('status').textContent = `プロジェクト「${name}」を開きました。設計を調整して実行できます。`;
  updateProjMenuState();
  // Reset replay/analysis state and restore this project's chat thread.
  S.replay = null;
  // Restore run state from the server: a project that already has a completed run
  // should reopen with ④検証/⑤提案 unlocked and its KPIs/PNG/replay in place —
  // not re-locked until the user runs again.
  S.hasRun = !!m.has_run;
  if (m.has_run) {
    if (m.kpis) renderKpis(m.kpis);
    $('pngImg').src = `/api/projects/${name}/png?ts=${Date.now()}`;
    renderProposalStory();
    loadReplay().catch(() => {});  // best-effort; replay may be absent
  }
  // Invalidate the Designer model cache so the next design mount refetches
  // /full (the model may have changed via import/generate on (re)open).
  S._designerProj = null;
  // "% your data" > 0 ⇒ real customer data has been imported (not just template).
  S.hasData = /([1-9]\d*)\s*%/.test(m.provenance_summary || '');
  refreshReadiness();
  if (S.chat && S.chat.loadFor) S.chat.loadFor(name);
  if (S.settings && S.settings.loadFor) S.settings.loadFor(name);
  if (S.view === 'design') mountDesigner();
  if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
  if (S.view === 'overview') mountOverviewView();  // refresh ①取込 dashboard live
  refreshScorecard();  // re-score for the (re)opened project
}

async function mountDesigner() {
  if (!S.project) return;
  // Fast path: the Designer for this project is already live and its model has
  // not been invalidated (openProject nulls S._designerProj on any model change)
  // — just refit, skip the /full refetch + full rebuild. Big revisit snappiness.
  if (S.designer && S._designerProj === S.project) { S.designer.resize(); return; }
  // Re-entrancy guard: tearing down the old Designer up-front (so a concurrent
  // mount can't orphan it), then bailing if the project/view changed while the
  // model fetch was in flight — otherwise two rapid mounts could leak listeners.
  if (S.designer) { S.designer.dispose(); S.designer = null; }
  const epoch = (S._designerEpoch = (S._designerEpoch || 0) + 1);
  const proj = S.project;
  const model = await api(`/api/projects/${proj}/full`);
  if (epoch !== S._designerEpoch || S.view !== 'design' || S.project !== proj) return;
  S.designer = new Designer($('design'), model, {
    save: async (sections) => {
      const r = await api(`/api/projects/${S.project}/design`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sections),
      });
      $('provenance').textContent = r.provenance_summary;
      $('status').textContent = '設計を保存しました。「実行」で検証できます。';
      hist.log('💾', '設計を保存しました', 'design', 'design');
      await openProjectQuiet();  // refresh headline values after re-materialise
      refreshScorecard();        // re-score the saved design
      return r;
    },
    // Slot the loaded inventory onto the created locations (velocity/ABC).
    assignInventory: async (strategy = 'abc') => {
      const s = await api(`/api/projects/${S.project}/assign-inventory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      $('status').textContent = '在庫割付: ' + (s.message || '完了');
      return s;
    },
    // Reverse-name a 5-axis work method (live, as the user turns the knobs).
    workmethodName: async (work) => api('/api/workmethod/name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(work),
    }),
    // Suggest a work method from the loaded project's order profile.
    recommendWork: async () => api(`/api/projects/${S.project}/workmethod/recommend`),
  });
  S.designer.resize();
  S._designerProj = proj;  // mark the cached model fresh for this project
}
async function openProjectQuiet() {
  const m = await api(`/api/projects/${S.project}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
}
function renderHeadline(fields, values) {
  const el = $('headline'); el.innerHTML = '';
  for (const f of fields) {
    let v = values[f.path];
    const id = 'hf_' + f.path.replace(/\W/g, '_');
    const scale = f.scale || 1;
    let input;
    if (f.type === 'choice') {
      const opts = (f.choices || []).map(c => {
        const val = (typeof c === 'object') ? c.value : c;
        const lab = (typeof c === 'object') ? c.label : c;
        return `<option value="${val}" ${val === v ? 'selected' : ''}>${lab}</option>`;
      }).join('');
      input = `<select id="${id}" data-path="${f.path}">${opts}</select>`;
    } else {
      const shown = (v ?? 0) / scale;
      input = `<input id="${id}" data-path="${f.path}" data-scale="${scale}" ` +
        `type="number" step="any" value="${shown}" />`;
    }
    const unit = f.unit ? `<span class="unit">${f.unit}</span>` : '';
    el.insertAdjacentHTML('beforeend',
      `<div class="field"><label>${f.label}</label>${input}${unit}</div>`);
  }
}
async function applyHeadline() {
  if (!S.project) return;
  const payload = {};
  document.querySelectorAll('#headline [data-path]').forEach(inp => {
    let v = inp.value;
    if (inp.type === 'number') v = parseFloat(v) * (parseFloat(inp.dataset.scale) || 1);
    payload[inp.dataset.path] = v;
  });
  const r = await api(`/api/projects/${S.project}/headline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  $('provenance').textContent = r.provenance_summary;
  $('status').textContent = 'キー項目を反映しました。';
  toast('キー項目を反映しました。', 'ok');
  hist.log('🔢', 'キー項目を反映しました', 'overview', 'base');
}
// Core run flow, shared by the sidebar button and the Cody chat. Throws on
// failure (callers decide how to surface it); returns the run payload.
// Best-effort 中止: flag the in-flight run server-side. The /run POST then
// returns {cancelled:true} promptly (the engine aborts between sim-chunks).
function cancelRun(name) {
  return api(`/api/projects/${name}/run/cancel`, { method: 'POST' }).catch(() => {});
}

async function doRun() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いまシミュレーション中だよ。終わるまで少し待ってね。');
  S.running = true;
  // honest sim-clock progress overlay (倉庫の1日が進む + ETA). polls the server.
  const proj = S.project;
  const prog = startRunProgress({ getProject: () => proj, onCancel: () => cancelRun(proj) });
  try {
    const r = await api(`/api/projects/${S.project}/run`, { method: 'POST' });
    if (r && r.cancelled) { prog.stop('cancelled'); return r; }  // 中止: skip render
    S.hasRun = true;
    refreshReadiness();
    renderKpis(r.kpis);
    // 操作履歴: one row per completed run, carrying the one-line verdict.
    const k = r.kpis || {};
    const vd = k.verdict ? String(k.verdict) : '';
    hist.log(k.can_handle_demand === false ? '⚠️' : '✅',
      'シミュレーション完了'
      + (vd ? ' — ' + (vd.length > 64 ? vd.slice(0, 64) + '…' : vd) : ''),
      'analysis', 'run');
    await loadReplay();
    $('pngImg').src = `/api/projects/${S.project}/png?ts=${Date.now()}`;
    renderProposalStory();
    if (S.export) S.export.refresh();
    if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
    refreshScorecard();  // run done → the rail can now show 解析 vs DES deltas
    return r;
  } finally {
    S.running = false;
    prog.stop();
  }
}
async function runSim() {
  if (!S.project) return;
  setBtnBusy($('runBtn'), true, '実行中…');
  $('status').textContent = '重厚なシミュレーションを実行中…';
  cody('thinking', 'シミュレーション中…動きを最後まで追ってるよ。');
  try {
    const r = await doRun();
    if (r && r.cancelled) {
      $('status').textContent = '中止しました。';
      toast('シミュレーションを中止しました。', 'info');
      cody('neutral', '中止したよ。設定を変えて、いつでもまた実行できる。');
      return;
    }
    $('status').textContent = `完了（${r.run}）。`;
    cody('success', '完了！「分析」タブに指摘と次の一手をまとめたよ。');
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
    toast('シミュレーションに失敗しました: ' + e.message, 'error');
    cody('error', 'エラー: ' + e.message + ' — 落ち着いて直そう。');
  } finally {
    setBtnBusy($('runBtn'), false);
  }
}
async function loadReplay() {
  const rep = await api(`/api/projects/${S.project}/replay`);
  S.replay = rep;
  S.window = rep.meta.replay_window_s || rep.meta.duration_s || 1;
  S.t = 0;
  S.playing = true;
  S._needs2d = true;  // fresh replay → repaint even if it loads while paused
  $('playBtn').disabled = false; $('scrub').disabled = false;
  $('playBtn').textContent = '⏸';
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  if (S.view === 'view3d') mount3d();
}
// ⑤提案: retell the run as a one-page story on screen — ① 課題 verdict, the
// proposal sheet (② 設計 / ③ 検証 baked into the PNG), then ⑤ 裏付け provenance +
// next-step CTAs. Mirrors the PPTX/PDF narrative spine. Degrades safely when
// there's no run yet (verdict hidden; the PNG's alt copy shows).
function renderProposalStory() {
  const v = $('pstoryVerdict'), foot = $('pstoryFoot'), kp = $('pstoryKpis');
  if (!v || !foot) return;
  const k = S.kpis;
  if (k) {
    const ok = k.can_handle_demand;
    v.className = 'pstory-verdict ' + (ok ? 'ok' : 'bad');
    v.innerHTML = '<span class="pstory-kicker">① 課題</span>'
      + `<span class="pstory-headword">${ok ? '捌ける' : '捌けない'}</span>`
      + `<span class="pstory-line">${esc(k.verdict || '')}</span>`;
    v.hidden = false;
  } else {
    v.hidden = true;
  }
  // ③ 検証: the decision-grade headline KPIs, lifted onto the proposal page so it
  // reads as a self-contained story (the shared bottom kpiBar is hidden here).
  if (kp) {
    if (k) {
      const cur = k.currency || '¥';
      const chips = [
        ['スループット', `${k.throughput_per_hr.toFixed(0)} 件/時`, false],
        ['出荷完了', `${k.orders_completed.toFixed(0)} / ${k.orders_arrived.toFixed(0)} 件`,
          !k.can_handle_demand],
        ['ボトルネック', `${k.bottleneck_jp || ''} ${(k.bottleneck_utilization * 100).toFixed(0)}%`,
          k.bottleneck_utilization >= 0.95],
        ['処理時間 中央', `${(k.cycle_p50_s / 60).toFixed(0)} 分`, false],
      ];
      if (k.total_cost_per_order) chips.push(['1件コスト', `${cur}${k.total_cost_per_order.toFixed(1)}`, false]);
      kp.innerHTML = '<span class="pstory-kicker">③ 検証</span>'
        + chips.map(([lab, val, bad]) =>
          `<span class="pstory-chip${bad ? ' bad' : ''}">`
          + `<span class="pstory-chip-l">${esc(lab)}</span>`
          + `<span class="pstory-chip-v">${esc(val)}</span></span>`).join('');
      kp.hidden = false;
    } else {
      kp.hidden = true;
    }
  }
  const prov = ($('provenance') && $('provenance').textContent) || '';
  foot.innerHTML = `<span class="pstory-prov">⑤ 裏付け：${esc(prov)}</span>`
    + '<span class="pstory-cta">'
    + '<button type="button" class="pstory-btn" data-go="compare">④ 推奨：シナリオ比較 →</button>'
    + '<button type="button" class="pstory-btn primary" data-go="export">提案書を書き出す →</button>'
    + '</span>';
  foot.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => switchView(b.dataset.go); });
  foot.hidden = false;
}

function renderKpis(k) {
  S.kpis = k;  // remember the latest verdict so ⑤提案 can retell it
  const cls = k.can_handle_demand ? 'ok' : 'bad';
  const cards = [
    ['スループット', k.throughput_p5 != null
      ? `${k.throughput_per_hr.toFixed(0)} 件/時 (${k.throughput_p5.toFixed(0)}–${k.throughput_p95.toFixed(0)})`
      : `${k.throughput_per_hr.toFixed(0)} 件/時`],
    ['出荷完了', `${k.orders_completed.toFixed(0)} / ${k.orders_arrived.toFixed(0)}`],
    ['ボトルネック', `${k.bottleneck_jp || ''} ${(k.bottleneck_utilization*100).toFixed(0)}%`],
    ['ピッカー稼働率', `${k.n_pickers}名 ${(k.picker_utilization*100).toFixed(0)}%`],
    ['梱包台稼働率', `${k.n_packers}台 ${(k.packer_utilization*100).toFixed(0)}%`],
    ['処理時間 中央値/最悪', `${(k.cycle_p50_s/60).toFixed(0)}/${(k.cycle_p95_s/60).toFixed(0)} 分`],
    ['1件あたり歩行', `${k.walk_per_order_m.toFixed(0)} m`],
  ];
  const cur = k.currency || '¥';
  if (k.robustness != null && k.replications > 1)
    cards.push(['安定度', `${(k.robustness*100).toFixed(0)}% (${k.replications}回検証)`]);
  if (k.n_agvs) cards.push(['AGV稼働率', `${k.n_agvs}台 ${(k.agv_utilization*100).toFixed(0)}%`]);
  if (k.total_cost_per_order) cards.push(['1件あたりコスト', `${cur}${k.total_cost_per_order.toFixed(1)}`]);
  if (k.monthly_cost) cards.push(['月間コスト', `${cur}${Math.round(k.monthly_cost).toLocaleString()}`]);
  // HERO treatment: a prominent verdict banner (大きく 捌ける/捌けない + 一文)
  // followed by a responsive KPI grid (reuses the .kpi-hero cell styling).
  const headword = k.can_handle_demand ? '捌ける' : '捌けない';
  const verdictLine = esc(k.verdict || '');
  $('kpiBar').innerHTML =
    `<div class="kpi-verdict-hero ${cls}" role="status" aria-live="polite">` +
      `<div class="kvh-mark" aria-hidden="true"></div>` +
      `<div class="kvh-body">` +
        `<div class="kvh-headword">${headword}</div>` +
        (verdictLine ? `<div class="kvh-line">${verdictLine}</div>` : '') +
      `</div>` +
    `</div>` +
    `<div class="kpi-hero kpi-hero--run">` +
      cards.map(([kk, vv]) =>
        `<div class="kpi-hero-cell"><div class="kpi-label">${esc(kk)}</div>` +
        `<div class="kpi-value">${esc(vv)}</div></div>`).join('') +
    `</div>`;
}

// Core scenario-compare flow, shared by the button and the Cody chat.
async function doRunScenarios() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いま実行中だよ。終わるまで少し待ってね。');
  S.running = true;
  const proj = S.project;
  const prog = startRunProgress({ getProject: () => proj, onCancel: () => cancelRun(proj),
    title: '3シナリオを比較実行中…', sub: '現行・ピーク日・AGV導入をそれぞれDESで回します。' });
  try {
    const data = await api(`/api/projects/${S.project}/run-scenarios`, { method: 'POST' });
    if (data && data.cancelled) { prog.stop('cancelled'); return data; }
    if (S.compare) S.compare.dispose();
    $('compareView').innerHTML = '';  // clear any skeleton placeholder
    S.compare = new CompareView($('compareView'), data);
    return data;
  } finally {
    S.running = false;
    prog.stop();
  }
}
async function runScenarios() {
  if (!S.project) { toast('先にプロジェクトを作ってください。', 'error'); return; }
  setBtnBusy($('runScenariosBtn'), true, '比較中…');
  $('compareStatus').textContent = '3シナリオを重厚シミュレーション中…';
  if (S.compare && S.compare.dispose) S.compare.dispose();
  $('compareView').innerHTML = '<div class="skeleton-block" aria-hidden="true"></div>'
    + '<div class="skeleton-block" aria-hidden="true"></div>';
  try {
    const data = await doRunScenarios();
    if (data && data.cancelled) {
      $('compareStatus').textContent = '中止しました。';
      $('compareView').innerHTML = '';
      toast('シナリオ比較を中止しました。', 'info');
    } else {
      $('compareStatus').textContent = '完了。';
    }
  } catch (e) {
    $('compareStatus').textContent = 'エラー: ' + e.message;
    $('compareView').innerHTML = '';
    toast('シナリオ比較に失敗しました: ' + e.message, 'error');
  } finally {
    setBtnBusy($('runScenariosBtn'), false);
  }
}

function mount3d() {
  const el = $('view3d');
  if (!S.replay) return;
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  // Clear any leftover fallback message from a previous failed mount.
  const fb = el.querySelector('.view3d-fallback');
  if (fb) fb.remove();
  try {
    S.scene3d = new Scene3D(el, S.replay, () => S.t);
    if (S.preset && S.scene3d.setPreset) S.scene3d.setPreset(S.preset);
    // Spotlight the run's bottleneck zone in 3D (same constraint the 2D ⚠ and the
    // ⑤提案 ③検証 chip call out). Resolve the JP label → zone type via JP_TO_TYPE.
    const bk = S.kpis;
    if (bk && bk.bottleneck_jp && S.scene3d.setBottleneck) {
      S.scene3d.setBottleneck(JP_TO_TYPE[bk.bottleneck_jp] || null);
    }
    applyStaffing3d();   // overlay the timetable staffing if one has been computed
    S.scene3d.resize();
  } catch (e) {
    // WebGL may be unavailable (no GPU / context loss). Don't let the failure
    // escape the click handler; show a graceful fallback in the panel instead.
    S.scene3d = null;
    el.innerHTML = '<div class="view3d-fallback">3D表示を初期化できませんでした'
      + '（お使いの環境でWebGLが利用できない可能性があります）。'
      + '「2D アニメーション」タブでも動きを確認できます。</div>';
  }
}

function mountExport() {
  if (S.export) { S.export.refresh(); return; }
  S.export = new ExportView($('export'), {
    getProjectName: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
  });
  S.export.refresh();
}

function mountDataAnalysisView() {
  if (S.dataanalysis) return;
  S.dataanalysis = mountDataAnalysis($('dataanalysis'), {
    getProject: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
  });
}

function mountMaterialFlowView() {
  if (S.materialflow) { S.materialflow.refresh(); return; }
  S.materialflow = mountMaterialFlow($('materialflow'), {
    toast: (msg, kind) => toast(msg, kind),
    getProject: () => S.project,
  });
}

function mountNotesView() {
  if (!S.notes) {
    S.notes = mountNotes($('notes'), {
      getProject: () => S.project,
      toast: (msg, kind) => toast(msg, kind),
    });
  } else {
    S.notes.refresh();   // re-read the current project's board
  }
}

// ---- readiness / 動線 (Cody home status + soft-gated result tabs) -----------
// The product never blocks (every model is runnable from provisional values), so
// the result tier is *soft*-gated: tabs stay visible but carry a 「要実行」 badge
// and clicking one before a run nudges toward 実行 instead of showing emptiness.
function refreshReadiness() {
  // Single source of truth for progress / current location: the 5-phase stepper
  // (✓ done / 🔒 locked) + the per-phase hint banner. The old header status pill
  // duplicated this (project/data/run chips) and was removed.
  if (S.journey) S.journey.refresh();
  if (S.view) updatePhaseHint(S.view);
}

// ---- import ----------------------------------------------------------------
// The ①取込 upload handlers (uploadZip/Cad/Distances/Mapcsv/Rmpm/Table/Shipments
// + generateMissing) live in ./js/imports.js, wired to their shell deps via
// initImports() in main(). Their UI (drop zones / pickers / per-card status) is
// the ①取込 hub rendered by ./js/overview.js, which imports them directly.

// ---- theme (light/dark, manual toggle, persisted) -------------------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀ ライト' : '🌙 ダーク';
  // Let canvas/SVG views (2D replay, analysis charts) re-read colors.
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}
function initTheme() {
  // Dark-first per the brand handoff; the manual toggle still wins when set.
  const saved = localStorage.getItem('whsim-theme');
  applyTheme(saved || 'dark');
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('whsim-theme', next);
  applyTheme(next);
}

// ---- Cody mascot companion (help / suggestion / error reactions) -----------
function cody(mood, say) { if (S.cody) S.cody.setMood(mood, say ? { say } : {}); }

// ---- shared busy state (spinner on a button + disable controls) -------------
function setBtnBusy(btn, on, busyLabel) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${busyLabel || btn.dataset.label}`;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label != null) { btn.textContent = btn.dataset.label; }
  }
}

// ---- view switching (shared by the tab bar and the Cody chat) -------------
function switchView(view) {
  if (!view || !$(view)) return;
  S.view = view;
  document.querySelectorAll('.panel').forEach(x => {
    const on = x.id === view;
    x.classList.toggle('active', on);
    x.hidden = !on;
  });
  // Designer sets inline display on #design; override it so the panel hides.
  $('design').style.display = (view === 'design') ? 'flex' : 'none';
  // The replay transport only belongs to the 2D/3D animation views.
  const replayView = (view === 'view2d' || view === 'view3d');
  document.querySelector('.transport').style.display = replayView ? 'flex' : 'none';
  // The chat home, analysis dashboards and timetable carry their own summaries;
  // the designer needs the full canvas height, so the KPI bar hides there too.
  const kpiBar = $('kpiBar');
  kpiBar.style.display =
    (view === 'analysis' || view === 'dataanalysis' || view === 'materialflow'
      || view === 'notes' || view === 'chat' || view === 'timetable' || view === 'overview'
      || view === 'bi' || view === 'bianalytics' || view === 'design'
      || view === 'storage' || view === 'cost' || view === 'pickrate' || view === 'workcompare'
      || view === 'viewpng')  // ⑤提案 carries its own ③検証 strip (pstoryKpis)
      ? 'none' : '';
  // ④検証: in the 2D/3D replay views the verdict + KPIs read as the page HERO
  // (lifted above the replay canvas), not a footer strip. ⑤提案 renders its own
  // ③検証 strip (pstoryKpis); elsewhere the bar stays an inline summary.
  kpiBar.classList.toggle('is-hero', replayView);
  // The 3D表現 preset control only belongs to the 3D view (kept out of the
  // journey row otherwise, so it isn't persistent noise for the salesperson).
  const presetCtl = $('presetCtl');
  if (presetCtl) presetCtl.style.display = (view === 'view3d') ? 'inline-flex' : 'none';
  // Soft guidance: opening a run-gated result view (④検証 / ⑤提案) before any run
  // nudges toward 実行. Previously this keyed off a flat `.tab[data-need]` element
  // that no longer exists in the DOM (journey.js renders .jn-pill/.jn-sub), so the
  // nudge never fired — it is now driven by the view→phase map (VIEW_PHASE).
  const gatedPhase = VIEW_PHASE[view];
  if ((gatedPhase === 'validate' || gatedPhase === 'propose') && !S.hasRun) {
    cody('curious', S.project
      ? 'この結果はシミュレーション実行後に表示されるよ。③設計の「実行する」か、ヘッダ右上の「▶ 実行」を押してね。'
      : 'まずプロジェクトを作って実行しよう。結果はそのあとここに出るよ。');
  }
  // The chat view embeds Cody in the thread; hide the floating companion there
  // so it doesn't overlap the composer (it returns on every other view).
  if (S.cody) { if (view === 'chat') S.cody.hide(); else S.cody.show(); }
  if (view === 'design') mountDesigner();
  if (view === 'analysis') { mountAnalysis($('analysis'), S.project); if (S.project) cody('curious', '結果を読み解こう。気になる指摘があれば言って。'); }
  if (view === 'view3d') mount3d();
  if (view === 'view2d') { fitCanvas(); S._needs2d = true; } // repaint on entry (paused or empty)
  if (view === 'viewpng') renderProposalStory();
  if (view === 'export') mountExport();
  if (view === 'dataanalysis') mountDataAnalysisView();
  if (view === 'materialflow') mountMaterialFlowView();
  if (view === 'notes') mountNotesView();
  if (view === 'timetable') mountTimetableView();
  if (view === 'storage') mountStorageView();
  if (view === 'cost') mountCostView();
  if (view === 'pickrate') mountPickrateView();
  if (view === 'workcompare') mountWorkCompareView();
  if (view === 'overview') mountOverviewView();
  if (view === 'bi') mountBIView();
  if (view === 'bianalytics') mountBIAnalyticsView();
  if (view === 'chat' && S.chat) S.chat.focus();
  // Keep the 5-phase stepper highlight + the per-phase hint banner in sync with
  // whatever drove the view change (journey click, Cody, or programmatic).
  if (S.journey) S.journey.setActive(view);
  updatePhaseHint(view);
  // 採点表レール: tell the dock which view/phase we're on (it shows on ②③④, hides
  // on ①⑤, and auto-collapses to the strip in ③設計 so the designer keeps the
  // right side). setPhase refetches the scorecard when entering a rail phase.
  if (S.scorecard) {
    S.scorecard.setView(view);
    S.scorecard.setPhase(VIEW_PHASE[view] || null);
  }
}

// viewId → phase id (mirrors journey.js PHASES). Cross-cutting views map to null.
const VIEW_PHASE = {
  overview: 'intake',
  // ②分析 analysis home: 物量サマリ / 対話分析 / 基礎物量 (volume what-if).
  dataanalysis: 'analyze', bianalytics: 'analyze', bi: 'analyze', materialflow: 'analyze',
  design: 'design', storage: 'design', timetable: 'design',
  analysis: 'validate', view2d: 'validate', view3d: 'validate', workcompare: 'validate',
  cost: 'design', pickrate: 'design',
  viewpng: 'propose', compare: 'propose', export: 'propose',
};

// 採点表レール recompute: coalesce the trigger fan-in (openProject /
// model-changed / designer save / doRun / design-dirty / phase entry) into one
// debounced GET /scorecard so a burst of edits costs one analytic recompute.
let _scRefreshTimer = 0;
function refreshScorecard() {
  if (!S.scorecard) return;
  clearTimeout(_scRefreshTimer);
  _scRefreshTimer = setTimeout(() => { if (S.scorecard) S.scorecard.refresh(); }, 250);
}

// Show the phase-goal + next-step banner; for run-gated phases without a run
// (and analyze without data / intake without a project) surface the empty state.
function updatePhaseHint(view) {
  if (!S.phaseHint) return;
  const phase = VIEW_PHASE[view];
  if (!phase) { S.phaseHint.hide(); return; } // chat / notes are cross-cutting
  let empty = false;
  if (phase === 'validate' || phase === 'propose') empty = !S.hasRun;
  else if (phase === 'analyze') empty = !S.hasData;
  else if (phase === 'intake') empty = !S.project;
  S.phaseHint.show(phase, { empty, desc: viewDesc(view) });
}

function mountBIAnalyticsView() {
  if (!S.bianalytics) {
    S.bianalytics = mountBIAnalytics($('bianalytics'), {
      getProject: () => S.project,
      toast: (m, k) => toast(m, k),
      // Delegate a free-text question to Cody: jump to the chat view and ask.
      askCody: (q) => { switchView('chat'); if (S.chat && S.chat.ask) S.chat.ask(q); },
    });
  } else { S.bianalytics.refresh(); }
}

// Mount the 基礎物量 split view (ETL→material-flow); refresh on revisit.
function mountBIView() {
  if (!S.bi) {
    S.bi = mountBI($('bi'), {
      getProject: () => S.project,
      toast: (m, k) => toast(m, k),
    });
  } else {
    S.bi.refresh();
  }
}

// Mount the ①取込 overview home once; refresh it on every revisit.
function mountOverviewView() {
  if (!S.overview) {
    S.overview = mountOverview($('overviewDash'), {
      getState: () => S,
      getProject: () => api(`/api/projects/${S.project}/model`),
      switchTo: switchView,
      // "✨ サンプルでためす" on the empty ①取込: build a demo project so a
      // salesperson reaches a runnable model (and the 60-second proposal path)
      // without any data at hand.
      createSample: () => createSampleProject(),
      toast: (m, k) => toast(m, k),
    });
  } else {
    S.overview.refresh();
  }
}

// Build + open the bundled sample project (POST /api/projects/sample). Shared by
// the ①取込 empty-state CTA and the first-run onboarding card. Throws on failure
// so callers can surface it.
async function createSampleProject() {
  const res = await fetch('/api/projects/sample', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    let detail = `サンプルを用意できませんでした (${res.status})`;
    try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (_e) { /* ignore */ }
    throw new Error(detail);
  }
  const data = await res.json().catch(() => ({}));
  const name = (data && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : null;
  if (!name) throw new Error('サンプル名を取得できませんでした');
  await refreshProjects(name);
  await openProject(name);
  return name;
}

// ---- timetable (作業タイムチャート) — mounted once; holds editable state ------
// The staffing solve runs client-side, so it works without a project/run. Its
// live map draws the loaded project's real zones (棚配置) with per-time workers;
// the per-time headcount it emits also feeds the 2D view (時刻連動).
let _ttProj;
async function fetchLayoutFor(name) {
  if (!name) return null;
  try {
    const f = await api(`/api/projects/${name}/full`);
    return f && f.layout ? { bounds: f.layout.bounds, zones: f.layout.zones } : null;
  } catch (_e) { return null; }
}
function mountStorageView() {
  if (S.storage) { S.storage.refresh(); return; }
  S.storage = mountStorage($('storage'), {
    getProject: () => S.project,
    toast: (m, k) => toast(m, k),
  });
}

function mountCostView() {
  if (S.cost) { S.cost.refresh(); return; }
  S.cost = mountCost($('cost'), {
    getProject: () => S.project,
    // Mirror benchmark applications into the 操作履歴 at this seam (cost.js owns
    // the apply flow but reports success only through its injected toast).
    toast: (m, k) => {
      toast(m, k);
      if (k === 'ok' && typeof m === 'string' && m.includes('ベンチマーク')) {
        hist.log('📐', m, 'cost', 'bench');
      }
    },
  });
}

function mountPickrateView() {
  if (S.pickrate) { S.pickrate.refresh(); return; }
  S.pickrate = mountPickrate($('pickrate'), {
    getProject: () => S.project,
    toast: (m, k) => toast(m, k),
  });
}

function mountWorkCompareView() {
  if (S.workcompare) return;
  S.workcompare = mountWorkCompare($('workcompare'), {
    getProject: () => S.project,
    toast: (m, k) => toast(m, k),
  });
}

function mountTimetableView() {
  if (S.timetable) {
    S.timetable.resize();
    if (_ttProj !== S.project) {       // project switched since last visit → refresh map
      _ttProj = S.project;
      fetchLayoutFor(S.project).then((l) => { if (S.timetable) S.timetable.setLayout(l); });
    }
    return;
  }
  _ttProj = S.project;
  S.timetable = mountTimetable($('timetable'), {
    getProject: () => S.project,
    fetchLayout: () => fetchLayoutFor(S.project),
    onChange: (payload) => {
      S.timetableStaffing = payload;
      S._needs2d = true;  // staffing/cursor changed → one repaint even while paused
      if (S.view === 'view2d') draw2d();
      if (S.view === 'view3d' && S.scene3d) applyStaffing3d();
    },
  });
}

// Push the timetable's per-time, per-section headcount into the 3D scene as
// worker spheres placed in their zones (時刻連動). No-op without a staffing
// snapshot or a live scene.
function applyStaffing3d() {
  const p = S.timetableStaffing;
  if (!S.scene3d || !p || !S.scene3d.setStaffing) return;
  const count = S.scene3d.setStaffing({ by_section: p.by_section, zmap: p.section_zone_type, colors: p.colors });
  // Lightweight signal (count of worker spheres placed) for observers/tests.
  document.dispatchEvent(new CustomEvent('whsim:staffing3d', { detail: { count, minute: p.minute } }));
}

// ---- apply structured edits then re-run (closes the analysis loop) ---------
// Dispatched from analysis.js / chat.js via CustomEvent('whsim:apply-run').
async function applyAndRun(edits) {
  if (!S.project) { toast('先にプロジェクトを作ってください。', 'error'); return; }
  if (S.running) { toast('いま実行中です。完了までお待ちください。', 'info'); return; }
  if (!edits || typeof edits !== 'object' || !Object.keys(edits).length) return;
  $('status').textContent = '変更を適用して再実行中…';
  cody('thinking', '提案を反映して、もう一度シミュレーションするよ。');
  try {
    const a = await api(`/api/projects/${S.project}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits }),
    });
    if (a && a.provenance_summary) $('provenance').textContent = a.provenance_summary;
    if (a && Array.isArray(a.skipped) && a.skipped.length) {
      toast(`一部の変更は適用できませんでした（${a.skipped.length}件）。`, 'info');
    }
    S._designerProj = null;  // apply-run changed the model → invalidate Designer cache
    await openProjectQuiet();
    const r = await doRun();
    $('status').textContent = `再実行が完了しました（${r.run}）。`;
    toast('変更を適用して再実行しました。', 'ok');
    cody('success', '反映して再実行したよ。分析を見比べてみて。');
    switchView('analysis');
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
    toast('適用に失敗しました: ' + e.message, 'error');
    cody('error', 'うまく適用できなかった: ' + e.message);
  }
}
document.addEventListener('whsim:apply-run', (e) => {
  const edits = e && e.detail && e.detail.edits;
  // No edits (e.g. the designer's 「実行する →」 CTA dispatches an empty detail):
  // a plain run, identical to the header ▶ 実行 button.
  if (!edits || typeof edits !== 'object' || !Object.keys(edits).length) { runSim(); return; }
  applyAndRun(edits);
});

// Cross-view drill navigation: a module asks the shell to switch views
// (e.g. 対話分析 "基礎物量で見る →" / "人員設計へ →").
document.addEventListener('whsim:nav', (e) => {
  const view = e && e.detail && e.detail.view;
  if (typeof view === 'string' && view) switchView(view);
});

// Baton: ③設計「生産性試算」(解析) → ④検証「作業方法比較」(DES). Carry the
// analytic recommendation so the DES view highlights it + reconciles 解析↔DES.
document.addEventListener('whsim:workcompare-focus', (e) => {
  const pick = e && e.detail;
  switchView('workcompare');            // mounts the view if needed
  if (S.workcompare && S.workcompare.setAnalyticPick) S.workcompare.setAnalyticPick(pick);
});

// A module imported/changed the model on disk (e.g. the 物量サマリ ETL ingested a
// shipments CSV into orders). Re-open the project to refresh provenance / 実データ%
// / readiness, then optionally navigate (e.g. to 対話分析 to see real demand).
document.addEventListener('whsim:model-changed', async (e) => {
  if (!S.project) return;
  await openProject(S.project);
  const dest = e && e.detail && e.detail.nav;
  if (typeof dest === 'string' && dest) switchView(dest);
});

// Lightweight "the design changed under the cursor" signal (the designer may
// emit it on every edit). The 採点表レール re-scores analytically; it's debounced,
// so a burst of edits costs one recompute. Safe if never fired.
// Live re-score: the designer emits its UNSAVED edit sections on every edit, so
// the rail's dependent variables move WHILE dragging — no save round-trip. Falls
// back to the saved-model GET when no sections ride along.
let _scLiveTimer = 0;
document.addEventListener('whsim:design-dirty', (e) => {
  const sections = e && e.detail && e.detail.sections;
  if (!S.scorecard) return;
  clearTimeout(_scLiveTimer);
  _scLiveTimer = setTimeout(() => {
    if (!S.scorecard) return;
    if (sections) S.scorecard.refreshLive(sections);
    else S.scorecard.refresh();
  }, 250);
});

// 物量サマリタブ → タイムチャート: place the day from the measured volumes.
document.addEventListener('whsim:load-timetable', (e) => {
  const scenario = e && e.detail && e.detail.scenario;
  if (!scenario) { toast('先に物量を分析してください。', 'info'); return; }
  switchView('timetable');           // mounts the timetable if needed
  if (S.timetable && S.timetable.loadExternal) {
    S.timetable.loadExternal(scenario);
    toast('実データの物量でタイムチャートに人員配置しました。', 'ok');
  }
});

// Re-resolve the cached canvas palette when the theme flips. draw2d already runs
// in the RAF loop, so it just re-reads PALETTE on the next frame; force one draw
// for the static (paused / no-replay) case so the canvas repaints immediately.
document.addEventListener('themechange', () => {
  refreshPalette();
  S._needs2d = true;  // re-read PALETTE on the next frame even while paused
  if (S.view === 'view2d') draw2d();
});

// Modules (e.g. the timetable tab) request a toast via a CustomEvent so they
// stay decoupled from the shell's notification host.
document.addEventListener('whsim:toast', (e) => {
  const d = (e && e.detail) || {};
  if (d.msg) toast(d.msg, d.kind || 'info');
  // 生産性フィードバックの実測採用 (analysis.js) surfaces only through this toast
  // bus — mirror the adoption into the 操作履歴 at the shell seam we own.
  if (d.kind === 'ok' && typeof d.msg === 'string'
      && (d.msg.includes('実測値を原価に採用') || d.msg.includes('想定値に戻しました'))) {
    hist.log('📊', d.msg, 'analysis', 'prod');
  }
});

// ---- project management menu (duplicate / rename / delete) -----------------
// The menu open/close/keyboard handling (closeProjMenu/openProjMenu/onDocClick/
// onProjMenuKey) and the three project actions (projDuplicate/projRename/
// projDelete) moved verbatim to ./js/projectmenu.js; they are imported above and
// wired to their shell deps via initProjectMenu() in main(). The #projMenuBtn /
// menuitem click wiring stays in initUI() (unchanged).

// Reset everything tied to a now-gone project.
function clearProjectState() {
  S.project = null;
  S.replay = null;
  S.hasRun = false;
  S.hasData = false;
  _lastOpened = null;
  hist.setProject(null);
  refreshReadiness();
  if (S.settings && S.settings.clear) S.settings.clear();
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  $('projectSelect').value = '';
  $('runBtn').disabled = true;
  $('playBtn').disabled = true; $('scrub').disabled = true;
  $('headline').innerHTML = '';
  $('kpiBar').innerHTML = '';
  $('importLog').innerHTML = '';
  $('pngImg').removeAttribute('src');
  $('provenance').textContent = '— your data';
  $('status').textContent = 'プロジェクトを選択するか、新規に作成してください。';
  updateProjMenuState();
  if (S.chat && S.chat.loadFor) S.chat.loadFor(null);
  if (S.view === 'analysis') mountAnalysis($('analysis'), null);
  if (S.view === 'overview') mountOverviewView();  // back to the empty ①取込 state
}

// ---- actions the Cody chat invokes to drive whsim --------------------------
const chatActions = {
  listTemplates: () => api('/api/templates'),
  createProject: (name, template) => doCreate(name, template || $('templateSelect').value || 'ecommerce_small'),
  runSim: async () => { const r = await doRun(); return r.kpis; },
  openView: (view) => switchView(view),
  runScenarios: () => doRunScenarios(),
  getAnalysis: () => (S.project ? api(`/api/projects/${S.project}/analysis`) : Promise.resolve(null)),
};

// ---- collapsible sidebar (hamburger; persisted) ----------------------------
function initSidebar() {
  const layout = document.querySelector('.layout');
  const saved = localStorage.getItem('whsim-sidebar');
  const collapsed = saved ? saved === 'collapsed' : window.innerWidth <= 880;
  layout.classList.toggle('sidebar-collapsed', collapsed);
  $('sidebarToggle').onclick = () => {
    const isCol = layout.classList.toggle('sidebar-collapsed');
    localStorage.setItem('whsim-sidebar', isCol ? 'collapsed' : 'open');
    // Re-fit canvas/3D/designer once the grid transition settles.
    setTimeout(() => {
      fitCanvas();
      if (S.scene3d) S.scene3d.resize();
      if (S.designer) S.designer.resize();
    }, 280);
  };
}

// ---- wire up ---------------------------------------------------------------
function initUI() {
  $('createBtn').onclick = async () => {
    const name = $('newName').value.trim();
    if (!name) {
      $('status').textContent = 'プロジェクト名を入力してください。';
      toast('プロジェクト名を入力してください。', 'info');
      $('newName').focus();
      return;
    }
    setBtnBusy($('createBtn'), true, '作成中…');
    try {
      await doCreate(name, $('templateSelect').value);
      $('newName').value = '';
      toast(`「${name}」を作成しました。`, 'ok');
      cody('excited', `「${name}」を用意したよ。まずは設計を触ってみよう。`);
    } catch (e) {
      $('status').textContent = '作成に失敗: ' + e.message;
      toast('作成に失敗しました: ' + e.message, 'error');
      cody('error', '作成でつまずいた: ' + e.message + ' — 直せるよ。');
    } finally {
      setBtnBusy($('createBtn'), false);
    }
  };
  $('projectSelect').onchange = (e) => { if (e.target.value) openProject(e.target.value); };
  $('applyBtn').onclick = async () => {
    try { await applyHeadline(); }
    catch (e) {
      $('status').textContent = 'エラー: ' + e.message;
      toast('反映に失敗しました: ' + e.message, 'error');
    }
  };
  $('runBtn').onclick = runSim;
  $('runScenariosBtn').onclick = runScenarios;

  // 5-phase guided journey (replaces the flat tab bar). The stepper owns view
  // selection; switchView keeps it (and the phase-hint banner) in sync.
  S.journey = mountJourney($('journey'), {
    getState: () => S,
    onSelectView: (v) => switchView(v),
    // Clicking a run-gated phase before any run: a toast explains the gate.
    // (switchView already surfaces the matching Cody nudge for the opened view,
    // so we don't double up on the companion here.)
    onLockedAttempt: () => {
      toast('この段階はシミュレーション実行後に確認できます。', 'info');
    },
  });
  S.phaseHint = mountPhaseHint($('phaseHint'), {
    onCta: (target) => switchView(target),
    onRun: () => runSim(),
  });
  // Sync the initial highlight with the default landing view (Cody home).
  S.journey.setActive(S.view);
  updatePhaseHint(S.view);

  // 採点表レール: the persistent right dock that scores the design analytically on
  // ②③④. It reserves its own footprint on `.main` (no overlap with the designer),
  // and its footer ▶ runs the same DES path as the header button.
  S.scorecard = mountScorecard({
    getProject: () => S.project,
    onRun: () => runSim(),
    onNav: (v) => switchView(v),
    // When the reserved width changes (toggle/resize), refit the active canvas/
    // designer so they reflow into the new work area on the next frame.
    onReserve: () => requestAnimationFrame(() => {
      fitCanvas();
      if (S.designer) S.designer.resize();
      if (S.scene3d) S.scene3d.resize();
    }),
  });
  // Reflect the initial view/phase so the dock shows/hides correctly on load.
  S.scorecard.setView(S.view);
  S.scorecard.setPhase(VIEW_PHASE[S.view] || null);

  // project management menu
  $('projMenuBtn').onclick = (e) => {
    e.stopPropagation();
    if ($('projMenu').hidden) openProjMenu(); else closeProjMenu();
  };
  $('projMenu').querySelectorAll('[role="menuitem"]').forEach((mi) => {
    mi.onclick = () => {
      const act = mi.dataset.act;
      closeProjMenu();
      if (act === 'save-sample') projSaveSample();
      else if (act === 'duplicate') projDuplicate();
      else if (act === 'rename') projRename();
      else if (act === 'delete') projDelete();
    };
  });

  $('themeToggle').onclick = toggleTheme;

  $('presetSelect').onchange = (e) => {
    S.preset = e.target.value;
    if (S.scene3d) S.scene3d.setPreset(S.preset);
  };

  // transport
  $('playBtn').onclick = () => {
    S.playing = !S.playing;
    $('playBtn').textContent = S.playing ? '⏸' : '▶';
  };
  $('scrub').oninput = (e) => {
    if (!S.replay) return;
    S.playing = false; $('playBtn').textContent = '▶';  // don't fight the user
    S.t = (parseFloat(e.target.value) / 1000) * S.window;
    $('clock').textContent = (S.t / 60).toFixed(1) + ' 分';
    S._needs2d = true;  // scrubbed while paused → one repaint at the new playhead
  };
  $('speed').onchange = (e) => { S.speed = parseFloat(e.target.value); };

  // Import drop zones / file pickers are owned by the ①取込 hub (overview.js),
  // which wires the persistent hidden inputs in #ihubAssets directly.

  // Coalesce resize bursts (window drag / orientation) into one rAF-aligned
  // pass so we don't thrash canvas + WebGL + designer layout 20×/sec.
  let _resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (_resizeRaf) return;
    _resizeRaf = requestAnimationFrame(() => {
      _resizeRaf = 0;
      fitCanvas();
      if (S.scene3d) S.scene3d.resize();
      if (S.designer) S.designer.resize();
    });
  });
  $('playBtn').disabled = true; $('scrub').disabled = true; // until a run exists
  // Default view is the ①取込 hub, which uses neither the replay transport nor
  // the KPI footer.
  document.querySelector('.transport').style.display = 'none';
  $('kpiBar').style.display = 'none';
  refreshReadiness();
  fitCanvas();
}

(async function main() {
  // Inject the shell helpers the extracted modules call back into. These are
  // hoisted function declarations, so wiring them up here (before any user
  // interaction can fire the import / project-menu handlers) is safe.
  initImports({ toast, openProject, mountDesigner, nudgeToDesign, setBtnBusy, cody });
  initProjectMenu({ toast, refreshProjects, openProject, clearProjectState });
  initMySamples({ openProject, refreshProjects, toast });
  refreshMySamples();
  initTheme();
  refreshPalette();
  initUI();
  initSidebar();
  // Sidebar 操作履歴 card: per-project activity feed (localStorage-backed).
  S.history = mountHistory($('historyList'), { switchTo: (v) => switchView(v) });
  S.cody = mountCody(document.body, { mood: 'idle' });
  // Default view is the chat home, which embeds Cody in the thread — keep the
  // floating companion hidden there (switchView toggles it on other views).
  if (S.view === 'chat') S.cody.hide();
  // Chat home: the conversation owns the greeting, so the floating mascot
  // stays quiet until it reacts to an action.
  S.chat = mountChat($('chat'), {
    getProject: () => S.project,
    avatarSVG: codyAvatarSVG,
    onMood: (mood, say) => cody(mood, say),
    actions: chatActions,
  });
  S.settings = mountSettings({
    getProject: () => S.project,
    toast: (msg, kind) => toast(msg, kind),
    hasRun: () => S.hasRun,
    onRerun: () => runSim(),
  });
  S.onboarding = mountOnboarding({
    toast: (msg, kind) => toast(msg, kind),
    openProject: async (name) => { await refreshProjects(name); await openProject(name); },
    refreshProjects: () => refreshProjects(),
    hasProjects: async () => {
      const sel = $('projectSelect');
      // Options beyond the leading "（新規作成）" placeholder mean projects exist.
      return !!(sel && sel.options && sel.options.length > 1);
    },
  });
  await loadTemplates();
  await refreshProjects();
  // First-run: show the sample CTA if there are no projects yet.
  if (S.onboarding) {
    S.onboarding.maybeShowFirstRunCTA();
    // Subtle first-visit guide (shown once; localStorage 'whsim-onboarded').
    setTimeout(() => { try { S.onboarding.startGuide(false); } catch (_e) { /* ignore */ } }, 600);
  }
  // Land on ①取込 (overview): mounts the panel, lights the stepper's ① pill, and
  // shows the phase-goal banner — so the entry point and current location are
  // always explicit (the app no longer opens onto the cross-cutting OCTA chat).
  switchView(S.view);
  requestAnimationFrame(loop);
  // Dismiss the boot splash once the shell is mounted and interactive.
  const boot = $('boot');
  if (boot) {
    setTimeout(() => boot.classList.add('gone'), 400);
    setTimeout(() => boot.remove(), 1100);
  }
})();
