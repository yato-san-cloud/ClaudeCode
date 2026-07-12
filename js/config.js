// ============================================================
//  Bomberman — global configuration & constants
//
//  Loaded FIRST as a classic <script>. Every value here is a
//  top-level `const`, so it is visible to all later script
//  files (classic scripts share a single global lexical scope).
//  Do NOT use `import`/`export` anywhere in this project.
// ============================================================

// ---- Grid geometry -----------------------------------------
const TILE = 44;                 // px per grid cell
const COLS = 15;                 // grid columns (odd; includes the 1-cell border)
const ROWS = 13;                 // grid rows    (odd; includes the 1-cell border)
const HUD_HEIGHT = 60;           // px reserved at the top of the canvas for the HUD

const PLAY_W   = COLS * TILE;    // 660  — width of the play field
const PLAY_H   = ROWS * TILE;    // 572  — height of the play field
const CANVAS_W = PLAY_W;         // canvas draws HUD (top) + play field (below)
const CANVAS_H = PLAY_H + HUD_HEIGHT;

// ---- Tiles --------------------------------------------------
// Stored in GameMap.grid[row][col].
const TileType = Object.freeze({ EMPTY: 0, WALL: 1, BRICK: 2 });

// ---- Directions --------------------------------------------
// dc = column delta, dr = row delta.
const DIRS = Object.freeze({
  up:    { dc:  0, dr: -1 },
  down:  { dc:  0, dr:  1 },
  left:  { dc: -1, dr:  0 },
  right: { dc:  1, dr:  0 },
});
const DIR_LIST = ['up', 'down', 'left', 'right'];

// ---- Entities ----------------------------------------------
// Hitbox is a square slightly smaller than a cell so players can
// slip around corners. Keep it EVEN so it centres cleanly.
const ENTITY_SIZE = 2 * Math.round(TILE * 0.72 / 2); // 32

// ---- Timings (milliseconds) --------------------------------
const BOMB_FUSE_MS      = 2000;  // delay before a bomb detonates
const EXPLOSION_MS      = 480;   // how long flames linger
const RESPAWN_INVULN_MS = 1600;  // invulnerability window after a respawn

// ---- Player defaults / limits ------------------------------
const PLAYER_SPEED      = 150;   // px per second (base)
const PLAYER_SPEED_STEP = 26;    // added per Speed power-up
const PLAYER_SPEED_MAX  = 280;
const START_LIVES       = 3;
const START_BOMBS       = 1;     // simultaneous bombs
const START_RANGE       = 1;     // flame reach in cells
const MAX_RANGE         = 8;
const MAX_BOMBS         = 8;

// ---- Enemies -----------------------------------------------
const ENEMY_BASE_SPEED      = 68; // px per second (level 1)
const ENEMY_SPEED_PER_LEVEL = 6;  // added each level
const START_ENEMIES         = 3;
const ENEMIES_PER_LEVEL     = 1;  // extra enemy each level
const ENEMY_SMART_FROM_LEVEL = 3; // some enemies start chasing from this level

// ---- Map generation ----------------------------------------
const BRICK_DENSITY  = 0.72;     // chance an eligible interior cell becomes a brick
const POWERUP_CHANCE = 0.34;     // chance a destroyed brick reveals a power-up

const PowerupType = Object.freeze({ BOMB: 'bomb', FIRE: 'fire', SPEED: 'speed' });

// ---- Scoring -----------------------------------------------
const SCORE_BRICK   = 10;
const SCORE_POWERUP = 50;
const SCORE_ENEMY   = 100;
const SCORE_LEVEL   = 500;

// ---- Palette -----------------------------------------------
const COLORS = Object.freeze({
  bgTop:     '#0b1020',
  bgBottom:  '#131a2e',
  hudBg:     '#0f1526',
  floorA:    '#2f9e57',   // grass checker light
  floorB:    '#2a8f4d',   // grass checker dark
  floorEdge: '#256e3d',
  wall:      '#5a6473',   // hard, indestructible
  wallHi:    '#818b9a',
  wallLo:    '#3b414c',
  brick:     '#b5651d',   // soft, destructible
  brickHi:   '#d2792a',
  brickLo:   '#8c4c14',
  bomb:      '#1b1b22',
  bombHi:    '#41414f',
  fuse:      '#ffcf5a',
  spark:     '#ff5a3c',
  flameCore: '#fff6cf',
  flameMid:  '#ff9d2e',
  flameEdge: '#ff3b2f',
  player:    '#41a6ff',
  playerDk:  '#1f6fd0',
  enemy:     '#e0466e',
  enemyDk:   '#a82a4c',
  enemySmart:'#c26bff',
  enemySmartDk:'#8a3fd0',
  puBomb:    '#3a3a46',
  puFire:    '#ff6a2b',
  puSpeed:   '#37d9c6',
  hud:       '#eef2fb',
  hudDim:    '#93a0bb',
  good:      '#5ee08a',
  bad:       '#ff6b6b',
});

// A single shared PRNG hook is unnecessary — Math.random() is fine in the browser.
