// phasehint.js — per-phase navigation banner: goal + next action + empty state.
// Self-contained module. Renders a slim one-line banner at the top of each phase
// showing the phase's objective (left) and the "next move" CTA button (right).
// When the phase has no data yet, an empty-state message is surfaced instead.
// Code/comments in English; user-facing strings in Japanese.

const PHASES = {
  intake: {
    subtitle: '案件を作り顧客データを取り込む',
    ctaText: 'データを分析する →',
    ctaTargetView: 'dataanalysis',
    empty: 'プロジェクトを作成し、出荷データ（CSV/Excel）を取り込んでください。',
  },
  analyze: {
    subtitle: '物量・波動・ABCを把握する',
    ctaText: 'レイアウトを設計 →',
    ctaTargetView: 'design',
    empty: '出荷データがまだありません。①取込でデータを読み込むと自動分析が始まります。',
  },
  design: {
    subtitle: 'レイアウトと工程・人員を組む',
    ctaText: 'シミュレーションを実行 →',
    ctaTargetView: null, // run action → opts.onRun()
    empty: 'レイアウト・棚種別・動線を置くと、必要工数と人員配分を試算します。',
  },
  validate: {
    subtitle: '捌けるかをKPIと動きで確認',
    ctaText: '提案をまとめる →',
    ctaTargetView: 'viewpng',
    empty: 'まだ実行結果がありません。③設計で『シミュレーション実行』を押してください。',
  },
  propose: {
    subtitle: '提案書とシナリオ比較を出す',
    ctaText: '提案書を書き出す →',
    ctaTargetView: 'export',
    empty: '検証が完了すると、提案PNG・シナリオ比較・提案書を出力できます。',
  },
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function injectStyle() {
  if (document.getElementById('ph-style')) return;
  const s = document.createElement('style');
  s.id = 'ph-style';
  s.textContent = `
  .ph{display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;
    background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-left:4px solid var(--accent,#2f7bff);border-radius:var(--r-lg);
    padding:var(--sp-3) var(--sp-4);margin:0 auto var(--sp-3);max-width:1100px;width:100%}
  .ph[hidden]{display:none}
  .ph-goal{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
  .ph-sub{font-size:14px;font-weight:600;color:var(--ink-primary,#16202e);line-height:1.4}
  .ph-empty{font-size:12.5px;color:var(--ink-secondary,#52677c);line-height:1.55}
  .ph.is-empty{border-left-color:var(--ink-tertiary,#8195a8)}
  .ph.is-empty .ph-sub{color:var(--ink-secondary,#52677c);font-weight:600;font-size:13px}
  .ph-cta{flex:none;padding:9px 18px;border-radius:var(--r-md);border:none;cursor:pointer;
    background:var(--accent,#2f7bff);color:#04222c;font:inherit;font-weight:700;font-size:13.5px;
    white-space:nowrap;transition:background var(--dur-1) var(--ease-out),transform var(--dur-1) var(--ease-out)}
  .ph-cta:hover{background:var(--accent-hover,#1A73CE);transform:translateY(-1px)}
  .ph-cta:active{transform:translateY(0)}
  .ph-cta:focus-visible{outline:2px solid var(--accent,#2f7bff);outline-offset:2px}
  @media (prefers-reduced-motion: reduce){
    .ph-cta{transition:none}
    .ph-cta:hover,.ph-cta:active{transform:none}
  }
  @media (max-width:640px){
    .ph{align-items:stretch}
    .ph-goal{flex-basis:100%}
    .ph-cta{width:100%}
  }
  `;
  document.head.appendChild(s);
}

export function mountPhaseHint(el, opts = {}) {
  injectStyle();
  const onCta = opts.onCta || (() => {});
  const onRun = opts.onRun || (() => {});

  const root = document.createElement('div');
  root.className = 'ph';
  root.hidden = true;

  const goal = document.createElement('div');
  goal.className = 'ph-goal';

  const sub = document.createElement('div');
  sub.className = 'ph-sub';

  const empty = document.createElement('div');
  empty.className = 'ph-empty';
  empty.setAttribute('aria-live', 'polite');
  empty.hidden = true;

  goal.appendChild(sub);
  goal.appendChild(empty);

  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'ph-cta';

  root.appendChild(goal);
  root.appendChild(cta);

  el.innerHTML = '';
  el.appendChild(root);

  let current = null;

  cta.onclick = () => {
    const p = current && PHASES[current];
    if (!p) return;
    if (current === 'design') onRun();
    else if (p.ctaTargetView) onCta(p.ctaTargetView);
  };

  function show(phaseId, { empty: isEmpty = false } = {}) {
    const p = PHASES[phaseId];
    if (!p) { hide(); return; }
    current = phaseId;

    sub.textContent = p.subtitle;
    cta.textContent = p.ctaText;

    root.classList.toggle('is-empty', !!isEmpty);
    empty.hidden = !isEmpty;
    empty.textContent = isEmpty ? p.empty : '';

    const showCta = phaseId === 'design' ? !isEmpty : !!p.ctaTargetView;
    cta.hidden = !showCta;

    root.hidden = false;
  }

  function hide() {
    root.hidden = true;
    current = null;
  }

  function dispose() {
    cta.onclick = null;
    el.innerHTML = '';
    current = null;
  }

  return { show, hide, dispose };
}
