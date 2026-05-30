// HUD + inventory/crafting UI. Renders the hotbar, a full inventory screen with
// a 2x2 crafting grid, health hearts, the day clock, and toast messages.
// Block icons are sliced out of the procedural atlas canvas.

import { BLOCK_BY_ID } from './blocks.js';
import { ATLAS_COLS } from './blocks.js';
import { HOTBAR_SIZE, MAIN_SIZE, INV_COLS } from './inventory.js';
import { matchRecipe } from './crafting.js';

const ATLAS_TILE_PX = 16;

export class UI {
  constructor(atlasCanvas, inventory, player) {
    this.atlas = atlasCanvas;
    this.inventory = inventory;
    this.player = player;
    this.iconCache = new Map();
    this.held = null; // { id, count } cursor stack
    this.craftGrid = [null, null, null, null]; // 2x2
    this.invOpen = false;

    this.hotbarEl = document.getElementById('hotbar');
    this.invEl = document.getElementById('inventory');
    this.heartsEl = document.getElementById('hearts');
    this.clockEl = document.getElementById('clock');
    this.toastEl = document.getElementById('toast');
    this.cursorEl = document.getElementById('cursor-item');

    this._buildHotbar();
    document.addEventListener('mousemove', (e) => {
      if (this.held) {
        this.cursorEl.style.left = e.clientX + 'px';
        this.cursorEl.style.top = e.clientY + 'px';
      }
    });
  }

  // Return a data URL icon for a block id (cached).
  iconFor(id) {
    if (this.iconCache.has(id)) return this.iconCache.get(id);
    const block = BLOCK_BY_ID[id];
    if (!block || !block.faces) { this.iconCache.set(id, null); return null; }
    const tile = block.faces[4] != null ? block.faces[4] : block.faces[2];
    const col = tile % ATLAS_COLS;
    const row = Math.floor(tile / ATLAS_COLS);
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.atlas,
      col * ATLAS_TILE_PX, row * ATLAS_TILE_PX, ATLAS_TILE_PX, ATLAS_TILE_PX,
      0, 0, 32, 32
    );
    const url = c.toDataURL();
    this.iconCache.set(id, url);
    return url;
  }

  _slotEl(slot, onClick) {
    const el = document.createElement('div');
    el.className = 'slot';
    if (slot) {
      const url = this.iconFor(slot.id);
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        el.appendChild(img);
      }
      if (slot.count > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = slot.count;
        el.appendChild(cnt);
      }
      el.title = BLOCK_BY_ID[slot.id]?.name || '';
    }
    if (onClick) el.addEventListener('mousedown', onClick);
    return el;
  }

  _buildHotbar() {
    this.hotbarEl.innerHTML = '';
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'slot hotbar-slot';
      this.hotbarEl.appendChild(el);
      this.hotbarSlots.push(el);
    }
  }

  renderHotbar() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this.hotbarSlots[i];
      el.innerHTML = '';
      el.classList.toggle('selected', i === this.inventory.selected);
      const slot = this.inventory.slots[i];
      if (slot) {
        const url = this.iconFor(slot.id);
        if (url) { const img = document.createElement('img'); img.src = url; el.appendChild(img); }
        if (slot.count > 1) {
          const cnt = document.createElement('span');
          cnt.className = 'count';
          cnt.textContent = slot.count;
          el.appendChild(cnt);
        }
      }
    }
  }

  renderHearts(health, maxHealth = 20) {
    this.heartsEl.innerHTML = '';
    const hearts = Math.ceil(maxHealth / 2);
    for (let i = 0; i < hearts; i++) {
      const h = document.createElement('span');
      h.className = 'heart';
      const filled = health - i * 2;
      if (filled >= 2) h.textContent = '❤'; // full
      else if (filled === 1) { h.textContent = '❤'; h.classList.add('half'); }
      else { h.textContent = '❤'; h.classList.add('empty'); }
      this.heartsEl.appendChild(h);
    }
  }

  renderClock(timeOfDay) {
    // Convert 0..1 to HH:MM, with 0.25 = 06:00 sunrise mapping to a 24h clock.
    const hours = Math.floor(((timeOfDay * 24) + 6) % 24);
    const mins = Math.floor((((timeOfDay * 24) + 6) % 1) * 60);
    const isDay = timeOfDay > 0.23 && timeOfDay < 0.77;
    this.clockEl.textContent =
      `${isDay ? '☀' : '☾'} ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }

  toast(msg) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  toggleInventory() {
    this.invOpen = !this.invOpen;
    if (this.invOpen) this.openInventory();
    else this.closeInventory();
    return this.invOpen;
  }

  closeInventory() {
    this.invOpen = false;
    this.invEl.classList.remove('open');
    // Return crafting-grid + held items to inventory.
    for (let i = 0; i < this.craftGrid.length; i++) {
      if (this.craftGrid[i]) {
        this.inventory.add(this.craftGrid[i].id, this.craftGrid[i].count);
        this.craftGrid[i] = null;
      }
    }
    if (this.held) {
      this.inventory.add(this.held.id, this.held.count);
      this.held = null;
      this._renderCursor();
    }
  }

  openInventory() {
    this.invOpen = true;
    this.invEl.classList.add('open');
    this.renderInventory();
  }

  _renderCursor() {
    if (this.held) {
      this.cursorEl.innerHTML = '';
      const url = this.iconFor(this.held.id);
      if (url) { const img = document.createElement('img'); img.src = url; this.cursorEl.appendChild(img); }
      if (this.held.count > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.textContent = this.held.count;
        this.cursorEl.appendChild(cnt);
      }
      this.cursorEl.style.display = 'block';
    } else {
      this.cursorEl.style.display = 'none';
      this.cursorEl.innerHTML = '';
    }
  }

  // Click handler that picks up / drops / swaps a stack between a backing
  // array and the held cursor stack.
  _slotClick(getArr, index, e) {
    e.preventDefault();
    const arr = getArr();
    const slot = arr[index];
    if (this.held) {
      if (!slot) {
        arr[index] = this.held;
        this.held = null;
      } else if (slot.id === this.held.id) {
        slot.count += this.held.count;
        this.held = null;
      } else {
        arr[index] = this.held;
        this.held = slot;
      }
    } else if (slot) {
      this.held = slot;
      arr[index] = null;
    }
    this._renderCursor();
    this.renderInventory();
  }

  renderInventory() {
    this.invEl.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Inventory';
    this.invEl.appendChild(title);

    // Crafting area.
    const craftWrap = document.createElement('div');
    craftWrap.className = 'craft-area';
    const grid = document.createElement('div');
    grid.className = 'craft-grid';
    for (let i = 0; i < 4; i++) {
      const el = this._slotEl(this.craftGrid[i], (e) =>
        this._slotClick(() => this.craftGrid, i, e));
      grid.appendChild(el);
    }
    craftWrap.appendChild(grid);

    const arrow = document.createElement('div');
    arrow.className = 'craft-arrow';
    arrow.textContent = '→';
    craftWrap.appendChild(arrow);

    const recipe = matchRecipe(this.craftGrid);
    const outSlot = recipe ? { id: recipe.result.id, count: recipe.result.count } : null;
    const outEl = this._slotEl(outSlot, (e) => {
      e.preventDefault();
      if (!recipe) return;
      // Consume ingredients, give result (place on cursor or merge).
      const r = matchRecipe(this.craftGrid);
      if (!r) return;
      for (const ing of r.ingredients) {
        let need = ing.count;
        for (let i = 0; i < this.craftGrid.length && need > 0; i++) {
          const s = this.craftGrid[i];
          if (s && s.id === ing.id) {
            const take = Math.min(s.count, need);
            s.count -= take; need -= take;
            if (s.count <= 0) this.craftGrid[i] = null;
          }
        }
      }
      if (this.held && this.held.id === r.result.id) {
        this.held.count += r.result.count;
      } else if (!this.held) {
        this.held = { id: r.result.id, count: r.result.count };
      } else {
        this.inventory.add(r.result.id, r.result.count);
      }
      this._renderCursor();
      this.renderInventory();
    });
    outEl.classList.add('output');
    craftWrap.appendChild(outEl);
    this.invEl.appendChild(craftWrap);

    // Main inventory grid (rows after hotbar).
    const mainGrid = document.createElement('div');
    mainGrid.className = 'inv-grid';
    for (let i = 0; i < MAIN_SIZE; i++) {
      const slotIndex = HOTBAR_SIZE + i;
      const el = this._slotEl(this.inventory.slots[slotIndex], (e) =>
        this._slotClick(() => this.inventory.slots, slotIndex, e));
      mainGrid.appendChild(el);
    }
    this.invEl.appendChild(mainGrid);

    // Hotbar row inside inventory.
    const hbGrid = document.createElement('div');
    hbGrid.className = 'inv-grid hotbar-row';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = this._slotEl(this.inventory.slots[i], (e) =>
        this._slotClick(() => this.inventory.slots, i, e));
      hbGrid.appendChild(el);
    }
    this.invEl.appendChild(hbGrid);

    const hint = document.createElement('p');
    hint.className = 'inv-hint';
    hint.textContent = 'Click to pick up / place stacks. Press E or Esc to close.';
    this.invEl.appendChild(hint);
  }
}
