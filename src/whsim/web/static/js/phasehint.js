// phasehint.js — per-phase navigation banner: goal + next action + empty state.
// Self-contained module. Renders a slim one-line banner at the top of each phase
// showing the phase's objective (left) and the "next move" CTA button (right).
// When the phase has no data yet, an empty-state message is surfaced instead.
// Code/comments in English; user-facing strings in Japanese.
import { esc } from './util.js';

// Per-phase banner copy. `subtitle` = the page's purpose in one plain sentence
// ("why am I here"); `ctaText` = the concrete next move that NAMES the next phase
// so the 動線 (where this leads) is obvious; `empty` = what to do first when the
// phase has no data yet.
// An EMPTY phase gets its own CTA (`emptyCtaText`/`emptyCtaTargetView`): the
// forward button must never promise a screen that has nothing on it. ②分析 with
// no data sends you back to ①取込 to fix the cause, not on to ③設計.
const PHASES = {
  intake: {
    subtitle: '案件を作り、顧客の出荷データを取り込む',
    ctaText: '②分析でデータを読み解く →',
    ctaTargetView: 'dataanalysis',
    empty: 'まず案件（プロジェクト）を作り、出荷データ（CSV/Excel）を取り込みます。',
  },
  analyze: {
    subtitle: '物量・波動・ABCを読み解き、設計の根拠をつかむ',
    ctaText: '③設計でレイアウトを描く →',
    ctaTargetView: 'design',
    empty: '出荷データがまだありません。①取込で読み込むと、ここで自動分析が始まります。',
    emptyCtaText: '①取込でデータを読み込む →',
    emptyCtaTargetView: 'overview',
  },
  design: {
    subtitle: 'レイアウト・工程・人員を組み立てる',
    ctaText: '④検証へ：シミュレーションを実行 →',
    ctaTargetView: null, // run action → opts.onRun()
    empty: '「棚」モードで保管棚を配置しましょう（棚を描く／一括生成／面積オート生成、設備パレットで棚種別を選択）。①取込でMapMakerレイアウトを読み込めば、そのまま編集できます。',
  },
  validate: {
    subtitle: '設計で本当に捌けるかを、KPIと動きで確かめる',
    ctaText: '⑤提案へ：結果をまとめる →',
    ctaTargetView: 'viewpng',
    empty: 'まだ実行結果がありません。『▶ シミュレーション実行』を押すと、捌けるかをここで確認できます。',
  },
  propose: {
    subtitle: '提案PNG・シナリオ比較・提案書で顧客に見せる',
    ctaText: '提案書（PPTX/PDF）を書き出す →',
    ctaTargetView: 'export',
    empty: '④検証で実行すると、提案PNG・シナリオ比較・提案書を出力できます。',
    emptyCtaText: '④検証でシミュレーションを実行 →',
    emptyCtaTargetView: 'analysis',
  },
};


function injectStyle() {
  if (document.getElementById('ph-style')) return;
  const s = document.createElement('style');
  s.id = 'ph-style';
  s.textContent = `
  .ph{display:flex;align-items:center;gap:var(--sp-3);flex-wrap:wrap;
    background:var(--bg-panel,#f7f6f3);border:1px solid var(--line,rgba(120,140,170,.18));
    border-left:4px solid var(--accent,#16C0DE);border-radius:var(--r-lg);
    padding:var(--sp-3) var(--sp-4);margin:0 auto var(--sp-3);max-width:1100px;width:100%}
  .ph[hidden]{display:none}
  .ph-goal{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
  .ph-sub{font-size:14px;font-weight:600;color:var(--ink-primary,#16202e);line-height:1.4}
  .ph-empty{font-size:12.5px;color:var(--ink-secondary,#52677c);line-height:1.55}
  .ph.is-empty{border-left-color:var(--ink-tertiary,#8195a8)}
  .ph.is-empty .ph-sub{color:var(--ink-secondary,#52677c);font-weight:600;font-size:13px}
  .ph-cta{flex:none;padding:9px 18px;border-radius:var(--r-md);border:none;cursor:pointer;
    background:var(--accent,#16C0DE);color:#04222c;font:inherit;font-weight:700;font-size:13.5px;
    white-space:nowrap;transition:background var(--dur-1) var(--ease-out),transform var(--dur-1) var(--ease-out)}
  .ph-cta:hover{background:var(--accent-hover,#1A73CE);transform:translateY(-1px)}
  .ph-cta:active{transform:translateY(0)}
  .ph-cta:focus-visible{outline:2px solid var(--accent,#16C0DE);outline-offset:2px}
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
  let currentEmpty = false;

  cta.onclick = () => {
    const p = current && PHASES[current];
    if (!p) return;
    // 実行はフェーズ境界のアクション: ③設計のCTA、および④検証が未実行のときのCTA。
    if (current === 'design' || (current === 'validate' && currentEmpty)) onRun();
    else if (currentEmpty && p.emptyCtaTargetView) onCta(p.emptyCtaTargetView);
    else if (p.ctaTargetView) onCta(p.ctaTargetView);
  };

  function show(phaseId, { empty: isEmpty = false, desc = '' } = {}) {
    const p = PHASES[phaseId];
    if (!p) { hide(); return; }
    current = phaseId;
    currentEmpty = !!isEmpty;

    // ONE line, not two. It used to print 「<phase goal> ・ <view desc>」, which
    // on ②分析 read 「…読み解き、設計の根拠をつかむ ・ …物量の全体像をつかむ」 —
    // the same sentence twice. The phase goal already sits under the active pill
    // in the rail, so the banner carries the finer-grained line (what THIS view
    // does) and falls back to the phase goal only when a view has no blurb.
    sub.textContent = desc || p.subtitle;
    // ④検証が未実行のときは、CTA自体を実行アクションにする(結果が無いのに
    // 「提案をまとめる」と促さない)。空フェーズは原因を直しに戻す文言を優先。
    const runCta = phaseId === 'validate' && isEmpty;
    cta.textContent = runCta ? '▶ シミュレーション実行'
      : (isEmpty && p.emptyCtaText) ? p.emptyCtaText : p.ctaText;

    root.classList.toggle('is-empty', !!isEmpty);
    empty.hidden = !isEmpty;
    empty.textContent = isEmpty ? p.empty : '';

    // CTAの可視性: ③設計はレイアウトがある時のみ、④検証は常時(未実行=実行 /
    // 実行済=次へ)、その他はターゲットビューがある時。
    const showCta = phaseId === 'design' ? !isEmpty
      : phaseId === 'validate' ? true
      : !!(isEmpty && p.emptyCtaTargetView ? p.emptyCtaTargetView : p.ctaTargetView);
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
