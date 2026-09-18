// util.js — shared DOM/fetch/escaping helpers for the whsim frontend.
//
// Vanilla ES module, no dependencies. These three helpers were previously
// copy-pasted (with small, inconsistent variations) across many modules; this
// is the single canonical source.

// Shorthand for document.getElementById.
export const $ = (id) => document.getElementById(id);

// fetch wrapper: returns parsed JSON, or throws an Error carrying the backend
// JSON `detail` (falling back to the HTTP statusText).
export const api = async (url, opts) => {
  const r = await fetch(url, opts);
  // 401 = the access gate (web/auth.py) wants a session. That is not an error
  // any caller can act on, so handle it once here: bounce to the login form
  // carrying where we were, and never resolve (the navigation is the outcome).
  if (r.status === 401) {
    const body = await r.json().catch(() => ({}));
    if (body && body.login) {
      const back = location.pathname + location.search + location.hash;
      location.href = `${body.login}?next=${encodeURIComponent(back)}`;
      await new Promise(() => {});   // stop this call chain while we navigate
    }
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

// HTML escaper. Escapes the full superset `& < > " '` so the result is safe in
// both element-text and attribute-value contexts.
export const esc = (s) => String(s == null ? '' : s).replace(
  /[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
);

// ---------------------------------------------------------------------------
// Brand modal (modalPrompt / modalConfirm) — accessible replacements for the
// native prompt()/confirm() dialogs. Token-styled (scrim + card), focus-trapped,
// Esc cancels, Enter confirms, aria-modal/role=dialog, reduced-motion aware.
//
// Both return a Promise; the caller never blocks the main thread but the
// ergonomics mirror the native calls:
//   modalPrompt(...) → Promise<string|null>  (null = cancelled, like prompt())
//   modalConfirm(...) → Promise<boolean>     (false = cancelled, like confirm())
// ---------------------------------------------------------------------------

// Inject the modal stylesheet once, lazily (mirrors the journey/phasehint
// injectStyle() pattern so this file stays self-contained — no CSS edits needed
// in callers). Every colour flows from a design token.
function ensureModalStyle() {
  if (document.getElementById('whsim-modal-style')) return;
  const s = document.createElement('style');
  s.id = 'whsim-modal-style';
  s.textContent = `
  .wm-modal-scrim{position:fixed;inset:0;z-index:9700;display:grid;place-items:center;
    padding:var(--sp-4,16px);background:rgba(15,15,15,0.42);
    animation:wmModalFade var(--dur-2,160ms) var(--ease-out,ease)}
  html[data-theme="dark"] .wm-modal-scrim{background:rgba(0,0,0,0.58)}
  .wm-modal{width:min(440px,100%);background:var(--bg-app,#fff);color:var(--ink-primary,#37352F);
    border:1px solid var(--line-hair,rgba(55,53,47,0.09));border-radius:var(--r-lg,12px);
    box-shadow:var(--sh-pop,0 14px 40px rgba(15,15,15,0.18));
    padding:var(--sp-5,20px) var(--sp-5,20px) var(--sp-4,16px);
    animation:wmModalRise var(--dur-3,240ms) var(--ease-out,ease) both}
  .wm-modal-title{font-size:var(--fs-title,20px);font-weight:var(--fw-bold,700);
    letter-spacing:var(--ls-title,-0.012em);line-height:1.3;color:var(--ink-primary,#37352F);
    margin:0 0 var(--sp-2,8px)}
  .wm-modal-msg{font-size:var(--fs-body,14px);line-height:var(--lh-body,1.55);
    color:var(--ink-secondary,rgba(55,53,47,0.65));margin:0 0 var(--sp-4,16px)}
  .wm-modal-label{display:block;font-size:var(--fs-sm,13px);font-weight:var(--fw-medium,500);
    color:var(--ink-secondary,rgba(55,53,47,0.65));margin:0 0 6px}
  .wm-modal-input{width:100%;box-sizing:border-box;font:inherit;font-size:var(--fs-body,14px);
    padding:9px 12px;border:1px solid var(--line-strong,rgba(55,53,47,0.16));
    border-radius:var(--r-md,8px);background:var(--bg-app,#fff);color:var(--ink-primary,#37352F);
    transition:border-color var(--dur-2,160ms) var(--ease,ease),box-shadow var(--dur-2,160ms) var(--ease,ease)}
  .wm-modal-input:focus{outline:none;border-color:var(--accent,#16C0DE);
    box-shadow:0 0 0 3px var(--accent-tint,#E4F8FC)}
  .wm-modal-actions{display:flex;justify-content:flex-end;gap:var(--sp-2,8px);
    margin-top:var(--sp-5,20px)}
  .wm-modal-btn{font:inherit;font-size:var(--fs-sm,13px);font-weight:var(--fw-semibold,600);
    padding:8px 16px;border-radius:var(--r-md,8px);cursor:pointer;
    border:1px solid var(--line-strong,rgba(55,53,47,0.16));background:var(--bg-app,#fff);
    color:var(--ink-primary,#37352F);
    transition:background var(--dur-1,90ms) var(--ease,ease),border-color var(--dur-1,90ms) var(--ease,ease)}
  .wm-modal-btn:hover{background:var(--bg-hover,#F1F0ED)}
  .wm-modal-btn:focus-visible{outline:2px solid var(--line-focus,#0E8FA8);outline-offset:2px}
  .wm-modal-btn.primary{background:var(--accent,#16C0DE);border-color:var(--accent,#16C0DE);
    color:var(--ink-onAccent,#04222C);font-weight:var(--fw-bold,700)}
  .wm-modal-btn.primary:hover{background:var(--accent-hover,#3AD3EE);border-color:var(--accent-hover,#3AD3EE)}
  .wm-modal-btn.danger{background:var(--bad,#C4453F);border-color:var(--bad,#C4453F);color:#fff;
    font-weight:var(--fw-bold,700)}
  .wm-modal-btn.danger:hover{filter:brightness(1.06)}
  @keyframes wmModalFade{from{opacity:0}to{opacity:1}}
  @keyframes wmModalRise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){
    .wm-modal-scrim,.wm-modal{animation:none}
    .wm-modal-btn,.wm-modal-input{transition:none}
  }`;
  document.head.appendChild(s);
}

// Shared dialog engine. `build(card, close)` populates the card and returns
// `{accept, cancel, focusEl}`: `accept()` resolves the confirm/OK outcome
// (Enter), `cancel()` resolves the cancel outcome (Esc / scrim click / cancel
// button), `focusEl` is the element to focus first.
function openModal({ build }) {
  ensureModalStyle();
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'wm-modal-scrim';
    const card = document.createElement('div');
    card.className = 'wm-modal';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.tabIndex = -1;
    scrim.appendChild(card);

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      // Restore focus to whatever opened the dialog (e.g. the menu trigger).
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(value);
    };

    const { accept, cancel, focusEl } = build(card, close);

    function trapFocus(e) {
      const f = card.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.isComposing) {
        // Don't hijack Enter inside a multiline control (none here, but safe).
        if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
        e.preventDefault(); accept();
      } else if (e.key === 'Tab') { trapFocus(e); }
    }
    // Click on the scrim (outside the card) cancels, like dismissing a dialog.
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) cancel(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    (focusEl || card).focus();
  });
}

// Accessible text-input dialog. Resolves the entered string, or null on cancel.
// Defaults preserve prompt() ergonomics: `value` pre-fills + selects the field.
export function modalPrompt({ title = '', label = '', message = '', value = '',
  okLabel = 'OK', cancelLabel = 'キャンセル' } = {}) {
  return openModal({
    build(card, close) {
      const inputId = 'wm-modal-input-' + Math.random().toString(36).slice(2, 8);
      card.innerHTML = `
        <h2 class="wm-modal-title">${esc(title)}</h2>
        ${message ? `<p class="wm-modal-msg">${esc(message)}</p>` : ''}
        ${label ? `<label class="wm-modal-label" for="${inputId}">${esc(label)}</label>` : ''}
        <input class="wm-modal-input" id="${inputId}" type="text" autocomplete="off">
        <div class="wm-modal-actions">
          <button type="button" class="wm-modal-btn" data-act="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="wm-modal-btn primary" data-act="ok">${esc(okLabel)}</button>
        </div>`;
      card.setAttribute('aria-label', title || label || 'プロンプト');
      const input = card.querySelector('.wm-modal-input');
      input.value = value;
      const accept = () => close(input.value);
      const cancel = () => close(null);
      card.querySelector('[data-act="ok"]').addEventListener('click', accept);
      card.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
      // Select the prefilled text so the user can type over it immediately.
      queueMicrotask(() => { input.focus(); input.select(); });
      return { accept, cancel, focusEl: input };
    },
  });
}

// Accessible confirmation dialog. Resolves true (confirm) or false (cancel).
// `danger:true` styles the primary action as destructive (red).
export function modalConfirm({ title = '', message = '', okLabel = 'OK',
  cancelLabel = 'キャンセル', danger = false } = {}) {
  return openModal({
    build(card, close) {
      card.innerHTML = `
        <h2 class="wm-modal-title">${esc(title)}</h2>
        ${message ? `<p class="wm-modal-msg">${esc(message)}</p>` : ''}
        <div class="wm-modal-actions">
          <button type="button" class="wm-modal-btn" data-act="cancel">${esc(cancelLabel)}</button>
          <button type="button" class="wm-modal-btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
        </div>`;
      card.setAttribute('aria-label', title || message || '確認');
      const accept = () => close(true);
      const cancel = () => close(false);
      card.querySelector('[data-act="ok"]').addEventListener('click', accept);
      card.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
      // Default focus on the confirm button (Enter also confirms via onKey).
      return { accept, cancel, focusEl: card.querySelector('[data-act="ok"]') };
    },
  });
}
