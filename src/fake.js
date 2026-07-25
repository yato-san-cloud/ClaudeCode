// インストールした「実物」のゲーム。
// 広告で見せたパズルは影も形もなく、ひたすらタマゴを合体させるだけの何か。
// ポップアップと全画面広告で操作の邪魔をし続ける。

import { sfx } from './sfx.js';

const BLOBS = [
  { emoji: '🥚', color: '#cbd5e1', name: 'タマゴ' },
  { emoji: '🐣', color: '#fcd34d', name: 'ヒナ' },
  { emoji: '🦎', color: '#86efac', name: 'トカゲ' },
  { emoji: '🐲', color: '#7dd3fc', name: 'コドラゴン' },
  { emoji: '🐉', color: '#c4b5fd', name: 'ドラゴン' },
  { emoji: '👑', color: '#fda4af', name: 'ドラゴン王' },
];

const COLS = 4;
const ROWS = 5;

/* ------------------------------------------------------------------ */
/* ポップアップ                                                        */
/* ------------------------------------------------------------------ */

export class Popups {
  constructor(veil) {
    this.veil = veil;
  }

  /** ポップアップを 1 枚出す。押されたボタンの value で解決する Promise を返す。 */
  show(spec) {
    sfx.popup();
    return new Promise((resolve) => {
      const pop = document.createElement('div');
      pop.className = 'pop';
      const done = (v) => {
        this.veil.classList.remove('on');
        this.veil.innerHTML = '';
        resolve(v);
      };

      if (spec.ribbon) {
        const r = document.createElement('div');
        r.className = 'ribbon';
        r.textContent = spec.ribbon;
        pop.append(r);
      }
      if (spec.closable !== false) {
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '✕';
        // 閉じるボタンは意図的に小さく、押しても一度は逃げる
        let dodged = 0;
        x.onclick = () => {
          if (dodged < 1) {
            dodged++;
            x.style.transform = `translate(${-14 - Math.random() * 10}px, ${8 + Math.random() * 8}px)`;
            return;
          }
          done('close');
        };
        pop.append(x);
      }

      const h = document.createElement('h3');
      h.innerHTML = spec.title;
      pop.append(h);

      if (spec.stars) {
        const s = document.createElement('div');
        s.className = 'stars';
        s.textContent = '★★★★★';
        pop.append(s);
      }
      if (spec.body) {
        const p = document.createElement('p');
        p.innerHTML = spec.body;
        pop.append(p);
      }
      if (spec.price) {
        const pr = document.createElement('div');
        pr.className = 'price';
        pr.innerHTML = (spec.was ? `<span class="was">${spec.was}</span>` : '') + spec.price;
        pop.append(pr);
      }
      if (spec.timer) {
        const t = document.createElement('div');
        t.className = 'timer';
        pop.append(t);
        let left = spec.timer;
        const tick = () => {
          const m = String(Math.floor(left / 60)).padStart(2, '0');
          const s2 = String(left % 60).padStart(2, '0');
          t.textContent = `⏳ 残り ${m}:${s2}`;
          // 減らない。ときどき増える
          if (left > 0 && Math.random() < 0.25) left += 1;
        };
        tick();
        const iv = setInterval(tick, 1000);
        pop.addEventListener('remove', () => clearInterval(iv));
        setTimeout(() => clearInterval(iv), 120000);
      }

      const stack = document.createElement('div');
      stack.className = 'stack';
      for (const b of spec.buttons) {
        const btn = document.createElement('button');
        btn.className = `btn ${b.cls ?? ''}`;
        btn.innerHTML = b.label;
        btn.onclick = () => done(b.value ?? b.label);
        stack.append(btn);
      }
      pop.append(stack);

      if (spec.note) {
        const n = document.createElement('div');
        n.className = 'tiny';
        n.style.marginTop = '8px';
        n.innerHTML = spec.note;
        pop.append(n);
      }

      this.veil.innerHTML = '';
      this.veil.append(pop);
      this.veil.classList.add('on');
    });
  }

  async queue(specs) {
    for (const s of specs) await this.show(s);
  }
}

/* ------------------------------------------------------------------ */
/* 全画面広告                                                          */
/* ------------------------------------------------------------------ */

const AD_SLOTS = [
  { bg: 'linear-gradient(160deg,#ff6b6b,#c92a2a)', icon: '🎰', big: '今すぐ回せ！', sub: '登録不要・完全無料' },
  { bg: 'linear-gradient(160deg,#4dabf7,#1864ab)', icon: '🏰', big: '城を守れ！', sub: '99%が失敗する防衛バトル' },
  { bg: 'linear-gradient(160deg,#69db7c,#2b8a3e)', icon: '💰', big: '1日3分で', sub: 'あなたの畑が金鉱に' },
  { bg: 'linear-gradient(160deg,#da77f2,#862e9c)', icon: '🧩', big: 'IQ 140以上のみ', sub: 'クリアできるパズル' },
];

export class Interstitial {
  constructor(el) {
    this.el = el;
    this.count = 0;
  }

  /** 1 回の広告表示。カウントダウンはズルをし、×は 1 回逃げる。 */
  play() {
    this.count++;
    const slot = AD_SLOTS[(this.count - 1) % AD_SLOTS.length];
    return new Promise((resolve) => {
      this.el.innerHTML = '';
      this.el.style.background = slot.bg;

      const label = document.createElement('div');
      label.className = 'adlabel';
      label.textContent = '広告';

      const count = document.createElement('div');
      count.className = 'adcount';

      const body = document.createElement('div');
      body.className = 'adbody';
      body.innerHTML =
        `<div class="spin">${slot.icon}</div>` +
        `<div><div class="big">${slot.big}</div><div style="opacity:.85;margin-top:6px">${slot.sub}</div></div>` +
        `<button class="btn cta" style="max-width:240px">今すぐインストール</button>`;

      const close = document.createElement('button');
      close.className = 'adclose';
      close.textContent = '✕';
      close.style.top = '6px';
      close.style.right = '34px';
      close.style.display = 'none';

      this.el.append(label, count, body, close);
      this.el.classList.add('on');

      // 5→4→4→3→4→3→2→1 と、進んだり戻ったりする
      const seq = [5, 4, 4, 3, 4, 3, 2, 1, 0];
      let i = 0;
      count.textContent = `${seq[0]} 秒後にスキップ`;
      const iv = setInterval(() => {
        i++;
        if (i >= seq.length) {
          clearInterval(iv);
          count.textContent = 'スキップ可能';
          close.style.display = 'grid';
          return;
        }
        count.textContent = `${seq[i]} 秒後にスキップ`;
      }, 620);

      let dodged = 0;
      close.onclick = () => {
        if (dodged < 1) {
          dodged++;
          close.style.top = 'auto';
          close.style.bottom = '8px';
          close.style.right = '8px';
          return;
        }
        clearInterval(iv);
        this.el.classList.remove('on');
        this.el.innerHTML = '';
        resolve();
      };

      body.querySelector('button').onclick = () => {
        // 「インストール」を押しても何も起きない。広告が 1 枚増えるだけ
        body.querySelector('.big').textContent = '読み込み中…';
      };
    });
  }
}

/* ------------------------------------------------------------------ */
/* マージゲーム本体                                                    */
/* ------------------------------------------------------------------ */

export class MergeGame {
  constructor(root, { popups, interstitial, onRefund, toast }) {
    this.root = root;
    this.popups = popups;
    this.ads = interstitial;
    this.onRefund = onRefund;
    this.toast = toast;

    this.cells = new Array(COLS * ROWS).fill(null);
    this.sel = -1;
    this.energy = 5;
    this.gems = 0;
    this.coins = 0;
    this.level = 1;
    this.merges = 0;
    this.actions = 0;
    this.lockTaps = 0;
    this.busy = false;
    this.tab = 'home';

    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="hud">
        <span class="chip lv">Lv.<b id="fg-lv">1</b></span>
        <span class="chip">⚡<b id="fg-en">5</b>/5</span>
        <span class="chip">💎<b id="fg-gem">0</b></span>
        <span class="grow"></span>
        <span class="chip">🪙<b id="fg-coin">0</b></span>
      </div>
      <div class="board" id="fg-board"></div>
      <div class="gameactions">
        <button class="btn buy" id="fg-spawn">タマゴを生む (⚡1)</button>
      </div>
      <div class="nav">
        <button class="on" data-tab="home"><i>🏠</i>ホーム</button>
        <button data-tab="puzzle"><i>🧩</i>パズル<span class="badge">🔒</span></button>
        <button data-tab="gacha"><i>🎁</i>ガチャ</button>
        <button data-tab="shop"><i>🛒</i>ショップ</button>
        <button data-tab="config"><i>⚙️</i>設定</button>
      </div>`;

    this.boardEl = this.root.querySelector('#fg-board');
    for (let i = 0; i < COLS * ROWS; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.onclick = () => this.tapSlot(i);
      this.boardEl.append(s);
    }
    this.root.querySelector('#fg-spawn').onclick = () => this.spawn();
    for (const b of this.root.querySelectorAll('.nav button')) {
      b.onclick = () => this.goTab(b.dataset.tab, b);
    }
    this.render();
  }

  /** 起動直後の連続ポップアップ。これが「実物」の第一印象。 */
  async intro() {
    this.busy = true;
    await this.popups.show({
      ribbon: '🎉 初回限定 🎉',
      title: 'ようこそ、王よ！',
      body: 'いま始めると<b>スターターパック</b>が<br>特別価格で手に入ります',
      was: '¥3,200',
      price: '¥120',
      timer: 599,
      buttons: [{ label: '今すぐ購入する', cls: 'buy' }, { label: 'あとで', cls: 'ghost' }],
    });
    await this.popups.show({
      ribbon: 'おすすめ',
      title: '⭐ VIPパス ⭐',
      body: '広告なし・毎日💎100・自動マージ<br>いつでも解約できます',
      price: '¥980 / 月',
      buttons: [{ label: '3日間無料ではじめる', cls: 'buy' }, { label: 'いいえ、広告を見ます', cls: 'ghost' }],
    });
    await this.popups.show({
      title: 'ログインボーナス 1日目',
      body: '🪙 50 を受け取りました！<br>7日連続で💎1000！',
      buttons: [{ label: '受け取る', cls: 'buy' }],
      closable: false,
    });
    this.coins += 50;
    await this.popups.show({
      title: '通知を許可しますか？',
      body: 'スタミナ全回復・イベント開始・<br>フレンド申請・その他のお知らせ',
      buttons: [{ label: '許可', cls: 'buy' }, { label: '許可', cls: 'ghost' }],
      note: 'どちらを選んでも許可されます',
    });
    this.render();
    this.busy = false;
    this.hand(this.root.querySelector('#fg-spawn'), 'ここをタップ！');
  }

  hand(target, text) {
    this.clearHand();
    if (!target) return;
    const h = document.createElement('div');
    h.className = 'tutorhand';
    h.textContent = '👆';
    const r = target.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    const scale = rr.width / this.root.offsetWidth;
    h.style.left = `${(r.left - rr.left) / scale + r.width / scale / 2}px`;
    h.style.top = `${(r.top - rr.top) / scale + 6}px`;
    this.root.append(h);
    this._hand = h;
    if (text) this.toast(text);
  }

  clearHand() {
    if (this._hand) { this._hand.remove(); this._hand = null; }
  }

  render() {
    this.root.querySelector('#fg-lv').textContent = this.level;
    this.root.querySelector('#fg-en').textContent = this.energy;
    this.root.querySelector('#fg-gem').textContent = this.gems;
    this.root.querySelector('#fg-coin').textContent = this.coins;

    const slots = this.boardEl.children;
    for (let i = 0; i < this.cells.length; i++) {
      const v = this.cells[i];
      const el = slots[i];
      el.classList.toggle('sel', this.sel === i);
      const cur = el.firstChild;
      if (v == null) { if (cur) cur.remove(); continue; }
      if (cur && Number(cur.dataset.lv) === v) continue;
      if (cur) cur.remove();
      const b = document.createElement('div');
      b.className = 'blob';
      b.dataset.lv = v;
      const def = BLOBS[Math.min(v, BLOBS.length - 1)];
      b.style.setProperty('--c', def.color);
      b.innerHTML = `${def.emoji}<span class="n">${v + 1}</span>`;
      el.append(b);
    }
  }

  async spawn() {
    if (this.busy) return;
    this.clearHand();
    if (this.energy <= 0) return this.outOfEnergy();
    const free = this.cells.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
    if (!free.length) return this.toast('ボードがいっぱいです！');
    this.energy--;
    this.cells[free[(Math.random() * free.length) | 0]] = 0;
    sfx.tap();
    this.render();
    await this.afterAction();
  }

  async tapSlot(i) {
    if (this.busy) return;
    this.clearHand();
    if (this.cells[i] == null) { this.sel = -1; return this.render(); }
    if (this.sel === -1 || this.sel === i) { this.sel = i; sfx.tap(); return this.render(); }
    if (this.cells[this.sel] !== this.cells[i]) { this.sel = i; sfx.tap(); return this.render(); }

    this.cells[i] = this.cells[i] + 1;
    this.cells[this.sel] = null;
    this.sel = -1;
    this.merges++;
    this.coins += 10;
    sfx.merge();
    this.render();

    if (this.merges === 2) {
      this.toast('タマゴが増えていく…！これは…楽しい…のか？');
    }
    if (this.merges % 4 === 0) {
      this.level++;
      this.render();
      await this.popups.show({
        title: `🎊 レベル ${this.level} 達成！`,
        body: '新機能が解放されました：<br><b>なし</b>',
        buttons: [{ label: 'すごい！', cls: 'buy' }],
        closable: false,
      });
    }
    await this.afterAction();
  }

  /** 3 手ごとに広告。回数が増えるほど「おかしい」と気づかせる導線を出す。 */
  async afterAction() {
    this.actions++;
    if (this.actions % 3 !== 0) return;
    this.busy = true;
    await this.ads.play();
    this.busy = false;
    if (this.ads.count === 2) {
      this.toast('⚙️ 設定から「返金」できます', 5200);
    } else if (this.ads.count >= 4) {
      const a = await this.popups.show({
        title: 'ちょっといいですか',
        body: 'このゲーム、<br>広告で見たやつと違いませんか？',
        buttons: [
          { label: '違う。パズルがしたかった', cls: 'buy', value: 'refund' },
          { label: 'いや、タマゴが好きなので', cls: 'ghost', value: 'stay' },
        ],
        closable: false,
      });
      if (a === 'refund') this.onRefund();
    }
  }

  async outOfEnergy() {
    const a = await this.popups.show({
      title: '⚡ エネルギーが切れました',
      body: '全回復まで <b>29:58</b><br>いま回復すればすぐ遊べます',
      price: '¥120',
      buttons: [
        { label: '💎 で回復する', cls: 'buy', value: 'buy' },
        { label: '広告を見て +1', cls: '', value: 'ad' },
        { label: '待つ', cls: 'ghost', value: 'wait' },
      ],
    });
    if (a === 'ad') {
      this.busy = true;
      await this.ads.play();
      await this.ads.play(); // 「+1」のはずが 2 本流れる
      this.busy = false;
      this.energy += 1;
      this.render();
      this.toast('⚡+1 …のために広告2本');
    } else if (a === 'buy') {
      await this.popups.show({
        title: '💎 が足りません',
        body: '💎120 が必要です。<br>いま所持しているのは 💎0 です',
        buttons: [{ label: '💎を購入する (¥1,200〜)', cls: 'buy' }, { label: 'やめる', cls: 'ghost' }],
      });
    }
  }

  async goTab(tab, btn) {
    if (this.busy) return;
    this.clearHand();
    for (const b of this.root.querySelectorAll('.nav button')) b.classList.toggle('on', b === btn);
    sfx.tap();

    if (tab === 'home') return;
    // ホーム以外は結局ホームに戻される
    setTimeout(() => {
      for (const b of this.root.querySelectorAll('.nav button')) {
        b.classList.toggle('on', b.dataset.tab === 'home');
      }
    }, 300);

    if (tab === 'puzzle') return this.puzzleTab();
    if (tab === 'gacha') return this.gachaTab();
    if (tab === 'shop') return this.shopTab();
    if (tab === 'config') return this.configTab();
  }

  async puzzleTab() {
    this.lockTaps++;
    if (this.lockTaps < 3) {
      await this.popups.show({
        title: '🔒 パズルモード',
        body: `プレイヤーレベル <b>150</b> で解放されます。<br>現在のレベル：<b>${this.level}</b>`,
        buttons: [{ label: 'わかった', cls: 'ghost' }],
      });
      return;
    }
    const a = await this.popups.show({
      title: '🔒 パズルモード',
      body: 'そんなにパズルがしたいのですか？',
      buttons: [
        { label: 'はい。広告のあれがしたい', cls: 'buy', value: 'yes' },
        { label: 'いいえ', cls: 'ghost', value: 'no' },
      ],
    });
    if (a !== 'yes') return;

    await this.popups.show({
      title: '🧩 パズル 特別体験版',
      body: '<div style="font-size:40px;line-height:1.2">🧍‍♂️ ⬅ 💰</div>宝はすでに勇者の隣にあります。<br>ピンを抜く必要はありません。',
      buttons: [{ label: 'クリア！', cls: 'buy' }],
      closable: false,
    });
    const b = await this.popups.show({
      ribbon: 'おめでとうございます',
      title: '🎉 パズル 1/1 クリア！',
      body: '次のパズルは<br><b>プレイヤーレベル 300</b> または',
      price: '¥2,400',
      buttons: [
        { label: '購入する', cls: 'buy', value: 'buy' },
        { label: 'ふざけるな', cls: 'ghost', value: 'angry' },
      ],
    });
    if (b === 'angry') {
      const c = await this.popups.show({
        title: 'ご不満のようですね',
        body: '購入した覚えのない体験に対しては<br>返金を請求できます。',
        buttons: [
          { label: '返金をリクエストする', cls: 'buy', value: 'refund' },
          { label: 'タマゴに戻る', cls: 'ghost', value: 'stay' },
        ],
      });
      if (c === 'refund') this.onRefund();
    }
  }

  async gachaTab() {
    await this.popups.show({
      title: '🎁 ドラゴン召喚',
      body: '10連ガチャ<br><span class="tiny">SSR排出率 0.03%（天井 300連）</span>',
      price: '💎 3,000',
      buttons: [
        { label: '無料10連を回す！', cls: 'buy', value: 'free' },
        { label: 'やめる', cls: 'ghost', value: 'no' },
      ],
    });
    await this.popups.show({
      title: '✨✨✨ 演出中 ✨✨✨',
      body: '<div style="font-size:44px">🥚🥚🥚🥚🥚<br>🥚🥚🥚🥚🥚</div>',
      buttons: [{ label: '結果を見る', cls: '' }],
      closable: false,
    });
    sfx.cash();
    await this.popups.show({
      title: '結果',
      body: '<b>N タマゴ</b> ×10<br><span class="tiny">所持しているタマゴに変換されました</span>',
      buttons: [{ label: 'OK', cls: 'ghost' }],
      closable: false,
    });
  }

  async shopTab() {
    await this.popups.show({
      title: '🛒 ショップ',
      body:
        '<div style="text-align:left;font-size:12.5px;line-height:2">' +
        '💎 60 …… ¥1,200<br>' +
        '💎 300 …… ¥6,000<br>' +
        '💎 2,000 …… ¥39,800<br>' +
        '⚡ 全回復 …… ¥120<br>' +
        '🧩 パズルモード …… ¥2,400<br>' +
        '🚫 広告削除 …… ¥980 / 月</div>',
      buttons: [{ label: '閉じる', cls: 'ghost' }],
    });
  }

  async configTab() {
    const a = await this.popups.show({
      title: '⚙️ 設定',
      body: 'BGM ◻ / SE ◻ / 通知 ☑（変更できません）',
      buttons: [
        { label: 'アカウント連携', cls: 'ghost', value: 'x' },
        { label: 'お問い合わせ', cls: 'ghost', value: 'x' },
        { label: '返金をリクエストする', cls: 'buy', value: 'refund' },
      ],
    });
    if (a === 'refund') this.onRefund();
  }
}
