// whsim frontend: design -> import -> confirm headline -> run -> animated replay.
import { Scene3D } from './js/view3d.js';
import { Designer } from './js/designer.js';

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

const STATE_COLOR = { idle: '#9e9e9e', travel: '#1f78b4', carry: '#6a3d9a',
                      pick: '#33a02c', pack: '#e31a1c' };
const ABC_COLOR = { A: '#d7301f', B: '#fc8d59', C: '#fdcc8a' };
const ZONE_JP = { receiving: '入荷', storage: '保管', picking: 'ピッキング',
                  packing: '梱包', shipping: '出荷', staging: '一時保管' };

const S = {
  project: null, replay: null, scene3d: null, designer: null,
  t: 0, window: 1, playing: true, speed: 60, view: 'design',
};

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
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!rep) {
    ctx.fillStyle = '#9aa4b0'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('プロジェクトを作成して「実行」すると、ここに動きが表示されます', w / 2, h / 2);
    return;
  }
  const b = rep.meta.bounds, pad = 16;
  const sc = Math.min((w - 2 * pad) / b.width, (h - 2 * pad) / b.depth);
  const ox = (w - b.width * sc) / 2, oy = (h - b.depth * sc) / 2;
  const X = (x) => ox + x * sc, Y = (y) => h - oy - y * sc; // flip y

  ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
  ctx.strokeRect(X(0), Y(b.depth), b.width * sc, b.depth * sc);
  for (const z of rep.zones) {
    ctx.fillStyle = hexA(z.color || '#eeeeee', 0.32);
    ctx.fillRect(X(z.x), Y(z.y + z.h), z.w * sc, z.h * sc);
    ctx.fillStyle = '#8a93a0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
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
  for (const wk of rep.workers) {
    const [x, y, st] = interp(wk.keyframes, S.t);
    ctx.fillStyle = STATE_COLOR[st] || '#999';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 0.7;
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
  $('projectSelect').innerHTML = '<option value="">（新規作成）</option>' +
    ps.map(p => `<option value="${p}">${p}</option>`).join('');
  if (select) $('projectSelect').value = select;
}
async function openProject(name) {
  S.project = name;
  const m = await api(`/api/projects/${name}/model`);
  renderHeadline(m.headline_fields, m.headline_values);
  $('provenance').textContent = m.provenance_summary;
  $('runBtn').disabled = false;
  $('status').textContent = `プロジェクト「${name}」を開きました。設計を調整して実行できます。`;
  if (S.view === 'design') mountDesigner();
}

async function mountDesigner() {
  if (!S.project) return;
  const model = await api(`/api/projects/${S.project}/full`);
  if (S.designer) S.designer.dispose();
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
}
async function runSim() {
  if (!S.project) return;
  $('runBtn').disabled = true;
  $('status').textContent = '重厚なシミュレーションを実行中…';
  try {
    const r = await api(`/api/projects/${S.project}/run`, { method: 'POST' });
    renderKpis(r.kpis);
    await loadReplay();
    $('pngImg').src = `/api/projects/${S.project}/png?ts=${Date.now()}`;
    $('status').textContent = `完了（${r.run}）。`;
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
  } finally {
    $('runBtn').disabled = false;
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
    ['スループット', `${k.throughput_per_hr.toFixed(0)} 件/時`],
    ['出荷完了', `${k.orders_completed.toFixed(0)} / ${k.orders_arrived.toFixed(0)}`],
    ['ボトルネック', `${k.bottleneck_jp || ''} ${(k.bottleneck_utilization*100).toFixed(0)}%`],
    ['ピッカー稼働率', `${k.n_pickers}名 ${(k.picker_utilization*100).toFixed(0)}%`],
    ['梱包台稼働率', `${k.n_packers}台 ${(k.packer_utilization*100).toFixed(0)}%`],
    ['処理時間 中央値/最悪', `${(k.cycle_p50_s/60).toFixed(0)}/${(k.cycle_p95_s/60).toFixed(0)} 分`],
    ['1件あたり歩行', `${k.walk_per_order_m.toFixed(0)} m`],
  ];
  $('kpiBar').innerHTML = `<div class="verdict ${cls}">${k.verdict}</div>` +
    cards.map(([kk, vv]) => `<div class="kpi"><div class="k">${kk}</div><div class="v">${vv}</div></div>`).join('');
}

function mount3d() {
  const el = $('view3d');
  if (!S.replay) return;
  if (S.scene3d) S.scene3d.dispose();
  S.scene3d = new Scene3D(el, S.replay, () => S.t);
  S.scene3d.resize();
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
  } catch (e) { $('importLog').textContent = 'エラー: ' + e.message; }
}

// ---- wire up ---------------------------------------------------------------
function initUI() {
  $('createBtn').onclick = async () => {
    const name = $('newName').value.trim();
    if (!name) { $('status').textContent = 'プロジェクト名を入力してください。'; return; }
    try {
      await api('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, template: $('templateSelect').value }),
      });
      await refreshProjects(name);
      await openProject(name);
    } catch (e) {
      $('status').textContent = '作成に失敗: ' + e.message;
    }
  };
  $('projectSelect').onchange = (e) => { if (e.target.value) openProject(e.target.value); };
  $('applyBtn').onclick = applyHeadline;
  $('runBtn').onclick = runSim;

  // tabs
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    S.view = t.dataset.tab;
    $(S.view).classList.add('active');
    if (S.view === 'design') { mountDesigner(); }
    if (S.view === 'view3d') { mount3d(); }
    if (S.view === 'view2d') fitCanvas();
  });

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
  fitCanvas();
}

(async function main() {
  initUI();
  await loadTemplates();
  await refreshProjects();
  requestAnimationFrame(loop);
})();
