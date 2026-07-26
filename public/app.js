/**
 * LIFF ミニアプリ。
 *
 * 体感速度のための設計:
 *  - チェックは楽観更新。押した瞬間に線が引かれ、通信は後追い。店内は電波が
 *    悪いので、待たせないことが最優先。
 *  - 描画はキー付きの差分更新。4秒ごとのポーリングで DOM を作り直すと、
 *    進行中のアニメーションが消え、スクロール位置も飛ぶ。
 *  - 楽観更新の取り消しは「サーバの値が追いつくまで保持」。押した直後に
 *    リロードして自分の更新を消してしまう事故を防ぐ。
 *  - 入力中は再描画しない。
 */

const POLL_MS = 4000;
const COMBO_WINDOW_MS = 8000;
const COMBO_THRESHOLD = 3;

const state = {
  idToken: null,
  households: [],
  householdId: null,
  listId: null,
  groups: [],
  /** 送信中のチェック操作。サーバの値が追いつくまで保持する。 */
  pending: new Map(),
  /** 完了して畳んだ売り場を、利用者が手で開き直したもの */
  expanded: new Set(),
  polling: null,
  /** タイマー: elapsed = Date.now() - anchor */
  anchor: null,
  pace: { bestSecondsPerItem: null, previousSecondsPerItem: null, trips: 0 },
  ticker: null,
  combo: 0,
  lastCheckAt: 0,
  wasComplete: false,
};

const el = {
  boot: document.getElementById('boot'),
  app: document.getElementById('app'),
  household: document.getElementById('household'),
  timer: document.getElementById('timer'),
  refresh: document.getElementById('refresh'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  ghost: document.getElementById('ghost'),
  progressText: document.getElementById('progress-text'),
  raceHint: document.getElementById('race-hint'),
  routeHint: document.getElementById('route-hint'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  suggestCount: document.getElementById('suggest-count'),
  suggestions: document.getElementById('suggestions'),
  addForm: document.getElementById('add-form'),
  addInput: document.getElementById('add-input'),
  catalogList: document.getElementById('catalog-suggestions'),
  complete: document.getElementById('complete'),
  combo: document.getElementById('combo'),
  toast: document.getElementById('toast'),
  groupTemplate: document.getElementById('group-template'),
  itemTemplate: document.getElementById('item-template'),
};

/** 生きている DOM ノード。差分更新のためにキーで引けるようにしておく。 */
const itemNodes = new Map(); // itemId -> { li, main, name, meta, checked }
const groupNodes = new Map(); // category -> { section, title, name, count, ul }

// ---------- 小物 ----------

function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 対応していない端末では何もしない (iOS はここに来る)
  }
}

/** 変わったときだけ書く。無駄な再レイアウトを避ける。 */
function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

let toastTimer = null;
function toast(message, variant) {
  el.toast.textContent = message;
  el.toast.className = variant ? `toast ${variant}` : 'toast';
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, variant === 'record' ? 4200 : 2600);
}

// ---------- 通信 ----------

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.idToken}`,
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) throw new Error('認証が切れました。開き直してください。');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `通信に失敗しました (${response.status})`);
  }
  return response.json();
}

// ---------- 表示 ----------

function isChecked(item) {
  return state.pending.has(item.id) ? state.pending.get(item.id) : item.checked;
}

function formatMeta(item) {
  const parts = [];
  if (item.quantity !== null && item.quantity !== undefined) {
    parts.push(`${item.quantity}${item.unit ?? ''}`);
  } else if (item.unit) {
    parts.push(item.unit);
  }
  if (item.note) parts.push(item.note);
  // 原文の併記は「解析が言い換えてしまった」ときだけ。
  // 「牛乳2本」→ 名前「牛乳」+ 数量「2本」で足りているので出さない。
  if (item.raw && !item.raw.includes(item.name)) parts.push(`「${item.raw}」`);
  return parts.join(' · ');
}

function createItemNode(itemId) {
  const fragment = el.itemTemplate.content.cloneNode(true);
  const node = {
    li: fragment.querySelector('.item'),
    main: fragment.querySelector('.item-main'),
    name: fragment.querySelector('.item-name'),
    meta: fragment.querySelector('.item-meta'),
    checked: false,
    item: null,
  };
  node.li.dataset.id = itemId;
  node.main.addEventListener('click', () => toggleItem(node, !node.checked));
  fragment
    .querySelector('.item-remove')
    .addEventListener('click', () => removeItem(itemId, node.item?.name ?? ''));
  itemNodes.set(itemId, node);
  return node;
}

function createGroupNode(category) {
  const fragment = el.groupTemplate.content.cloneNode(true);
  const node = {
    section: fragment.querySelector('.group'),
    title: fragment.querySelector('.group-title'),
    name: fragment.querySelector('.group-name'),
    count: fragment.querySelector('.group-count'),
    ul: fragment.querySelector('.items'),
  };
  node.title.addEventListener('click', () => {
    if (state.expanded.has(category)) state.expanded.delete(category);
    else state.expanded.add(category);
    renderList();
  });
  groupNodes.set(category, node);
  return node;
}

/** 目的の位置に無いときだけ動かす。毎回 append すると再生中の遷移が飛ぶ。 */
function placeAfter(parent, node, previous) {
  const expected = previous ? previous.nextElementSibling : parent.firstElementChild;
  if (expected !== node) parent.insertBefore(node, expected);
}

function renderList() {
  const total = state.groups.reduce((sum, group) => sum + group.items.length, 0);
  if (total === 0) {
    for (const node of itemNodes.values()) node.li.remove();
    itemNodes.clear();
    for (const node of groupNodes.values()) node.section.remove();
    groupNodes.clear();
    el.empty.hidden = false;
    el.complete.disabled = true;
    el.complete.classList.remove('ready');
    setComplete(false);
    updateProgress(0, 0);
    return;
  }
  el.empty.hidden = true;

  const liveGroups = new Set();
  const liveItems = new Set();
  let done = 0;
  let previousSection = null;

  for (const group of state.groups) {
    liveGroups.add(group.category);
    const groupNode = groupNodes.get(group.category) ?? createGroupNode(group.category);
    placeAfter(el.list, groupNode.section, previousSection);
    previousSection = groupNode.section;

    let doneInGroup = 0;
    let previousItem = null;

    for (const item of group.items) {
      liveItems.add(item.id);
      const node = itemNodes.get(item.id) ?? createItemNode(item.id);
      placeAfter(groupNode.ul, node.li, previousItem);
      previousItem = node.li;

      node.item = item;
      setText(node.name, item.name);
      setText(node.meta, formatMeta(item));
      node.li.classList.toggle('uncertain', Boolean(item.uncertain));

      const checked = isChecked(item);
      if (node.checked !== checked) {
        node.checked = checked;
        node.li.classList.toggle('checked', checked);
        node.main.setAttribute('aria-pressed', String(checked));
      }
      if (checked) {
        doneInGroup += 1;
        done += 1;
      }
    }

    setText(groupNode.name, group.label);
    setText(groupNode.count, `${doneInGroup}/${group.items.length}`);

    // 売り場を1つ終えるたびに畳む。リストが目に見えて短くなるのが手応えになる。
    const finished = doneInGroup === group.items.length;
    const collapsed = finished && !state.expanded.has(group.category);
    groupNode.section.classList.toggle('done', finished);
    groupNode.section.classList.toggle('collapsed', collapsed);
    groupNode.title.setAttribute('aria-expanded', String(!collapsed));
  }

  for (const [id, node] of itemNodes) {
    if (liveItems.has(id)) continue;
    node.li.remove();
    itemNodes.delete(id);
  }
  for (const [category, node] of groupNodes) {
    if (liveGroups.has(category)) continue;
    node.section.remove();
    groupNodes.delete(category);
  }

  el.complete.disabled = done === 0;
  updateProgress(done, total);
  setComplete(done === total);
}

function setComplete(complete) {
  el.complete.classList.toggle('ready', complete);
  el.complete.textContent = complete ? '🏁 ゴール' : '買い物を終える';
  el.progressBar.classList.toggle('finished', complete);

  if (complete && !state.wasComplete) buzz([24, 50, 24, 50, 60]);
  state.wasComplete = complete;
}

function updateProgress(done, total) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  el.progressFill.style.width = `${percent}%`;
  setText(
    el.progressText,
    total === 0 ? 'リストは空です' : `残り ${total - done} 件 / 全 ${total} 件`,
  );
  updateGhost(done, total);
}

/**
 * ゴーストランナー。自己ベストのペースなら今どこにいるはずかを示し、
 * リードしているか遅れているかを出す。
 */
function updateGhost(done, total) {
  const best = state.pace.bestSecondsPerItem;
  const started = state.anchor !== null;

  if (!started || total === 0) {
    el.ghost.hidden = true;
    el.raceHint.hidden = true;
    return;
  }

  if (best === null) {
    el.ghost.hidden = true;
    el.raceHint.hidden = false;
    el.raceHint.className = 'race-hint';
    setText(el.raceHint, '今回が基準タイムになります');
    return;
  }

  const elapsed = Date.now() - state.anchor;
  const ghostItems = Math.max(0, Math.min(total, elapsed / 1000 / best));
  el.ghost.hidden = false;
  el.ghost.style.left = `${(ghostItems / total) * 100}%`;

  const lead = done - ghostItems;
  el.raceHint.hidden = false;
  if (lead >= 0.5) {
    el.raceHint.className = 'race-hint ahead';
    setText(el.raceHint, `ベストより ${Math.floor(lead)}件リード`);
  } else if (lead <= -0.5) {
    el.raceHint.className = 'race-hint behind';
    setText(el.raceHint, `ベストより ${Math.ceil(-lead)}件ビハインド`);
  } else {
    el.raceHint.className = 'race-hint';
    setText(el.raceHint, 'ベストと互角');
  }
}

function updateRouteHint(route) {
  if (!route) {
    el.routeHint.hidden = true;
    return;
  }
  el.routeHint.hidden = false;
  el.routeHint.classList.toggle('learned', route.learned);
  setText(
    el.routeHint,
    route.learned
      ? 'あなたの回り方に合わせて並べています'
      : route.trips === 0
        ? '消し込んだ順番から売り場の並びを覚えます'
        : `売り場の並びを学習中（あと ${route.remaining} 回）`,
  );
}

// ---------- タイマー ----------

function startTicker() {
  if (state.ticker) return;
  state.ticker = setInterval(tick, 1000);
  tick();
}

function tick() {
  if (state.anchor === null) {
    el.timer.hidden = true;
    return;
  }
  el.timer.hidden = false;
  setText(el.timer, formatDuration(Date.now() - state.anchor));

  const total = state.groups.reduce((sum, group) => sum + group.items.length, 0);
  const done = state.groups
    .flatMap((group) => group.items)
    .filter(isChecked).length;
  updateGhost(done, total);

  const best = state.pace.bestSecondsPerItem;
  if (best !== null && total > 0) {
    const ghostItems = (Date.now() - state.anchor) / 1000 / best;
    el.timer.classList.toggle('ahead', done - ghostItems >= 0.5);
    el.timer.classList.toggle('behind', done - ghostItems <= -0.5);
  }
}

/**
 * 計測の起点をサーバ時刻から決める。端末の時計がズレていても、
 * サーバが返す経過時間を錨にすれば表示はズレない。
 */
function anchorFrom(elapsedMs, startedAt) {
  if (startedAt === null || startedAt === undefined) {
    state.anchor = null;
    el.timer.hidden = true;
    return;
  }
  const next = Date.now() - (elapsedMs ?? 0);
  // 1秒以上ズレたときだけ直す。毎回書き換えると表示が細かく震える。
  if (state.anchor === null || Math.abs(next - state.anchor) > 1000) state.anchor = next;
  startTicker();
}

// ---------- 操作 ----------

function showBurst(node) {
  const burst = document.createElement('span');
  burst.className = 'burst';
  burst.textContent = '+1';
  node.li.appendChild(burst);
  burst.addEventListener('animationend', () => burst.remove(), { once: true });
}

function bumpCombo() {
  const now = Date.now();
  state.combo = now - state.lastCheckAt < COMBO_WINDOW_MS ? state.combo + 1 : 1;
  state.lastCheckAt = now;

  if (state.combo < COMBO_THRESHOLD) return;
  el.combo.textContent = `${state.combo} COMBO!`;
  el.combo.hidden = false;
  // アニメーションを最初から流し直す
  el.combo.style.animation = 'none';
  void el.combo.offsetWidth;
  el.combo.style.animation = '';
  el.combo.addEventListener(
    'animationend',
    () => {
      el.combo.hidden = true;
    },
    { once: true },
  );
  buzz([12, 30, 12]);
}

async function toggleItem(node, checked) {
  const itemId = node.li.dataset.id;

  // 先に画面を動かす。通信の往復は待たない。
  state.pending.set(itemId, checked);
  renderList();

  if (checked) {
    buzz(12);
    showBurst(node);
    bumpCombo();
  } else {
    state.combo = 0;
  }

  try {
    const result = await api(`/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ checked }),
    });
    // 最初の1件でタイマーが回り出す。次のポーリングを待たせない。
    if (result.startedAt && state.anchor === null) {
      anchorFrom(0, result.startedAt);
      loadList().catch(() => {});
    }
  } catch (error) {
    state.pending.delete(itemId); // 巻き戻す
    renderList();
    toast(error.message);
  }
}

async function removeItem(itemId, name) {
  try {
    await api(`/items/${itemId}`, { method: 'DELETE' });
    toast(`${name} を外しました`);
    await loadList();
  } catch (error) {
    toast(error.message);
  }
}

async function addItem(rawInput) {
  const value = rawInput.trim();
  if (!value) return;
  try {
    await api('/lists/items', {
      method: 'POST',
      body: JSON.stringify({ householdId: state.householdId, name: value }),
    });
    el.addInput.value = '';
    await loadList();
  } catch (error) {
    toast(error.message);
  }
}

/** 完了時の結果表示。押した甲斐があったと分かるように。 */
function raceMessage(result) {
  const parts = [`${result.purchased}件`];
  const race = result.race;

  if (race && race.durationMs > 0) parts.push(formatDuration(race.durationMs));
  if (result.carriedOver.length > 0) parts.push(`${result.carriedOver.length}件持ち越し`);

  if (race?.counted && race.isPersonalBest) {
    return { text: `🏆 ${parts.join(' / ')} 自己ベスト更新!`, variant: 'record' };
  }
  if (race?.counted && race.deltaVsBest !== null) {
    parts.push(`ベストまで あと${Math.abs(Math.round(race.deltaVsBest))}秒/件`);
  } else if (result.promoted?.length > 0) {
    parts.push(result.promoted.map((p) => `${p.name}→${p.label}`).join('、'));
  } else if (result.route && !result.route.learned) {
    parts.push(`順路はあと${result.route.remaining}回`);
  }
  return { text: parts.join(' / '), variant: null };
}

async function completeShopping() {
  if (!state.listId) return;
  const confirmed = window.confirm(
    'チェックしたものを購入済みとして記録します。\n未チェックのものは次のリストに残ります。',
  );
  if (!confirmed) return;

  try {
    const result = await api(`/lists/${state.listId}/complete`, { method: 'POST' });
    const { text, variant } = raceMessage(result);
    toast(text, variant);
    if (variant === 'record') buzz([30, 60, 30, 60, 90]);

    state.anchor = null;
    state.combo = 0;
    state.expanded.clear();
    await loadList();
    await loadSuggestions();
  } catch (error) {
    toast(error.message);
  }
}

// ---------- 読み込み ----------

/** サーバの値が追いついた楽観更新を捨てる。追いつくまでは保持する。 */
function reconcilePending(groups) {
  for (const group of groups) {
    for (const item of group.items) {
      if (state.pending.get(item.id) === item.checked) state.pending.delete(item.id);
    }
  }
}

async function loadList() {
  const data = await api(`/lists/active?householdId=${encodeURIComponent(state.householdId)}`);
  state.listId = data.list?.id ?? null;
  reconcilePending(data.groups);
  state.groups = data.groups;
  if (data.race) {
    state.pace = data.race.pace ?? state.pace;
    anchorFrom(data.race.elapsedMs, data.race.startedAt);
  }
  renderList();
  updateRouteHint(data.route);
}

async function loadSuggestions() {
  try {
    const data = await api(`/suggestions?householdId=${encodeURIComponent(state.householdId)}`);
    renderSuggestions(data);
  } catch {
    // 提案は無くても買い物はできる。黙って諦める。
  }
}

function renderSuggestions(data) {
  el.suggestions.textContent = '';
  const entries = [
    ...data.suggestions.map((item) => ({ ...item, kind: 'suggest' })),
    ...data.usual
      .filter((usual) => !data.suggestions.some((s) => s.id === usual.id))
      .map((item) => ({ ...item, kind: 'usual', reason: 'いつも買っています' })),
  ];

  el.suggestCount.hidden = entries.length === 0;
  el.suggestCount.textContent = String(entries.length);

  if (entries.length === 0) {
    const note = document.createElement('p');
    note.className = 'suggestions-empty';
    note.textContent =
      '履歴がたまると、切れそうなものと定番をここに出します。買い物を「終える」たびに学習します。';
    el.suggestions.appendChild(note);
    return;
  }

  for (const entry of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';

    const label = document.createElement('span');
    label.textContent = `＋ ${entry.name}`;
    chip.appendChild(label);

    if (entry.reason) {
      const reason = document.createElement('span');
      reason.className = 'chip-reason';
      reason.textContent = entry.reason;
      chip.appendChild(reason);
    }

    chip.addEventListener('click', async () => {
      if (chip.classList.contains('added')) return;
      chip.classList.add('added');
      buzz(10);
      try {
        await api('/lists/items/bulk', {
          method: 'POST',
          body: JSON.stringify({ householdId: state.householdId, catalogItemIds: [entry.id] }),
        });
        toast(`${entry.name} を追加しました`);
        await loadList();
      } catch (error) {
        chip.classList.remove('added');
        toast(error.message);
      }
    });

    el.suggestions.appendChild(chip);
  }
}

async function loadCatalog() {
  try {
    const data = await api(`/catalog?householdId=${encodeURIComponent(state.householdId)}`);
    el.catalogList.textContent = '';
    for (const item of data.items) {
      const option = document.createElement('option');
      option.value = item.name;
      el.catalogList.appendChild(option);
    }
  } catch {
    // 補完が出ないだけなので無視
  }
}

function startPolling() {
  stopPolling();
  state.polling = setInterval(async () => {
    if (document.hidden) return;
    if (document.activeElement === el.addInput) return;
    try {
      await loadList();
    } catch {
      // 一時的な失敗は次の周期で回復する
    }
  }, POLL_MS);
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
  if (state.ticker) clearInterval(state.ticker);
  state.ticker = null;
}

async function switchHousehold(householdId) {
  state.householdId = householdId;
  state.pending.clear();
  state.expanded.clear();
  state.anchor = null;
  localStorage.setItem('householdId', householdId);
  await loadList();
  await Promise.all([loadSuggestions(), loadCatalog()]);
}

// ---------- 起動 ----------

function showError(message) {
  el.boot.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = message;
  p.style.padding = '0 32px';
  p.style.textAlign = 'center';
  p.style.lineHeight = '1.7';
  el.boot.appendChild(p);
}

async function main() {
  try {
    const config = await (await fetch('/liff-config.json')).json();
    if (!config.liffId) throw new Error('LIFF_ID が設定されていません。');

    await liff.init({ liffId: config.liffId });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    state.idToken = liff.getIDToken();
    if (!state.idToken) throw new Error('ログイン情報を取得できませんでした。');

    const { households } = await api('/households');
    if (households.length === 0) {
      showError(
        'まだリストがありません。\nLINEのトークで一度なにか送ってから開き直してください。',
      );
      return;
    }

    state.households = households;
    const saved = localStorage.getItem('householdId');
    state.householdId = households.some((h) => h.id === saved) ? saved : households[0].id;

    for (const household of households) {
      const option = document.createElement('option');
      option.value = household.id;
      option.textContent = household.name;
      option.selected = household.id === state.householdId;
      el.household.appendChild(option);
    }
    el.household.hidden = households.length <= 1;

    await switchHousehold(state.householdId);

    el.boot.hidden = true;
    el.app.hidden = false;
    startPolling();
  } catch (error) {
    console.error(error);
    showError(error.message ?? '起動に失敗しました。');
  }
}

el.household.addEventListener('change', (event) => {
  switchHousehold(event.target.value).catch((error) => toast(error.message));
});

el.refresh.addEventListener('click', () => {
  loadList().catch((error) => toast(error.message));
  loadSuggestions();
});

el.addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  addItem(el.addInput.value);
});

el.complete.addEventListener('click', completeShopping);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.householdId) {
    loadList().catch(() => {});
  }
});

window.addEventListener('pagehide', stopPolling);

main();
