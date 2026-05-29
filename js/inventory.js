// Inventory + hotbar logic. Pure, Node-testable.

export const HOTBAR_SIZE = 9;
export const INV_ROWS = 3;      // main inventory rows (excluding hotbar)
export const INV_COLS = 9;
export const MAIN_SIZE = INV_ROWS * INV_COLS;
export const TOTAL_SLOTS = HOTBAR_SIZE + MAIN_SIZE;
export const MAX_STACK = 64;

// A slot is null or { id, count }.
export class Inventory {
  constructor(size = TOTAL_SLOTS) {
    this.slots = new Array(size).fill(null);
    this.selected = 0; // hotbar index 0..HOTBAR_SIZE-1
  }

  get selectedSlot() {
    return this.slots[this.selected];
  }

  // Add items; returns the number that could NOT be added (0 = all added).
  add(id, count = 1) {
    if (id === 0 || count <= 0) return count;
    // First, top up existing stacks of the same id.
    for (let i = 0; i < this.slots.length && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < MAX_STACK) {
        const space = MAX_STACK - s.count;
        const take = Math.min(space, count);
        s.count += take;
        count -= take;
      }
    }
    // Then fill empty slots.
    for (let i = 0; i < this.slots.length && count > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(MAX_STACK, count);
        this.slots[i] = { id, count: take };
        count -= take;
      }
    }
    return count;
  }

  // Remove up to `count` of `id`; returns the number actually removed.
  remove(id, count = 1) {
    let removed = 0;
    for (let i = 0; i < this.slots.length && removed < count; i++) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const take = Math.min(s.count, count - removed);
        s.count -= take;
        removed += take;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    return removed;
  }

  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  has(id, count = 1) {
    return this.count(id) >= count;
  }

  // Consume one of the currently selected hotbar item. Returns its id or 0.
  consumeSelected() {
    const s = this.slots[this.selected];
    if (!s) return 0;
    const id = s.id;
    s.count--;
    if (s.count <= 0) this.slots[this.selected] = null;
    return id;
  }

  selectNext(delta) {
    this.selected = (this.selected + delta + HOTBAR_SIZE) % HOTBAR_SIZE;
  }

  setSelected(i) {
    if (i >= 0 && i < HOTBAR_SIZE) this.selected = i;
  }

  // Swap two slots (for drag-and-drop inventory management).
  swap(a, b) {
    if (a < 0 || b < 0 || a >= this.slots.length || b >= this.slots.length) return;
    const tmp = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = tmp;
  }

  serialize() {
    return { slots: this.slots, selected: this.selected };
  }

  load(data) {
    if (!data) return;
    if (Array.isArray(data.slots)) {
      this.slots = data.slots.map((s) => (s ? { id: s.id, count: s.count } : null));
      while (this.slots.length < TOTAL_SLOTS) this.slots.push(null);
    }
    if (typeof data.selected === 'number') this.selected = data.selected;
  }
}
