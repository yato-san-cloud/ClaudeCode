/*
 * physics.js — 沼 (Numa) パチンコ用の軽量2D物理エンジン
 *
 * 玉(円) vs 釘(円), 玉 vs 壁(線分) の衝突解決を行う。
 * グローバル名前空間 window.Numa に公開する（モジュール/CORS 不要で
 * file:// からでも GitHub Pages からでも動くようにするため）。
 */
(function (global) {
  'use strict';

  const Numa = (global.Numa = global.Numa || {});

  // ---- ベクトル演算（プレーン関数で軽量に） ----------------------------
  function len(x, y) {
    return Math.hypot(x, y);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * 玉。位置・速度・半径を持つ。
   */
  class Ball {
    constructor(x, y, r) {
      this.x = x;
      this.y = y;
      this.r = r || 6.2;
      this.vx = 0;
      this.vy = 0;
      this.alive = true;
      this.state = 'field'; // 'field' | 'stage' | 'dead'
      this.targetX = null; // ステージ内での誘導目標
      this.stageT = 0; // ステージ滞在時間
      this.spin = 0; // 描画用の回転
    }
  }

  // ---- 衝突解決 -------------------------------------------------------
  // 反発係数と摩擦
  const REST = 0.45; // 反発係数（通常の衝突）
  // この法線速度未満の接触では反発を 0 にする。坂上で低速バウンドを繰り返して
  // 玉が止まってしまうのを防ぎ、重力の接線成分で自然に滑り落ちさせる。
  const REST_VMIN = 55;

  /** 玉と釘（静的な円）の衝突を解決する。衝突したら true。 */
  function collideCircle(ball, cx, cy, cr, rest) {
    const dx = ball.x - cx;
    const dy = ball.y - cy;
    const d = len(dx, dy);
    const min = ball.r + cr;
    if (d >= min || d === 0) return false;

    const nx = dx / d;
    const ny = dy / d;
    // めり込みを押し出す
    const overlap = min - d;
    ball.x += nx * overlap;
    ball.y += ny * overlap;
    // 法線方向の速度成分を反射
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      // 釘（凸）は常に反発させる。頂点でバランスして止まらないように。
      const e = rest == null ? REST : rest;
      const j = -(1 + e) * vn;
      ball.vx += j * nx;
      ball.vy += j * ny;
      // 釘当たりのバラつき（パチンコらしい不確定性／頂点での静止を崩す）
      ball.vx += (Math.random() - 0.5) * 0.9;
    }
    return true;
  }

  /** 線分上で点 p に最も近い点を返す。 */
  function closestOnSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby || 1e-9;
    let t = ((px - ax) * abx + (py - ay) * aby) / len2;
    t = clamp(t, 0, 1);
    return { x: ax + abx * t, y: ay + aby * t };
  }

  /** 玉と線分（壁）の衝突を解決する。衝突したら true。 */
  function collideSegment(ball, ax, ay, bx, by, rest) {
    const c = closestOnSegment(ball.x, ball.y, ax, ay, bx, by);
    const dx = ball.x - c.x;
    const dy = ball.y - c.y;
    const d = len(dx, dy);
    if (d >= ball.r || d === 0) return false;

    const nx = dx / d;
    const ny = dy / d;
    const overlap = ball.r - d;
    ball.x += nx * overlap;
    ball.y += ny * overlap;
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      // 低速接触では反発しない → 玉は斜面に着き、重力の接線成分で滑り落ちる
      const e = -vn < REST_VMIN ? 0 : rest == null ? REST : rest;
      const j = -(1 + e) * vn;
      ball.vx += j * nx;
      ball.vy += j * ny;
      // 端点での完全静止（バランス）を崩す微小ジッター
      ball.vx += (Math.random() - 0.5) * 0.6;
    }
    return true;
  }

  Numa.physics = {
    Ball,
    collideCircle,
    collideSegment,
    closestOnSegment,
    len,
    clamp,
    REST,
  };
})(window);
