// ============================================================
//  Bomberman — main / bootstrap
//
//  Classic <script> file (NO import/export). Loaded LAST. Wires
//  the canvas to a Game instance and drives the requestAnimationFrame
//  loop. dt is converted ms -> seconds and clamped to <= 0.05 so
//  collision (which assumes per-frame moves < TILE) stays sound.
// ============================================================

window.addEventListener('DOMContentLoaded', function () {
  const canvas = document.getElementById('game');
  if (!canvas) return;

  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  const game = new Game(canvas);
  window.__game = game; // handy for debugging in the console

  let last = null;

  function frame(now) {
    // Skip the first frame: establish a time baseline without stepping.
    if (last === null) {
      last = now;
      requestAnimationFrame(frame);
      return;
    }

    let dt = (now - last) / 1000; // ms -> seconds
    last = now;

    if (dt < 0) dt = 0;      // guard against clock weirdness
    if (dt > 0.05) dt = 0.05; // clamp big gaps (tab switch, GC) -> no tunnelling

    game.update(dt);
    game.render();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
});
