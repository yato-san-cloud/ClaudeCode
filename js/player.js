// Player controller: movement, gravity, jumping, flying, and swept AABB
// collision against the voxel world. No Three.js dependency (camera sync is
// done by the caller), so the physics is Node-testable.

import { isSolid } from './blocks.js';

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

const GRAVITY = 28;        // blocks / s^2
const JUMP_SPEED = 9.2;    // blocks / s
const WALK_SPEED = 5.0;
const RUN_SPEED = 8.5;
const FLY_SPEED = 12.0;
const MAX_FALL = 60;

export class Player {
  constructor(x = 0, y = 80, z = 0) {
    this.position = { x, y, z }; // feet position (bottom-centre of AABB)
    this.velocity = { x: 0, y: 0, z: 0 };
    this.yaw = 0;    // radians, around Y
    this.pitch = 0;  // radians, look up/down
    this.onGround = false;
    this.flying = false;
    this.half = PLAYER_WIDTH / 2;
  }

  get eyePosition() {
    return {
      x: this.position.x,
      y: this.position.y + EYE_HEIGHT,
      z: this.position.z,
    };
  }

  // Forward/right look direction on the horizontal plane.
  lookDir() {
    return {
      x: -Math.sin(this.yaw) * Math.cos(this.pitch),
      y: Math.sin(this.pitch),
      z: -Math.cos(this.yaw) * Math.cos(this.pitch),
    };
  }

  // input: { forward, back, left, right, jump, sneak, run } booleans.
  update(dt, input, world) {
    if (dt > 0.05) dt = 0.05; // clamp big frame gaps for stable physics

    // Desired horizontal movement in world space.
    let mx = 0, mz = 0;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    // forward = -Z when yaw 0
    if (input.forward) { mx -= sinY; mz -= cosY; }
    if (input.back) { mx += sinY; mz += cosY; }
    if (input.left) { mx -= cosY; mz += sinY; }
    if (input.right) { mx += cosY; mz -= sinY; }
    const mlen = Math.hypot(mx, mz);
    if (mlen > 0) { mx /= mlen; mz /= mlen; }

    const speed = this.flying ? FLY_SPEED : (input.run ? RUN_SPEED : WALK_SPEED);
    this.velocity.x = mx * speed;
    this.velocity.z = mz * speed;

    if (this.flying) {
      let vy = 0;
      if (input.jump) vy += FLY_SPEED;
      if (input.sneak) vy -= FLY_SPEED;
      this.velocity.y = vy;
    } else {
      this.velocity.y -= GRAVITY * dt;
      if (this.velocity.y < -MAX_FALL) this.velocity.y = -MAX_FALL;
      if (input.jump && this.onGround) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    // Integrate with per-axis collision resolution.
    this._moveAxis(world, this.velocity.x * dt, 0, 0);
    this._moveAxis(world, 0, 0, this.velocity.z * dt);
    this.onGround = false;
    this._moveAxis(world, 0, this.velocity.y * dt, 0);
  }

  // Move along a single axis and resolve collisions on that axis only.
  _moveAxis(world, dx, dy, dz) {
    this.position.x += dx;
    this.position.y += dy;
    this.position.z += dz;
    this._resolve(world, dx, dy, dz);
  }

  _aabb() {
    const h = this.half;
    return {
      minX: this.position.x - h,
      maxX: this.position.x + h,
      minY: this.position.y,
      maxY: this.position.y + PLAYER_HEIGHT,
      minZ: this.position.z - h,
      maxZ: this.position.z + h,
    };
  }

  _resolve(world, dx, dy, dz) {
    const b = this._aabb();
    const x0 = Math.floor(b.minX), x1 = Math.floor(b.maxX);
    const y0 = Math.floor(b.minY), y1 = Math.floor(b.maxY);
    const z0 = Math.floor(b.minZ), z1 = Math.floor(b.maxZ);

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (!isSolid(world.getBlock(x, y, z))) continue;
          // Block AABB is [x,x+1] etc. Resolve based on which axis we moved.
          if (dx > 0) this.position.x = x - this.half - 1e-4;
          else if (dx < 0) this.position.x = x + 1 + this.half + 1e-4;
          if (dy > 0) { this.position.y = y - PLAYER_HEIGHT - 1e-4; this.velocity.y = 0; }
          else if (dy < 0) { this.position.y = y + 1 + 1e-4; this.velocity.y = 0; this.onGround = true; }
          if (dz > 0) this.position.z = z - this.half - 1e-4;
          else if (dz < 0) this.position.z = z + 1 + this.half + 1e-4;
        }
      }
    }
  }
}
