/**
 * LIFF ミニアプリ。
 *
 * 設計上のポイント:
 *  - チェックは楽観更新。押した瞬間に線が引かれ、通信は後追い。
 *    店内は電波が悪いので、待たせない方が体感が段違いによい。
 *  - 4秒ごとにポーリングして相手の変更を取り込む。画面が背面のときは止める。
 *  - 入力中・スクロール中は再描画しない (取りこぼしのストレスを避ける)。
 */

const state = {
  idToken: null,
  households: [],
  householdId: null,
  listId: null,
  groups: [],
  updatedAt: 0,
  /** 送信中のチェック操作。ポーリング結果で上書きされないように保持する。 */
  pending: new Map(),
  polling: null,
};

const el = {
  boot: document.getElementById('boot'),
  app: document.getElementById('app'),
  household: document.getElementById('household'),
  refresh: document.getElementById('refresh'),
  progressBar: document.querySelector('#progress-bar > span'),
  progressText: document.getElementById('progress-text'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  suggestPanel: document.getElementById('suggest-panel'),
  suggestCount: document.getElementById('suggest-count'),
  suggestions: document.getElementById('suggestions'),
  addForm: document.getElementById('add-form'),
  addInput: document.getElementById('add-input'),
  catalogList: document.getElementById('catalog-suggestions'),
  complete: document.getElementById('complete'),
  toast: document.getElementById('toast'),
  groupTemplate: document.getElementById('group-template'),
  itemTemplate: document.getElementById('item-template'),
};

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
  if (response.status === 401) {
    throw new Error('認証が切れました。画面を開き直してください。');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `通信に失敗しました (${response.status})`);
  }
  return response.json();
}

// ---------- 表示 ----------

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

function formatMeta(item) {
  const parts = [];
  if (item.quantity !== null && item.quantity !== undefined) {
    parts.push(`${item.quantity}${item.unit ?? ''}`);
  } else if (item.unit) {
    parts.push(item.unit);
  }
  if (item.note) parts.push(item.note);
  // 原文が名前と違うときだけ併記する。妻の書き方をそのまま見せたい。
  if (item.raw && item.raw !== item.name && !parts.includes(item.raw)) {
    parts.push(`「${item.raw}」`);
  }
  return parts.join(' · ');
}

function renderList() {
  el.list.textContent = '';

  const total = state.groups.reduce((sum, group) => sum + group.items.length, 0);
  if (total === 0) {
    el.empty.hidden = false;
    el.complete.disabled = true;
    updateProgress(0, 0);
    return;
  }
  el.empty.hidden = true;

  let done = 0;
  const fragment = document.createDocumentFragment();

  for (const group of state.groups) {
    const groupNode = el.groupTemplate.content.cloneNode(true);
    groupNode.querySelector('.group-title').textContent = group.label;
    const ul = groupNode.querySelector('.items');

    for (const item of group.items) {
      const checked = state.pending.has(item.id) ? state.pending.get(item.id) : item.checked;
      if (checked) done += 1;

      const node = el.itemTemplate.content.cloneNode(true);
      const li = node.querySelector('.item');
      li.dataset.id = item.id;
      li.classList.toggle('checked', checked);
      li.classList.toggle('uncertain', Boolean(item.uncertain));

      node.querySelector('.item-name').textContent = item.name;
      node.querySelector('.item-meta').textContent = formatMeta(item);

      const main = node.querySelector('.item-main');
      main.setAttribute('aria-pressed', String(checked));
      main.addEventListener('click', () => toggleItem(item.id, !checked));

      node
        .querySelector('.item-remove')
        .addEventListener('click', () => removeItem(item.id, item.name));

      ul.appendChild(node);
    }
    fragment.appendChild(groupNode);
  }

  el.list.appendChild(fragment);
  el.complete.disabled = done === 0;
  updateProgress(done, total);
}

function updateProgress(done, total) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  el.progressBar.style.width = `${percent}%`;
  el.progressText.textContent =
    total === 0 ? 'リストは空です' : `残り ${total - done} 件 / 全 ${total} 件`;
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

// ---------- 操作 ----------

async function toggleItem(itemId, checked) {
  state.pending.set(itemId, checked);
  renderList();
  try {
    await api(`/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ checked }),
    });
  } catch (error) {
    toast(error.message);
  } finally {
    state.pending.delete(itemId);
  }
  await loadList();
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
  // 「牛乳2本」のような入力はサーバ側の解析には通さず、そのまま名前として送る。
  // 数量の切り出しはサーバの追加APIではなくLINE経由の解析の仕事なので、
  // ここでは素直に1件として登録する。
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

async function completeShopping() {
  if (!state.listId) return;
  const confirmed = window.confirm(
    'チェックしたものを購入済みとして記録します。\n未チェックのものは次のリストに残ります。',
  );
  if (!confirmed) return;

  try {
    const result = await api(`/lists/${state.listId}/complete`, { method: 'POST' });
    const carried = result.carriedOver.length;
    toast(
      carried > 0
        ? `${result.purchased}件を記録。${carried}件を次に持ち越しました`
        : `${result.purchased}件を記録しました。お疲れさま`,
    );
    await loadList();
    await loadSuggestions();
  } catch (error) {
    toast(error.message);
  }
}

// ---------- 読み込み ----------

async function loadList() {
  const data = await api(`/lists/active?householdId=${encodeURIComponent(state.householdId)}`);
  state.listId = data.list?.id ?? null;
  state.groups = data.groups;
  state.updatedAt = data.updatedAt ?? 0;
  renderList();
}

async function loadSuggestions() {
  try {
    const data = await api(`/suggestions?householdId=${encodeURIComponent(state.householdId)}`);
    renderSuggestions(data);
  } catch {
    // 提案は無くても買い物はできる。黙って諦める。
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
  }, 4000);
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

async function switchHousehold(householdId) {
  state.householdId = householdId;
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
