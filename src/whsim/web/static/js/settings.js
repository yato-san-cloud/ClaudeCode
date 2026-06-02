// settings.js — コスト・稼働条件 (cost / operating-conditions) sidebar panel.
//
// A small, self-contained controller over the existing markup in index.html
// (#settingsForm and friends). Loads the flat settings dict when a project
// opens, lets the user edit numeric fields, and PUTs them back. On a successful
// save it toasts and — when a finished run exists — offers to re-run so the new
// cost assumptions flow into the KPIs.
//
// Backend contract (degrades gracefully on 404 / network error):
//   GET  /api/projects/{name}/settings -> flat dict
//   PUT  /api/projects/{name}/settings (body=flat dict) -> { ok, settings }
//
// Public API:
//   mountSettings(opts) -> controller
//     opts.getProject():        string | null
//     opts.toast(msg, kind?):   void
//     opts.hasRun():            boolean      (is a finished run available?)
//     opts.onRerun():           void|Promise (re-run the simulation)
//   controller: { loadFor(name), clear(), enabled(on) }
//
// Vanilla ES module, no imports. User-controlled values never reach innerHTML.

const $ = (id) => document.getElementById(id);

// field id -> backend key. Numeric fields are coerced; currency is a string.
const NUMERIC = {
  set_labor: 'labor_cost_per_hour',
  set_hours: 'working_hours_per_day',
  set_days: 'working_days_per_month',
  set_agv: 'agv_cost_per_month',
};
const CURRENCY_FIELD = { set_currency: 'currency' };

export function mountSettings(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const toast = typeof o.toast === 'function' ? o.toast : () => {};
  const getProject = typeof o.getProject === 'function' ? o.getProject : () => null;
  const hasRun = typeof o.hasRun === 'function' ? o.hasRun : () => false;
  const onRerun = typeof o.onRerun === 'function' ? o.onRerun : null;

  const toggle = $('settingsToggle');
  const body = $('settingsBody');
  const form = $('settingsForm');
  const saveBtn = $('settingsSave');
  const status = $('settingsStatus');
  if (!toggle || !body || !form) return { loadFor() {}, clear() {}, enabled() {} };

  let project = null;
  let saving = false;

  function setOpen(open) {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function enabled(on) {
    toggle.disabled = !on;
    if (!on) setOpen(false);
  }

  function setStatus(msg) {
    if (status) status.textContent = msg || '';
  }

  function fillForm(data) {
    const d = data && typeof data === 'object' ? data : {};
    const cur = (typeof d.currency === 'string' && d.currency) ? d.currency : '¥';
    const curSel = $('set_currency');
    if (curSel) {
      // Add the option if the backend returns something not in our preset list.
      if (!Array.from(curSel.options).some((op) => op.value === cur)) {
        const op = document.createElement('option');
        op.value = cur;
        op.textContent = cur;
        curSel.appendChild(op);
      }
      curSel.value = cur;
    }
    for (const [id, key] of Object.entries(NUMERIC)) {
      const el = $(id);
      if (!el) continue;
      const v = d[key];
      el.value = (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '';
    }
  }

  function collect() {
    const out = {};
    for (const [id, key] of Object.entries(CURRENCY_FIELD)) {
      const el = $(id);
      if (el) out[key] = el.value;
    }
    for (const [id, key] of Object.entries(NUMERIC)) {
      const el = $(id);
      if (!el) continue;
      const n = parseFloat(el.value);
      if (Number.isFinite(n)) out[key] = n;
    }
    return out;
  }

  async function loadFor(name) {
    project = (typeof name === 'string' && name.trim()) ? name.trim() : null;
    enabled(!!project);
    setStatus('');
    if (!project) { fillForm({}); return; }
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/settings`,
        { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        // 404 etc: the backend may not expose settings yet — degrade silently.
        fillForm({});
        return;
      }
      const data = await res.json();
      fillForm(data);
    } catch (_e) {
      fillForm({});
    }
  }

  function clear() {
    project = null;
    enabled(false);
    fillForm({});
    setStatus('');
  }

  async function save(e) {
    if (e) e.preventDefault();
    if (saving) return;
    if (!project) { toast('先にプロジェクトを開いてください。', 'info'); return; }
    saving = true;
    const label = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span>保存中…';
    }
    setStatus('保存中…');
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(collect()),
      });
      if (!res.ok) {
        let detail = `保存に失敗しました (${res.status})`;
        try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (_e) { /* ignore */ }
        throw new Error(detail);
      }
      const data = await res.json().catch(() => ({}));
      if (data && data.settings) fillForm(data.settings);
      setStatus('保存しました。');
      toast('コスト・稼働条件を保存しました。', 'ok');
      // If a finished run exists, offer to re-run so costs refresh.
      if (onRerun && hasRun()) {
        if (window.confirm('変更を反映するため、シミュレーションを再実行しますか？')) {
          await onRerun();
        }
      }
    } catch (err) {
      setStatus('エラー: ' + (err && err.message ? err.message : ''));
      toast('保存に失敗しました: ' + (err && err.message ? err.message : ''), 'error');
    } finally {
      saving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = label || '保存';
      }
    }
  }

  // Wire events once.
  toggle.addEventListener('click', () => {
    if (toggle.disabled) return;
    setOpen(body.hidden);
  });
  form.addEventListener('submit', save);

  // Start disabled until a project opens.
  enabled(false);

  return { loadFor, clear, enabled };
}

export default mountSettings;
