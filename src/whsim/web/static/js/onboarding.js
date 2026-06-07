// onboarding.js — first-run experience for whsim.
//
// Three pieces, all dismissible and reduced-motion aware:
//   1) A "サンプルでためす" call-to-action injected into the chat home when no
//      projects exist yet — POSTs /api/projects/sample, opens it, toasts.
//   2) A one-line "3ステップ: 作る → 実行 → 提案書" hint under that CTA.
//   3) A subtle first-visit guide (a "?" help popover + coachmarks) explaining
//      作成 / 実行 / 分析 / 提案書, shown once via localStorage 'whsim-onboarded'.
//
// Backend contract (degrades gracefully on 404 / error):
//   POST /api/projects/sample  body { name? } -> { name, ready }
//
// Public API:
//   mountOnboarding(opts) -> controller
//     opts.toast(msg, kind?):       void
//     opts.openProject(name):       Promise   (refresh list + open)
//     opts.refreshProjects():       Promise   (re-read project list)
//     opts.hasProjects():           Promise<boolean>
//   controller: { maybeShowFirstRunCTA(), refreshCTA(), startGuide() }
//
// Vanilla ES module. No raw-HTML for any server/user string (textContent only).

// Versioned: bumping re-introduces the guide once to existing users. v3 refreshes
// the ③設計/④検証 copy to cover the new MapMaker shelf editor + realistic 3D.
const STORAGE_KEY = 'whsim-onboarded-v3';

const $ = (id) => document.getElementById(id);

function alreadyOnboarded() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (_e) { return false; }
}
function markOnboarded() {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_e) { /* ignore */ }
}

export function mountOnboarding(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const toast = typeof o.toast === 'function' ? o.toast : () => {};
  const openProject = typeof o.openProject === 'function' ? o.openProject : async () => {};
  const hasProjects = typeof o.hasProjects === 'function' ? o.hasProjects : async () => true;

  let ctaEl = null;
  let creating = false;

  // ---- first-run CTA (lives inside the chat empty-state hero) ---------------

  function removeCTA() {
    if (ctaEl && ctaEl.parentNode) ctaEl.parentNode.removeChild(ctaEl);
    ctaEl = null;
  }

  function buildCTA() {
    const wrap = document.createElement('div');
    wrap.className = 'onboard-cta';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary onboard-sample-btn';
    btn.textContent = '✨ サンプルでためす';
    btn.setAttribute('aria-label', 'サンプルの倉庫プロジェクトを作成して試す');
    btn.addEventListener('click', () => { runSample(btn); });

    const hint = document.createElement('div');
    hint.className = 'onboard-hint';
    hint.textContent = '3ステップ: 作る → 実行 → 提案書';

    wrap.appendChild(btn);
    wrap.appendChild(hint);
    return wrap;
  }

  async function runSample(btn) {
    if (creating) return;
    creating = true;
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>用意中…';
    try {
      const res = await fetch('/api/projects/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let detail = `サンプルを用意できませんでした (${res.status})`;
        try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (_e) { /* ignore */ }
        throw new Error(detail);
      }
      const data = await res.json().catch(() => ({}));
      const name = (data && typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : null;
      if (!name) throw new Error('サンプル名を取得できませんでした');
      await openProject(name);
      removeCTA();
      toast('デモを用意したよ', 'ok');
    } catch (err) {
      toast('サンプルの用意に失敗しました: ' + (err && err.message ? err.message : ''), 'error');
      btn.disabled = false;
      btn.textContent = label || '✨ サンプルでためす';
    } finally {
      creating = false;
    }
  }

  // Show the CTA in the chat hero iff there are no projects yet. Safe to call
  // repeatedly (e.g. after a project is created/deleted) — refreshCTA.
  async function refreshCTA() {
    let none = false;
    // Treat an unknown result as possibly-empty so the first-run next-step is
    // never silently dropped on a transient hasProjects() failure.
    try { none = !(await hasProjects()); } catch (_e) { none = true; }
    const hero = document.querySelector('.chat-empty');
    if (!none || !hero) { removeCTA(); return; }
    if (ctaEl && ctaEl.parentNode === hero) return; // already shown
    removeCTA();
    ctaEl = buildCTA();
    // Insert right after the sub-heading so it reads as the primary action.
    const sub = hero.querySelector('.chat-hero-sub');
    if (sub && sub.nextSibling) hero.insertBefore(ctaEl, sub.nextSibling);
    else hero.appendChild(ctaEl);
  }

  // ---- first-visit guide (help "?" button + coachmark popover) --------------

  // Targets to spotlight: the 5-phase journey pills (degrade to a centered card
  // when a selector isn't present yet — renderStep handles target === null).
  const STEPS = [
    { sel: '.jn-pill[data-phase="intake"]', title: '① 取込', text: '案件を作り、顧客データ（CSV/Excel/ZIP/CAD/MapMakerレイアウト）を取り込みます。読めない項目は飛ばすだけで止まりません。手元に無ければ「サンプルでためす」でOK。' },
    { sel: '.jn-pill[data-phase="analyze"]', title: '② 分析', text: '取り込んだ出荷データから物量・波動・ABCを自動分析。現状の事実をここで掴みます。' },
    { sel: '.jn-pill[data-phase="design"]', title: '③ 設計', text: 'レイアウトを描けます。「棚」モードで保管棚を自由配置（棚一括生成／面積オート生成）、設備パレットから棚種別（パレットラック等）を選択。描いた地図がそのまま動線になります。' },
    { sel: '.jn-pill[data-phase="validate"]', title: '④ 検証', text: 'シミュレーションを実行し、処理能力・コスト・混雑をKPIで確認。「3Dビュー」では本物そっくりの棚と作業者の動きをドラッグで自由に見渡せます。' },
    { sel: '.jn-pill[data-phase="propose"]', title: '⑤ 提案', text: '提案PNG・シナリオ比較・提案書（PPTX/PDF）を出力。「実データN%」も併記されます。' },
    { sel: '.jn-pin[data-view="chat"]', title: '横断: OCTA と 知見', text: 'どのフェーズでもOCTAに相談でき、気づきは「知見」に残せます。フェーズ動線とは別レーンでいつでも使えます。' },
  ];

  let overlay = null;
  let stepIdx = 0;
  let onResize = null;        // module-scoped so clearGuide can detach it
  let lastFocused = null;     // element focused before the guide opened

  function clearGuide() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKey, true);
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finishGuide(); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); nextStep(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevStep(); }
  }

  function finishGuide() {
    markOnboarded();
    clearGuide();
    // Restore focus to whatever was focused before the guide opened.
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch (_e) { /* ignore */ }
    }
    lastFocused = null;
  }

  function renderStep() {
    if (!overlay) return;
    const step = STEPS[stepIdx];
    const target = step ? document.querySelector(step.sel) : null;
    const card = overlay.querySelector('.coach-card');
    const spot = overlay.querySelector('.coach-spot');
    if (!card || !spot) return;

    // Title + body.
    card.querySelector('.coach-title').textContent = step.title;
    card.querySelector('.coach-text').textContent = step.text;
    card.querySelector('.coach-count').textContent = `${stepIdx + 1} / ${STEPS.length}`;
    const nextBtn = card.querySelector('.coach-next');
    nextBtn.textContent = stepIdx === STEPS.length - 1 ? '完了' : '次へ';
    const prevBtn = card.querySelector('.coach-prev');
    prevBtn.hidden = stepIdx === 0;

    // Position the spotlight + card near the target (fallback: centered).
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = 6;
      spot.style.display = 'block';
      spot.style.left = (r.left - pad) + 'px';
      spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px';
      spot.style.height = (r.height + pad * 2) + 'px';
      // Place the card below the target if room, else above.
      const below = r.bottom + 12;
      const cw = Math.min(300, window.innerWidth - 24);
      card.style.width = cw + 'px';
      let left = Math.min(Math.max(8, r.left), window.innerWidth - cw - 8);
      card.style.left = left + 'px';
      if (below + 160 < window.innerHeight) {
        card.style.top = below + 'px';
      } else {
        card.style.top = Math.max(8, r.top - 170) + 'px';
      }
    } else {
      spot.style.display = 'none';
      card.style.width = 'min(300px, calc(100vw - 24px))';
      card.style.left = '50%';
      card.style.top = '50%';
      card.style.transform = 'translate(-50%, -50%)';
    }
  }

  function nextStep() {
    if (stepIdx >= STEPS.length - 1) { finishGuide(); return; }
    stepIdx += 1;
    renderStep();
  }
  function prevStep() {
    if (stepIdx <= 0) return;
    stepIdx -= 1;
    renderStep();
  }

  function buildGuide() {
    const ov = document.createElement('div');
    ov.className = 'coach-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'はじめてのガイド');

    const scrim = document.createElement('div');
    scrim.className = 'coach-scrim';
    scrim.addEventListener('click', finishGuide);

    const spot = document.createElement('div');
    spot.className = 'coach-spot';

    const card = document.createElement('div');
    card.className = 'coach-card';
    // Announce title/text swaps as the user steps through the guide.
    card.setAttribute('aria-live', 'polite');

    const count = document.createElement('div');
    count.className = 'coach-count';

    const title = document.createElement('div');
    title.className = 'coach-title';

    const text = document.createElement('div');
    text.className = 'coach-text';

    const actions = document.createElement('div');
    actions.className = 'coach-actions';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'coach-skip';
    skip.textContent = 'スキップ';
    skip.addEventListener('click', finishGuide);

    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'coach-prev';
    prev.textContent = '戻る';
    prev.addEventListener('click', prevStep);

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'primary coach-next';
    next.textContent = '次へ';
    next.addEventListener('click', nextStep);

    actions.appendChild(skip);
    actions.appendChild(prev);
    actions.appendChild(next);

    card.appendChild(count);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(actions);

    ov.appendChild(scrim);
    ov.appendChild(spot);
    ov.appendChild(card);
    return ov;
  }

  function startGuide(force) {
    if (!force && alreadyOnboarded()) return;
    clearGuide();
    // Remember where focus was so finishGuide can restore it.
    lastFocused = document.activeElement;
    stepIdx = 0;
    overlay = buildGuide();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    // Defer so layout has settled before measuring targets, then move focus
    // into the dialog (Next button) so keyboard/SR users land inside it.
    requestAnimationFrame(() => {
      renderStep();
      const nextBtn = overlay && overlay.querySelector('.coach-next');
      if (nextBtn && typeof nextBtn.focus === 'function') {
        try { nextBtn.focus(); } catch (_e) { /* ignore */ }
      }
    });
    // Keep the spotlight aligned if the window resizes mid-guide. Stored in a
    // closure-scoped var so clearGuide() can detach it (no listener leak).
    onResize = () => { if (overlay) renderStep(); };
    window.addEventListener('resize', onResize);
  }

  // ---- help "?" button in the header tools ----------------------------------

  function mountHelpButton() {
    const tools = document.querySelector('.header-tools');
    if (!tools || $('helpBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'helpBtn';
    btn.type = 'button';
    btn.className = 'icon-btn help-btn';
    btn.textContent = '?';
    btn.title = '使い方ガイド';
    btn.setAttribute('aria-label', '使い方ガイドを開く');
    btn.addEventListener('click', () => startGuide(true));
    // Place it before the theme toggle.
    const theme = $('themeToggle');
    if (theme && theme.parentNode === tools) tools.insertBefore(btn, theme);
    else tools.appendChild(btn);
  }

  // ---- init -----------------------------------------------------------------

  mountHelpButton();

  async function maybeShowFirstRunCTA() {
    await refreshCTA();
  }

  return { maybeShowFirstRunCTA, refreshCTA, startGuide };
}

export default mountOnboarding;
