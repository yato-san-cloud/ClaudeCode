/*
 * main.js — 起動・描画ループ・UI バインド。
 */
(function (global) {
  'use strict';
  const Numa = global.Numa;

  function $(id) {
    return document.getElementById(id);
  }

  function fmtYen(v) {
    const sign = v < 0 ? '−' : v > 0 ? '+' : '';
    return sign + '¥' + Math.abs(v).toLocaleString('ja-JP');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const canvas = $('board');
    const ctx = canvas.getContext('2d');
    const board = new Numa.Board();

    // --- DPR 対応のキャンバススケーリング ---
    function fit() {
      const dpr = global.devicePixelRatio || 1;
      const wrap = canvas.parentElement;
      const maxW = Math.min(wrap.clientWidth, 460);
      const scale = maxW / board.W;
      canvas.style.width = maxW + 'px';
      canvas.style.height = board.H * scale + 'px';
      canvas.width = Math.round(board.W * dpr);
      canvas.height = Math.round(board.H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    global.addEventListener('resize', fit);
    fit();

    // --- HUD ---
    const hud = {
      tama: $('stat-tama'),
      invest: $('stat-invest'),
      dejama: $('stat-dejama'),
      hits: $('stat-hits'),
      balance: $('stat-balance'),
      mode: $('mode-badge'),
      goal: $('goal-fill'),
    };

    const game = new Numa.Game(board, Numa.audio, {
      onStats: (s) => {
        hud.tama.textContent = s.tama.toLocaleString();
        hud.invest.textContent = '¥' + s.invested.toLocaleString();
        hud.dejama.textContent = s.dejama.toLocaleString();
        hud.hits.textContent = s.hits;
        hud.balance.textContent = fmtYen(s.balance);
        hud.balance.className = 'big ' + (s.balance >= 0 ? 'plus' : 'minus');
        if (s.mode === 'jackpot') {
          hud.mode.textContent = '大当たり ' + s.round + 'R';
          hud.mode.classList.add('on');
        } else {
          hud.mode.textContent = '通常';
          hud.mode.classList.remove('on');
        }
        const pct = Math.max(0, Math.min(100, (s.balance / s.goalYen) * 100));
        hud.goal.style.width = pct + '%';
      },
      onMessage: (text, type) => showMessage(text, type),
      onZawa: (on) => toggleZawa(on),
      onResult: (won) => {
        if (won) showOverlay('勝利', '沼を、制した……！', true);
      },
    });

    // --- メッセージ表示 ---
    const banner = $('banner');
    let bannerT = null;
    function showMessage(text, type) {
      banner.textContent = text;
      banner.className = 'banner show ' + (type || '');
      clearTimeout(bannerT);
      const dur = type === 'jackpot' || type === 'win' ? 2600 : 1400;
      bannerT = setTimeout(() => banner.classList.remove('show'), dur);
    }

    // --- ざわ…ざわ…演出 ---
    const zawa = $('zawa');
    function toggleZawa(on) {
      zawa.classList.toggle('active', on);
    }

    // --- オーバーレイ ---
    function showOverlay(title, sub, win) {
      const o = $('overlay');
      $('overlay-title').textContent = title;
      $('overlay-sub').textContent = sub;
      o.classList.add('show');
      o.classList.toggle('win', !!win);
    }
    function hideOverlay() {
      $('overlay').classList.remove('show');
    }

    // --- コントロール ---
    const powerEl = $('power');
    powerEl.addEventListener('input', () => game.setPower(powerEl.value / 100));
    game.setPower(powerEl.value / 100);

    const fireBtn = $('fire');
    // 押している間だけ単発連射（オートとは別に手動も可）
    let holding = false;
    let holdTimer = null;
    function startHold() {
      Numa.audio.ensure();
      holding = true;
      const tick = () => {
        if (!holding) return;
        game.launch();
        holdTimer = setTimeout(tick, 280);
      };
      tick();
    }
    function endHold() {
      holding = false;
      clearTimeout(holdTimer);
    }
    fireBtn.addEventListener('mousedown', startHold);
    fireBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startHold();
    });
    global.addEventListener('mouseup', endHold);
    global.addEventListener('touchend', endHold);

    const autoBtn = $('auto');
    autoBtn.addEventListener('click', () => {
      Numa.audio.ensure();
      const on = !game.autoFire;
      game.setAutoFire(on);
      autoBtn.classList.toggle('on', on);
      autoBtn.textContent = on ? '自動 ●' : '自動 ○';
    });

    const muteBtn = $('mute');
    muteBtn.addEventListener('click', () => {
      const m = !Numa.audio.muted;
      Numa.audio.setMuted(m);
      muteBtn.textContent = m ? '🔇' : '🔊';
    });

    const resetBtn = $('reset');
    resetBtn.addEventListener('click', () => {
      game.reset();
      game.setAutoFire(false);
      autoBtn.classList.remove('on');
      autoBtn.textContent = '自動 ○';
      hideOverlay();
    });

    // スタートゲート（自動再生ポリシー対策）
    $('start-btn').addEventListener('click', () => {
      Numa.audio.ensure();
      $('start-gate').classList.add('hidden');
    });

    // キーボード操作
    global.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Space') {
        e.preventDefault();
        Numa.audio.ensure();
        game.launch();
      } else if (e.key === 'a' || e.key === 'A') {
        autoBtn.click();
      }
    });

    // --- メインループ ---
    let last = performance.now();
    function loop(now) {
      const dt = (now - last) / 1000;
      last = now;
      game.update(dt);
      game.draw(ctx);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
})(window);
