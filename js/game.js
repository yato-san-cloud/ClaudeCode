/*
 * game.js — 沼 のゲームロジック（状態機械・物理ループ・収支管理）。
 *
 * 流れ:
 *   打ち出し → 釘で散る → 始動チャッカー通過で羽根開放
 *   → 開いた羽根がステージへ玉を呼び込む → Vゾーン入賞で【大当たり】
 *   → 最大16ラウンドの出玉ラッシュ（継続抽選つき）
 *
 * Vゾーンは原作どおり“渋い”。捕獲しても大半はハズレ、たまにV。
 */
(function (global) {
  'use strict';
  const Numa = (global.Numa = global.Numa || {});
  const P = Numa.physics;

  const CONFIG = {
    gravity: 1400, // px/s^2（盤面）
    stageGravity: 760, // ステージ内はゆっくり
    yenPerBall: 4, // 4円パチンコ
    loanYen: 500, // 玉貸し1回
    loanBalls: 125, // 500円で125玉
    pNormalV: 0.06, // 通常時のV入賞率（渋い。ステージ入賞の大半はハズレ）
    pContinue: 0.82, // 大当たり中の継続率
    maxRounds: 16,
    payoutPerRound: 140, // 1ラウンドあたりの出玉
    goalYen: 10000, // 目標収支
    maxBalls: 6, // 同時に盤面を流れる玉数の上限
    fireInterval: 0.34, // オート打ちの間隔(s)
    openDur: 1.0, // 羽根が開いている時間(s)
  };

  class Game {
    constructor(board, audio, hooks) {
      this.board = board;
      this.audio = audio;
      this.hooks = hooks || {};
      this.reset();
    }

    reset() {
      this.balls = [];
      this.mode = 'normal'; // 'normal' | 'jackpot'
      this.tama = 0; // 持ち玉
      this.invested = 0; // 投資（円）
      this.dejama = 0; // 総出玉
      this.launches = 0; // 発射数
      this.hits = 0; // 大当たり回数
      this.power = 0.44; // 打ち出し強さ 0..1
      this.autoFire = false;
      this._fireT = 0;
      this.timers = [];
      this.zawa = false;
      this.gameOver = false;
      this.won = false;

      this.wing = { amt: 0, phase: 'idle', queue: 0, hold: 0, jackpot: false };
      this.round = 0;
      this.roundContinued = false;

      this.fx = { chuckerFlash: { C: 0, L: 0, R: 0 }, vFlash: 0 };
      this._emitStats();
    }

    // ---- タイマー（ゲームループ駆動） ---------------------------------
    after(sec, fn) {
      this.timers.push({ t: sec, fn });
    }
    _updateTimers(dt) {
      for (let i = this.timers.length - 1; i >= 0; i--) {
        const tm = this.timers[i];
        tm.t -= dt;
        if (tm.t <= 0) {
          this.timers.splice(i, 1);
          tm.fn();
        }
      }
    }

    // ---- 打ち出し -----------------------------------------------------
    setPower(p) {
      this.power = P.clamp(p, 0, 1);
    }
    setAutoFire(on) {
      this.autoFire = on;
    }

    _spend() {
      // 1玉発射。持ち玉が無ければ玉貸し（投資）。
      if (this.tama <= 0) {
        this.invested += CONFIG.loanYen;
        this.tama += CONFIG.loanBalls;
      }
      this.tama--;
    }

    launch(power) {
      if (this.gameOver) return;
      if (this.balls.length >= CONFIG.maxBalls) return;
      const pw = power == null ? this.power : power;
      this._spend();
      this.launches++;
      const b = new P.Ball(396, 562, 6.2);
      b.vy = -1250; // 必ずレール上端まで届く一定初速
      b.vx = -26;
      b.power = pw; // ぶっこみ位置（盤面への入射点）を決める
      this.balls.push(b);
      this.audio.launch();
      this._emitStats();
    }

    // ---- 羽根 ---------------------------------------------------------
    _openWings(cycles) {
      if (this.mode !== 'normal') return;
      this.wing.queue += cycles;
    }
    get wingsOpen() {
      return this.wing.amt > 0.5;
    }
    _updateWings(dt) {
      const w = this.wing;
      const speed = 6; // 開閉速度
      let target;
      if (w.jackpot) {
        target = 1;
        w.amt += (target - w.amt) * Math.min(1, speed * dt);
        return;
      }
      // 開閉サイクル
      if (w.phase === 'idle') {
        target = 0;
        if (w.queue > 0) {
          w.phase = 'open';
          w.hold = CONFIG.openDur;
        }
      } else if (w.phase === 'open') {
        target = 1;
        if (w.amt > 0.9) {
          w.hold -= dt;
          if (w.hold <= 0) w.phase = 'close';
        }
      } else {
        // close
        target = 0;
        if (w.amt < 0.05) {
          w.queue = Math.max(0, w.queue - 1);
          w.phase = 'idle';
        }
      }
      w.amt += (target - w.amt) * Math.min(1, speed * dt);
    }

    // ---- メインループ -------------------------------------------------
    update(dt) {
      // 過大なdtを刻む（タブ復帰時の吹っ飛び防止）
      dt = Math.min(dt, 0.05);
      this._updateTimers(dt);
      this._updateWings(dt);

      // FXの減衰
      for (const k in this.fx.chuckerFlash)
        this.fx.chuckerFlash[k] = Math.max(0, this.fx.chuckerFlash[k] - dt);
      this.fx.vFlash = Math.max(0, this.fx.vFlash - dt);

      // オート打ち
      if (this.autoFire && !this.gameOver && this.mode === 'normal') {
        this._fireT -= dt;
        if (this._fireT <= 0) {
          this._fireT = CONFIG.fireInterval;
          this.launch(this.power + (Math.random() - 0.5) * 0.06);
        }
      }

      // 玉の更新
      const sub = 4;
      const h = dt / sub;
      for (let s = 0; s < sub; s++) {
        for (const b of this.balls) {
          if (!b.alive) continue; // 同フレーム内で確定済みの玉は再処理しない
          if (b.state === 'field') this._stepField(b, h);
          else if (b.state === 'rail') this._stepRail(b, h);
          else if (b.state === 'stage') this._stepStage(b, h);
        }
      }
      // 玉詰まり解消（安全網）
      const YK = this.board.YK;
      for (const b of this.balls) {
        if (!b.alive || b.state !== 'field') continue;
        // (1) ほぼ静止した玉を蹴り出す
        const moved = Math.hypot(b.x - (b._lx || 0), b.y - (b._ly || 0));
        if (b._lx != null && moved < 2.4) {
          b._stuck = (b._stuck || 0) + dt;
        } else {
          b._stuck = 0;
        }
        b._lx = b.x;
        b._ly = b.y;
        // (2) 屋根ゾーンに長居する玉（頂点でバウンドし続ける等）も蹴り出す
        const onRoof = b.x > 158 && b.x < 286 && b.y > 200 && b.y < YK.top + 10;
        b._roofT = onRoof ? (b._roofT || 0) + dt : 0;
        if (b._stuck > 0.45 || b._roofT > 0.9) {
          b.vx = (Math.random() < 0.5 ? -1 : 1) * 320;
          b.vy = 140;
          b.y += 8; // 接触を切って確実に離脱させる
          b._stuck = 0;
          b._roofT = 0;
        }
      }

      // 退場した玉を除去
      this.balls = this.balls.filter((b) => b.alive);

      // ステージ滞在中の緊張演出
      const inStage = this.balls.some((b) => b.state === 'stage');
      if (inStage !== this.zawa) {
        this.zawa = inStage;
        if (this.hooks.onZawa) this.hooks.onZawa(inStage);
      }
    }

    _stepField(b, h) {
      // レール上端に到達したら、上部ガイドへ移行（釘に当たらず左へ運ぶ）。
      if (b.y < 96 && b.x > this.board.LANE.xMin) {
        b.state = 'rail';
        b.y = 80;
        b.vx = -520;
        b.vy = 0;
        // ぶっこみ位置: 強いほど左奥へ（狙いの要）
        b.railTargetX = 318 - b.power * 258;
        return;
      }
      b.vy += CONFIG.gravity * h;
      b.x += b.vx * h;
      b.y += b.vy * h;
      b.spin += b.vx * h * 0.05;

      // 壁
      for (const w of this.board.walls) {
        P.collideSegment(b, w.ax, w.ay, w.bx, w.by, w.rest);
      }
      // 屋根の肩（常時）。釘列なので玉は引っかからず左右へ落ちる。
      for (const p of this.board.roofShoulder) P.collideCircle(b, p.x, p.y, p.r);
      // フタ（羽根が閉じている時だけ）。開くと中央が抜けて捕獲口になる。
      if (!this.wingsOpen) {
        for (const p of this.board.roofLid) P.collideCircle(b, p.x, p.y, p.r);
      }
      // 釘
      for (const p of this.board.pegs) {
        if (P.collideCircle(b, p.x, p.y, p.r)) {
          if (Math.random() < 0.25) this.audio.peg();
        }
      }

      // 捕獲（羽根が開いている時、ヤクモノ上部の玉を羽根がすくい込む）
      if (this.wingsOpen && this.mode === 'normal') {
        const YK = this.board.YK;
        if (b.x > YK.left && b.x < YK.right && b.y > YK.top - 28 && b.y < YK.top + 10) {
          this._capture(b);
          return;
        }
      }

      // 始動チャッカー。判定ゾーンを下降通過する玉を pCatch で拾う。
      // 1玉につき1チャッカーあたり1回だけ抽選（同フレームの再判定を防ぐ）。
      for (const c of this.board.CHUCKERS) {
        if (
          b.vy > 0 &&
          Math.abs(b.x - c.x) < c.w / 2 &&
          b.y > c.y - 10 &&
          b.y < c.y + 10
        ) {
          if (!b._tried) b._tried = {};
          if (!b._tried[c.id]) {
            b._tried[c.id] = true;
            if (Math.random() < c.pCatch) {
              this._triggerChucker(c);
              b.alive = false;
              return;
            }
          }
        }
      }

      // アウト
      if (b.y > this.board.OUT.y && b.x > this.board.OUT.left && b.x < this.board.OUT.right) {
        b.alive = false;
        this.audio.out();
        return;
      }
      if (b.y > this.board.H + 30) {
        b.alive = false;
      }
    }

    _stepRail(b, h) {
      // 上部ガイドを左へ滑走し、ぶっこみ位置で盤面へ落とす。
      b.x += b.vx * h;
      b.y = 80;
      b.spin += b.vx * h * 0.05;
      if (b.x <= b.railTargetX) {
        b.x = b.railTargetX;
        b.state = 'field';
        b.vx = (Math.random() - 0.5) * 30;
        b.vy = 60;
      }
    }

    _stepStage(b, h) {
      const S = this.board.STAGE;
      b.stageT += h;
      b.vy += CONFIG.stageGravity * h;
      // 目標x（V or ハズレ）へ緩く誘導
      const ax = P.clamp((b.targetX - b.x) * 8, -320, 320);
      b.vx += ax * h;
      b.vx *= 0.99;
      b.x += b.vx * h;
      b.y += b.vy * h;
      b.spin += b.vx * h * 0.05;

      for (const w of this.board.stageWalls) {
        P.collideSegment(b, w.ax, w.ay, w.bx, w.by, w.rest);
      }

      // 着床／時間切れで判定
      if (b.y >= S.floor - 2 || b.stageT > 1.6) {
        this._resolveStage(b);
      }
    }

    // ---- ヤクモノ処理 -------------------------------------------------
    _triggerChucker(c) {
      this.fx.chuckerFlash[c.id] = 0.4;
      this.audio.chucker();
      this._openWings(c.opens);
      this.audio.wing();
      this._emitStats();
    }

    _capture(b) {
      this.audio.capture();
      const S = this.board.STAGE;
      b.state = 'stage';
      b.y = S.top + 4;
      b.x = P.clamp(b.x, this.board.YK.mouthL + 4, this.board.YK.mouthR - 4);
      b.vy = 40;
      b.vx = 0;
      b.stageT = 0;
      // 渋いV抽選
      const hitV = Math.random() < CONFIG.pNormalV;
      b._outcome = hitV ? 'V' : 'OUT';
      if (hitV) {
        b.targetX = this.board.VZONE.x;
      } else {
        // 左右どちらかのハズレへ
        b.targetX = Math.random() < 0.5 ? S.left + 10 : S.right - 10;
      }
    }

    _resolveStage(b) {
      b.alive = false;
      if (b._outcome === 'V') {
        this._hitV();
      } else {
        // ハズレ（玉は飲まれて終わり）
        if (this.hooks.onMessage) this.hooks.onMessage('ハズレ……', 'lose');
      }
    }

    _hitV() {
      this.fx.vFlash = 1.2;
      this.audio.jackpot();
      this._startJackpot();
    }

    // ---- 大当たり（スクリプト演出） -----------------------------------
    _startJackpot() {
      this.hits++;
      this.mode = 'jackpot';
      this.wing.jackpot = true;
      this.round = 0;
      if (this.hooks.onMessage) this.hooks.onMessage('大当たり！！ 沼が口を開いた！', 'jackpot');
      this._emitStats();
      this.after(0.8, () => this._beginRound());
    }

    _beginRound() {
      this.round++;
      this.roundContinued = false;
      if (this.hooks.onMessage)
        this.hooks.onMessage(`ROUND ${this.round} / ${CONFIG.maxRounds}`, 'round');
      this.audio.round();
      // 出玉を小刻みに加算（10個の玉が飲まれる演出）
      const drops = 10;
      const per = CONFIG.payoutPerRound / drops;
      for (let i = 0; i < drops; i++) {
        this.after(0.12 + i * 0.13, () => {
          this.dejama += per;
          this.tama += per;
          this.audio.payout();
          this._emitStats();
        });
      }
      // ラウンド終了時に継続抽選
      this.after(0.12 + drops * 0.13 + 0.25, () => {
        this.roundContinued = Math.random() < CONFIG.pContinue;
        if (this.round < CONFIG.maxRounds && this.roundContinued) {
          this.after(0.35, () => this._beginRound());
        } else {
          this.after(0.4, () => this._endJackpot());
        }
      });
    }

    _endJackpot() {
      this.mode = 'normal';
      this.wing.jackpot = false;
      this.wing.amt = 0;
      const total = Math.round(this.round * CONFIG.payoutPerRound);
      if (this.hooks.onMessage)
        this.hooks.onMessage(`大当たり終了  ${this.round}R 完走 / 獲得 ${total}玉`, 'end');
      this._emitStats();
      this._checkGoal();
    }

    _checkGoal() {
      const bal = this.balance();
      if (bal >= CONFIG.goalYen && !this.won) {
        this.won = true;
        this.gameOver = true;
        this.autoFire = false;
        this.audio.win();
        if (this.hooks.onMessage)
          this.hooks.onMessage(`勝利！ 収支 +¥${bal.toLocaleString()}  沼を制した……！`, 'win');
        if (this.hooks.onResult) this.hooks.onResult(true, bal);
      }
    }

    balance() {
      return this.tama * CONFIG.yenPerBall - this.invested;
    }

    stats() {
      return {
        tama: Math.floor(this.tama),
        invested: this.invested,
        dejama: Math.floor(this.dejama),
        launches: this.launches,
        hits: this.hits,
        balance: this.balance(),
        mode: this.mode,
        round: this.round,
        maxRounds: CONFIG.maxRounds,
        goalYen: CONFIG.goalYen,
        ballsInPlay: this.balls.length,
      };
    }

    _emitStats() {
      if (this.hooks.onStats) this.hooks.onStats(this.stats());
    }

    // ---- 描画 ---------------------------------------------------------
    draw(ctx) {
      this.board.draw(ctx, {
        wingAmt: this.wing.amt,
        chuckerFlash: this.fx.chuckerFlash,
        vFlash: this.fx.vFlash,
      });
      // 玉
      for (const b of this.balls) {
        const g = ctx.createRadialGradient(b.x - 2, b.y - 2, 1, b.x, b.y, b.r);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.5, '#cfd8dc');
        g.addColorStop(1, '#6b7a80');
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
      }
    }
  }

  Numa.Game = Game;
  Numa.CONFIG = CONFIG;
})(window);
