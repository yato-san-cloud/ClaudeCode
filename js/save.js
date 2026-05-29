// Save / load serialization. Storage-agnostic core (pure, testable) plus thin
// localStorage wrappers used by the browser.

export const SAVE_KEY = 'voxelcraft.save.v1';
export const SAVE_VERSION = 1;

// Build a plain serializable snapshot from world + player + inventory.
export function buildSave(world, player, inventory) {
  // world.edits is a Map "wx,wy,wz" -> id. Serialize as compact array.
  const edits = [];
  for (const [key, id] of world.edits) {
    edits.push([key, id]);
  }
  return {
    version: SAVE_VERSION,
    seed: world.seed,
    time: world.timeOfDay ?? 0,
    edits,
    player: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      yaw: player.yaw,
      pitch: player.pitch,
      flying: player.flying,
    },
    inventory: inventory.serialize(),
  };
}

// Apply a snapshot to a fresh world/player/inventory.
export function applySave(snapshot, world, player, inventory) {
  if (!snapshot) return false;
  if (Array.isArray(snapshot.edits)) {
    for (const [key, id] of snapshot.edits) {
      world.edits.set(key, id);
    }
  }
  if (typeof snapshot.time === 'number') world.timeOfDay = snapshot.time;
  if (snapshot.player && player) {
    player.position.x = snapshot.player.x;
    player.position.y = snapshot.player.y;
    player.position.z = snapshot.player.z;
    player.yaw = snapshot.player.yaw ?? player.yaw;
    player.pitch = snapshot.player.pitch ?? player.pitch;
    player.flying = !!snapshot.player.flying;
  }
  if (snapshot.inventory && inventory) inventory.load(snapshot.inventory);
  return true;
}

export function saveToStorage(storage, snapshot) {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(snapshot));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadFromStorage(storage) {
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.version !== SAVE_VERSION) return null;
    return data;
  } catch (e) {
    return null;
  }
}

export function clearStorage(storage) {
  try { storage.removeItem(SAVE_KEY); return true; } catch (e) { return false; }
}
