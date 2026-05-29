// Three.js rendering layer: scene setup, chunk mesh management within a render
// distance, day/night lighting + sky, and the block-selection highlight.

import * as THREE from 'three';
import { buildAtlasCanvas } from './atlas.js';
import { buildChunkGeometry, CHUNK_SIZE } from './chunk.js';
import { chunkKey, worldToChunk } from './world.js';

export class Renderer {
  constructor(canvas, world, renderDistance = 6) {
    this.world = world;
    this.renderDistance = renderDistance;
    this.meshes = new Map(); // chunkKey -> THREE.Mesh

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.1, 1000
    );

    // Texture atlas material.
    const tex = new THREE.CanvasTexture(buildAtlasCanvas());
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshLambertMaterial({
      map: tex,
      vertexColors: true,
      alphaTest: 0.5,
      transparent: false,
    });

    // Sky + fog.
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, CHUNK_SIZE * (renderDistance - 2), CHUNK_SIZE * renderDistance);

    // Lights.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xffffff, 0.9);
    this.sun.position.set(50, 100, 30);
    this.scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x87ceeb, 0x4f6a2f, 0.3);
    this.scene.add(this.hemi);

    // Block selection highlight (slightly larger wireframe cube).
    const hgeo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const hedges = new THREE.EdgesGeometry(hgeo);
    this.highlight = new THREE.LineSegments(
      hedges,
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 })
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    window.addEventListener('resize', () => this.onResize());
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  buildMesh(chunk) {
    const data = buildChunkGeometry(chunk, (x, y, z) => this.world.getBlock(x, y, z));
    const key = chunkKey(chunk.cx, chunk.cz);
    let mesh = this.meshes.get(key);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
    geo.setIndex(data.indices);
    geo.computeBoundingSphere();

    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new THREE.Mesh(geo, this.material);
      mesh.frustumCulled = true;
      this.meshes.set(key, mesh);
      this.scene.add(mesh);
    }
    chunk.dirty = false;
  }

  // Ensure chunks around the player exist + are meshed; unload far ones.
  updateChunks(playerX, playerZ) {
    const { cx, cz } = worldToChunk(Math.floor(playerX), Math.floor(playerZ));
    const R = this.renderDistance;

    // Load / generate near chunks.
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        const ccx = cx + dx, ccz = cz + dz;
        const chunk = this.world.ensureChunk(ccx, ccz);
        if (chunk.dirty) this.buildMesh(chunk);
      }
    }

    // Remesh any chunks the world flagged (e.g. edits / neighbour updates).
    for (const key of this.world.newlyDirty) {
      const c = this.world.chunks.get(key);
      if (c && c.generated && c.dirty) this.buildMesh(c);
    }
    this.world.newlyDirty.clear();

    // Unload distant chunk meshes to bound memory.
    for (const [key, mesh] of this.meshes) {
      const [mx, mz] = key.split(',').map(Number);
      if ((mx - cx) ** 2 + (mz - cz) ** 2 > (R + 2) ** 2) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(key);
      }
    }
  }

  setHighlight(block) {
    if (!block) { this.highlight.visible = false; return; }
    this.highlight.visible = true;
    this.highlight.position.set(block[0] + 0.5, block[1] + 0.5, block[2] + 0.5);
  }

  // timeOfDay in [0,1): 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset.
  updateDayNight(timeOfDay) {
    const angle = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sx = Math.cos(angle), sy = Math.sin(angle);
    this.sun.position.set(sx * 100, sy * 100, 40);
    // Daylight factor: 1 at noon, ~0 at night.
    const day = Math.max(0, sy);
    this.sun.intensity = 0.25 + day * 0.85;
    this.ambient.intensity = 0.25 + day * 0.4;
    this.hemi.intensity = 0.15 + day * 0.3;

    // Sky colour blends day -> night.
    const dayCol = new THREE.Color(0x87ceeb);
    const nightCol = new THREE.Color(0x0a0e2a);
    const sky = nightCol.clone().lerp(dayCol, Math.min(1, day * 1.5));
    this.scene.background = sky;
    this.scene.fog.color = sky;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
