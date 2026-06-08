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
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

// HTML escaper. Escapes the full superset `& < > " '` so the result is safe in
// both element-text and attribute-value contexts.
export const esc = (s) => String(s == null ? '' : s).replace(
  /[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
);
