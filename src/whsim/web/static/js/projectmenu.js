// projectmenu.js — the project-management menu (複製 / 名前変更 / 削除), extracted
// verbatim from app.js's `// ---- project management menu ----` section.
//
// Two cohesive, low-coupling clusters: (1) the accessible menu open/close +
// keyboard handling (Escape / Arrow / Home / End / Tab), and (2) the three
// project actions that prompt/confirm and POST to /api/projects/<name>/{duplicate,
// rename} or DELETE it. They drive the #projMenu / #projMenuBtn DOM and the shared
// SPA state (`S`).
//
// The project-lifecycle helpers they call (`refreshProjects`, `openProject`,
// `clearProjectState`) and `toast` stay in app.js (they own headline/readiness/
// run wiring) and are injected once via `initProjectMenu(deps)`. Behaviour is
// identical: same DOM ids, same prompt/confirm strings, same endpoints, same
// follow-up calls (incl. the chat-bucket rename/clear) in the same order.
import { S } from './state.js';
import { $, api, modalPrompt, modalConfirm } from './util.js';

// Shell helpers that remain in app.js, injected at boot.
let toast = () => {};
let refreshProjects = async () => {};
let openProject = async () => {};
let clearProjectState = () => {};

export function initProjectMenu(deps) {
  ({ toast, refreshProjects, openProject, clearProjectState } = deps);
}

// ---- project management menu (duplicate / rename / delete) -----------------
export function closeProjMenu() {
  const menu = $('projMenu'), btn = $('projMenuBtn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', onDocClickProjMenu, true);
  document.removeEventListener('keydown', onProjMenuKey, true);
}
export function openProjMenu() {
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
export async function projDuplicate() {
  const from = S.project;
  if (!from) return;
  closeProjMenu();
  const to = (await modalPrompt({
    title: 'プロジェクトを複製',
    message: `「${from}」を複製します。新しい名前を入力してください。`,
    label: '新しいプロジェクト名',
    value: from + '-copy',
    okLabel: '複製',
  }) || '').trim();
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
export async function projRename() {
  const from = S.project;
  if (!from) return;
  closeProjMenu();
  const to = (await modalPrompt({
    title: 'プロジェクト名を変更',
    message: `「${from}」の新しい名前を入力してください。`,
    label: '新しいプロジェクト名',
    value: from,
    okLabel: '変更',
  }) || '').trim();
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
export async function projDelete() {
  const name = S.project;
  if (!name) return;
  closeProjMenu();
  if (!(await modalConfirm({
    title: 'プロジェクトを削除',
    message: `プロジェクト「${name}」を削除します。元に戻せません。よろしいですか？`,
    okLabel: '削除',
    cancelLabel: 'キャンセル',
    danger: true,
  }))) return;
  try {
    await api(`/api/projects/${name}`, { method: 'DELETE' });
    if (S.chat && S.chat.clearBucket) S.chat.clearBucket(name);
    clearProjectState();
    await refreshProjects('');
    toast(`「${name}」を削除しました。`, 'ok');
  } catch (e) { toast('削除に失敗しました: ' + e.message, 'error'); }
}
