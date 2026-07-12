# まきばのしずく (Makiba no Shizuku / Ranch Droplet) — Technical Architecture

> Single self-contained `index.html`. Canvas2D world + HTML/CSS UI overlay. Vanilla JS, no external assets, no CDN. Runs inside a sandboxed artifact iframe.

This document is the **integration contract**. Every implementer writes exactly one `src/js/*.js` module, attaches it to the global `Game` namespace, and honors the public API signatures below verbatim so that parallel work concatenates cleanly.

---

## 1. Module list & load order

Files live in `src/js/`. The build script (`tools/build.js`) concatenates them **in this exact order** into `index.html`. Load order matters because later modules read `Game.DATA` and reference other namespaces at `init()` time (never at file-eval time — see Integration Rules).

| # | File | Namespace | Responsibility (one line) |
|---|------|-----------|---------------------------|
| 00 | `src/js/00-data.js` | `Game.DATA` | Frozen content + balance tables (breeds, crops, buildings, products, prices, ranks, seasons). Pure data. |
| 01 | `src/js/util.js` | `Game.Util`, `Game.bus` | Math/format helpers, seeded RNG, EventBus singleton. |
| 02 | `src/js/state.js` | `Game.State` | Central `Game.state` object + `newGame()` factory + schema version constant. |
| 03 | `src/js/save.js` | `Game.Save` | localStorage serialize/deserialize, migration, autosave scheduling. |
| 04 | `src/js/time.js` | `Game.Time` | Day/season/weather clock; converts sim ticks → calendar; emits time events. |
| 05 | `src/js/economy.js` | `Game.Economy` | Money, market prices & fluctuation, transactions, ledger. |
| 06 | `src/js/world.js` | `Game.World` | Tile grid, building placement/occupancy, terrain, pathfinding helpers. |
| 07 | `src/js/crops.js` | `Game.Crops` | Plant/grow/water/harvest crop entities on tiles. |
| 08 | `src/js/animals.js` | `Game.Animals` | Animal entities: needs, production, breeding, aging, AI movement. |
| 09 | `src/js/sprites.js` | `Game.Sprites` | Pure procedural draw functions per breed/animal/building/crop/prop/weather. |
| 10 | `src/js/render.js` | `Game.Render` | Camera (zoom/pan/clamp), layered draw, day-night light, particle system. |
| 11 | `src/js/audio.js` | `Game.Audio` | WebAudio synth SFX + procedural music, mixer, mute. |
| 12 | `src/js/input.js` | `Game.Input` | Mouse/touch/keyboard, pan/zoom gestures, placement mode, tile/entity picking. |
| 13 | `src/js/ui.js` | `Game.UI` | HUD + all panels, notifications, tooltips, modals; DOM overlay. |
| 14 | `src/js/tutorial.js` | `Game.Tutorial` | Scripted onboarding steps, highlight/gate flow. |
| 15 | `src/js/game.js` | `Game` (boot/loop) | Bootstrap, wires init order, owns the main RAF loop, pause/speed, day advance. |

CSS lives in `src/css/styles.css` and is inlined into `<style>` by the build.

Dependency direction is **downward only** by load order, with two exceptions resolved via the bus: `render` reads `world/animals/crops/economy` state (read-only), and `ui` reads everything (read-only) and writes only through public setters / bus events. No module reaches "up" the list at eval time.

---

## 2. Central state shape (`Game.state`)

`Game.State.newGame(seed)` returns this object. Everything mutable that must persist lives here. Modules **own** specific sub-trees (noted per module) but all read access is shared. Coordinates: **tile units** are integer `(tx,ty)`; **world units** = tiles × `TILE` px; **screen units** come from the camera transform.

```jsonc
{
  "version": 1,                 // schema version, mirrors Game.State.SCHEMA_VERSION
  "seed": 123456789,            // uint32 master seed for Game.Util.rng
  "rngState": 123456789,        // current mutable RNG cursor (advances during sim)
  "createdAt": 1720742400000,   // epoch ms (real time), for playtime stats
  "playtimeMs": 0,              // accumulated real playtime

  "money": 500,                 // G. owned by Economy
  "rank": 1,                    // ranch rank/level. owned by Economy
  "rankXp": 0,                  // progress toward next rank

  // --- Time (owned by Time) ---
  "tick": 0,                    // total sim ticks elapsed (1 tick = 1 game-minute)
  "minuteOfDay": 360,           // 0..1439 (start 06:00)
  "day": 1,                     // 1-based day counter (never resets)
  "dayOfSeason": 1,             // 1..DAYS_PER_SEASON
  "season": "spring",           // spring|summer|autumn|winter
  "year": 1,
  "weather": "sunny",           // sunny|cloudy|rainy|snowy
  "weatherTicksLeft": 480,      // ticks until weather re-roll

  // --- World (owned by World) ---
  "grid": { "w": 32, "h": 32, "tiles": [ /* w*h flat array of Tile */ ] },
  //   Tile = { terrain:"grass"|"dirt"|"water"|"path", buildingId:null|int,
  //            cropId:null|int, walkable:true, fenced:false }
  "buildings": [
    // { id, type:"barn", tx, ty, w, h, level:1, capacity, inhabitants:[animalId],
    //   storage:{itemId:qty}, progress:0, builtDay:1 }
  ],
  "nextBuildingId": 1,

  // --- Crops (owned by Crops) ---
  "crops": [
    // { id, cropId:"corn", tx, ty, stage:0, growth:0, watered:false,
    //   plantedTick:0, readyAt:tick, dead:false }
  ],
  "nextCropId": 1,

  // --- Animals (owned by Animals) ---
  "animals": [
    // { id, breed:"holstein", name:"モモ", tx, ty, x, y,          // x,y world-unit float for smooth move
    //   ageDays:0, adult:false, sex:"f"|"m",
    //   needs:{ hunger:100, happiness:100, health:100, cleanliness:100 },
    //   production:{ ready:false, itemId:"milk", amount:0, cooldownTicks:0 },
    //   pregnant:false, gestationTicks:0, homeBuildingId:1,
    //   ai:{ mode:"idle", targetTx:null, targetTy:null, blinkTimer:0, hopPhase:0 } }
  ],
  "nextAnimalId": 1,

  // --- Inventory & products (owned by Economy) ---
  "inventory": { /* itemId -> qty, e.g. "milk": 3, "hay": 20, "cheese": 0 */ },
  "seeds": { /* cropId -> qty of seeds owned */ },

  // --- Market (owned by Economy) ---
  "market": {
    "prices": { /* itemId -> currentPrice (G) */ },
    "trend":  { /* itemId -> -1..1 drift direction */ },
    "lastUpdateDay": 1
  },

  // --- Upgrades / unlocks (owned by Economy) ---
  "upgrades": { /* upgradeId -> true, e.g. "auto_feed": true, "big_barn": true */ },
  "unlocked": { "buildings": ["barn","coop"], "animals":["holstein"], "crops":["grass","hay"] },

  // --- Goals / achievements (owned by UI/Economy jointly, read-only elsewhere) ---
  "goals":       { /* goalId -> {done:false, progress:0} */ },
  "achievements":{ /* achId  -> unlockedDay|null */ },

  // --- Tutorial (owned by Tutorial) ---
  "tutorial": { "active": true, "step": 0, "seen": {} },

  // --- Settings (owned by UI/Audio) ---
  "settings": {
    "master": 0.8, "sfx": 0.9, "music": 0.5, "muted": false,
    "speed": 1,               // 1|2|3 speed multiplier (0 = paused via `paused`)
    "showParticles": true, "reduceMotion": false, "lang": "ja"
  },
  "paused": false,

  // --- Camera (owned by Render; persisted for QoL) ---
  "camera": { "x": 0, "y": 0, "zoom": 1 },   // x,y = world-unit top-left focus

  // --- Stats (append-only counters, owned by many; write via Economy.stat) ---
  "stats": {
    "totalEarned": 0, "totalSpent": 0, "animalsBorn": 0, "cropsHarvested": 0,
    "itemsSold": 0, "buildingsBuilt": 0, "daysPlayed": 0
  }
}
```

Constants (not in state, live in `00-data`): `TILE=48`, `DAYS_PER_SEASON=28`, `TICKS_PER_DAY=1440`, `SCHEMA_VERSION=1`.

---

## 3. EventBus contract (`Game.bus`)

Singleton created in `util.js`: `Game.bus = Game.Util.makeEventBus()`.
API: `on(event, fn) -> unsub()`, `once(event, fn)`, `off(event, fn)`, `emit(event, payload)`.
Handlers must be side-effect-safe and cheap; heavy work goes on the next sim tick. Emit is synchronous.

**Canonical event names & payloads:**

| Event | Emitted by | Payload |
|-------|-----------|---------|
| `tick` | time | `{tick, dt}` (every sim tick) |
| `minute:advance` | time | `{minuteOfDay}` |
| `day:advance` | time | `{day, dayOfSeason, season, year}` |
| `season:change` | time | `{season, year}` |
| `weather:change` | time | `{weather, prev}` |
| `night:fall` / `day:break` | time | `{minuteOfDay}` |
| `money:change` | economy | `{money, delta, reason}` |
| `purchase` | economy | `{kind, id, cost, meta}` |
| `sale` | economy | `{itemId, qty, unitPrice, total}` |
| `inventory:change` | economy | `{itemId, qty, delta}` |
| `market:update` | economy | `{prices}` |
| `levelup` | economy | `{rank, prevRank}` |
| `goal:progress` / `goal:complete` | economy/ui | `{goalId, progress}` |
| `achievement:unlock` | economy | `{achId}` |
| `build` | world | `{buildingId, type, tx, ty}` |
| `build:remove` | world | `{buildingId, type}` |
| `crop:plant` | crops | `{cropId, tx, ty, id}` |
| `crop:ready` | crops | `{id, cropId, tx, ty}` |
| `crop:harvest` | crops | `{id, cropId, itemId, qty}` |
| `animal:spawn` | animals | `{id, breed, tx, ty}` |
| `animal:born` | animals | `{id, breed, motherId}` |
| `animal:produce` | animals | `{id, itemId, amount}` |
| `animal:need` | animals | `{id, need, value}` (fires when a need crosses a warning threshold) |
| `animal:die` | animals | `{id, breed, cause}` |
| `build:select` / `entity:select` | input | `{buildingId}` / `{kind, id}` |
| `tool:change` | input | `{tool}` |
| `notify` | any | `{text, icon, kind:"info"\|"good"\|"warn"\|"bad", ttl}` |
| `tutorial:step` | tutorial | `{step, id}` |
| `tutorial:done` | tutorial | `{}` |
| `save` / `load` | save | `{slot, version}` |
| `ui:panel:open` / `ui:panel:close` | ui | `{panel}` |
| `game:ready` | game | `{}` (all init complete) |
| `game:pause` / `game:resume` | game | `{}` |

Rule: **UI listens, systems emit.** Simulation modules never call `Game.UI` directly — they `emit('notify', …)` and UI decides presentation.

---

## 4. Main loop design (`Game`)

`game.js` owns a single `requestAnimationFrame` loop with a **fixed-timestep simulation** decoupled from render.

```
SIM_HZ        = 8            // base simulation frames per real second at speed 1
SIM_DT_MS     = 1000/SIM_HZ  // 125ms accumulator step
TICKS_PER_SIM = 1            // 1 sim step advances the clock by `speed` game-minutes
```

- `Game.state.settings.speed ∈ {1,2,3}` multiplies **how many game-minutes each sim step advances** (via `Game.Time.step(minutes)`), not the RAF rate. `paused` freezes the accumulator (render continues, so blinks/hover still animate via a separate `presentationTime`).
- Loop:
  ```
  function frame(now):
    dt = now - last; last = now
    playtime += dt
    if !paused:
      acc += dt
      while acc >= SIM_DT_MS:
        Game.Time.step(state.settings.speed)   // advances minuteOfDay; may emit day:advance
        Game.Crops.update(1)                    // 1 sim-step; internally scales by minutes
        Game.Animals.update(1)
        Game.Economy.update(1)
        acc -= SIM_DT_MS
    Game.Render.frame(now)                       // interpolates animal x,y toward tile centers
    Game.Audio.update(now)
    Game.UI.tick(now)                            // cheap: HUD numbers, notification timers
    raf(frame)
  ```
- **Day advance:** `Time.step` increments `minuteOfDay`; on wrap past 1440 it increments `day`/`dayOfSeason`, rolls season/year at `DAYS_PER_SEASON`, and emits `day:advance` (then possibly `season:change`). Systems subscribe to `day:advance` for per-day work (market re-roll, need decay accounting, autosave trigger, goal checks). Per-tick continuous work (movement, growth, production cooldowns) happens in each module's `update()`.
- **Interpolation:** simulation moves animals in tile steps by setting `ai.targetTx/targetTy`; render eases `x,y` toward the target each frame for smooth motion independent of SIM_HZ.
- Spike guard: `acc` is clamped to a max (e.g. 500ms) so a backgrounded tab doesn't fast-forward days.

---

## 5. Render layering & camera

`Game.Render.frame(now)` draws in this fixed back-to-front order onto one canvas:

1. **Sky/background gradient** — season + time-of-day tinted.
2. **Terrain tiles** — grass/dirt/water/path, only visible tiles (culled by camera).
3. **Tile decals** — fences, tilled soil, water shimmer.
4. **Crops** — sorted by `ty` (painter's).
5. **Buildings** — sorted by `ty` (so animals in front of lower buildings draw over them).
6. **Animals** — merged with buildings/crops into one y-sorted pass for correct overlap.
7. **Props/decoration** — flowers, rocks, signposts.
8. **Ground particles** — dust, water splashes.
9. **Weather overlay** — rain/snow particles, cloud shadows.
10. **Day-night light** — multiply/overlay gradient by `minuteOfDay` (dawn/noon/dusk/night), plus warm window glow at night.
11. **Air particles** — hearts, sparkles, "+G" floaters, emote bubbles.
12. **Placement ghost & selection highlight** — driven by `Game.Input` current tool.

Layers 4–6 share a single y-sorted list built each frame from visible entities.

**Camera model:** `state.camera = {x, y, zoom}` where `x,y` is the world-unit coordinate at the top-left of the viewport and `zoom ∈ [ZOOM_MIN, ZOOM_MAX]` (e.g. 0.5..2.5).
`screen = (world - camera_xy) * zoom`. Inverse for picking: `world = screen/zoom + camera_xy`.
Pan is clamped so the ranch bounds (`0..grid.w*TILE`, `0..grid.h*TILE`) can't scroll fully off-screen (`Game.Render.clampCamera()`). Zoom is anchored at the cursor/pinch midpoint. DPR-aware: canvas backing store scaled by `devicePixelRatio`.

---

## 6. Save format & versioning

- **Key:** `localStorage["makiba.save.v1.slot0"]` (+ `slot1`, `slot2`; `makiba.settings` mirrors settings for pre-load).
- **Format:** `JSON.stringify` of a wrapper: `{ v: SCHEMA_VERSION, t: epochMs, state: <Game.state> }`. Transient fields (none currently — camera is kept) are stripped by `Save.serialize`. `rngState` is persisted so RNG is deterministic across load.
- **Autosave:** `Save.enableAutosave()` subscribes to `day:advance` and writes slot0 every N days (default 1), debounced; also saves on `visibilitychange` hidden.
- **Migration:** `Save.migrate(raw)` runs a chain `migrations[from→from+1]` until `raw.v === SCHEMA_VERSION`. Each migration is a pure `(state)=>state`. Unknown/newer versions → refuse & offer fresh start (never crash). Corrupt JSON → caught, treated as no save.
- **Load flow:** `Save.load(slot)` → parse → migrate → validate shape (fill missing keys from `newGame` defaults, deep-merge) → assign into `Game.state`.

---

## 7. Build approach (`tools/build.js`)

Node script, run via `node tools/build.js` (also a `--watch` mode).

1. Read `src/js/` files in the **fixed order array** hardcoded in the script (00-data … game). Fail loudly if a listed file is missing or an unexpected file is present.
2. Read `src/css/styles.css`.
3. Read `tools/template.html` (shell with `<canvas id="game">`, `<div id="ui-root">`, `%%CSS%%`, `%%JS%%`, `%%TITLE%%` markers).
4. Concatenate JS in order into one IIFE-wrapped block: `(function(){ const Game = (window.Game = window.Game || {}); \n<module1>\n<module2>… \n document.addEventListener('DOMContentLoaded', function(){ Game.boot(); }); })();`
5. Inline CSS into `<style>`, JS into `<script>`, write `index.html` at repo root.
6. No minification required (single-file clarity), but strip nothing that breaks. Assert output has no `import`/`require`/`fetch`/CDN URLs (constraint guard).

Each module file is authored as: `Game.Economy = (function(){ … return {…}; })();` — a self-contained assignment, no leading `(function(){` of its own that the concat would double-wrap incorrectly. (The build's single outer IIFE provides shared closure + the `Game` const.)

---

## 8. Integration rules for implementers (MUST follow)

1. **No top-level side effects.** A module file, when evaluated, may only (a) define its namespace object and (b) attach it to `Game`. No DOM access, no `new AudioContext`, no reading `Game.state`, no `addEventListener`, no timers at eval time. All of that goes in `Game.X.init(ctx)`.
2. **`init(ctx)` contract.** `game.js` calls each module's `init()` in load order after `Game.state` exists, passing `ctx = { canvas, ui:rootEl, state:Game.state }`. Order: State→Save(load or newGame)→Time→Economy→World→Crops→Animals→Sprites→Render→Audio→Input→UI→Tutorial. Register bus listeners inside `init`.
3. **Draw functions are pure.** Everything in `Game.Sprites.*` and `Game.Render` draw helpers take `(ctx, ...args)` and must not mutate `Game.state` or read the clock directly (time/season passed as args). Same output for same inputs → safe to call at any speed/paused.
4. **State mutation ownership.** Only the owning module writes its sub-tree (table §2). Others read freely and request changes via that module's public API or a bus event. Money is changed **only** via `Game.Economy.credit/debit`. Inventory only via `Game.Economy.addItem/removeItem`.
5. **RNG discipline.** All randomness goes through `Game.Util.rng()` (seeded, advances `state.rngState`) so runs are reproducible and saves are deterministic. No `Math.random()`.
6. **Registering a UI panel.** `Game.UI.registerPanel({ id, title, icon, render(bodyEl, state), onOpen?, onClose? })`. Panels are created lazily; `render` populates a DOM node UI owns. Open via `Game.UI.openPanel(id)` or `bus.emit('ui:panel:open',{panel:id})`.
7. **Registering an input tool.** `Game.Input.registerTool({ id, cursor, onTileEnter?(tx,ty), onTileClick?(tx,ty,btn), onEntityClick?(kind,id), ghost?(ctx,tx,ty), onExit? })`. Placement modes (build/plant/buy-animal) are tools. Switch with `Game.Input.setTool(id, payload)`; emits `tool:change`.
8. **Notifications, not coupling.** To tell the player something, `bus.emit('notify', {...})`. Never call into `Game.UI` from a sim module.
9. **No cross-module eval-time refs.** Reference other namespaces only inside functions/`init`, never at file top level (load order guarantees existence only at runtime, not necessarily at eval of a given line if refactored).
10. **Numbers from data.** All balance values (prices, growth times, capacities, decay rates, rank thresholds) come from `Game.DATA`. No magic numbers in logic modules.

---

## 9. Public API per module

Signature notation: `Game.NS.fn(args)->ret`. `id` = int, `tile`=`{tx,ty}`.

### `Game.DATA` (00-data.js)
Owns: nothing (frozen data). Depends on: none.
Read-only tables (deep-frozen). Accessors are plain property reads plus a few lookups:
- `Game.DATA.breeds` `{holstein:{name,baseYield,productItem,gestationDays,adultDays,feedRate,value,rarity,palette,size,traits}, ...}`
- `Game.DATA.animals` (non-cow species, same shape) / merged view `Game.DATA.species`
- `Game.DATA.crops` `{corn:{name,seedCost,growTicks,stages,yieldItem,yieldQty,season:[...],waterNeed}, ...}`
- `Game.DATA.buildings` `{barn:{name,cost,w,h,capacity,accepts:[...],produces?,upgradeTo?,unlockRank}, ...}`
- `Game.DATA.products` `{milk:{name,basePrice,category,recipe?}, cheese:{recipe:{milk:2},time,...}, ...}`
- `Game.DATA.ranks` `[{rank,xpNeeded,title,unlocks}]`, `Game.DATA.seasons`, `Game.DATA.weatherTable`
- `Game.DATA.goals`, `Game.DATA.achievements`, `Game.DATA.upgrades`
- `Game.DATA.const` `{TILE,DAYS_PER_SEASON,TICKS_PER_DAY,SIM_HZ, needDecay:{...}, ZOOM_MIN,ZOOM_MAX}`
- `Game.DATA.get(category,id)->obj|undefined`

### `Game.Util` + `Game.bus` (util.js)
Owns: `Game.bus` singleton, `state.rngState` cursor helper. Depends on: none.
- `Game.Util.makeEventBus()->{on,once,off,emit}`
- `Game.Util.makeRng(seed)->fn()` — mulberry32; returns float [0,1)
- `Game.Util.rng()->float` — bound to `Game.state.rngState` (set in init)
- `Game.Util.randInt(min,max)->int`, `Game.Util.pick(arr)->el`, `Game.Util.chance(p)->bool`
- `Game.Util.clamp(v,min,max)->num`, `Game.Util.lerp(a,b,t)->num`, `Game.Util.invLerp(a,b,v)->t`
- `Game.Util.ease.inOut(t)`, `.outBack(t)`, `.outElastic(t)`, `.outBounce(t)` `->num`
- `Game.Util.formatG(n)->str` ("1,234G"), `Game.Util.formatTime(min)->str` ("06:30")
- `Game.Util.uid(state,key)->int` (returns & increments `state[key]`)
- `Game.Util.aabb(ax,ay,aw,ah,bx,by,bw,bh)->bool`, `Game.Util.dist2(ax,ay,bx,by)->num`

### `Game.State` (state.js)
Owns: `Game.state` reference + `SCHEMA_VERSION`. Depends on: DATA, Util.
- `Game.State.SCHEMA_VERSION` `=1`
- `Game.State.newGame(seed?)->stateObject` — full default state per §2, one free `holstein`, rundown starter buildings.
- `Game.State.set(stateObj)->void` — replaces `Game.state` (used by Save.load)
- `Game.State.defaults()->partialState` — used by load deep-merge to backfill missing keys

### `Game.Save` (save.js)
Owns: nothing (reads/writes state + localStorage). Depends on: State, Util(bus).
- `Game.Save.init(ctx)->void`
- `Game.Save.save(slot=0)->bool`
- `Game.Save.load(slot=0)->bool` (assigns into Game.state via State.set; returns false if none)
- `Game.Save.hasSave(slot=0)->bool`
- `Game.Save.deleteSave(slot=0)->void`
- `Game.Save.serialize(state)->string`, `Game.Save.deserialize(str)->state`
- `Game.Save.migrate(rawWrapper)->rawWrapper`
- `Game.Save.enableAutosave(days=1)->void`, `Game.Save.exportString()->b64`, `Game.Save.importString(b64)->bool`

### `Game.Time` (time.js)
Owns: `state.tick, minuteOfDay, day, dayOfSeason, season, year, weather, weatherTicksLeft`. Depends on: DATA, Util(bus).
- `Game.Time.init(ctx)->void`
- `Game.Time.step(minutes)->void` — advance clock by N game-minutes; emits minute/day/season/weather events.
- `Game.Time.isNight()->bool`, `Game.Time.lightLevel()->float` (0..1 for render)
- `Game.Time.rollWeather()->weatherId`, `Game.Time.setWeather(w)->void`
- `Game.Time.clock()->{minuteOfDay,day,season,year,weather}`

### `Game.Economy` (economy.js)
Owns: `state.money, rank, rankXp, inventory, seeds, market, upgrades, unlocked, goals, achievements, stats`. Depends on: DATA, Util(bus), Time(events).
- `Game.Economy.init(ctx)->void`, `Game.Economy.update(steps)->void`
- `Game.Economy.canAfford(cost)->bool`
- `Game.Economy.debit(amount, reason)->bool` (fails if insufficient; emits money:change/purchase)
- `Game.Economy.credit(amount, reason)->void`
- `Game.Economy.addItem(itemId, qty)->void`, `Game.Economy.removeItem(itemId, qty)->bool`, `Game.Economy.itemCount(itemId)->int`
- `Game.Economy.sell(itemId, qty)->{ok,total}` (uses market price; emits sale)
- `Game.Economy.buySeed(cropId, qty)->bool`, `Game.Economy.price(itemId)->G`
- `Game.Economy.updateMarket()->void` (daily drift; emits market:update)
- `Game.Economy.addXp(n)->void` (may emit levelup), `Game.Economy.rankInfo()->{rank,title,xp,next}`
- `Game.Economy.buyUpgrade(upgradeId)->bool`, `Game.Economy.hasUpgrade(id)->bool`, `Game.Economy.isUnlocked(cat,id)->bool`, `Game.Economy.unlock(cat,id)->void`
- `Game.Economy.stat(key, delta)->void`, `Game.Economy.checkGoals()->void`

### `Game.World` (world.js)
Owns: `state.grid, buildings, nextBuildingId`. Depends on: DATA, Util(bus), Economy(cost).
- `Game.World.init(ctx)->void`
- `Game.World.tileAt(tx,ty)->Tile|null`, `Game.World.inBounds(tx,ty)->bool`
- `Game.World.canPlace(type, tx, ty)->{ok, reason?}` (footprint, occupancy, terrain, unlock)
- `Game.World.place(type, tx, ty)->buildingId|-1` (debits via Economy, emits build)
- `Game.World.remove(buildingId)->bool` (emits build:remove)
- `Game.World.buildingAt(tx,ty)->building|null`, `Game.World.getBuilding(id)->building|null`
- `Game.World.buildingsOfType(type)->[building]`, `Game.World.upgrade(id)->bool`
- `Game.World.freeTileNear(tx,ty,pred?)->{tx,ty}|null` (for animal spawn/AI)
- `Game.World.isWalkable(tx,ty)->bool`, `Game.World.capacityFor(type)->{used,max}`
- `Game.World.addInhabitant(buildingId,animalId)->bool`, `Game.World.removeInhabitant(buildingId,animalId)->void`

### `Game.Crops` (crops.js)
Owns: `state.crops, nextCropId` (+ writes `tile.cropId` via World). Depends on: DATA, Util, World, Economy, Time(events).
- `Game.Crops.init(ctx)->void`, `Game.Crops.update(steps)->void` (growth, weather/water effects)
- `Game.Crops.canPlant(cropId,tx,ty)->{ok,reason?}` (season, tilled/empty tile)
- `Game.Crops.plant(cropId,tx,ty)->cropId|-1` (consumes seed via Economy)
- `Game.Crops.water(tx,ty)->bool`, `Game.Crops.harvest(tx,ty)->{ok,itemId,qty}` (adds to inventory)
- `Game.Crops.cropAt(tx,ty)->crop|null`, `Game.Crops.isReady(id)->bool`, `Game.Crops.stageOf(crop)->int`

### `Game.Animals` (animals.js)
Owns: `state.animals, nextAnimalId`. Depends on: DATA, Util, World, Economy, Time(events).
- `Game.Animals.init(ctx)->void`, `Game.Animals.update(steps)->void` (needs decay, production, AI move, aging, gestation)
- `Game.Animals.spawn(breedId, tx, ty, opts?)->animalId` (emits animal:spawn)
- `Game.Animals.buy(breedId, buildingId)->{ok,id,reason?}` (debits, assigns home, capacity check)
- `Game.Animals.sell(animalId)->{ok,total}`
- `Game.Animals.get(id)->animal|null`, `Game.Animals.at(tx,ty)->animal|null`, `Game.Animals.inBuilding(buildingId)->[animal]`
- `Game.Animals.feed(animalId, feedItemId)->bool`, `Game.Animals.feedBuilding(buildingId, feedItemId)->int`
- `Game.Animals.pet(animalId)->void` (happiness+ , emits particles via bus), `Game.Animals.clean(animalId)->void`
- `Game.Animals.collect(animalId)->{ok,itemId,amount}`, `Game.Animals.collectBuilding(buildingId)->{items}`
- `Game.Animals.canBreed(aId,bId)->bool`, `Game.Animals.breed(aId,bId)->{ok,reason?}` (sets pregnancy)
- `Game.Animals.rename(id,name)->void`, `Game.Animals.needSummary(id)->{hunger,happiness,health,cleanliness}`

### `Game.Sprites` (sprites.js)
Owns: nothing (pure draw). Depends on: DATA, Util(ease). **All functions pure `(ctx, ...)->void`.**
- `Game.Sprites.animal(ctx, breedId, x, y, opts)` — opts `{size, facing, hopPhase, blink, mood, adult}`
- `Game.Sprites.building(ctx, type, x, y, opts)` — `{level, w, h, lit}`
- `Game.Sprites.crop(ctx, cropId, x, y, opts)` — `{stage, watered, sway}`
- `Game.Sprites.prop(ctx, propId, x, y, opts)`, `Game.Sprites.tile(ctx, terrain, x, y, size, variant)`
- `Game.Sprites.weatherParticle(ctx, type, x, y, t)`, `Game.Sprites.heart/sparkle/coin(ctx,x,y,t)`
- `Game.Sprites.face(ctx, x, y, r, opts)` — reusable kawaii eyes/blush/mouth
- `Game.Sprites.uiIcon(ctx, iconId, x, y, size)` — for canvas-drawn item icons

### `Game.Render` (render.js)
Owns: `state.camera`, particle pool (transient, not persisted). Depends on: DATA, Util, Sprites, World, Crops, Animals, Time, Economy(read), Input(current tool ghost).
- `Game.Render.init(ctx)->void`, `Game.Render.frame(now)->void`
- `Game.Render.worldToScreen(wx,wy)->{sx,sy}`, `Game.Render.screenToWorld(sx,sy)->{wx,wy}`, `Game.Render.screenToTile(sx,sy)->{tx,ty}`
- `Game.Render.panBy(dxScreen,dyScreen)->void`, `Game.Render.zoomAt(sx,sy,factor)->void`, `Game.Render.clampCamera()->void`
- `Game.Render.centerOn(tx,ty)->void`, `Game.Render.resize()->void`
- `Game.Render.spawnParticle(kind,wx,wy,opts)->void`, `Game.Render.emitFloatText(wx,wy,text,color)->void`
- `Game.Render.shake(mag)->void`

### `Game.Audio` (audio.js)
Owns: AudioContext + nodes (transient), reads `state.settings`. Depends on: DATA, Util(bus).
- `Game.Audio.init(ctx)->void` (lazy `resume()` on first user gesture), `Game.Audio.update(now)->void`
- `Game.Audio.sfx(id, opts?)->void` (ids: coin, plant, harvest, moo, chick, build, click, error, levelup, heart, pop)
- `Game.Audio.playMusic(trackId)->void`, `Game.Audio.stopMusic()->void`, `Game.Audio.duckFor(ms)->void`
- `Game.Audio.setVolumes({master,sfx,music})->void`, `Game.Audio.setMuted(bool)->void`
- Wires common SFX to bus events (sale→coin, build→build, animal:born→heart) inside init.

### `Game.Input` (input.js)
Owns: current tool + pointer state (transient). Depends on: Render(coord transforms), World, Animals, Crops, UI, bus.
- `Game.Input.init(ctx)->void`
- `Game.Input.registerTool(toolDef)->void`, `Game.Input.setTool(id, payload?)->void`, `Game.Input.getTool()->id`, `Game.Input.clearTool()->void` (back to "inspect")
- `Game.Input.pickAt(sx,sy)->{kind:'animal'|'building'|'crop'|'tile', id?, tx, ty}`
- `Game.Input.hoverTile()->{tx,ty}|null`
- Internally handles: wheel/pinch zoom (→Render.zoomAt), drag pan (→Render.panBy), tap vs drag disambiguation, keyboard (arrows/WASD pan, +/- zoom, space pause, 1/2/3 speed, esc cancel tool).

### `Game.UI` (ui.js)
Owns: `state.settings` writes, DOM overlay tree, `state.goals/achievements` display. Depends on: everything (read) + bus. Writes only via public setters/bus.
- `Game.UI.init(ctx)->void`, `Game.UI.tick(now)->void` (refresh HUD numbers, timers)
- `Game.UI.registerPanel(panelDef)->void`, `Game.UI.openPanel(id, payload?)->void`, `Game.UI.closePanel(id)->void`, `Game.UI.togglePanel(id)->void`
- Built-in panels registered in init: `shop, barn, inspector, upgrades, goals, market, almanac, settings`.
- `Game.UI.notify({text,icon,kind,ttl})->void` (also bus 'notify' → this), `Game.UI.toast(text)->void`
- `Game.UI.tooltip(show, x, y, html)->void`, `Game.UI.modal({title,body,buttons})->Promise<choice>`
- `Game.UI.confirm(msg)->Promise<bool>`, `Game.UI.openInspector(kind,id)->void`
- `Game.UI.refreshHUD()->void`, `Game.UI.setPlacementBanner(text|null)->void`

### `Game.Tutorial` (tutorial.js)
Owns: `state.tutorial`. Depends on: UI, bus, and reads world/economy to detect step completion.
- `Game.Tutorial.init(ctx)->void`, `Game.Tutorial.start()->void`, `Game.Tutorial.skip()->void`
- `Game.Tutorial.next()->void`, `Game.Tutorial.current()->stepDef|null`, `Game.Tutorial.isActive()->bool`
- Step defs `{id, text, highlight:selector|tileRect, gate:(state)=>bool, onEnter?, requireEvent?}`; advances when `gate` passes or `requireEvent` fires. Emits `tutorial:step`/`tutorial:done`.

### `Game` (game.js — boot + loop)
Owns: RAF handle, accumulator, `paused` orchestration. Depends on: all.
- `Game.boot()->void` — the DOMContentLoaded entry: grabs canvas/ui root, builds ctx, runs init order, loads save or `newGame`, starts loop, kicks tutorial if new, emits `game:ready`.
- `Game.start()->void` / `Game.stop()->void` (RAF control)
- `Game.pause()->void` / `Game.resume()->void` / `Game.togglePause()->void`
- `Game.setSpeed(1|2|3)->void`
- `Game.resetGame()->void` (confirm → newGame → save), `Game.hardReload()->void`

---

## 10. Bootstrap order (authoritative)

```
DOMContentLoaded → Game.boot():
  ctx = { canvas:#game, ui:#ui-root }
  Game.State: if Save.hasSave() → Save.load() else Game.state = newGame(randomSeed)
  bind Game.Util.rng to state.rngState
  init in order: Time, Economy, World, Crops, Animals, Sprites, Render, Audio, Input, UI, Tutorial
  Save.enableAutosave()
  Render.resize(); Render.centerOn(spawn)
  if state.tutorial.active → Tutorial.start()
  bus.emit('game:ready')
  Game.start()   // begins RAF loop
```

Sprites/Render/Audio have no state ownership beyond transient pools; they can init after simulation modules safely. Input needs Render (coords) and UI (panels) present, so it initializes after both are constructed but UI registers panels in its own init — Input only references them at event time, satisfying rule #9.
