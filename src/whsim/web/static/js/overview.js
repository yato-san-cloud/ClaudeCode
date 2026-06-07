// overview.js — ①取込: プロジェクト概要 / 取込状況ホーム。
// 状態の可視化 + 準備チェックリスト + 「次の一手」。取込操作自体は左サイドバーに既存。
// opts: { getState(): {project,hasData,hasRun,running}, getProject(): Promise<modelJSON|null>,
//         switchTo(view), toast(msg,kind) }  ※すべて app.js 側が供給する実在物。

const SUBTREE_JP = {
  locations: 'ロケーション', items: '商品マスタ', process: 'オペレーション',
  resources: '人員・設備', orders: '出荷・入荷データ', simulation: '実行条件',
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const OV_CSS = `
/* Make the overview a normal scrollable document block: the default
   .panel.active{display:flex;flex:1} would height-constrain it and shrink the
   header on short (mobile) viewports, overlapping the sections. */
#overview.panel.active{display:block;overflow:auto}
.ov{display:flex;flex-direction:column;gap:16px;max-width:920px;margin:0 auto;width:100%;
  padding:6px 2px 28px;color:var(--ink-primary);font-family:var(--font-sans)}
.ov>*{flex-shrink:0}
.ov-head{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;
  background:var(--bg-panel);border:1px solid var(--line-hair);
  border-radius:var(--r-lg);padding:18px 20px;box-shadow:var(--sh-xs)}
.ov-id{flex:1 1 220px;min-width:200px}
.ov-name{font-size:22px;font-weight:700;line-height:1.2;color:var(--ink-primary)}
.ov-tmpl{margin-top:4px;font-size:12.5px;color:var(--ink-secondary)}
.ov-tmpl b{color:var(--ink-primary);font-weight:600}
.ov-prov{flex:1 1 320px;min-width:260px}
.ov-prov-pct{font-size:13px;color:var(--ink-secondary)}
.ov-prov-pct b{font-size:20px;color:var(--accent-ink);font-weight:700}
.ov-meter{height:8px;border-radius:var(--r-pill);background:var(--bg-sunken);
  border:1px solid var(--line-hair);overflow:hidden;margin:7px 0 9px}
.ov-meter span{display:block;height:100%;background:var(--accent);
  border-radius:var(--r-pill);transition:width var(--dur-3) var(--ease-out)}
.ov-chips{display:flex;flex-wrap:wrap;gap:6px}
.ov-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;
  padding:3px 9px;border-radius:var(--r-pill);border:1px solid var(--line-soft);
  background:var(--bg-sunken);color:var(--ink-secondary)}
.ov-chip i{font-style:normal;font-size:9.5px;font-weight:700;opacity:.85}
.ov-chip.real{background:var(--ok-tint);border-color:var(--ok-line);color:var(--ok-ink)}
.ov-chip.gen{background:var(--warn-tint);border-color:var(--warn-line);color:var(--warn-ink)}
.ov-chip.prov{background:var(--bg-sunken);border-color:var(--line-soft);color:var(--ink-tertiary)}
.ov-next{background:var(--accent-tint);border:1px solid var(--accent-tint);
  border-radius:var(--r-lg);padding:18px 20px;box-shadow:var(--sh-xs)}
.ov-next-k{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  color:var(--accent-ink)}
.ov-next-title{margin-top:4px;font-size:19px;font-weight:700;color:var(--ink-primary)}
.ov-next-hint{margin-top:4px;font-size:13px;color:var(--ink-secondary)}
.ov-next-btn{margin-top:12px;padding:10px 20px;border:none;border-radius:var(--r-md);
  background:var(--accent);color:var(--ink-onAccent);font:inherit;font-weight:700;cursor:pointer;
  box-shadow:var(--sh-sm)}
.ov-next-btn:hover{background:var(--accent-hover)}
.ov-next-side{margin-top:12px;font-size:12.5px;font-weight:600;color:var(--accent-ink)}
.ov-next-link{margin:var(--sp-3) 0 0 var(--sp-3);padding:0;border:none;background:none;
  font:inherit;font-size:var(--fs-sm);font-weight:600;color:var(--accent-ink);cursor:pointer;
  border-bottom:1px solid transparent;transition:border-color var(--dur-1) var(--ease-out)}
.ov-next-link:hover{border-bottom-color:var(--accent-ink)}
.ov-next-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.ov-next-link{transition:none}}
.ov-card{background:var(--bg-panel);border:1px solid var(--line-hair);
  border-radius:var(--r-lg);padding:16px 18px;box-shadow:var(--sh-xs)}
.ov-h3{margin:0 0 10px;font-size:14px;font-weight:700;color:var(--ink-primary)}
.ov-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.ov-ck{display:flex;align-items:flex-start;gap:12px;padding:12px 13px;
  border:1px solid var(--line-soft);border-radius:var(--r-md);background:var(--bg-app)}
.ov-ck.done{background:var(--ok-tint);border-color:var(--ok-line)}
.ov-mark{flex:none;width:22px;height:22px;border-radius:var(--r-pill);
  display:grid;place-items:center;font-size:13px;font-weight:800;
  background:var(--bg-sunken);border:1px solid var(--line-strong);color:transparent}
.ov-ck.done .ov-mark{background:var(--ok);border-color:var(--ok);color:#fff}
.ov-ck-body{flex:1 1 auto;min-width:0}
.ov-ck-label{font-size:14px;font-weight:600;color:var(--ink-primary);
  display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ov-state{font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:var(--r-pill);
  background:var(--warn-tint);color:var(--warn-ink);border:1px solid var(--warn-line)}
.ov-ck.done .ov-state{background:transparent;border-color:var(--ok-line);color:var(--ok-ink)}
.ov-ck-note{margin-top:4px;font-size:12px;color:var(--ink-secondary);line-height:1.55}
.ov-cta{flex:none;align-self:center;padding:8px 14px;border-radius:var(--r-md);
  border:1px solid var(--accent);background:var(--accent-tint);color:var(--accent-ink);
  font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.ov-cta:hover{background:var(--accent-tint)}
.ov-cta.primary{background:var(--accent);border-color:var(--accent);color:var(--ink-onAccent);font-weight:700;
  box-shadow:var(--sh-sm);transition:background var(--dur-1) var(--ease-out)}
.ov-cta.primary:hover{background:var(--accent-hover)}
.ov-cta.primary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.ov-cta.primary{transition:none}}
.ov-empty{text-align:center;padding:48px 20px;color:var(--ink-secondary)}
.ov-empty-h{font-size:17px;font-weight:700;color:var(--ink-primary);margin-bottom:8px}
.ov-empty p{font-size:13px;line-height:1.7;margin:0}
.ov-foot{font-size:12px;color:var(--ink-tertiary);line-height:1.6;margin:2px 4px 0}
.ov-foot b{color:var(--ink-secondary);font-weight:600}
@media(max-width:640px){
  .ov-head{display:block;padding:14px}
  .ov-id{margin-bottom:12px}
  .ov-id,.ov-prov{min-width:0;width:auto}
  .ov-next,.ov-card{padding:14px}
  .ov-name{font-size:19px}
  .ov-ck{flex-wrap:wrap}
  .ov-cta{width:100%;margin-top:8px}
  .ov-next-btn{width:100%}
}
`;

function injectStyle() {
  if (document.getElementById('ov-style')) return;
  const s = document.createElement('style');
  s.id = 'ov-style';
  s.textContent = OV_CSS;
  document.head.appendChild(s);
}

export function mountOverview(el, opts = {}) {
  injectStyle();
  const getState = opts.getState || (() => ({}));
  const getProject = opts.getProject || (async () => null);
  const switchTo = opts.switchTo || (() => {});
  const toast = opts.toast || (() => {});

  const root = document.createElement('div');
  root.className = 'ov';
  el.innerHTML = '';
  el.appendChild(root);

  async function api(url, o) {
    const r = await fetch(url, o);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }

  function derive(st, prov) {
    const sub = (prov && prov.provenance && prov.provenance.subtrees) || {};
    const isReal = (k) => sub[k] === 'imported' || sub[k] === 'interview';
    const isGen = (k) => sub[k] === 'generated';
    const realPct = prov && prov.provenance
      ? Math.round((prov.provenance.confidence || 0) * 100) : 0;
    return {
      project: st.project || null,
      template: (prov && prov.provenance && prov.provenance.template_id) || '—',
      realPct,
      summary: (prov && prov.provenance_summary) || '',
      sub,
      hasProject: !!st.project,
      hasData: !!st.hasData || realPct > 0,
      hasItems: isReal('items') || isGen('items'),
      hasRun: !!st.hasRun,
    };
  }

  function nextAction(d) {
    if (!d.hasProject) return { title: 'プロジェクトを作成', hint: '左サイドバーで名前とテンプレを選んで「作成」。', target: null, act: null };
    if (!d.hasData) return { title: '顧客データを取り込む', hint: '左の「表データ(CSV/Excel)を取込」や ZIP ドロップへ。', target: 'dataanalysis', act: null };
    if (!d.hasItems) return { title: '不足データを生成', hint: '実データから商品マスタ等を補完します。', target: null, act: 'generate' };
    if (!d.hasRun) return {
      title: '設計を始める', hint: 'レイアウト・工程・人員を組んで試算へ。先に物量を確認するなら「分析」へ。',
      nav: 'bi', primaryLabel: '設計を始める →',
      secondary: { nav: 'dataanalysis', label: '分析を見る →' },
      target: null, act: null,
    };
    return { title: '結果を確認して提案へ', hint: '「分析」で読み解き、「提案PNG/エクスポート」へ。', target: 'analysis', act: null };
  }

  function checklist(d) {
    return [
      { key: 'data', label: '顧客データ取込済み？', ok: d.hasData,
        ctaLabel: 'データ分析へ', target: 'dataanalysis',
        note: '左サイドバーの「表データ(CSV/Excel)を取込」「ZIPをドロップ」「CAD/地図/棚間距離」から取込。' },
      { key: 'items', label: '商品マスタ有り／不足データ生成済み？', ok: d.hasItems,
        ctaLabel: '不足データを生成', act: 'generate',
        note: '左サイドバーの「不足データを生成」でも実行できます。' },
      { key: 'run', label: 'シミュレーション実行済み？', ok: d.hasRun,
        ctaLabel: null, target: null,
        note: '左サイドバーの「▶ シミュレーション実行」を押してください。' },
    ];
  }

  async function runGenerate(btn) {
    const st = getState();
    if (!st.project) { toast('先にプロジェクトを作成してください。', 'info'); return; }
    if (btn) { btn.disabled = true; btn.dataset.l = btn.textContent; btn.textContent = '生成中…'; }
    try {
      const r = await api(`/api/projects/${st.project}/generate-missing`, { method: 'POST' });
      const n = (r.generated && r.generated.length) || 0;
      toast(n ? '不足データを生成しました。' : '生成できる不足データはありませんでした。', n ? 'ok' : 'info');
      await render();
    } catch (e) {
      toast('生成に失敗しました: ' + e.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.l || '不足データを生成'; }
    }
  }

  async function render() {
    const st = getState();
    if (!st.project) {
      root.innerHTML =
        `<div class="ov-empty">
           <div class="ov-empty-h">プロジェクトがまだありません</div>
           <p>左サイドバーで名前とテンプレートを選び「作成」してください。<br>
              取り込み（ZIP/CSV/CAD/MapMaker）はすべて左サイドバーにあります。</p>
         </div>`;
      return;
    }
    let prov = null;
    try { prov = await getProject(); } catch (_e) { /* fall back to provisional render */ }
    const d = derive(st, prov);
    const na = nextAction(d);
    const items = checklist(d);

    const pct = Math.max(0, Math.min(100, d.realPct));
    const chips = Object.keys(SUBTREE_JP).map((k) => {
      const v = d.sub[k];
      const cls = (v === 'imported' || v === 'interview') ? 'real'
        : v === 'generated' ? 'gen' : 'prov';
      const t = (v === 'imported' || v === 'interview') ? '実データ'
        : v === 'generated' ? '生成' : '仮値';
      return `<span class="ov-chip ${cls}">${SUBTREE_JP[k]}<i>${t}</i></span>`;
    }).join('');

    const listHtml = items.map((it) => {
      const cta = it.ok ? ''
        : it.act === 'generate'
          ? `<button class="ov-cta primary" data-act="generate">不足データを生成</button>`
          : it.target
            ? `<button class="ov-cta" data-go="${it.target}">${esc(it.ctaLabel)} →</button>`
            : '';
      return `<li class="ov-ck ${it.ok ? 'done' : 'todo'}">
        <span class="ov-mark" aria-hidden="true">${it.ok ? '✓' : ''}</span>
        <div class="ov-ck-body">
          <div class="ov-ck-label">${esc(it.label)}
            <span class="ov-state">${it.ok ? '済' : '未'}</span></div>
          ${it.ok ? '' : `<div class="ov-ck-note">${esc(it.note)}</div>`}
        </div>
        ${cta}
      </li>`;
    }).join('');

    root.innerHTML =
      `<div class="ov-head">
         <div class="ov-id">
           <div class="ov-name">${esc(d.project)}</div>
           <div class="ov-tmpl">テンプレート: <b>${esc(d.template)}</b></div>
         </div>
         <div class="ov-prov" title="${esc(d.summary)}" aria-live="polite">
           <div class="ov-prov-pct">実データ <b>${pct}%</b></div>
           <div class="ov-meter"><span style="width:${pct}%"></span></div>
           <div class="ov-chips">${chips}</div>
         </div>
       </div>

       <section class="ov-next">
         <div class="ov-next-k">次にやること</div>
         <div class="ov-next-title">${esc(na.title)}</div>
         <div class="ov-next-hint">${esc(na.hint)}</div>
         ${na.nav
           ? `<button class="ov-next-btn" data-nav="${esc(na.nav)}">${esc(na.primaryLabel || (na.title + ' →'))}</button>`
             + (na.secondary
               ? `<button class="ov-next-link" data-nav="${esc(na.secondary.nav)}">${esc(na.secondary.label)}</button>`
               : '')
           : na.act === 'generate'
             ? `<button class="ov-next-btn" data-act="generate">不足データを生成</button>`
             : na.target
               ? `<button class="ov-next-btn" data-go="${na.target}">${esc(na.title)}へ進む →</button>`
               : `<div class="ov-next-side">← 左サイドバーで操作してください</div>`}
       </section>

       <section class="ov-card">
         <h3 class="ov-h3">準備状況チェックリスト</h3>
         <ul class="ov-list">${listHtml}</ul>
       </section>

       <p class="ov-foot">取り込み操作（ZIP / 表データ / CAD / MapMaker地図 / 棚間距離 / 不足生成）は
         <b>左サイドバー</b>にまとまっています。このホームは状況の確認と次の一手の案内です。</p>`;

    wire();
  }

  function wire() {
    root.querySelectorAll('[data-go]').forEach((b) => {
      b.onclick = () => switchTo(b.dataset.go);
    });
    root.querySelectorAll('[data-nav]').forEach((b) => {
      b.onclick = () => document.dispatchEvent(
        new CustomEvent('whsim:nav', { detail: { view: b.dataset.nav } }));
    });
    root.querySelectorAll('[data-act="generate"]').forEach((b) => {
      b.onclick = () => runGenerate(b);
    });
  }

  render();
  return { refresh() { render(); }, dispose() { el.innerHTML = ''; } };
}
