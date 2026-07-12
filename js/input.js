// input.js — keyboard input handling for the Bomberman clone.
// Classic <script> file: declares `class Input` at top-level (no import/export).

class Input {
  constructor() {
    // action -> currently held (bool)
    this.down = {
      up: false,
      down: false,
      left: false,
      right: false,
      bomb: false,
      pause: false,
      restart: false,
      anykey: false,
    };

    // Movement directions currently held, stored in PRESS ORDER (oldest first).
    this._dirOrder = [];

    // Edge-trigger latches. `_edge` becomes true on the keydown that first
    // presses the key; consumeX() reads-and-clears it. `_armed` prevents
    // key auto-repeat from re-latching until a keyup re-arms it.
    this._bombEdge = false;
    this._bombArmed = true;
    this._pauseEdge = false;
    this._pauseArmed = true;
    this._restartEdge = false;
    this._restartArmed = true;

    // "Press any key" latch.
    this._anyKey = false;

    // First-keydown gate for resuming audio.
    this._soundResumed = false;

    // Map event.code -> action name.
    this._map = {
      ArrowUp: 'up',
      KeyW: 'up',
      ArrowDown: 'down',
      KeyS: 'down',
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      Space: 'bomb',
      KeyJ: 'bomb',
      KeyK: 'bomb',
      KeyP: 'pause',
      KeyR: 'restart',
      Enter: 'anykey',
    };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _isMoveAction(action) {
    return action === 'up' || action === 'down' || action === 'left' || action === 'right';
  }

  _onKeyDown(event) {
    const code = event.code;

    // Prevent page scrolling for arrows and space regardless of mapping.
    if (
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space'
    ) {
      event.preventDefault();
    }

    // Any keydown resumes audio (once) and satisfies "press any key".
    if (!event.repeat) this._anyKey = true;
    if (!this._soundResumed) {
      this._soundResumed = true;
      if (typeof Sound !== 'undefined' && Sound && typeof Sound.resume === 'function') {
        Sound.resume();
      }
    }

    const action = this._map[code];
    if (!action) return;

    const wasDown = this.down[action];
    this.down[action] = true;

    if (this._isMoveAction(action)) {
      if (!wasDown && this._dirOrder.indexOf(action) === -1) {
        this._dirOrder.push(action);
      }
      return;
    }

    // Edge-triggered actions: latch only on a fresh press (armed).
    if (action === 'bomb') {
      if (this._bombArmed) {
        this._bombEdge = true;
        this._bombArmed = false;
      }
    } else if (action === 'pause') {
      if (this._pauseArmed) {
        this._pauseEdge = true;
        this._pauseArmed = false;
      }
    } else if (action === 'restart') {
      if (this._restartArmed) {
        this._restartEdge = true;
        this._restartArmed = false;
      }
    }
  }

  _onKeyUp(event) {
    const code = event.code;
    const action = this._map[code];
    if (!action) return;

    this.down[action] = false;

    if (this._isMoveAction(action)) {
      const idx = this._dirOrder.indexOf(action);
      if (idx !== -1) this._dirOrder.splice(idx, 1);
      return;
    }

    // Re-arm edge-triggered actions on release.
    if (action === 'bomb') {
      this._bombArmed = true;
    } else if (action === 'pause') {
      this._pauseArmed = true;
    } else if (action === 'restart') {
      this._restartArmed = true;
    }
  }

  isDown(action) {
    return !!this.down[action];
  }

  // Most-recently-pressed movement direction still held, or null.
  primaryDirection() {
    if (this._dirOrder.length === 0) return null;
    return this._dirOrder[this._dirOrder.length - 1];
  }

  consumeBomb() {
    if (this._bombEdge) {
      this._bombEdge = false;
      return true;
    }
    return false;
  }

  consumePause() {
    if (this._pauseEdge) {
      this._pauseEdge = false;
      return true;
    }
    return false;
  }

  consumeRestart() {
    if (this._restartEdge) {
      this._restartEdge = false;
      return true;
    }
    return false;
  }

  consumeAnyKey() {
    if (this._anyKey) {
      this._anyKey = false;
      return true;
    }
    return false;
  }
}
