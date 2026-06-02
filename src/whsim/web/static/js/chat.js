// chat.js — Cody conversational UI for the whsim warehouse simulator.
//
// A ChatGPT / Claude-style thread where a non-technical user talks to the
// "Cody" mascot in Japanese, and Cody DRIVES the app: creates projects, runs
// simulations, opens views, compares scenarios. The natural-language parse
// happens server-side (POST /api/cody/chat returns an `intent` + `params`);
// this module turns that intent into concrete calls on `opts.actions` and
// renders the results inline as compact cards.
//
// Public API:
//   mountChat(targetEl, opts) -> controller
//     opts.getProject():            string|null
//     opts.avatarSVG(mood):         string  (inline SVG markup; from cody.js)
//     opts.onMood(mood, say?):      void    (reflect mood on floating mascot)
//     opts.actions: {
//       listTemplates(): Promise<[{template_id,name}]>
//       createProject(name, template): Promise<void>
//       runSim(): Promise<object>
//       openView(view): void
//       runScenarios(): Promise<object>
//       getAnalysis(): Promise<object>
//     }
//   controller: { el, focus(), reset(), addCody(text,{mood}), destroy() }
//
// Self-contained vanilla ES module: no framework, no build step, no own CSS
// (the shell owner ships the styles). Defensive throughout — any fetch or
// action failure surfaces as a friendly Cody error bubble, never a silent
// throw. User text is set via textContent only (no raw-HTML injection).

// ---- small helpers ---------------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v, decimals = 0) {
  if (!isNum(v)) return '—';
  return v.toFixed(decimals);
}

// Yen with thousands separators (mirrors export.js / compare.js idiom).
function yen(v, decimals = 0) {
  if (!isNum(v)) return '—';
  const fixed = v.toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '¥' + sign + grouped + (frac ? '.' + frac : '');
}

const VALID_MOODS = [
  'idle', 'thinking', 'typing', 'success', 'error', 'curious', 'excited', 'sleeping',
];

function safeMood(m) {
  return VALID_MOODS.indexOf(m) >= 0 ? m : 'idle';
}

// Default empty-state suggestion chips.
const DEFAULT_SUGGESTS = [
  'ECの小さな倉庫を作って',
  '実行して結果を見せて',
  '繁忙期と比べたら？',
  'AGVを入れたら？',
];

const GREETING_TITLE = '倉庫のこと、なんでも聞いて。';
const GREETING_SUB = 'やりたいことを話すだけ。Codyが倉庫を作って、動かして、結果を見せるよ。';

// History turns sent to the endpoint (sliding window).
const HISTORY_TURNS = 8;

// ---- main mount -------------------------------------------------------------

export function mountChat(targetEl, opts = {}) {
  const target = typeof targetEl === 'string' ? document.querySelector(targetEl) : targetEl;
  if (!target) {
    throw new Error('mountChat: target element not found');
  }

  const o = opts && typeof opts === 'object' ? opts : {};
  const actions = (o.actions && typeof o.actions === 'object') ? o.actions : {};

  // ---- state ----
  const history = []; // [{ role:'user'|'cody', text }]
  let started = false; // false => empty state; true => thread layout
  let busy = false; // awaiting endpoint / running an action
  let destroyed = false;
  // A name the user just typed in response to a "プロジェクト名は？" prompt.
  let pendingCreate = null; // { template } when we asked for a name inline

  // ---- DOM scaffold ----
  const root = document.createElement('div');
  root.className = 'chat-view';

  // Empty state (centered hero + composer + suggests). Built once; toggled.
  const empty = document.createElement('div');
  empty.className = 'chat-empty';

  const hero = document.createElement('div');
  hero.className = 'chat-hero';
  setSVG(hero, safeAvatar('idle'));

  const heroTitle = document.createElement('div');
  heroTitle.className = 'chat-hero-title';
  heroTitle.textContent = GREETING_TITLE;

  const heroSub = document.createElement('div');
  heroSub.className = 'chat-hero-sub';
  heroSub.textContent = GREETING_SUB;

  empty.appendChild(hero);
  empty.appendChild(heroTitle);
  empty.appendChild(heroSub);

  // Thread (scroll area). Hidden until the first message.
  const thread = document.createElement('div');
  thread.className = 'chat-thread';
  thread.hidden = true;

  // Suggestion chips (shared row; lives just above the composer).
  const suggests = document.createElement('div');
  suggests.className = 'chat-suggests';

  // Composer.
  const composer = document.createElement('form');
  composer.className = 'chat-composer';

  const input = document.createElement('textarea');
  input.className = 'chat-input';
  input.rows = 1;
  input.setAttribute('placeholder', 'Codyに話しかけてみよう…');
  input.setAttribute('aria-label', 'メッセージを入力');

  const send = document.createElement('button');
  send.className = 'chat-send';
  send.type = 'submit';
  send.setAttribute('aria-label', '送信');
  send.textContent = '送信';

  composer.appendChild(input);
  composer.appendChild(send);

  // Empty state holds hero; the suggests + composer sit at the bottom of root
  // in the thread layout. For the empty state, ChatGPT-style, the composer and
  // suggests are visually part of the centered block, so we place them inside
  // `empty` initially and relocate them to root once the thread starts.
  empty.appendChild(composer);
  empty.appendChild(suggests);

  root.appendChild(empty);
  root.appendChild(thread);

  target.appendChild(root);

  // ---- helpers bound to this instance ----

  function safeAvatar(mood) {
    try {
      const fn = o.avatarSVG;
      if (typeof fn === 'function') {
        const s = fn(safeMood(mood));
        if (typeof s === 'string') return s;
      }
    } catch (_e) { /* ignore */ }
    return '';
  }

  // Set inline SVG markup safely-ish: the avatar SVG is trusted (from cody.js),
  // user text is never routed through here.
  function setSVG(el, markup) {
    el.innerHTML = markup || '';
  }

  function callMood(mood, say) {
    try {
      if (typeof o.onMood === 'function') o.onMood(safeMood(mood), say);
    } catch (_e) { /* ignore */ }
  }

  function currentProject() {
    try {
      const fn = o.getProject;
      const n = typeof fn === 'function' ? fn() : null;
      return (typeof n === 'string' && n.trim()) ? n.trim() : null;
    } catch (_e) {
      return null;
    }
  }

  function scrollToBottom() {
    // Defer so layout has settled after the append.
    requestAnimationFrame(() => {
      if (!destroyed) thread.scrollTop = thread.scrollHeight;
    });
  }

  // Switch from the centered empty state to the thread layout. The composer
  // and suggests move out of `empty` and become persistent root children.
  function ensureStarted() {
    if (started) return;
    started = true;
    empty.hidden = true;
    thread.hidden = false;
    // Relocate composer + suggests to the bottom of root (after thread).
    root.appendChild(suggests);
    root.appendChild(composer);
  }

  // ---- message rendering ----

  function appendUser(text) {
    ensureStarted();
    const msg = document.createElement('div');
    msg.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text; // textContent: no HTML injection
    msg.appendChild(bubble);
    thread.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function appendCody(text, mood) {
    ensureStarted();
    const msg = document.createElement('div');
    msg.className = 'msg cody';

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    setSVG(avatar, safeAvatar(mood || 'idle'));

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = typeof text === 'string' ? text : '';

    msg.appendChild(avatar);
    msg.appendChild(bubble);
    thread.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  // A compact result card, optionally severity-colored.
  function appendCard(title, bodyLines, severity) {
    ensureStarted();
    const card = document.createElement('div');
    card.className = 'chat-card';
    if (severity === 'ok' || severity === 'warn' || severity === 'bad') {
      card.classList.add(severity);
    }
    if (title) {
      const t = document.createElement('div');
      t.className = 'chat-card-title';
      t.textContent = title;
      card.appendChild(t);
    }
    const body = document.createElement('div');
    body.className = 'chat-card-body';
    const lines = Array.isArray(bodyLines) ? bodyLines : (bodyLines != null ? [bodyLines] : []);
    lines.forEach((line) => {
      const row = document.createElement('div');
      row.textContent = typeof line === 'string' ? line : String(line);
      body.appendChild(row);
    });
    card.appendChild(body);
    thread.appendChild(card);
    scrollToBottom();
    return card;
  }

  // Animated typing indicator (three dots). Returns the element so callers
  // can remove it when the reply / action completes.
  let typingEl = null;
  function showTyping() {
    if (typingEl) return typingEl;
    ensureStarted();
    const t = document.createElement('div');
    t.className = 'chat-typing';
    for (let i = 0; i < 3; i += 1) {
      t.appendChild(document.createElement('span'));
    }
    thread.appendChild(t);
    typingEl = t;
    scrollToBottom();
    return t;
  }

  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  function codyError(detail) {
    const msg = (typeof detail === 'string' && detail.trim()) ? detail.trim() : '何かに引っかかったみたい';
    callMood('error');
    appendCody(`エラー: ${msg}。直せるよ。`, 'error');
  }

  // ---- suggestion chips ----

  function renderSuggests(list) {
    suggests.textContent = '';
    const items = Array.isArray(list) && list.length ? list : DEFAULT_SUGGESTS;
    items.forEach((label) => {
      if (typeof label !== 'string' || !label.trim()) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-suggest';
      chip.textContent = label;
      chip.addEventListener('click', () => {
        if (busy) return;
        input.value = label;
        autoGrow();
        submit();
      });
      suggests.appendChild(chip);
    });
  }

  // ---- composer behaviour ----

  function autoGrow() {
    // Auto-grow up to ~5 lines.
    input.style.height = 'auto';
    const lineGuess = 22; // px per line fallback
    const maxH = lineGuess * 5 + 16;
    const next = Math.min(input.scrollHeight, maxH);
    input.style.height = next + 'px';
  }

  function setBusy(on) {
    busy = !!on;
    input.disabled = busy;
    send.disabled = busy;
  }

  // ---- endpoint + intent execution ----

  function historyPayload() {
    // Last ~8 turns, role normalized to 'user' | 'cody'.
    return history.slice(-HISTORY_TURNS).map((h) => ({ role: h.role, text: h.text }));
  }

  async function callEndpoint(message) {
    const body = {
      message,
      project: currentProject(),
      history: historyPayload(),
    };
    const res = await fetch('/api/cody/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`サーバーが応答しませんでした (${res.status})`);
    }
    const data = await res.json();
    return (data && typeof data === 'object') ? data : {};
  }

  // Generate a fallback project name when the user says "おまかせ".
  function generatedName() {
    return `cody-${Date.now()}`;
  }

  function wantsAuto(text) {
    if (typeof text !== 'string') return false;
    return /適当|おまかせ|お任せ|なんでも|何でも/.test(text);
  }

  // Resolve a project name for create_project from params / the raw message.
  function resolveCreateName(params, rawMessage) {
    if (params && typeof params.name === 'string' && params.name.trim()) {
      return params.name.trim();
    }
    if (wantsAuto(rawMessage)) return generatedName();
    return null;
  }

  // Execute the parsed intent. Returns a short follow-up line for Cody, or null.
  async function executeIntent(data, rawMessage) {
    const intent = data && typeof data.intent === 'string' ? data.intent : 'unknown';
    const params = (data && data.params && typeof data.params === 'object') ? data.params : {};
    const needs = Array.isArray(data && data.needs) ? data.needs : [];

    switch (intent) {
      case 'create_project':
        return execCreate(params, needs, rawMessage);
      case 'run':
        return execRun(false);
      case 'estimate':
        return execRun(true);
      case 'open_view':
        return execOpenView(params);
      case 'compare':
        return execCompare();
      // help / smalltalk / unknown: reply only, no action.
      default:
        return null;
    }
  }

  async function execCreate(params, needs, rawMessage) {
    const template = (params && typeof params.template === 'string' && params.template)
      ? params.template : 'ecommerce_small';

    // If a name is missing and still required, ask inline (do not execute).
    let name = resolveCreateName(params, rawMessage);
    if (!name && needs.indexOf('name') >= 0) {
      pendingCreate = { template };
      callMood('curious');
      return '倉庫の名前を教えて。「おまかせ」でもいいよ。';
    }
    if (!name) {
      // No explicit need, but nothing to name it with — fall back gracefully.
      pendingCreate = { template };
      callMood('curious');
      return '倉庫の名前は何にする？';
    }

    callMood('typing');
    if (typeof actions.createProject !== 'function') {
      throw new Error('プロジェクトを作成できませんでした');
    }
    await actions.createProject(name, template);
    pendingCreate = null;
    appendCard(`「${name}」を用意したよ`, [
      `テンプレート: ${template}`,
      'このまま「実行して」と言えば動かすよ。',
    ], 'ok');
    callMood('success');
    return null;
  }

  async function execRun(isEstimate) {
    if (!currentProject()) {
      callMood('curious');
      return 'まずは倉庫を作ろう。「ECの小さな倉庫を作って」みたいに話しかけてね。';
    }
    if (typeof actions.runSim !== 'function') {
      throw new Error('シミュレーションを実行できませんでした');
    }
    callMood('thinking');
    const result = await actions.runSim();
    const k = (result && typeof result === 'object') ? result : {};

    const can = k.can_handle_demand;
    const verdict = can === true ? '可' : (can === false ? '不可' : '—');
    const severity = can === true ? 'ok' : (can === false ? 'bad' : 'warn');

    const lines = [
      `スループット: ${isNum(k.throughput_per_hr) ? num(k.throughput_per_hr, 1) + ' 件/時' : '—'}`,
      `ボトルネック: ${(typeof k.bottleneck_jp === 'string' && k.bottleneck_jp) ? k.bottleneck_jp : '—'}`,
      `需要対応: ${verdict}`,
    ];
    if (isNum(k.total_cost_per_order)) {
      lines.push(`1件あたりコスト: ${yen(k.total_cost_per_order, 1)}`);
    }
    const title = isEstimate ? 'ざっくり試算の結果' : 'シミュレーション結果';
    appendCard(title, lines, severity);

    callMood(can === false ? 'curious' : 'success');
    if (isEstimate) {
      return 'これはざっくりした見立てだよ。詳しく見るなら「結果を見せて」と言ってね。';
    }
    return can === false
      ? 'いまの構成だと需要に追いつかないかも。AGVを入れたり人を増やして比べてみよう。'
      : '結果は問題なさそう。「比べて」で改善案も見られるよ。';
  }

  async function execOpenView(params) {
    const view = (params && typeof params.view === 'string' && params.view) ? params.view : 'analysis';
    if (typeof actions.openView === 'function') {
      actions.openView(view);
    }

    if (view === 'analysis') {
      let insight = null;
      if (typeof actions.getAnalysis === 'function') {
        try {
          const a = await actions.getAnalysis();
          insight = topInsight(a);
        } catch (_e) {
          insight = null;
        }
      }
      appendCard('分析を開いたよ', insight ? [insight] : ['分析タブを見てね。'], 'ok');
      callMood('success');
      return null;
    }

    appendCard('画面を切り替えたよ', [`「${viewLabel(view)}」を開いたよ。`], 'ok');
    callMood('success');
    return null;
  }

  async function execCompare() {
    if (!currentProject()) {
      callMood('curious');
      return '比較するには、先に倉庫を作って実行してね。';
    }
    if (typeof actions.runScenarios !== 'function') {
      throw new Error('シナリオを比較できませんでした');
    }
    callMood('thinking');
    await actions.runScenarios();
    if (typeof actions.openView === 'function') {
      actions.openView('compare');
    }
    appendCard('3シナリオを比較したよ', [
      '現行・提案などを並べて見られるよ。',
    ], 'ok');
    callMood('success');
    return '比較タブで、コストや人員の違いを確認してね。';
  }

  // Pull a single headline insight string out of an analysis payload.
  function topInsight(a) {
    if (!a || typeof a !== 'object') return null;
    // Common shapes: { insights:[{text}|string] }, { verdict }, { summary }.
    const ins = a.insights || a.findings || a.recommendations;
    if (Array.isArray(ins) && ins.length) {
      const first = ins[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (first && typeof first === 'object') {
        const t = first.text || first.title || first.message || first.label;
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
    }
    if (typeof a.verdict === 'string' && a.verdict.trim()) return a.verdict.trim();
    if (typeof a.summary === 'string' && a.summary.trim()) return a.summary.trim();
    const k = (a.kpis && typeof a.kpis === 'object') ? a.kpis : null;
    if (k && typeof k.bottleneck_jp === 'string' && k.bottleneck_jp) {
      return `ボトルネックは「${k.bottleneck_jp}」みたい。`;
    }
    return null;
  }

  function viewLabel(view) {
    const labels = {
      analysis: '分析',
      view2d: '2Dレイアウト',
      compare: '比較',
      design: '設計',
      export: 'エクスポート',
    };
    return labels[view] || view;
  }

  // ---- send flow ----

  async function submit() {
    if (busy || destroyed) return;
    const raw = input.value;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return;

    // Clear composer immediately.
    input.value = '';
    autoGrow();

    appendUser(text);
    history.push({ role: 'user', text });

    // If we previously asked for a project name, intercept this message as the
    // answer instead of re-parsing it as a fresh intent.
    // If we asked for a project name but the user typed a command instead,
    // cancel the pending create and handle the message as a normal turn —
    // otherwise the project would be named e.g. "実行して結果を見せて".
    if (pendingCreate && !wantsAuto(text)
        && /(実行|回し|回す|シミュ|動かし|比較|くらべ|比べ|結果|分析|レポート|キャンセル|やめ|中止)/.test(text)) {
      pendingCreate = null;
      const note = '作成はいったん保留にするね。';
      appendCody(note, 'idle');
      history.push({ role: 'cody', text: note });
      // fall through to the normal endpoint flow below
    } else if (pendingCreate) {
      const create = pendingCreate;
      pendingCreate = null;
      const name = wantsAuto(text) ? generatedName() : text;
      setBusy(true);
      callMood('thinking');
      showTyping();
      try {
        if (typeof actions.createProject !== 'function') {
          throw new Error('プロジェクトを作成できませんでした');
        }
        await actions.createProject(name, create.template);
        hideTyping();
        appendCard(`「${name}」を用意したよ`, [
          `テンプレート: ${create.template}`,
          'このまま「実行して」と言えば動かすよ。',
        ], 'ok');
        const follow = 'できたよ。次は「実行して結果を見せて」がおすすめ。';
        appendCody(follow, 'success');
        history.push({ role: 'cody', text: follow });
        callMood('success');
        renderSuggests(['実行して結果を見せて', '繁忙期と比べたら？', 'AGVを入れたら？']);
      } catch (err) {
        hideTyping();
        codyError(err && err.message);
        history.push({ role: 'cody', text: 'エラー' });
      } finally {
        setBusy(false);
        focus();
      }
      return;
    }

    setBusy(true);
    callMood('thinking');
    showTyping();

    let data;
    try {
      data = await callEndpoint(text);
    } catch (err) {
      hideTyping();
      codyError(err && err.message);
      history.push({ role: 'cody', text: 'エラー' });
      setBusy(false);
      focus();
      return;
    }

    hideTyping();

    // Cody's primary reply.
    const reply = (typeof data.reply === 'string' && data.reply) ? data.reply : 'うん、わかった。';
    const mood = safeMood(data.mood);
    appendCody(reply, mood);
    history.push({ role: 'cody', text: reply });
    callMood(mood, reply);

    // Execute the mapped action (if any) and surface a follow-up.
    let followUp = null;
    try {
      followUp = await executeIntent(data, text);
    } catch (err) {
      hideTyping();
      codyError(err && err.message);
      history.push({ role: 'cody', text: 'エラー' });
      setBusy(false);
      // Still refresh suggestions before bailing.
      renderSuggests(data && data.suggestions);
      focus();
      return;
    }

    if (followUp) {
      appendCody(followUp, undefined);
      history.push({ role: 'cody', text: followUp });
    }

    // Refresh suggestion chips from the response.
    renderSuggests(data && data.suggestions);

    setBusy(false);
    focus();
  }

  // ---- events ----

  function onSubmit(e) {
    if (e) e.preventDefault();
    submit();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onInput() {
    autoGrow();
  }

  composer.addEventListener('submit', onSubmit);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('input', onInput);

  // ---- controller API ----

  function focus() {
    if (!destroyed) {
      try { input.focus(); } catch (_e) { /* ignore */ }
    }
  }

  function reset() {
    history.length = 0;
    pendingCreate = null;
    hideTyping();
    thread.textContent = '';
    started = false;
    thread.hidden = true;
    empty.hidden = false;
    // Move composer + suggests back into the empty-state block.
    empty.appendChild(composer);
    empty.appendChild(suggests);
    input.value = '';
    autoGrow();
    setBusy(false);
    renderSuggests(DEFAULT_SUGGESTS);
  }

  function addCody(text, opts2 = {}) {
    const mood = opts2 && opts2.mood ? opts2.mood : 'idle';
    appendCody(text, mood);
    history.push({ role: 'cody', text: typeof text === 'string' ? text : '' });
  }

  function destroy() {
    destroyed = true;
    hideTyping();
    composer.removeEventListener('submit', onSubmit);
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('input', onInput);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  const controller = {
    el: root,
    focus,
    reset,
    addCody,
    destroy,
  };

  // ---- init ----
  renderSuggests(DEFAULT_SUGGESTS);
  autoGrow();

  return controller;
}

export default mountChat;
