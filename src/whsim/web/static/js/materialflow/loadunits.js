// materialflow/loadunits.js — 荷姿（容器・台車）カタログのクライアント。
//
// whsim/loadunit.py is the authority: the catalogue lives there and the
// piece→容器→台車 conversion is computed there. This module NEVER re-implements
// the arithmetic in JS — it asks the server and renders the `chain` it gets back
// verbatim, so the number on screen is the number the rest of whsim uses.
//
// never-blocks: an older server (404), a closed project or a network hiccup all
// resolve to `null`, and every caller treats that as "荷姿はまだ扱えない" — the
// edge popover simply drops the 荷姿 section instead of throwing.

const base = (name) => `/api/projects/${encodeURIComponent(name)}`;

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// The payload key the catalogue arrived under, so a save round-trips in the same
// shape the server handed us (rather than guessing one).
function pick(doc) {
  if (Array.isArray(doc)) return { list: doc, key: 'load_units' };
  if (!doc || typeof doc !== 'object') return null;
  for (const k of ['load_units', 'loadunits', 'units', 'items']) {
    if (Array.isArray(doc[k])) return { list: doc[k], key: k };
  }
  return null;
}

/** GET the 荷姿 catalogue. → {list, key} | null */
export async function fetchCatalogue(name) {
  if (!name) return null;
  try {
    return pick(await getJSON(`${base(name)}/loadunits`));
  } catch (_e) {
    return null;
  }
}

/** POST the whole catalogue back. → {list, key} (the server's answer, or ours). */
export async function saveCatalogue(name, list, key = 'load_units') {
  if (!name) throw new Error('プロジェクトが開いていません');
  const r = await fetch(`${base(name)}/loadunits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ [key]: list }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  const doc = await r.json().catch(() => null);
  return pick(doc) || { list, key };
}

/**
 * Ask the server to convert a volume through a 容器/台車 pair.
 * → {containers, carriers, chain, provisional, …} | null (never throws).
 */
export async function convert(name, { pieces = 0, cases = 0, container = '', carrier = '' } = {}) {
  if (!name) return null;
  const q = new URLSearchParams();
  q.set('pieces', String(Math.max(0, Math.round(Number(pieces) || 0))));
  q.set('cases', String(Math.max(0, Math.round(Number(cases) || 0))));
  if (container) q.set('container', container);
  if (carrier) q.set('carrier', carrier);
  try {
    return await getJSON(`${base(name)}/loadunits/convert?${q.toString()}`);
  } catch (_e) {
    return null;
  }
}

/** The conversion echo as one line of text. Accepts a string or a list of steps. */
export function chainText(chain) {
  if (Array.isArray(chain)) {
    return chain.map((c) => (c && typeof c === 'object' ? (c.text || c.label || '') : String(c)))
      .filter(Boolean).join('  →  ');
  }
  if (chain && typeof chain === 'object') return String(chain.text || chain.label || '');
  return chain == null ? '' : String(chain);
}

/** Rows of one 荷姿 family, tolerant about how `kind` is spelled. */
export function unitsOfKind(list, kind) {
  const want = String(kind || '').toLowerCase();
  return (Array.isArray(list) ? list : []).filter((u) => {
    if (!u || !u.id) return false;
    const k = String(u.kind || '').toLowerCase();
    return k === want || (want === 'container' && k === 'case') || (want === 'carrier' && k === 'cart');
  });
}

export const unitById = (list, id) =>
  (Array.isArray(list) ? list : []).find((u) => u && u.id === id) || null;

// --- 入数 -------------------------------------------------------------------
// `capacity` is a MAP keyed by what the unit holds ({piece:30} / {orikon:14,
// case:14}), not a single number: a カゴ台車 takes 14 オリコン *or* 14 ケース, and
// 「何が何個」 is the whole question. Reading it as a scalar yields 0.

const capOf = (u) => (u && u.capacity && typeof u.capacity === 'object' ? u.capacity : {});
const isCarrier = (u) => ['carrier', 'pallet', 'cart'].includes(String((u || {}).kind || '').toLowerCase());

/**
 * Which entry of `unit.capacity` this leg is measured in.
 * A 容器 holds loose goods (点); a 台車 holds whatever 容器 the leg names, and
 * falls back to ケース when the leg names none.
 */
export function capacityKey(unit, containerRef = '') {
  const cap = capOf(unit);
  const prefer = isCarrier(unit)
    ? [containerRef, 'case', 'orikon', 'tray']
    : ['piece', 'case'];
  for (const k of prefer) if (k && Number(cap[k]) > 0) return k;
  const first = Object.keys(cap).find((k) => Number(cap[k]) > 0);
  return first || (isCarrier(unit) ? 'case' : 'piece');
}

/** 入数 of `unit` for the goods this leg puts in it. 0 when unstated. */
export const capacityOf = (unit, containerRef = '') =>
  Number(capOf(unit)[capacityKey(unit, containerRef)]) || 0;

/** The capacity map with ONE key rewritten; every other pairing is preserved. */
export function withCapacity(unit, key, value) {
  return { ...capOf(unit), [key]: value };
}

// Base goods have no catalogue row worth naming in a chip (「30 ピース(バラ)/オリコン」
// reads worse than 「30 点/オリコン」); everything else uses its own name.
const HELD_JA = { piece: '点', case: 'ケース' };

/** How to say the held goods in 「30 <held>/オリコン」. */
export function heldLabel(list, key) {
  if (HELD_JA[key]) return HELD_JA[key];
  const u = unitById(list, key);
  return (u && (u.name || u.id)) || key || '点';
}
