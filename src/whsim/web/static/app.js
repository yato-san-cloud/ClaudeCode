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
import { mountTimetable } from './js/timetable.js';

const EQUIP_JP = { agv: 'AGV', forklift: 'フォークリフト', asrs: '自動倉庫',
                   robot_arm: 'ロボットアーム', crane: 'クレーン' };
const DOOR_COLOR = { dock: '#1f78b4', personnel: '#33a02c', shutter: '#8d99ae' };

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

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

const STATE_COLOR = { idle: '#9e9e9e', travel: '#1f78b4', carry: '#6a3d9a',
                      pick: '#33a02c', pack: '#e31a1c' };
const ABC_COLOR = { A: '#d7301f', B: '#fc8d59', C: '#fdcc8a' };

// ---- theme-aware canvas palette --------------------------------------------
// Resolved from CSS custom properties at draw time (cached, refreshed on the
// `themechange` event). Fallbacks equal the previous hardcoded values so LIGHT
// mode is pixel-identical; the dark variants live in styles.css.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
let PALETTE = null;
function refreshPalette() {
  PALETTE = {
    shell:        cssVar('--canvas-shell', '#333'),
    zoneInk:      cssVar('--canvas-zone-ink', '#8a93a0'),
    inkFaint:     cssVar('--canvas-ink-faint', '#9aa4b0'),
    wall:         cssVar('--canvas-wall-rep', '#6b7785'),
    equip:        cssVar('--canvas-equip', '#444'),
    equipInk:     cssVar('--canvas-equip-ink', '#555'),
    markerStroke: cssVar('--canvas-marker-stroke', '#fff'),
    agentStroke:  cssVar('--canvas-agent-stroke', '#000'),
    conveyor:     cssVar('--canvas-conveyor-rep', '#8d99ae'),
  };
  return PALETTE;
}
const ZONE_JP = { receiving: '入荷', storage: '保管', picking: 'ピッキング',
                  packing: '梱包', shipping: '出荷', staging: '一時保管' };

const S = {
  project: null, replay: null, scene3d: null, designer: null, compare: null,
  export: null, cody: null, chat: null, settings: null, onboarding: null, timetable: null,
  hasRun: false, preset: 'natural',
  t: 0, window: 1, playing: true, speed: 60, view: 'chat',
};
const AGV_COLOR = { idle: '#9e9e9e', travel: '#1f78b4', pickup: '#33a02c',
                    dropoff: '#f57f17', charge: '#8e24aa' };

// ---- keyframe interpolation (must match the 3D view) -----------------------
function interp(keyframes, t) {
  if (!keyframes || !keyframes.length) return [0, 0, 'idle'];
  if (t <= keyframes[0][0]) return [keyframes[0][1], keyframes[0][2], 'idle'];
  const last = keyframes[keyframes.length - 1];
  if (t >= last[0]) return [last[1], last[2], last[3]];
  let lo = 0, hi = keyframes.length - 1;
  while (lo + 1 < hi) { const m = (lo + hi) >> 1; (keyframes[m][0] <= t ? lo = m : hi = m); }
  const k0 = keyframes[lo], k1 = keyframes[lo + 1];
  const f = Math.min(Math.max((t - k0[0]) / Math.max(k1[0] - k0[0], 1e-9), 0), 1);
  return [k0[1] + (k1[1] - k0[1]) * f, k0[2] + (k1[2] - k0[2]) * f, k0[3]];
}

// ---- 2D canvas -------------------------------------------------------------
const canvas = $('canvas2d');
const ctx = canvas.getContext('2d');
function fitCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function draw2d() {
  const rep = S.replay;
  const P = PALETTE || refreshPalette();
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!rep) {
    ctx.fillStyle = P.inkFaint; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('プロジェクトを作成して「実行」すると、ここに動きが表示されます', w / 2, h / 2);
    return;
  }
  const b = rep.meta.bounds, pad = 16;
  const sc = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth);
  const ox = (w - b.width * sc) / 2, oy = (h - b.depth * sc) / 2;
  const X = (x) => ox + x * sc, Y = (y) => h - oy - y * sc; // flip y

  ctx.strokeStyle = P.shell; ctx.lineWidth = 1.5;
  ctx.strokeRect(X(0), Y(b.depth), b.width * sc, b.depth * sc);
  for (const z of rep.zones) {
    ctx.fillStyle = hexA(z.color || '#eeeeee', 0.32);
    ctx.fillRect(X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc);
    ctx.fillStyle = P.zoneInk; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(ZONE_JP[z.type] || z.type, X(z.x + z.w / 2), Y(z.y + z.h / 2));
  }
  for (const r of rep.racks) {
    ctx.fillStyle = ABC_COLOR[r.abc] || '#ccc';
    ctx.fillRect(X(r.x) - 2, Y(r.y) - 2, 4, 4);
  }
  for (const s of rep.stations) {
    ctx.fillStyle = '#08519c'; ctx.beginPath();
    ctx.arc(X(s.x), Y(s.y), 7, 0, 7); ctx.fill();
  }
  // building shell: walls + doors (躯体)
  for (const wl of (rep.walls || [])) {
    if (!wl.points || wl.points.length < 2) continue;
    ctx.strokeStyle = P.wall; ctx.lineWidth = Math.max(2, (wl.thickness || 0.2) * sc);
    ctx.lineCap = 'round'; ctx.beginPath();
    wl.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.lineWidth = 1;
  }
  for (const dr of (rep.doors || [])) {
    ctx.fillStyle = DOOR_COLOR[dr.type] || '#1f78b4';
    ctx.fillRect(X(dr.x) - (dr.w * sc) / 2, Y(dr.y) - 3, dr.w * sc, 6);
  }
  // placed equipment (static markers, labelled)
  for (const eq of (rep.equipment || [])) {
    ctx.fillStyle = P.equip; ctx.strokeStyle = P.markerStroke; ctx.lineWidth = 1;
    ctx.fillRect(X(eq.x) - 7, Y(eq.y) - 7, 14, 14);
    ctx.strokeRect(X(eq.x) - 7, Y(eq.y) - 7, 14, 14);
    ctx.fillStyle = P.equipInk; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(EQUIP_JP[eq.type] || eq.type, X(eq.x), Y(eq.y) - 10);
  }
  // conveyors (static)
  for (const cv of (rep.conveyors || [])) {
    if (!cv.points || cv.points.length < 2) continue;
    ctx.strokeStyle = P.conveyor; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath();
    cv.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.lineWidth = 1;
  }
  // manual flow-line routes (動線)
  for (const rt of (rep.routes || [])) {
    if (!rt.points || rt.points.length < 2) continue;
    ctx.strokeStyle = rt.mover === 'forklift' ? '#f57f17' : '#00b8d4';
    ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath();
    rt.points.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  }
  // forklifts (moving, orange diamond-ish squares)
  for (const fk of (rep.forklifts || [])) {
    const [x, y, st] = interp(fk.keyframes, S.t);
    ctx.fillStyle = st === 'putaway' ? '#e65100' : '#ffb74d';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    ctx.fillRect(X(x) - 7, Y(y) - 5, 14, 10);
    ctx.strokeRect(X(x) - 7, Y(y) - 5, 14, 10);
  }
  // AGVs (moving squares, distinct from round workers)
  for (const ag of (rep.agvs || [])) {
    const [x, y, st] = interp(ag.keyframes, S.t);
    ctx.fillStyle = AGV_COLOR[st] || '#1f78b4';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    ctx.fillRect(X(x) - 6, Y(y) - 5, 12, 10);
    ctx.strokeRect(X(x) - 6, Y(y) - 5, 12, 10);
  }
  // workers (round)
  for (const wk of rep.workers) {
    const [x, y, st] = interp(wk.keyframes, S.t);
    ctx.fillStyle = STATE_COLOR[st] || '#999';
    ctx.strokeStyle = P.agentStroke; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.arc(X(x), Y(y), 6, 0, 7); ctx.fill(); ctx.stroke();
  }
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- shared clock / render loop -------------------------------------------
let lastTs = performance.now();
function loop(ts) {
  const dt = (ts - lastTs) / 1000; lastTs = ts;
  if (S.playing && S.replay) {
    S.t += dt * S.speed;
    if (S.t > S.window) S.t = 0;
    $('scrub').value = String(Math.round((S.t / S.window) * 1000));
    $('clock').textContent = (S.t / 60).toFixed(1) + ' 分';
  }
  if (S.view === 'view2d') draw2d();
  requestAnimationFrame(loop);
}

// ---- data flow -------------------------------------------------------------
async function loadTemplates() {
  const ts = await api('/api/templates');
  $('templateSelect').innerHTML = ts.map(t =>
    `<option value="${t.template_id}">${t.name || t.template_id}</option>`).join('');
}
async function refreshProjects(select) {
  const ps = await api('/api/projects');
  const sel = $('projectSelect');
  sel.innerHTML = '<option value="">（新規作成）</option>';
  ps.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    sel.appendChild(opt);
  });
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
  await refreshProjects(name);
  await openProject(name);
}
async function openProject(name) {
  S.project = name;
  const m = await api(`/api/projects/${name}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
  $('provenance').textContent = m.provenance_summary;
  $('runBtn').disabled = false;
  $('status').textContent = `プロジェクト「${name}」を開きました。設計を調整して実行できます。`;
  updateProjMenuState();
  // Reset replay/analysis state and restore this project's chat thread.
  S.replay = null;
  S.hasRun = false;
  if (S.chat && S.chat.loadFor) S.chat.loadFor(name);
  if (S.settings && S.settings.loadFor) S.settings.loadFor(name);
  if (S.view === 'design') mountDesigner();
  if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
}

async function mountDesigner() {
  if (!S.project) return;
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
      await openProjectQuiet();  // refresh headline values after re-materialise
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
}
// Core run flow, shared by the sidebar button and the Cody chat. Throws on
// failure (callers decide how to surface it); returns the run payload.
async function doRun() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いまシミュレーション中だよ。終わるまで少し待ってね。');
  S.running = true;
  try {
    const r = await api(`/api/projects/${S.project}/run`, { method: 'POST' });
    S.hasRun = true;
    renderKpis(r.kpis);
    await loadReplay();
    $('pngImg').src = `/api/projects/${S.project}/png?ts=${Date.now()}`;
    if (S.export) S.export.refresh();
    if (S.view === 'analysis') mountAnalysis($('analysis'), S.project);
    return r;
  } finally {
    S.running = false;
  }
}
async function runSim() {
  if (!S.project) return;
  setBtnBusy($('runBtn'), true, '実行中…');
  $('status').textContent = '重厚なシミュレーションを実行中…';
  cody('thinking', 'シミュレーション中…動きを最後まで追ってるよ。');
  try {
    const r = await doRun();
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
  $('playBtn').disabled = false; $('scrub').disabled = false;
  $('playBtn').textContent = '⏸';
  if (S.scene3d) { S.scene3d.dispose(); S.scene3d = null; }
  if (S.view === 'view3d') mount3d();
}
function renderKpis(k) {
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
  $('kpiBar').innerHTML = `<div class="verdict ${cls}">${k.verdict}</div>` +
    cards.map(([kk, vv]) => `<div class="kpi"><div class="k">${kk}</div><div class="v">${vv}</div></div>`).join('');
}

// Core scenario-compare flow, shared by the button and the Cody chat.
async function doRunScenarios() {
  if (!S.project) throw new Error('先にプロジェクトを作ってね。');
  if (S.running) throw new Error('いま実行中だよ。終わるまで少し待ってね。');
  S.running = true;
  try {
    const data = await api(`/api/projects/${S.project}/run-scenarios`, { method: 'POST' });
    if (S.compare) S.compare.dispose();
    $('compareView').innerHTML = '';  // clear any skeleton placeholder
    S.compare = new CompareView($('compareView'), data);
    return data;
  } finally {
    S.running = false;
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
    await doRunScenarios();
    $('compareStatus').textContent = '完了。';
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

// ---- import ----------------------------------------------------------------
async function uploadZip(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '取り込み中…';
  try {
    const r = await api(`/api/projects/${S.project}/import`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">取り込み: ${r.updated.join(', ') || 'なし'}</span>`];
    for (const w of r.warnings) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    $('provenance').textContent = r.provenance_summary;
    await openProject(S.project); // refresh headline values
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

async function uploadDistances(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = '棚間距離を取込中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-distances`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">棚間距離: ${r.count}件取込（実測距離で動線を補正）</span>`];
    for (const w of (r.warnings || []).slice(0, 5)) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

async function uploadCad(file) {
  if (!S.project) { $('importLog').textContent = '先にプロジェクトを作成してください。'; return; }
  const fd = new FormData(); fd.append('file', file);
  $('importLog').textContent = 'CAD図面を解析中…';
  try {
    const r = await api(`/api/projects/${S.project}/import-cad`, { method: 'POST', body: fd });
    const lines = [`<span class="ok">図面取込: 壁${r.walls}本 / ゾーン${r.zones}個 / ` +
      `外形 ${r.bounds ? r.bounds.width.toFixed(0) + '×' + r.bounds.depth.toFixed(0) + 'm' : '—'}</span>`];
    for (const w of (r.warnings || [])) lines.push(`<span class="warn">! ${w}</span>`);
    $('importLog').innerHTML = lines.join('\n');
    if (S.view === 'design') mountDesigner();
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; toast('取り込みに失敗しました: ' + e.message, 'error'); }
}

// ---- theme (light/dark, manual toggle, persisted) -------------------------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀ ライト' : '🌙 ダーク';
  // Let canvas/SVG views (2D replay, analysis charts) re-read colors.
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}
function initTheme() {
  const saved = localStorage.getItem('whsim-theme');
  applyTheme(saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
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
  document.querySelectorAll('.tab').forEach(x => {
    const on = x.dataset.tab === view;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
    x.tabIndex = on ? 0 : -1;
  });
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
  // The chat home, analysis dashboard and timetable carry their own summaries.
  $('kpiBar').style.display = (view === 'analysis' || view === 'chat' || view === 'timetable') ? 'none' : '';
  // The chat view embeds Cody in the thread; hide the floating companion there
  // so it doesn't overlap the composer (it returns on every other view).
  if (S.cody) { if (view === 'chat') S.cody.hide(); else S.cody.show(); }
  if (view === 'design') mountDesigner();
  if (view === 'analysis') { mountAnalysis($('analysis'), S.project); if (S.project) cody('curious', '結果を読み解こう。気になる指摘があれば言って。'); }
  if (view === 'view3d') mount3d();
  if (view === 'view2d') fitCanvas();
  if (view === 'export') mountExport();
  if (view === 'timetable') mountTimetableView();
  if (view === 'chat' && S.chat) S.chat.focus();
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
    onChange: (payload) => { S.timetableStaffing = payload; if (S.view === 'view2d') draw2d(); },
  });
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
  applyAndRun(edits);
});

// Re-resolve the cached canvas palette when the theme flips. draw2d already runs
// in the RAF loop, so it just re-reads PALETTE on the next frame; force one draw
// for the static (paused / no-replay) case so the canvas repaints immediately.
document.addEventListener('themechange', () => {
  refreshPalette();
  if (S.view === 'view2d') draw2d();
});

// Modules (e.g. the timetable tab) request a toast via a CustomEvent so they
// stay decoupled from the shell's notification host.
document.addEventListener('whsim:toast', (e) => {
  const d = (e && e.detail) || {};
  if (d.msg) toast(d.msg, d.kind || 'info');
});

// ---- project management menu (duplicate / rename / delete) -----------------
function closeProjMenu() {
  const menu = $('projMenu'), btn = $('projMenuBtn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickProjMenu, true);
  document.removeEventListener('keydown', onProjMenuKey, true);
}
function openProjMenu() {
  const menu = $('projMenu'), btn = $('projMenuBtn');
  if (!menu || !S.project) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('[role="menuitem"]');
  if (first) first.focus();
  document.addEventListener('click', onDocClickProjMenu, true);
  document.addEventListener('keydown', onProjMenuKey, true);
}
function onDocClickProjMenu(e) {
  if (!$('projMenu').contains(e.target) && e.target !== $('projMenuBtn')) closeProjMenu();
}
function onProjMenuKey(e) {
  const menu = $('projMenu');
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  const idx = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeProjMenu(); $('projMenuBtn').focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
  else if (e.key === 'Tab') { closeProjMenu(); }
}
async function projDuplicate() {
  const from = S.project;
  if (!from) return;
  const to = (prompt(`「${from}」を複製します。新しい名前を入力してください。`, from + '-copy') || '').trim();
  if (!to) return;
  try {
    const r = await api(`/api/projects/${from}/duplicate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    await refreshProjects(r.name || to);
    await openProject(r.name || to);
    toast(`「${from}」を複製しました。`, 'ok');
  } catch (e) { toast('複製に失敗しました: ' + e.message, 'error'); }
}
async function projRename() {
  const from = S.project;
  if (!from) return;
  const to = (prompt(`「${from}」の新しい名前を入力してください。`, from) || '').trim();
  if (!to || to === from) return;
  try {
    const r = await api(`/api/projects/${from}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (S.chat && S.chat.renameBucket) S.chat.renameBucket(from, r.name || to);
    await refreshProjects(r.name || to);
    await openProject(r.name || to);
    toast(`「${to}」に名前を変更しました。`, 'ok');
  } catch (e) { toast('名前変更に失敗しました: ' + e.message, 'error'); }
}
async function projDelete() {
  const name = S.project;
  if (!name) return;
  if (!confirm(`プロジェクト「${name}」を削除します。元に戻せません。よろしいですか？`)) return;
  try {
    await api(`/api/projects/${name}`, { method: 'DELETE' });
    if (S.chat && S.chat.clearBucket) S.chat.clearBucket(name);
    clearProjectState();
    await refreshProjects('');
    toast(`「${name}」を削除しました。`, 'ok');
  } catch (e) { toast('削除に失敗しました: ' + e.message, 'error'); }
}
// Reset everything tied to a now-gone project.
function clearProjectState() {
  S.project = null;
  S.replay = null;
  S.hasRun = false;
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

  // tabs: click + roving-tabindex keyboard navigation (WAI-ARIA tablist)
  const tabs = Array.from(document.querySelectorAll('.tab'));
  tabs.forEach((t) => {
    t.onclick = () => switchView(t.dataset.tab);
    t.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(t);
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j >= 0) { e.preventDefault(); switchView(tabs[j].dataset.tab); tabs[j].focus(); }
    });
  });

  // project management menu
  $('projMenuBtn').onclick = (e) => {
    e.stopPropagation();
    if ($('projMenu').hidden) openProjMenu(); else closeProjMenu();
  };
  $('projMenu').querySelectorAll('[role="menuitem"]').forEach((mi) => {
    mi.onclick = () => {
      const act = mi.dataset.act;
      closeProjMenu();
      if (act === 'duplicate') projDuplicate();
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
  };
  $('speed').onchange = (e) => { S.speed = parseFloat(e.target.value); };

  // dropzone
  const dz = $('dropzone'), fi = $('fileInput');
  dz.onclick = () => fi.click();
  fi.onchange = () => fi.files[0] && uploadZip(fi.files[0]);
  $('cadBtn').onclick = () => $('cadInput').click();
  $('cadInput').onchange = () => $('cadInput').files[0] && uploadCad($('cadInput').files[0]);
  $('distBtn').onclick = () => $('distInput').click();
  $('distInput').onchange = () => $('distInput').files[0] && uploadDistances($('distInput').files[0]);
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      $('importLog').textContent = 'ZIP ファイルをドロップしてください。';
      return;
    }
    uploadZip(f);
  });

  window.addEventListener('resize', () => {
    fitCanvas();
    if (S.scene3d) S.scene3d.resize();
    if (S.designer) S.designer.resize();
  });
  $('playBtn').disabled = true; $('scrub').disabled = true; // until a run exists
  // Default view is the Cody chat home: no replay transport, no KPI footer.
  document.querySelector('.transport').style.display = 'none';
  $('kpiBar').style.display = 'none';
  fitCanvas();
}

(async function main() {
  initTheme();
  refreshPalette();
  initUI();
  initSidebar();
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
  S.chat.focus();
  requestAnimationFrame(loop);
})();
