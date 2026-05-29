// Simple hostile mobs ("zombies"): wander, fall with gravity, chase the player
// when close at night, and deal contact damage. Rendering uses small Three.js
// box meshes built procedurally.

import * as THREE from 'three';
import { isSolid } from './blocks.js';

const MOB_HEIGHT = 1.8;
const MOB_HALF = 0.3;
const GRAVITY = 28;
const MOB_SPEED = 2.2;
const CHASE_RANGE = 16;
const ATTACK_RANGE = 1.4;
const MAX_MOBS = 12;

function makeMobMesh() {
  const group = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0x3c7d3c });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 0.3), skin);
  body.position.y = 0.95;
  group.add(body);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.45, 0.45),
    new THREE.MeshLambertMaterial({ color: 0x2f6b2f })
  );
  head.position.y = 1.75;
  group.add(head);
  return group;
}

class Mob {
  constructor(x, y, z) {
    this.position = { x, y, z };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.wanderAngle = Math.random() * Math.PI * 2;
    this.wanderTimer = 0;
    this.onGround = false;
    this.health = 20;
    this.mesh = makeMobMesh();
    this.dead = false;
  }

  update(dt, world, player, isNight) {
    if (dt > 0.05) dt = 0.05;
    const dpx = player.position.x - this.position.x;
    const dpz = player.position.z - this.position.z;
    const distToPlayer = Math.hypot(dpx, dpz);

    let dirX = 0, dirZ = 0;
    if (isNight && distToPlayer < CHASE_RANGE && distToPlayer > 0.01) {
      dirX = dpx / distToPlayer;
      dirZ = dpz / distToPlayer;
    } else {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderAngle = Math.random() * Math.PI * 2;
        this.wanderTimer = 2 + Math.random() * 3;
      }
      dirX = Math.cos(this.wanderAngle) * 0.5;
      dirZ = Math.sin(this.wanderAngle) * 0.5;
    }

    this.velocity.x = dirX * MOB_SPEED;
    this.velocity.z = dirZ * MOB_SPEED;
    this.velocity.y -= GRAVITY * dt;

    // Jump if blocked ahead and on ground.
    if (this.onGround) {
      const ahead = world.getBlock(
        Math.floor(this.position.x + dirX),
        Math.floor(this.position.y),
        Math.floor(this.position.z + dirZ)
      );
      if (isSolid(ahead)) this.velocity.y = 8;
    }

    this._moveAxis(world, this.velocity.x * dt, 0, 0);
    this._moveAxis(world, 0, 0, this.velocity.z * dt);
    this.onGround = false;
    this._moveAxis(world, 0, this.velocity.y * dt, 0);

    // Face movement direction.
    if (dirX !== 0 || dirZ !== 0) {
      this.mesh.rotation.y = Math.atan2(dirX, dirZ);
    }
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);

    // Contact attack.
    let attack = 0;
    if (distToPlayer < ATTACK_RANGE &&
        Math.abs(player.position.y - this.position.y) < 2) {
      attack = 1;
    }
    return attack;
  }

  _moveAxis(world, dx, dy, dz) {
    this.position.x += dx; this.position.y += dy; this.position.z += dz;
    const minX = Math.floor(this.position.x - MOB_HALF);
    const maxX = Math.floor(this.position.x + MOB_HALF);
    const minY = Math.floor(this.position.y);
    const maxY = Math.floor(this.position.y + MOB_HEIGHT);
    const minZ = Math.floor(this.position.z - MOB_HALF);
    const maxZ = Math.floor(this.position.z + MOB_HALF);
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++)
        for (let z = minZ; z <= maxZ; z++) {
          if (!isSolid(world.getBlock(x, y, z))) continue;
          if (dx > 0) this.position.x = x - MOB_HALF - 1e-4;
          else if (dx < 0) this.position.x = x + 1 + MOB_HALF + 1e-4;
          if (dy > 0) { this.position.y = y - MOB_HEIGHT - 1e-4; this.velocity.y = 0; }
          else if (dy < 0) { this.position.y = y + 1 + 1e-4; this.velocity.y = 0; this.onGround = true; }
          if (dz > 0) this.position.z = z - MOB_HALF - 1e-4;
          else if (dz < 0) this.position.z = z + 1 + MOB_HALF + 1e-4;
        }
  }
}

export class MobManager {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.mobs = [];
    this.spawnTimer = 0;
  }

  spawnNear(player) {
    if (this.mobs.length >= MAX_MOBS) return;
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 12;
    const x = Math.floor(player.position.x + Math.cos(angle) * dist);
    const z = Math.floor(player.position.z + Math.sin(angle) * dist);
    const y = this.world.surfaceHeight(x, z);
    if (y <= 0) return;
    const mob = new Mob(x + 0.5, y, z + 0.5);
    this.mobs.push(mob);
    this.scene.add(mob.mesh);
  }

  damageAt(point, radius, amount) {
    // Damage the closest mob within radius of a world point. Returns hit mob.
    let best = null, bestD = radius;
    for (const m of this.mobs) {
      const d = Math.hypot(
        m.position.x - point[0],
        m.position.y + 1 - point[1],
        m.position.z - point[2]
      );
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) {
      best.health -= amount;
      if (best.health <= 0) best.dead = true;
    }
    return best;
  }

  // Pick the nearest mob roughly along a ray (for melee attacks).
  pick(origin, dir, maxDist = 4) {
    let best = null, bestT = maxDist;
    for (const m of this.mobs) {
      const cx = m.position.x - origin[0];
      const cy = (m.position.y + 1) - origin[1];
      const cz = m.position.z - origin[2];
      const t = cx * dir[0] + cy * dir[1] + cz * dir[2]; // projection onto ray
      if (t < 0 || t > maxDist) continue;
      const px = origin[0] + dir[0] * t;
      const py = origin[1] + dir[1] * t;
      const pz = origin[2] + dir[2] * t;
      const perp = Math.hypot(m.position.x - px, (m.position.y + 1) - py, m.position.z - pz);
      if (perp < 0.9 && t < bestT) { bestT = t; best = m; }
    }
    return best ? { mob: best, dist: bestT } : null;
  }

  update(dt, player, isNight) {
    let totalAttack = 0;
    this.spawnTimer -= dt;
    if (isNight && this.spawnTimer <= 0) {
      this.spawnNear(player);
      this.spawnTimer = 3 + Math.random() * 4;
    }
    // Despawn during day or when too far.
    for (const m of this.mobs) {
      const far = Math.hypot(m.position.x - player.position.x, m.position.z - player.position.z) > 60;
      if (far || (!isNight && Math.random() < dt * 0.05)) m.dead = true;
    }
    for (const m of this.mobs) {
      if (m.dead) continue;
      totalAttack += m.update(dt, this.world, player, isNight);
    }
    // Remove dead.
    this.mobs = this.mobs.filter((m) => {
      if (m.dead) { this.scene.remove(m.mesh); return false; }
      return true;
    });
    return totalAttack;
  }
}
