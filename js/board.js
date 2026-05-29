/*
 * board.js — 沼 の盤面レイアウトと描画。
 *
 * 論理座標は 460 x 680。実ピクセルは devicePixelRatio でスケールする。
 * 盤面要素:
 *   - 外枠の壁（線分）とアウト穴への誘導路
 *   - 右側の打ち出しレーン（玉が天井へ駆け上がり、左へ舞い落ちる）
 *   - 釘（千鳥配置の円）
 *   - ヤクモノ「沼」本体＋羽根＋ステージ＋Vゾーン
 *   - 始動チャッカー 3 つ（中央＝2回開放 / 左右＝1回開放）
 */
(function (global) {
  'use strict';
  const Numa = (global.Numa = global.Numa || {});

  const W = 460;
  const H = 680;

  // ---- 主要座標 -------------------------------------------------------
  const CX = 222; // 盤面中心 x
  // ヤクモノ本体
  const YK = {
    left: 168,
    right: 276,
    top: 250,
    bottom: 352,
    mouthL: 196, // 天穴（捕獲口）左端
    mouthR: 248, // 天穴 右端
  };
  // ステージ内部
  const STAGE = { left: 172, right: 272, top: 268, floor: 332 };
  // Vゾーン（中央・狭い）
  const VZONE = { x: CX, y: 330, w: 16 };
  // 始動チャッカー
  // w は判定ゾーン幅、pCatch は通過した玉が入賞する確率（渋さの調整弁）
  const CHUCKERS = [
    { id: 'C', x: CX, y: 434, w: 64, opens: 3, pCatch: 0.34 }, // 中央＝3回開放
    { id: 'L', x: 118, y: 450, w: 60, opens: 2, pCatch: 0.22 },
    { id: 'R', x: 326, y: 450, w: 60, opens: 2, pCatch: 0.22 },
  ];
  // アウト穴（最下部の抜け）
  const OUT = { left: 150, right: 300, y: 656 };
  // 打ち出しレーン（釘を置かない通路）
  const LANE = { xMin: 360, yMin: 110, yMax: 600 };

  function buildWalls() {
    const w = [];
    const seg = (ax, ay, bx, by, rest) => w.push({ ax, ay, bx, by, rest });

    // 天井ドーム（右から左へ）。右肩で上昇玉を左へ返す。
    const dome = [
      [405, 70], [360, 52], [300, 42], [222, 38],
      [144, 42], [84, 52], [40, 70],
    ];
    for (let i = 0; i < dome.length - 1; i++) {
      seg(dome[i][0], dome[i][1], dome[i + 1][0], dome[i + 1][1], 0.5);
    }
    // 左右の壁
    seg(40, 70, 40, 580);
    seg(405, 70, 405, 580);
    // 下部ファンネル → アウト穴
    seg(40, 580, OUT.left, OUT.y);
    seg(405, 580, OUT.right, OUT.y);

    // ヤクモノ本体（玉が当たって弾む外形）。屋根は釘列（buildRoof）で作る。
    seg(YK.left, YK.top, YK.left, YK.bottom); // 左外壁
    seg(YK.right, YK.top, YK.right, YK.bottom); // 右外壁
    seg(YK.left, YK.bottom, YK.right, YK.bottom); // 底

    return w;
  }

  // 屋根を「釘の列」で作る。釘は凸なので玉が尾根で詰まらず左右へ転がり落ちる。
  // 羽根が開くと中央（フタ）の釘だけ消えて捕獲口が開く。
  function buildRoof() {
    const shoulder = [];
    const lid = [];
    const peak = { x: CX, y: YK.top - 26 };
    const addSlope = (a, b) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(L / 7)); // 釘を重ねて連続凸面にし、谷を無くす
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const peg = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: 4.8 };
        (peg.x > YK.mouthL - 2 && peg.x < YK.mouthR + 2 ? lid : shoulder).push(peg);
      }
    };
    addSlope({ x: 156, y: YK.top + 2 }, peak); // 左斜面
    addSlope(peak, { x: 288, y: YK.top + 2 }); // 右斜面
    return { shoulder, lid };
  }

  // ステージ内部の壁（捕獲後の玉が転がる空間）
  function buildStageWalls() {
    const s = [];
    const seg = (ax, ay, bx, by, rest) => s.push({ ax, ay, bx, by, rest });
    seg(STAGE.left, STAGE.top, STAGE.left, STAGE.floor, 0.3); // 左
    seg(STAGE.right, STAGE.top, STAGE.right, STAGE.floor, 0.3); // 右
    // 床は中央へ向かう緩い谷（V誘導）。中央に小さなVスロット。
    seg(STAGE.left, STAGE.floor - 4, VZONE.x - VZONE.w / 2, STAGE.floor, 0.2);
    seg(STAGE.right, STAGE.floor - 4, VZONE.x + VZONE.w / 2, STAGE.floor, 0.2);
    return s;
  }

  function buildPegs() {
    const pegs = [];
    const pr = 3.4;
    const add = (x, y) => pegs.push({ x, y, r: pr });

    const inForbidden = (x, y) => {
      // 打ち出しレーン
      if (x > LANE.xMin && y > LANE.yMin && y < LANE.yMax) return true;
      // ヤクモノ＋天穴周辺
      if (x > 150 && x < 296 && y > 196 && y < 366) return true;
      // チャッカー直上の通り道は空けておく
      for (const c of CHUCKERS) {
        if (Math.abs(x - c.x) < 16 && Math.abs(y - c.y) < 14) return true;
      }
      return false;
    };

    // 千鳥格子
    let row = 0;
    for (let y = 132; y <= 408; y += 32, row++) {
      const off = row % 2 ? 19 : 0;
      for (let x = 66 + off; x <= 352; x += 38) {
        if (!inForbidden(x, y)) add(x, y);
      }
    }

    // 天穴へ導く「道釘」（ヘソ）
    add(202, 214); add(242, 214);
    add(190, 236); add(254, 236);
    // ヤクモノ両肩から下へ落とす振り分け釘
    add(150, 386); add(294, 386);
    // 中央チャッカーへの誘導ファンネル（命釘）
    add(CX - 30, 404); add(CX + 30, 404);
    add(CX - 16, 418); add(CX + 16, 418);
    // 左右チャッカーへの誘導
    add(108, 430); add(140, 430);
    add(304, 430); add(336, 430);
    // 命釘（最後の砦）
    add(176, 470); add(268, 470);

    return pegs;
  }

  class Board {
    constructor() {
      this.W = W;
      this.H = H;
      this.walls = buildWalls();
      this.stageWalls = buildStageWalls();
      this.pegs = buildPegs();
      const roof = buildRoof();
      this.roofShoulder = roof.shoulder; // 常時有効（屋根の肩）
      this.roofLid = roof.lid; // 羽根が開くと消える（捕獲口のフタ）
      this.YK = YK;
      this.STAGE = STAGE;
      this.VZONE = VZONE;
      this.CHUCKERS = CHUCKERS;
      this.OUT = OUT;
      this.LANE = LANE;
      this.CX = CX;
    }

    // ---- 描画 ---------------------------------------------------------
    draw(ctx, st) {
      ctx.clearRect(0, 0, W, H);

      // 盤面の背景（沼＝淀んだ緑〜黒のグラデーション）
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0d1410');
      bg.addColorStop(0.5, '#10231a');
      bg.addColorStop(1, '#05080a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      this._drawLane(ctx);
      this._drawWalls(ctx);
      this._drawChuckers(ctx, st);
      this._drawYakumono(ctx, st);
      this._drawPegs(ctx);
    }

    _drawLane(ctx) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,160,140,0.25)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(LANE.xMin + 6, H - 40);
      ctx.lineTo(LANE.xMin + 6, 120);
      ctx.stroke();
      ctx.restore();
    }

    _drawWalls(ctx) {
      ctx.save();
      ctx.strokeStyle = 'rgba(180,210,190,0.55)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const s of this.walls) {
        ctx.moveTo(s.ax, s.ay);
        ctx.lineTo(s.bx, s.by);
      }
      ctx.stroke();
      ctx.restore();
    }

    _drawPegs(ctx) {
      ctx.save();
      for (const p of this.pegs) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = '#c9d6cf';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x - 0.8, p.y - 0.8, p.r * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fill();
      }
      ctx.restore();
    }

    _drawChuckers(ctx, st) {
      ctx.save();
      for (const c of this.CHUCKERS) {
        const flash = st && st.chuckerFlash && st.chuckerFlash[c.id] > 0;
        ctx.fillStyle = flash ? '#ffd34d' : '#2a6f4a';
        ctx.strokeStyle = '#aee9c6';
        ctx.lineWidth = 2;
        const x = c.x - c.w / 2;
        ctx.beginPath();
        ctx.roundRect(x, c.y - 8, c.w, 14, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#06120b';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.opens + '回', c.x, c.y + 2);
      }
      ctx.restore();
    }

    _drawYakumono(ctx, st) {
      const open = st ? st.wingAmt : 0; // 0:閉 1:開
      ctx.save();

      // 本体
      const grad = ctx.createLinearGradient(0, YK.top, 0, YK.bottom);
      grad.addColorStop(0, '#16382a');
      grad.addColorStop(1, '#0a1b13');
      ctx.fillStyle = grad;
      ctx.strokeStyle = '#7fbf9a';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(YK.left, YK.top, YK.right - YK.left, YK.bottom - YK.top, 8);
      ctx.fill();
      ctx.stroke();

      // ステージ（淀んだ水面）
      const water = ctx.createLinearGradient(0, STAGE.top, 0, STAGE.floor);
      water.addColorStop(0, '#0c2a20');
      water.addColorStop(1, '#04130d');
      ctx.fillStyle = water;
      ctx.fillRect(STAGE.left, STAGE.top, STAGE.right - STAGE.left, STAGE.floor - STAGE.top);

      // Vゾーン
      const vGlow = st && st.vFlash > 0;
      ctx.fillStyle = vGlow ? '#ffe14d' : '#c0392b';
      ctx.beginPath();
      ctx.roundRect(VZONE.x - VZONE.w / 2, VZONE.y - 6, VZONE.w, 12, 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('V', VZONE.x, VZONE.y + 4);

      // 「沼」の文字
      ctx.fillStyle = 'rgba(180,230,200,0.85)';
      ctx.font = 'bold 16px "Yu Mincho", serif';
      ctx.fillText('沼', CX, YK.top + 22);

      // 羽根（左右の軒）。閉:伏せて屋根、開:跳ね上がって捕獲口を開く。
      this._drawWing(ctx, 156, YK.top + 2, -1, open);
      this._drawWing(ctx, 288, YK.top + 2, 1, open);

      // 屋根の釘列。肩は常時、フタは開放度に応じて薄くなる。
      this._drawRoofPegs(ctx, this.roofShoulder, 1);
      this._drawRoofPegs(ctx, this.roofLid, 1 - open);

      ctx.restore();
    }

    _drawRoofPegs(ctx, pegs, alpha) {
      if (alpha <= 0.02) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      for (const p of pegs) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = '#d6e6dd';
        ctx.fill();
      }
      ctx.restore();
    }

    // 軒から斜面に沿って跳ね上がる羽根のアーム
    _drawWing(ctx, eaveX, eaveY, dir, open) {
      const peakX = CX;
      const peakY = YK.top - 26;
      // 閉(open=0): 軒→頂点の斜面に沿って伏せる。開(open=1): 外上方へ跳ね上げる。
      const cx = peakX + (eaveX - peakX) * 1.0;
      const cy = peakY + (eaveY - peakY) * 1.0;
      const tipClosedX = (eaveX + peakX) / 2;
      const tipClosedY = (eaveY + peakY) / 2;
      const tipOpenX = eaveX + dir * 30;
      const tipOpenY = eaveY - 30;
      const tipX = tipClosedX + (tipOpenX - tipClosedX) * open;
      const tipY = tipClosedY + (tipOpenY - tipClosedY) * open;
      ctx.save();
      ctx.strokeStyle = open > 0.05 ? '#ffd34d' : '#6fa588';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.shadowColor = open > 0.05 ? 'rgba(255,211,77,0.7)' : 'transparent';
      ctx.shadowBlur = open > 0.05 ? 8 : 0;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.restore();
    }
  }

  Numa.Board = Board;
})(window);
