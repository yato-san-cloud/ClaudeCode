// timetable/dom.js — the timetable package's shared DOM builder.
//
// `el(tag, cls, text)` was a private helper inside timetable.js; the facade and
// the extracted solver sub-editors (batch/shift/deps) all build DOM with it, so
// it lives here as the package's single source (mirrors designer/geometry.js).
// Pure, no state — identical to the previous inline definition.
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
