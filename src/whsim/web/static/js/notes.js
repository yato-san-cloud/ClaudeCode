// notes.js — 知見ボード（掲示板）. Pin tacit knowledge to numbers/processes so
// "なぜこの生産性/物量なのか" lives in the system and compounds. Per-project,
// display-name identity (localStorage), no auth yet.
import { api, esc } from './util.js';

const ANCHORS = [
  { v: 'general', t: '全般' }, { v: '生産性', t: '生産性' }, { v: '工程', t: '工程' },
  { v: '物量', t: '物量' }, { v: 'シナリオ', t: 'シナリオ' }, { v: '設計', t: '設計' },
  { v: '結果', t: '結果' },
];
const ANCHOR_C = {
  general: '#8195a8', 生産性: '#2ee6a0', 工程: '#2f7bff', 物量: '#f5b05a',
  シナリオ: '#9b6bff', 設計: '#34e3ff', 結果: '#ff5a78',
};

function injectStyle() {
  if (document.getElementById('nb-style')) return;
  const s = document.createElement('style');
  s.id = 'nb-style';
  s.textContent = `
  .nb{display:flex;flex-direction:column;gap:var(--sp-3);max-width:820px;margin:0 auto;width:100%;padding:6px 2px 24px}
  .nb h3{margin:0;font-size:15px;color:var(--ink-primary,#16202e)}
  .nb-form{display:flex;flex-direction:column;gap:8px;background:var(--bg-panel,#f7f6f3);
    border:1px solid var(--line,rgba(120,140,170,.18));border-radius:13px;padding:var(--sp-4)}
  .nb-row{display:flex;gap:8px;flex-wrap:wrap}
  .nb-form select,.nb-form input,.nb-form textarea{background:var(--bg-app,#fff);
    border:1px solid var(--line,#ccd);border-radius:8px;padding:8px 10px;font:inherit;color:var(--ink-primary,#16202e);
    transition:border-color var(--dur-1) var(--ease-out), background var(--dur-1) var(--ease-out)}
  .nb-form select:hover,.nb-form input:hover,.nb-form textarea:hover{border-color:var(--line-strong)}
  .nb-form textarea{width:100%;min-height:64px;resize:vertical}
  .nb-form input{flex:1;min-width:140px}
  .nb-post{align-self:flex-end;padding:8px 18px;border-radius:9px;border:none;cursor:pointer;
    background:var(--accent,#2f7bff);color:#04222c;font-weight:700}
  .nb-list{display:flex;flex-direction:column;gap:10px}
  .nb-item{background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-radius:12px;padding:12px 14px;border-left:4px solid var(--c,#8195a8)}
  .nb-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-tertiary,#8195a8);margin-bottom:5px}
  .nb-chip{font-size:10px;font-weight:700;color:#04222c;background:var(--c,#8195a8);padding:1px 7px;border-radius:999px}
  .nb-who{color:var(--ink-secondary,#52677c);font-weight:600}
  .nb-x{margin-left:auto;background:none;border:none;color:var(--ink-tertiary,#8195a8);cursor:pointer;font-size:14px;
    opacity:.7;border-radius:var(--r-xs);padding:0 var(--sp-1);
    transition:opacity var(--dur-1) var(--ease-out), background var(--dur-1) var(--ease-out)}
  .nb-x:hover{opacity:1;background:var(--bg-hover)}
  .nb-text{font-size:13.5px;color:var(--ink-primary,#16202e);line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .nb-empty{color:var(--ink-tertiary,#8195a8);text-align:center;padding:24px}
  `;
  document.head.appendChild(s);
}

export function mountNotes(el, opts = {}) {
  injectStyle();
  const toast = opts.toast || (() => {});
  const getProject = opts.getProject || (() => null);
  const root = document.createElement('div');
  root.className = 'nb';
  el.innerHTML = '';
  el.appendChild(root);

  function shell() {
    const proj = getProject();
    if (!proj) { root.innerHTML = '<div class="nb-empty">プロジェクトを選択すると知見を残せます。</div>'; return; }
    const author = localStorage.getItem('whsim-author') || '';
    root.innerHTML =
      `<h3>💬 知見ボード <span style="font-size:12px;color:var(--ink-tertiary,#8195a8)">— 生産性や工程の“なぜ”を残す</span></h3>
       <div class="nb-form">
         <div class="nb-row">
           <select data-nb="anchor">${ANCHORS.map((a) => `<option value="${a.v}">${a.t}</option>`).join('')}</select>
           <input data-nb="author" placeholder="表示名" value="${esc(author)}"/>
         </div>
         <textarea data-nb="text" placeholder="例）入荷検品の生産性は繁忙期(5/11)実測で23行/h。閑散期はもっと出る。"></textarea>
         <button class="nb-post" data-nb="post">投稿</button>
       </div>
       <div class="nb-list" data-nb="list"><div class="nb-empty">読み込み中…</div></div>`;
    root.querySelector('[data-nb="post"]').onclick = post;
    load();
  }

  async function load() {
    const proj = getProject();
    const list = root.querySelector('[data-nb="list"]');
    if (!proj || !list) return;
    try {
      const { notes } = await api(`/api/projects/${proj}/notes`);
      list.innerHTML = notes.length ? notes.map(item).join('')
        : '<div class="nb-empty">まだ知見がありません。最初の1件を残しましょう。</div>';
      list.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => del(b.dataset.del); });
    } catch (e) { list.innerHTML = `<div class="nb-empty">読み込み失敗: ${esc(e.message)}</div>`; }
  }

  function item(n) {
    const c = ANCHOR_C[n.anchor] || '#8195a8';
    return `<div class="nb-item" style="--c:${c}">
      <div class="nb-meta"><span class="nb-chip" style="--c:${c}">${esc(n.anchor)}</span>
        <span class="nb-who">${esc(n.author)}</span><span>${esc(n.ts)}</span>
        <button class="nb-x" data-del="${n.id}" title="削除">✕</button></div>
      <div class="nb-text">${esc(n.text)}</div></div>`;
  }

  async function post() {
    const proj = getProject();
    const text = root.querySelector('[data-nb="text"]').value.trim();
    const author = root.querySelector('[data-nb="author"]').value.trim();
    const anchor = root.querySelector('[data-nb="anchor"]').value;
    if (!text) { toast('本文を入力してください。', 'info'); return; }
    if (author) localStorage.setItem('whsim-author', author);
    try {
      await api(`/api/projects/${proj}/notes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor, author, text }),
      });
      root.querySelector('[data-nb="text"]').value = '';
      toast('知見を残しました。', 'ok');
      load();
    } catch (e) { toast('投稿に失敗しました: ' + e.message, 'error'); }
  }

  async function del(id) {
    const proj = getProject();
    try { await api(`/api/projects/${proj}/notes/${id}`, { method: 'DELETE' }); load(); }
    catch (e) { toast('削除に失敗しました: ' + e.message, 'error'); }
  }

  shell();
  return { refresh() { shell(); }, dispose() { el.innerHTML = ''; } };
}
