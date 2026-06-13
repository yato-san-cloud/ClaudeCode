// history.js — per-project activity log (操作履歴) for the left sidebar.
//
// A lightweight, localStorage-backed feed of what happened to the open project:
// lifecycle (create/open), imports (kind + filename), design saves, completed
// simulation runs (one-line verdict), benchmark applications and measured-
// productivity adoptions. The shell (app.js) and the import handlers
// (imports.js) call `hist.log(icon, text, view?, cat?)` at their success seams;
// this module owns persistence (key `whsim-history-<project>`, newest first,
// max 50 entries) and the sidebar card UI (relative timestamps, click-to-
// navigate via the entry's `view`, clear button).
//
// Styling is self-contained via injectStyle() with the `.hist-` prefix so it
// never collides with styles.css (which another agent owns).
import { esc } from './util.js';

const MAX_ENTRIES = 50;
const KEY_PREFIX = 'whsim-history-';

let _project = null;
let _render = null;       // set by mountHistory so hist.log() refreshes the card
let _switchTo = null;     // host-supplied navigation (app.js switchView)

function storageKey(project) { return KEY_PREFIX + project; }

function loadEntries(project) {
  if (!project) return [];
  try {
    const list = JSON.parse(localStorage.getItem(storageKey(project)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_e) { return []; }
}

function saveEntries(project, list) {
  if (!project) return;
  try {
    localStorage.setItem(storageKey(project), JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch (_e) { /* storage full / blocked — the log is best-effort */ }
}

// Relative timestamp (Japanese): たった今 / N分前 / N時間前 / M/D HH:MM.
export function relTime(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'たった今';
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// Public logging surface. A module-level singleton (like state.js `S`) so the
// shell and the import handlers write the SAME per-project feed.
export const hist = {
  setProject(name) {
    _project = name || null;
    if (_render) _render();
  },
  // Append one entry for the open project. `view` (optional) makes the row a
  // jump link (click → switchView(view)); `cat` (optional) tags the entry for
  // the ①取込 hub's per-card "last import" status lines.
  log(icon, text, view = null, cat = null) {
    if (!_project || !text) return;
    const list = loadEntries(_project);
    list.unshift({ t: Date.now(), icon: icon || '・', text: String(text), view, cat });
    saveEntries(_project, list);
    if (_render) _render();
  },
  // Latest entry of a category for the open project (or null).
  latest(cat) {
    if (!_project) return null;
    return loadEntries(_project).find((e) => e && e.cat === cat) || null;
  },
};

const HIST_CSS = `
.hist{display:flex;flex-direction:column;gap:6px;min-width:0}
.hist-bar{display:flex;align-items:center;gap:8px;min-height:20px}
.hist-count{font-size:10.5px;color:var(--ink-tertiary)}
.hist-clear{margin-left:auto;flex:0 0 auto;border:1px solid var(--line-soft);
  background:transparent;color:var(--ink-tertiary);font:inherit;font-size:10.5px;
  font-weight:600;padding:1px 8px;border-radius:var(--r-pill);cursor:pointer;
  transition:color var(--dur-1) var(--ease-out),border-color var(--dur-1) var(--ease-out)}
.hist-clear:hover{color:var(--ink-secondary);border-color:var(--line-strong)}
.hist-clear:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.hist-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;
  max-height:320px;overflow-y:auto;overscroll-behavior:contain}
.hist-row{display:flex;align-items:flex-start;gap:7px;width:100%;text-align:left;
  border:none;background:transparent;font:inherit;color:var(--ink-secondary);
  padding:5px 6px;border-radius:var(--r-md);cursor:default}
.hist-row.is-link{cursor:pointer}
.hist-row.is-link:hover{background:var(--bg-hover);color:var(--ink-primary)}
.hist-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.hist-ico{flex:0 0 auto;font-size:12px;line-height:1.5;width:16px;text-align:center}
.hist-body{flex:1;min-width:0;display:flex;flex-direction:column}
.hist-text{font-size:11.5px;line-height:1.45;overflow:hidden;display:-webkit-box;
  -webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}
.hist-time{font-size:10px;color:var(--ink-tertiary);margin-top:1px}
.hist-empty{font-size:11.5px;color:var(--ink-tertiary);line-height:1.6;padding:4px 2px}
@media (prefers-reduced-motion: reduce){.hist-clear{transition:none}}
`;

function injectStyle() {
  if (document.getElementById('hist-style')) return;
  const s = document.createElement('style');
  s.id = 'hist-style';
  s.textContent = HIST_CSS;
  document.head.appendChild(s);
}

// Mount the sidebar card body. opts: { switchTo(view) } — host navigation.
export function mountHistory(el, opts = {}) {
  injectStyle();
  _switchTo = opts.switchTo || null;

  const root = document.createElement('div');
  root.className = 'hist';
  el.innerHTML = '';
  el.appendChild(root);

  function render() {
    if (!_project) {
      root.innerHTML = '<div class="hist-empty">プロジェクトを開くと、取込・設計保存・実行などの操作がここに残ります。</div>';
      return;
    }
    const list = loadEntries(_project);
    if (!list.length) {
      root.innerHTML = '<div class="hist-empty">まだ操作履歴がありません。取込や実行を行うとここに記録されます。</div>';
      return;
    }
    const rows = list.map((e, i) => {
      const link = !!e.view;
      return `<li><button type="button" class="hist-row${link ? ' is-link' : ''}" data-i="${i}"
        ${link ? `title="${esc(e.text)}（クリックで関連ビューへ）"` : `title="${esc(e.text)}"`}>
        <span class="hist-ico" aria-hidden="true">${esc(e.icon || '・')}</span>
        <span class="hist-body">
          <span class="hist-text">${esc(e.text)}</span>
          <span class="hist-time">${esc(relTime(e.t || 0))}</span>
        </span>
      </button></li>`;
    }).join('');
    root.innerHTML =
      `<div class="hist-bar">
         <span class="hist-count">${list.length}件</span>
         <button type="button" class="hist-clear" title="このプロジェクトの操作履歴を消去">クリア</button>
       </div>
       <ul class="hist-list">${rows}</ul>`;

    const clearBtn = root.querySelector('.hist-clear');
    if (clearBtn) {
      clearBtn.onclick = () => {
        try { localStorage.removeItem(storageKey(_project)); } catch (_e) { /* ignore */ }
        render();
      };
    }
    root.querySelectorAll('.hist-row.is-link').forEach((btn) => {
      btn.onclick = () => {
        const e = list[Number(btn.dataset.i)];
        if (e && e.view && _switchTo) _switchTo(e.view);
      };
    });
  }

  _render = render;
  // Keep the relative timestamps fresh (cheap: ≤50 rows, once a minute).
  const timer = setInterval(render, 60000);
  render();

  return {
    refresh: render,
    dispose() {
      clearInterval(timer);
      if (_render === render) _render = null;
      el.innerHTML = '';
    },
  };
}
