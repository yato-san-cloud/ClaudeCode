// Game bootstrap + main loop: wires together world, renderer, player, mobs,
// inventory, crafting UI, input handling, day/night, combat, and saving.

import * as THREE from 'three';
import { World } from './world.js';
import { Player, EYE_HEIGHT } from './player.js';
import { Renderer } from './renderer.js';
import { MobManager } from './mobs.js';
import { Inventory, HOTBAR_SIZE } from './inventory.js';
import { UI } from './ui.js';
import { BLOCKS, BLOCK_BY_ID, isSolid } from './blocks.js';
import { buildAtlasCanvas } from './atlas.js';
import {
  buildSave, applySave, saveToStorage, loadFromStorage, clearStorage,
} from './save.js';

const DAY_LENGTH = 300;        // seconds per full day/night cycle
const MAX_HEALTH = 20;
const REACH = 7;
const MOUSE_SENS = 0.0022;

// What a broken block drops into the inventory.
const DROPS = {
  [BLOCKS.GRASS.id]: BLOCKS.DIRT.id,
  [BLOCKS.STONE.id]: BLOCKS.COBBLE.id,
  [BLOCKS.LEAVES.id]: 0, // leaves drop nothing
  [BLOCKS.SNOW.id]: BLOCKS.DIRT.id,
};

// Blocks the player is allowed to place (everything placeable from inventory).
function isPlaceable(id) {
  const b = BLOCK_BY_ID[id];
  return !!(b && b.id !== 0 && b.id !== BLOCKS.WATER.id && b.id !== BLOCKS.BEDROCK.id);
}

class Game {
  constructor() {
    const canvas = document.getElementById('game');
    const saved = loadFromStorage(window.localStorage);
    const seed = saved?.seed || ('world-' + Math.floor(Math.random() * 1e9));

    this.world = new World(seed);
    this.world.timeOfDay = 0.3;
    this.player = new Player(0.5, 80, 0.5);
    this.inventory = new Inventory();
    this.renderer = new Renderer(canvas, this.world, 6);
    this.mobs = new MobManager(this.renderer.scene, this.world);
    this.ui = new UI(buildAtlasCanvas(), this.inventory, this.player);

    this.health = MAX_HEALTH;
    this.hurtCooldown = 0;
    this.breakCooldown = 0;
    this.placeCooldown = 0;
    this.saveTimer = 0;
    this.mouse = { left: false, right: false };

    this.input = {
      forward: false, back: false, left: false, right: false,
      jump: false, sneak: false, run: false,
    };

    if (saved) {
      applySave(saved, this.world, this.player, this.inventory);
      this.ui.toast('Save loaded');
    } else {
      this._giveStartingItems();
      // Spawn on the surface.
      const sy = this.world.surfaceHeight(0, 0);
      this.player.position = { x: 0.5, y: sy + 1, z: 0.5 };
    }

    this._bindInput();
    this.ui.renderHotbar();
    this.ui.renderHearts(this.health, MAX_HEALTH);

    this.clock = new THREE.Clock();
    this.tmpDir = new THREE.Vector3();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);

    window.addEventListener('beforeunload', () => this.save());
  }

  _giveStartingItems() {
    this.inventory.add(BLOCKS.GRASS.id, 64);
    this.inventory.add(BLOCKS.DIRT.id, 64);
    this.inventory.add(BLOCKS.COBBLE.id, 64);
    this.inventory.add(BLOCKS.STONE.id, 64);
    this.inventory.add(BLOCKS.WOOD.id, 32);
    this.inventory.add(BLOCKS.PLANK.id, 64);
    this.inventory.add(BLOCKS.GLASS.id, 32);
    this.inventory.add(BLOCKS.SAND.id, 32);
    this.inventory.add(BLOCKS.LEAVES.id, 32);
  }

  _bindInput() {
    const canvas = this.renderer.renderer.domElement;

    canvas.addEventListener('click', () => {
      if (!this.ui.invOpen && document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.player.yaw -= e.movementX * MOUSE_SENS;
      this.player.pitch -= e.movementY * MOUSE_SENS;
      const lim = Math.PI / 2 - 0.01;
      this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
    });

    document.addEventListener('mousedown', (e) => {
      if (this.ui.invOpen) return;
      // Require the mouse to be captured first, so the click that grabs the
      // pointer doesn't also break a block.
      if (document.pointerLockElement !== canvas) return;
      if (e.button === 0) { this.mouse.left = true; this._tryBreak(); }
      if (e.button === 2) { this.mouse.right = true; this._tryPlace(); }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('wheel', (e) => {
      if (this.ui.invOpen) return;
      this.inventory.selectNext(e.deltaY > 0 ? 1 : -1);
      this.ui.renderHotbar();
    }, { passive: true });

    let lastSpace = 0;
    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyW': this.input.forward = true; break;
        case 'KeyS': this.input.back = true; break;
        case 'KeyA': this.input.left = true; break;
        case 'KeyD': this.input.right = true; break;
        case 'Space': {
          this.input.jump = true;
          const now = performance.now();
          if (now - lastSpace < 300) {
            this.player.flying = !this.player.flying;
            this.ui.toast(this.player.flying ? 'Flying: ON' : 'Flying: OFF');
          }
          lastSpace = now;
          e.preventDefault();
          break;
        }
        case 'ShiftLeft': case 'ShiftRight': this.input.sneak = true; break;
        case 'ControlLeft': case 'ControlRight': this.input.run = true; break;
        case 'KeyE': this._toggleInventory(); break;
        case 'Escape':
          if (this.ui.invOpen) this._toggleInventory();
          break;
        case 'KeyF': clearStorage(window.localStorage); this.ui.toast('Save cleared'); break;
        default:
          if (e.code.startsWith('Digit')) {
            const n = parseInt(e.code.slice(5), 10);
            if (n >= 1 && n <= HOTBAR_SIZE) {
              this.inventory.setSelected(n - 1);
              this.ui.renderHotbar();
            }
          }
      }
    });

    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': this.input.forward = false; break;
        case 'KeyS': this.input.back = false; break;
        case 'KeyA': this.input.left = false; break;
        case 'KeyD': this.input.right = false; break;
        case 'Space': this.input.jump = false; break;
        case 'ShiftLeft': case 'ShiftRight': this.input.sneak = false; break;
        case 'ControlLeft': case 'ControlRight': this.input.run = false; break;
      }
    });
  }

  _toggleInventory() {
    const open = this.ui.toggleInventory();
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      this.ui.renderHotbar();
    }
  }

  _eyeAndDir() {
    const eye = this.player.eyePosition;
    this.renderer.camera.getWorldDirection(this.tmpDir);
    return {
      origin: [eye.x, eye.y, eye.z],
      dir: [this.tmpDir.x, this.tmpDir.y, this.tmpDir.z],
    };
  }

  _tryBreak() {
    const { origin, dir } = this._eyeAndDir();
    // Prefer attacking a mob if one is closer along the ray than any block.
    const block = this.world.raycast(origin, dir, REACH);
    const mobPick = this.mobs.pick(origin, dir, REACH);
    const blockDist = block.hit
      ? Math.hypot(block.block[0] + 0.5 - origin[0], block.block[1] + 0.5 - origin[1], block.block[2] + 0.5 - origin[2])
      : Infinity;
    if (mobPick && mobPick.dist < blockDist) {
      this.mobs.damageAt([mobPick.mob.position.x, mobPick.mob.position.y + 1, mobPick.mob.position.z], 1.0, 6);
      return;
    }
    if (!block.hit) return;
    const [x, y, z] = block.block;
    const id = this.world.getBlock(x, y, z);
    if (id === BLOCKS.BEDROCK.id) { this.ui.toast('Bedrock is unbreakable'); return; }
    this.world.setBlock(x, y, z, 0);
    const drop = id in DROPS ? DROPS[id] : id;
    if (drop) this.inventory.add(drop, 1);
    this.ui.renderHotbar();
  }

  _tryPlace() {
    const slot = this.inventory.selectedSlot;
    if (!slot || !isPlaceable(slot.id)) return;
    const { origin, dir } = this._eyeAndDir();
    const block = this.world.raycast(origin, dir, REACH);
    if (!block.hit) return;
    const [bx, by, bz] = block.block;
    const [nx, ny, nz] = block.normal;
    const px = bx + nx, py = by + ny, pz = bz + nz;

    // Don't place inside the player's body.
    if (this._intersectsPlayer(px, py, pz)) return;
    if (isSolid(this.world.getBlock(px, py, pz))) return;

    this.world.setBlock(px, py, pz, slot.id);
    this.inventory.consumeSelected();
    this.ui.renderHotbar();
  }

  _intersectsPlayer(x, y, z) {
    const p = this.player.position;
    const half = this.player.half;
    const minX = p.x - half, maxX = p.x + half;
    const minY = p.y, maxY = p.y + 1.8;
    const minZ = p.z - half, maxZ = p.z + half;
    return (
      x + 1 > minX && x < maxX &&
      y + 1 > minY && y < maxY &&
      z + 1 > minZ && z < maxZ
    );
  }

  _isNight() {
    const t = this.world.timeOfDay;
    return t < 0.23 || t > 0.77;
  }

  _respawn() {
    this.health = MAX_HEALTH;
    const sy = this.world.surfaceHeight(0, 0);
    this.player.position = { x: 0.5, y: sy + 1, z: 0.5 };
    this.player.velocity = { x: 0, y: 0, z: 0 };
    this.ui.toast('You died — respawned');
  }

  save() {
    const snap = buildSave(this.world, this.player, this.inventory);
    saveToStorage(window.localStorage, snap);
  }

  _loop() {
    requestAnimationFrame(this._loop);
    let dt = this.clock.getDelta();
    if (dt > 0.1) dt = 0.1;

    // Time of day.
    this.world.timeOfDay = (this.world.timeOfDay + dt / DAY_LENGTH) % 1;

    if (!this.ui.invOpen) {
      this.player.update(dt, this.input, this.world);

      // Continuous break/place while holding the mouse.
      this.breakCooldown -= dt;
      this.placeCooldown -= dt;
      if (this.mouse.left && this.breakCooldown <= 0) { this._tryBreak(); this.breakCooldown = 0.22; }
      if (this.mouse.right && this.placeCooldown <= 0) { this._tryPlace(); this.placeCooldown = 0.22; }
    }

    // Void / fall safety.
    if (this.player.position.y < -10) {
      this.health -= MAX_HEALTH; // instant death in the void
    }

    // Mobs.
    const night = this._isNight();
    const attack = this.mobs.update(dt, this.player, night);
    this.hurtCooldown -= dt;
    if (attack > 0 && this.hurtCooldown <= 0) {
      this.health -= Math.min(attack, 3);
      this.hurtCooldown = 0.6;
      this.ui.renderHearts(this.health, MAX_HEALTH);
      document.getElementById('damage-flash').classList.add('flash');
      setTimeout(() => document.getElementById('damage-flash').classList.remove('flash'), 120);
    }
    if (this.health <= 0) { this._respawn(); this.ui.renderHearts(this.health, MAX_HEALTH); }

    // Camera follows the player's eye.
    const eye = this.player.eyePosition;
    this.renderer.camera.position.set(eye.x, eye.y, eye.z);
    this.renderer.camera.rotation.set(this.player.pitch, this.player.yaw, 0, 'YXZ');

    // Update world streaming + lighting.
    this.renderer.updateChunks(this.player.position.x, this.player.position.z);
    this.renderer.updateDayNight(this.world.timeOfDay);

    // Block highlight.
    const { origin, dir } = this._eyeAndDir();
    const hit = this.world.raycast(origin, dir, REACH);
    this.renderer.setHighlight(hit.hit ? hit.block : null);

    // HUD clock.
    this.ui.renderClock(this.world.timeOfDay);

    // Periodic autosave.
    this.saveTimer += dt;
    if (this.saveTimer > 15) { this.save(); this.saveTimer = 0; }

    this.renderer.render();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  // Render initial hotbar visuals once atlas/UI are ready.
  const game = new Game();
  window.__game = game; // handy for debugging
});
