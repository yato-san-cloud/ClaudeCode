// ミニゲーム共通の描画ヘルパ。各広告ゲームはこれを使って絵を作る。

export const gfx = {
  clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
  lerp: (a, b, t) => a + (b - a) * t,

  /** 角丸矩形のパスを引く（fill/stroke は呼び出し側で）。 */
  roundPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  },

  roundRect(ctx, x, y, w, h, r, fill, stroke, lw = 2) {
    this.roundPath(ctx, x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  },

  circle(ctx, x, y, r, fill, stroke, lw = 2) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  },

  /** 影付きの文字。size/color/align/weight/shadow を指定できる。 */
  text(ctx, str, x, y, o = {}) {
    const size = o.size ?? 16;
    ctx.save();
    ctx.font = `${o.weight ?? 800} ${size}px system-ui, sans-serif`;
    ctx.textAlign = o.align ?? 'center';
    ctx.textBaseline = o.baseline ?? 'middle';
    if (o.shadow !== false) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(str, x + 1.5, y + 1.5);
    }
    ctx.fillStyle = o.color ?? '#fff';
    ctx.fillText(str, x, y);
    ctx.restore();
  },

  /** 絵文字をキャンバスに置く。 */
  emoji(ctx, ch, x, y, size) {
    ctx.save();
    ctx.font = `${size}px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
    ctx.restore();
  },

  /** 縦グラデーションで背景を塗る。 */
  sky(ctx, w, h, top, bottom) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },

  /**
   * 汎用の棒人間キャラ。mood は 'calm' | 'happy' | 'scared' | 'dead'。
   * (x, y) は足元。
   */
  guy(ctx, x, y, scale = 1, mood = 'calm', color = '#3f6fd8') {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = color;
    ctx.fillRect(-7, -22, 14, 15);
    ctx.fillStyle = '#2a3450';
    ctx.fillRect(-6, -7, 4, 7);
    ctx.fillRect(2, -7, 4, 7);
    ctx.fillStyle = '#f3c9a0';
    this.circle(ctx, 0, -29, 8, '#f3c9a0');
    ctx.fillStyle = mood === 'dead' ? '#c0392b' : '#1b2233';
    if (mood === 'dead') {
      ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('×', -3, -27);
      ctx.fillText('×', 3, -27);
    } else if (mood === 'scared') {
      this.circle(ctx, -3, -30, 2.2, '#1b2233');
      this.circle(ctx, 3, -30, 2.2, '#1b2233');
      this.circle(ctx, 0, -25, 2.4, '#1b2233');
    } else {
      this.circle(ctx, -3, -30, 1.7, '#1b2233');
      this.circle(ctx, 3, -30, 1.7, '#1b2233');
      ctx.strokeStyle = '#1b2233';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (mood === 'happy') ctx.arc(0, -26, 3, 0.15 * Math.PI, 0.85 * Math.PI);
      else { ctx.moveTo(-2.5, -25.5); ctx.lineTo(2.5, -25.5); }
      ctx.stroke();
    }
    ctx.restore();
  },
};
