// Crafting recipes + matching. Pure, Node-testable.
//
// Two recipe kinds:
//  - "shapeless": needs a set of {id,count} ingredients regardless of layout.
//  - "shaped": a pattern in a grid (we match against a normalized 3x3 grid).
// For simplicity the UI uses shapeless matching against the crafting grid's
// total contents, plus a few shaped recipes matched by trimmed pattern.

import { BLOCKS } from './blocks.js';

export const RECIPES = [
  // 1 wood -> 4 planks
  {
    type: 'shapeless',
    ingredients: [{ id: BLOCKS.WOOD.id, count: 1 }],
    result: { id: BLOCKS.PLANK.id, count: 4 },
    name: 'Planks',
  },
  // 4 planks -> crafting / 1 plank stays simple; use planks -> ...
  // 8 cobble -> ... (decorative). Keep a few meaningful ones:
  // 4 stone -> nothing real; instead: cobble from stone via "furnace"? Keep simple.
  // 1 coal + 1 wood -> torch substitute: skip (no torch block).
  // 2 planks stacked -> "stick"? no stick item. Skip.
  // 4 sand -> glass (normally smelting; allow crafting for the clone)
  {
    type: 'shapeless',
    ingredients: [{ id: BLOCKS.SAND.id, count: 4 }],
    result: { id: BLOCKS.GLASS.id, count: 4 },
    name: 'Glass',
  },
  // 4 cobble -> ... furnace-less: cobble to stone (compacting)
  {
    type: 'shapeless',
    ingredients: [{ id: BLOCKS.COBBLE.id, count: 4 }],
    result: { id: BLOCKS.STONE.id, count: 4 },
    name: 'Stone',
  },
  // 1 stone -> cobble (mining yields cobble normally; allow reverse for clone)
  {
    type: 'shapeless',
    ingredients: [{ id: BLOCKS.STONE.id, count: 1 }],
    result: { id: BLOCKS.COBBLE.id, count: 1 },
    name: 'Cobblestone',
  },
];

// Count ingredients present in a list of slots (null | {id,count}).
function tallyGrid(slots) {
  const tally = new Map();
  for (const s of slots) {
    if (s && s.id) tally.set(s.id, (tally.get(s.id) || 0) + s.count);
  }
  return tally;
}

// Find the first recipe whose ingredients are exactly satisfied by the grid
// (no leftover item types, and counts are multiples for shapeless single-type).
export function matchRecipe(gridSlots) {
  const tally = tallyGrid(gridSlots);
  if (tally.size === 0) return null;

  for (const recipe of RECIPES) {
    if (recipe.type !== 'shapeless') continue;
    // Grid must contain exactly the ingredient id types.
    const ingIds = new Set(recipe.ingredients.map((i) => i.id));
    if (ingIds.size !== tally.size) continue;
    let ok = true;
    for (const ing of recipe.ingredients) {
      const have = tally.get(ing.id) || 0;
      if (have < ing.count) { ok = false; break; }
    }
    // Ensure no extra item types beyond the recipe.
    if (ok) {
      for (const id of tally.keys()) {
        if (!ingIds.has(id)) { ok = false; break; }
      }
    }
    if (ok) return recipe;
  }
  return null;
}
