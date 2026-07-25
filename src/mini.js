// 「広告で見たあのゲーム」を動かすための共通ホスト。
//
// 各広告ゲームは src/ads/<id>.js に 1 本ずつ置き、下の契約に従う。
// バンドル後は全モジュールが 1 つのスコープに展開されるので、
// トップレベルの宣言は「export const <大文字ID> = {...}」ただ 1 つに限ること。
//
//   export const RESCUE = {
//     meta: {
//       id: 'rescue',            // ファイル名と一致させる
//       title: 'お姫様救出',       // 日本語タイトル
//       hook: '99%が失敗！',       // 広告の煽り文句
//       icon: '🧍',               // 絵文字ひとつ
//       reality: '実際は農場ゲーム', // 落としたら出てきた本当のジャンル (オチ)
//       stages: 4,               // ステージ数
//       tint: '#c0392b',         // ギャラリーのカード配色
//     },
//     create(api) { ...; return game; },
//   };
//
// api:
//   W, H            論理キャンバスサイズ (360 x 520)
//   win()           クリア。1 ステージにつき 1 回だけ呼ぶ
//   lose(reason)    失敗。reason は日本語 1 行
//   say(text, ms)   画面中央に大きく文字を出す（演出用、省略可）
//   sfx             { tap, pull, coin, merge, fail, win, popup, cash }
//   rnd()           0..1 の乱数
//
// game:
//   hint            現ステージの一言説明。start() の中で書き換えてよい
//   start(i)        ステージ i (0 始まり) を初期化
//   update(dt)      毎フレーム。dt は秒（0.05 秒で頭打ちにしてある）
//   draw(ctx)       描画。背景を含めて毎フレーム全部描き直す
//   pointer(x,y,ph) 入力。x,y は論理座標、ph は 'down' | 'move' | 'up'
//   solve()         【必須】そのステージを正解手順で自動クリアする。
//                   qa/check.mjs が全ゲーム・全ステージでこれを呼び、
//                   ちゃんと win に到達するかをブラウザ上で検証する。
//                   1 回の呼び出しで完結しない場合 (時間経過が要る等) は、
//                   内部にフラグを立てて update() 側で進めてよい。

import { sfx } from './sfx.js';

export const MINI_W = 360;
export const MINI_H = 520;

export class MiniHost {
  constructor(canvas, { onWin, onLose } = {}) {
    this.canvas = canvas;
    canvas.width = MINI_W;
    canvas.height = MINI_H;
    this.ctx = canvas.getContext('2d');
    this.onWin = onWin;
    this.onLose = onLose;
    this.entry = null;
    this.game = null;
    this.state = 'idle'; // idle | play | won | lost
    this.stage = 0;
    this.says = [];
    this.last = 0;
    this.seed = 0x1a2b3c4d;

    const send = (e, ph) => {
      if (!this.game || this.state !== 'play') return;
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * MINI_W;
      const y = ((e.clientY - r.top) / r.height) * MINI_H;
      this.game.pointer?.(x, y, ph);
    };
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture?.(e.pointerId); send(e, 'down'); });
    canvas.addEventListener('pointermove', (e) => send(e, 'move'));
    canvas.addEventListener('pointerup', (e) => send(e, 'up'));
    canvas.addEventListener('pointercancel', (e) => send(e, 'up'));
  }

  get api() {
    return {
      W: MINI_W,
      H: MINI_H,
      sfx,
      rnd: () => {
        // xorshift32。ステージごとに同じ盤面が出るよう決定論的にしておく
        let x = this.seed;
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        this.seed = x >>> 0;
        return this.seed / 4294967296;
      },
      win: () => this.finish(true),
      lose: (reason) => this.finish(false, reason),
      say: (text, ms = 1200) => this.says.push({ text, life: ms / 1000, max: ms / 1000 }),
    };
  }

  load(entry, stage = 0) {
    this.entry = entry;
    this.stage = stage;
    this.seed = 0x1a2b3c4d + stage * 7919;
    this.says.length = 0;
    this.reason = '';
    this.game = entry.create(this.api);
    this.state = 'play';
    this.game.start(stage);
    this.last = 0;
  }

  restart() {
    if (this.entry) this.load(this.entry, this.stage);
  }

  /** 次のステージがあるなら進んで true。全部終わっていれば false。 */
  next() {
    if (!this.entry) return false;
    if (this.stage + 1 >= this.entry.meta.stages) return false;
    this.load(this.entry, this.stage + 1);
    return true;
  }

  finish(won, reason = '') {
    if (this.state !== 'play') return; // 二重呼び出しは無視
    this.state = won ? 'won' : 'lost';
    this.reason = reason;
    if (won) sfx.win(); else sfx.fail();
    (won ? this.onWin : this.onLose)?.(this.stage, reason);
  }

  frame(now) {
    if (!this.game) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
    this.last = now;

    if (this.state === 'play') this.game.update?.(dt);
    this.game.draw?.(this.ctx);

    // 演出テキストは決着後も消えるまで描く
    for (let i = this.says.length - 1; i >= 0; i--) {
      const s = this.says[i];
      s.life -= dt;
      if (s.life <= 0) { this.says.splice(i, 1); continue; }
      const t = 1 - s.life / s.max;
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.life * 3);
      ctx.translate(MINI_W / 2, MINI_H * 0.34 - t * 26);
      ctx.font = '900 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(s.text, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.text, 0, 0);
      ctx.restore();
    }
  }
}
