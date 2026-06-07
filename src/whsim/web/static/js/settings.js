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
  if (!toggle || !body || !form) return { loadFor() {}, clear() {}, enabled() {}, dispose() {} };

  // Cache the save button's original label once (avoid duplicating the literal).
  const SAVE_LABEL = saveBtn ? (saveBtn.textContent || '保存') : '保存';

  let project = null;
  let saving = false;
  let confirmRow = null; // inline re-run confirm (replaces window.confirm)

  // Inline, token-styled confirm row to replace the blocking native
  // window.confirm() — keeps the dark-Void aesthetic and is dismissible.
  // Resolves true if the user accepts the re-run, false otherwise.
  function removeConfirmRow() {
    if (confirmRow && confirmRow.parentNode) confirmRow.parentNode.removeChild(confirmRow);
    confirmRow = null;
  }

  function askRerun(message) {
    return new Promise((resolve) => {
      removeConfirmRow();
      const host = status && status.parentNode ? status.parentNode : form;
      const row = document.createElement('div');
      row.className = 'settings-confirm';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', message);
      // Token-only styling (no hardcoded hex / off-grid spacing).
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = 'var(--sp-2)';
      row.style.flexWrap = 'wrap';
      row.style.marginTop = 'var(--sp-2)';
      row.style.padding = 'var(--sp-2) var(--sp-3)';
      row.style.borderRadius = 'var(--r-md)';
      row.style.border = '1px solid var(--line-focus)';
      row.style.animation = 'rise var(--dur-3) var(--ease-out) both';

      const msg = document.createElement('span');
      msg.className = 'settings-confirm-msg';
      msg.textContent = message;
      msg.style.flex = '1 1 auto';
      msg.style.color = 'var(--ink-secondary)';

      const yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'primary';
      yes.textContent = '再実行';

      const no = document.createElement('button');
      no.type = 'button'; // plain button = secondary style
      no.textContent = 'あとで';

      const settle = (val) => {
        const tgt = (val ? saveBtn : toggle) || null;
        removeConfirmRow();
        if (tgt && typeof tgt.focus === 'function') {
          try { tgt.focus(); } catch (_e) { /* ignore */ }
        }
        resolve(val);
      };
      yes.addEventListener('click', () => settle(true));
      no.addEventListener('click', () => settle(false));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      });

      row.appendChild(msg);
      row.appendChild(no);
      row.appendChild(yes);
      host.appendChild(row);
      // Move focus onto the affirmative action for keyboard/SR users.
      requestAnimationFrame(() => {
        try { yes.focus(); } catch (_e) { /* ignore */ }
      });
    });
  }

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
      // If a finished run exists, offer to re-run so costs refresh — via an
      // inline, token-styled confirm (not the blocking native dialog).
      if (onRerun && hasRun()) {
        if (await askRerun('変更を反映するため、シミュレーションを再実行しますか？')) {
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
        saveBtn.textContent = SAVE_LABEL;
      }
    }
  }

  // Wire events once (named handlers so dispose() can detach them).
  function onToggleClick() {
    if (toggle.disabled) return;
    setOpen(body.hidden);
  }
  toggle.addEventListener('click', onToggleClick);
  form.addEventListener('submit', save);

  // Remove listeners + any inline confirm (parity with cody's destroy()).
  function dispose() {
    toggle.removeEventListener('click', onToggleClick);
    form.removeEventListener('submit', save);
    removeConfirmRow();
  }

  // Start disabled until a project opens.
  enabled(false);

  return { loadFor, clear, enabled, dispose };
}

export default mountSettings;
