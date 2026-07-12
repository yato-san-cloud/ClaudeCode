# IMPLEMENTER BRIEF — まきばのしずく (Makiba no Shizuku)

You are implementing ONE `src/js/<module>.js` file for a cute, vast, commercial-grade
ranch-management browser game. Read this brief + `docs/design/architecture.md` fully.
Visual modules also read `docs/design/art-bible.md`; gameplay modules skim
`docs/design/game-design.md`. The backbone (data/util/state/save/time/game) is DONE and
verified — you build on it.

Goal quality bar: **市販レベル (commercial)**. Cute, juicy, robust, no dead-ends, no console
errors. Write complete, production-quality code — not stubs, not TODOs.

---

## 0. Golden integration rules (violating these breaks the build)

1. **File shape.** The build wraps every module file in its OWN IIFE and concatenates them
   in order. Author your file as a single top-level assignment:
   `Game.Economy = (function () { 'use strict'; /* module-local helpers here */ return { /* public API */ }; })();`
   Module-local `const`/`function` at the top level of your file are private to your module
   (each file is its own IIFE). Share ONLY via the returned `Game.X` object.
2. **Globals available at eval time:** `Game`, `Game.RAW`, `Game.DATA`, `Game.Util`,
   `Game.bus`, `Game.State`, `Game.Save`, `Game.Time`. Other sim modules
   (`Game.Economy/World/Crops/Animals/Sprites/Render/Audio/Input/UI/Tutorial`) exist at
   RUNTIME (inside functions/`init`), NOT necessarily when your file first evaluates. So
   **never reference another sim module at file top level** — only inside functions.
3. **No top-level side effects.** At eval time only define+attach your namespace. All DOM
   access, `new AudioContext()`, `addEventListener`, `Game.state` reads, bus subscriptions,
   timers → go inside `Game.X.init(ctx)`. `game.js` calls each module's `init(ctx)` in order:
   Time, Economy, World, Crops, Animals, Sprites, Render, Audio, Input, UI, Tutorial.
   `ctx = { canvas, root, hud, dock, panels, toast, overlay, state }` (getters).
4. **Read the LIVE state.** Always read `Game.state` fresh. NEVER cache the state object
   (Save.load / new-game swap it). If you cache derived data, also subscribe to
   `bus.on('state:replaced', ...)` to rebuild. Caching individual entities for one frame is fine.
5. **State ownership.** Only the owning module writes its sub-tree (see architecture §2).
   Money changes ONLY via `Game.Economy.debit/credit`. Inventory ONLY via
   `Game.Economy.addItem/removeItem`. Others read freely, mutate via public API / bus.
6. **RNG discipline.** All gameplay randomness → `Game.Util.rng()` (seeded, deterministic,
   persisted). NEVER `Math.random()` in sim logic. For purely-cosmetic render jitter that
   must not perturb the sim stream, use `Game.Util.hash01(id, salt)`.
7. **THE DAILY-SIM MODEL (critical).** All heavy simulation happens once per in-game day, in
   `bus.on('day:advance', ...)` handlers, in this canonical order (handlers fire in module
   init order, which already matches): **Economy(market) → Crops(growth/wither) →
   Animals(needs decay, feed_trough, happiness, health, aging, production, breeding) →
   Economy again for events/goals/achievements/rank**. Your `update(steps)` method is called
   every sim step ONLY for smooth cosmetic work (animal movement interpolation, animation
   phases, dairy/'処理中' timers if you want intra-day). Fast-forward fires `day:advance` N
   times with NO `update()` calls — so anything essential MUST live in `day:advance`, not
   `update()`. Products appear "overnight" at dawn (this is the intended fantasy).
8. **Notify, don't couple.** To tell the player something: `bus.emit('notify', {text, icon,
   kind:'info'|'good'|'warn'|'bad', ttl})`. Sim modules NEVER call `Game.UI` directly.
9. **Numbers from data.** Every price/rate/threshold/capacity comes from `Game.DATA`. No magic
   numbers in logic. (Layout/animation constants in render/ui/sprites are fine.)
10. **Crash-safety.** Guard risky work in try/catch and call `Game._recordError('where', e)` so
    one bug can't freeze the loop. Keep per-frame work cheap; cull off-screen entities.

---

## 1. Backbone APIs you can rely on (already implemented)

### Game.Util  (+ Game.bus)
- RNG: `rng()->[0,1)`, `randInt(min,max)`, `randRange(min,max)`, `pick(arr)`, `chance(p)`,
  `shuffle(arr)`, `hash01(n,salt)` (cosmetic, non-sim).
- Math: `clamp(v,lo,hi)`, `lerp(a,b,t)`, `invLerp(a,b,v)`, `dist2`, `aabb`, `approach(cur,target,maxDelta)`.
- `ease.{linear,in,out,inOut,outBack,outElastic,outBounce}(t)`.
- Format: `formatG(n)->"1,234G"`, `formatNum(n)`, `formatTime(min)->"06:30"`.
- `uid(state,key)->int` (returns & increments), `deepClone(o)`, `deepMerge(dst,src)`.
- `Game.bus`: `on(ev,fn)->unsub`, `once`, `off`, `emit(ev,payload)`. Handlers are wrapped in
  try/catch already.

### Game.DATA  (frozen; see 00-data.js)
- Lists: `cowBreedsList, animalsList, cropsList, productsList, buildingsList, upgradesList,
  achievementsList, eventsList, npcsList, decorationsList, ranksList`.
- Maps by id: `breeds, animalsById, species, crops, products, buildings, upgrades,
  achievements, events, npcs, decorations`. `ranks` is an array (by star).
- Balance refs: `needs, production, feed, market, breeding, cropsBalance, weatherModel,
  speciesTraits, auras, capacities, landPlots, netWorthSpec, dailyTickOrder,
  upgradesEffectSpec, achievementsSpec, eventsSpec, difficulty, startSpec`, plus full `balance`.
- Helpers: `get(cat,id)`, `speciesOf(id)`, `isCow(id)`, `productOf(speciesId)`,
  `basePrice(itemId)`. `rankNetWorth{1..7}`, `rankTitles`, `referencePrices`.
- `DATA.const`: `TILE(48), DAYS_PER_SEASON(12), DAYS_PER_YEAR(48), SEASON_ORDER,
  MINUTES_PER_DAY(1440), SIM_HZ(8), REAL_SECONDS_PER_DAY(120), SPEEDS[1,2,3],
  START_MINUTE(360), PHASES, AMBIENT_LIGHT, LIGHT_TINT, ZOOM_MIN(0.55), ZOOM_MAX(2.6),
  WORLD_W(48), WORLD_H(36), PLOT_W(16), PLOT_H(12), SEASON_NAMES, WEATHER_NAMES`.

### Game.State
- `newGame(seed?)`, `makeAnimal(state,breedId,tx,ty,opts)->animal` (adds to state.animals &
  returns it — USE THIS in Animals.spawn), `placeBuilding(state,type,tx,ty)->building`
  (adds to state.buildings, marks tiles — USE THIS in World.place), `unlockedFor(rank)`,
  `defaultName(breedId,id)`, `set(stateObj)`, `SCHEMA_VERSION`.

### Game.Save: `save(slot)`, `load(slot)`, `hasSave`, `enableAutosave`, export/import.
### Game.Time: `step(min)`, `clock()`, `isNight()`, `phaseAt(min)`, `lightLevel()->0..1`,
  `rollWeather()`, `setWeather(w)`. Emits `tick, minute? , day:advance, season:change,
  weather:change, night:fall, day:break`.

---

## 2. Central state shape (owned sub-trees noted) — read architecture §2 for the full annotated version
```
version, seed, rngState, createdAt, playtimeMs,
money, rank, rankXp,                                   // Economy
tick, minuteOfDay(0..1439), day, dayOfSeason, season, year, weather, weatherTicksLeft, // Time
grid:{w,h,tiles:[{terrain:'grass'|'dirt'|'water'|'path', buildingId, cropId, walkable, fenced, unlocked, variant}]}, // World
buildings:[{id,type,tx,ty,w,h,level,capacity,inhabitants:[animalId],storage:{itemId:qty},progress,builtDay}], nextBuildingId, // World
crops:[{id,cropId,tx,ty,stage,growth(0..1),watered,plantedTick,dead}], nextCropId, // Crops
animals:[{id,breed,species,name,tx,ty,x,y,ageDays,adult,sex,temperament,traits[],
          needs:{hunger,happiness,health,cleanliness}, lastFeedQuality, petBonus,
          production:{ready,itemId,amount,cooldownDays,cycleProgress},
          pregnant,gestationDaysLeft,mateBreed,cooldownDaysLeft,homeBuildingId,
          ai:{mode,targetTx,targetTy,blinkTimer,hopPhase,moveCd,facing}}], nextAnimalId, // Animals
inventory:{itemId:qty}, seeds:{cropId:qty},           // Economy
market:{prices:{id:G}, index:{id:1.0}, trend:{id:-1..1}, glut:{id:0..}, lastUpdateDay, history:{id:[..]}}, // Economy
upgrades:{id:true}, unlocked:{buildings:[],animals:[],crops:[]}, research,   // Economy
buffs:[{target,mult?,add?,daysLeft,label}], loan:{principal}, lastStipendDay, // Economy
goals:{}, achievements:{achId:unlockedDay|null},      // Economy/UI
tutorial:{active,step,seen}, settings:{master,sfx,music,muted,speed,showParticles,reduceMotion,lang}, paused,
camera:{x,y,zoom},                                     // Render
stats:{totalEarned,totalSpent,totalSales,animalsBorn,cropsHarvested,itemsSold,buildingsBuilt,
       daysPlayed,totalMilk,totalCheese,totalEggs,totalTruffle,totalWool,totalPets,maxAnimals},
flags:{}
```
Coordinates: tile `(tx,ty)` integers; world units = tile*TILE(48); animal `x,y` are world-unit
floats (render interpolates toward tile centers). `screen = (world - camera.xy)*zoom`.

---

## 3. Event bus names (emit where you own; listen where you react)
`tick{tick,dt}`, `day:advance{day,dayOfSeason,season,year}`, `season:change{season,year}`,
`weather:change{weather,prev}`, `night:fall`, `day:break`,
`money:change{money,delta,reason}`, `purchase{kind,id,cost,meta}`, `sale{itemId,qty,unitPrice,total}`,
`inventory:change{itemId,qty,delta}`, `market:update{prices}`, `levelup{rank,prevRank}`,
`goal:progress{goalId,progress}`, `goal:complete{goalId}`, `achievement:unlock{achId}`,
`build{buildingId,type,tx,ty}`, `build:remove{buildingId,type}`,
`crop:plant{id,cropId,tx,ty}`, `crop:ready{id,cropId,tx,ty}`, `crop:harvest{id,cropId,itemId,qty}`,
`animal:spawn{id,breed,tx,ty}`, `animal:born{id,breed,motherId}`, `animal:produce{id,itemId,amount}`,
`animal:need{id,need,value}`, `entity:select{kind,id}`, `tool:change{tool}`,
`notify{text,icon,kind,ttl}`, `tutorial:step{step,id}`, `tutorial:done`,
`save`, `load`, `state:replaced{reason}`, `game:ready`, `game:pause`, `game:resume`, `speed:change{speed}`,
`fx:heart{x,y}`, `fx:sparkle{x,y}`, `fx:coin{x,y,amount}` (Render listens to draw particles;
emit these from sim actions like pet/sale/levelup — Render & Audio subscribe).

---

## 4. Public API each module MUST expose (so cross-calls integrate) — from architecture §9

- **Economy**: `init,update(steps), canAfford(cost), debit(amt,reason)->bool, credit(amt,reason),
  addItem(id,qty), removeItem(id,qty)->bool, itemCount(id), sell(id,qty)->{ok,total},
  buySeed(cropId,qty)->bool, price(itemId)->G, updateMarket(), addXp(n), rankInfo(),
  buyUpgrade(id)->bool, hasUpgrade(id), isUnlocked(cat,id), unlock(cat,id), stat(key,delta),
  checkGoals(), netWorth()->G, upgradeMult(target)->number, applyEffectTokens(arr,ctx)`.
- **World**: `init,update?, tileAt(tx,ty), inBounds(tx,ty), canPlace(type,tx,ty)->{ok,reason},
  place(type,tx,ty)->id|-1, remove(id)->bool, buildingAt(tx,ty), getBuilding(id),
  buildingsOfType(type)->[], upgrade(id)->bool, freeTileNear(tx,ty,pred?)->{tx,ty}|null,
  isWalkable(tx,ty), capacityFor(type)->{used,max}, addInhabitant(bId,aId), removeInhabitant(bId,aId)`.
- **Crops**: `init,update(steps), canPlant(cropId,tx,ty)->{ok,reason}, plant(cropId,tx,ty)->id|-1,
  water(tx,ty)->bool, harvest(tx,ty)->{ok,itemId,qty}, cropAt(tx,ty), isReady(id), stageOf(crop)->0..3`.
- **Animals**: `init,update(steps), spawn(breedId,tx,ty,opts?)->id, buy(breedId,buildingId)->{ok,id,reason},
  sell(id)->{ok,total}, get(id), at(tx,ty), inBuilding(bId)->[], feed(id,feedItemId)->bool,
  feedBuilding(bId,feedItemId)->int, pet(id), clean(id), collect(id)->{ok,itemId,amount},
  collectBuilding(bId)->{items}, canBreed(a,b), breed(a,b)->{ok,reason}, rename(id,name),
  needSummary(id)`.
- **Sprites** (pure `(ctx,...)->void`): `animal(ctx,breedId,x,y,opts{size,facing,hopPhase,blink,mood,adult}),
  building(ctx,type,x,y,opts{level,w,h,lit}), crop(ctx,cropId,x,y,opts{stage,watered,sway}),
  prop(ctx,propId,x,y,opts), tile(ctx,terrain,x,y,size,variant), weatherParticle(ctx,type,x,y,t),
  heart/sparkle/coin(ctx,x,y,t), face(ctx,x,y,r,opts), uiIcon(ctx,iconId,x,y,size)`.
- **Render**: `init,frame(now), worldToScreen(wx,wy), screenToWorld(sx,sy), screenToTile(sx,sy),
  panBy(dx,dy), zoomAt(sx,sy,factor), clampCamera(), centerOn(tx,ty), centerOnStart(), resize(),
  spawnParticle(kind,wx,wy,opts), emitFloatText(wx,wy,text,color), shake(mag)`.
- **Audio**: `init,update(now), sfx(id,opts?)` ids: `coin,plant,harvest,moo,chick,build,click,error,
  levelup,heart,pop`; `playMusic(id), stopMusic(), duckFor(ms), setVolumes({master,sfx,music}), setMuted(bool)`.
- **Input**: `init, registerTool(def), setTool(id,payload?), getTool(), clearTool(),
  pickAt(sx,sy)->{kind,id?,tx,ty}, hoverTile()`. Tool def:
  `{id,cursor,onTileEnter?(tx,ty),onTileClick?(tx,ty,btn),onEntityClick?(kind,id),ghost?(ctx,tx,ty),onExit?}`.
- **UI**: `init, tick(now), registerPanel(def), openPanel(id,payload?), closePanel(id), togglePanel(id),
  notify({text,icon,kind,ttl}), toast(text), tooltip(show,x,y,html), modal({title,body,buttons})->Promise,
  confirm(msg)->Promise<bool>, openInspector(kind,id), refreshHUD(), setPlacementBanner(text|null)`.
  Built-in panels to register: `shop, barn, inspector, upgrades, goals, market, almanac, settings`.
- **Tutorial**: `init, start(), skip(), next(), current(), isActive()`.

Any method another module might call before yours is ready must be null-guarded by the caller;
still, expose ALL listed methods so callers don't crash.

---

## 5. Data field names (content.json — use verbatim) & key formulas (balance.json)

**cowBreeds[]**: id,name,emoji,rarity,buyPrice,sellValue,baseMilkPerDay,milkQuality,matureAgeDays,
lifespanDays,feedPerDay,coldResist,heatResist,cutenessBlurb,personality,unlockRank.
**animals[]** (non-cow): id,name,emoji,kind(poultry/livestock/pet/utility),buyPrice,product,
productPerDay,feedPerDay,buildingNeeded,cutenessBlurb,unlockRank.
**crops[]**: id,name,emoji,seedPrice,growDays,feedValue,sellValue,season[],waterNeed,isDecor,
yieldAmount,cutenessBlurb.  **products[]**: id,name,emoji,basePrice,category,spoilDays,craftedFrom?.
**buildings[]**: id,name,emoji,buildCost,footprint[w,h],capacity,function,unlockRank,upgradeOf,cutenessBlurb.
**upgrades[]**: id,name,emoji,cost,effect(STRING like "milkYield*1.15" — note: content uses a single
string; treat as one token),description,unlockRank,requires[].  **achievements[]**: id,name,emoji,
description,condition(e.g. "totalEarned>=10000"),rewardG.  **events[]**: id,name,emoji,kind,weight,
minRank,description,effect(e.g. "happiness+5","spawnCalf").  **ranks[]**: star,name,requiredG,rewardBlurb,unlocksBlurb.
**decorations[]**: id,name,emoji,cost,footprint,happinessBoost,cutenessBlurb.
**npcs[]**: id,name,emoji,role,personality,greeting.

For richer tuning use `DATA.balance` (source of truth for mechanics):
- **Milk yield** (use `balance.production.byBreed[breed].baseMilkPerDay`, NOT content's):
  `milkYield = baseMilkPerDay * happinessMult * healthMult * seasonMult * feedMult * upgradeMult * ageMult`
  `happinessMult = clamp(0.40+0.008*happiness,0.40,1.20)`; `healthMult = clamp(0.55+0.0045*health,0.55,1.00)`;
  `seasonMult`: spring 1.05, autumn 1.0, summer `1-0.25*(1-heatResist)`, winter `1-0.30*(1-coldResist)`;
  `feedMult`: alfalfa 1.15, corn/wheat 1.05, grass/hay/clover 0.95, starving(hunger<20) 0.70;
  `ageMult`: baby/juvenile 0, adult 1. Production begins the day an animal becomes adult.
- **Quality**: `qualityScore = 0.40*happiness+0.25*health+0.20*(feedQuality*100)+0.15*temperament`;
  `premiumChance = clamp((qualityScore-60)/40,0,1)*premiumAffinity[breed]`; on success the day's milk is
  `quality_milk`. wagyu always premium.
- **Other animals** reuse happiness/health/season mult with `speciesTraits[id]` resist; see
  `production.otherAnimals` (chicken egg/day, sheep wool cycleDays 4, alpaca fine_wool 5, goat goat_milk/day,
  pig truffle cycleDays 6, all manure/day 0.5).
- **Needs (daily)**: see `balance.needs`. hunger -=40*weatherMult (+fed); cleanliness -=30*weatherMult (+cleaned);
  `happinessTarget = clamp(45 + 25*(hunger/100) + 15*(clean/100) + petBonus + min(companion,24) + shelter +
  weatherPenaltyIfUnsheltered, 0,100)`; `happiness += (target-happiness)*0.5`;
  `health += (happiness>=75?8:0) - (hunger<20?10:0) - (clean<35?5:0) + baselinePull(60)`; clamp 0..100.
  Neglect is SOFT: never kills, never debts; low needs only cut yield/quality.
- **Market (daily)**: `index' = clamp(index + U(-0.08,0.08)+U(-0.04,0.04)+(1-index)*0.15, 0.60,1.60)`;
  `sellPrice = round(basePrice*index*seasonalDemand[cat][season]*weatherDemand*(1-glut)*(1-0.05+stallBonus))`.
  See `balance.market` for basePrices, seasonalDemand, supplyGlut, marketStallTierBonusPct[0.1,0.16,0.22].
- **Breeding**: `balance.breeding` — gestationDays{cow:8,...}, babyGrowthDays{cow:6,...}, cooldownDays,
  chanceOfTwins, offspring temperament `clamp((tA+tB)/2 + U(-8,+12),10,100)`, rareTraitChance 0.03
  [sparkle_coat,heterochromia,golden], babyScale 0.6, minHappinessToBreed 65.
- **Crops (daily)**: `progress += (1/(growDays*cropGrowMult)) * waterEffect * seasonEffect *
  fertilizerEffect * weatherEffect`; ready at >=1. See `balance.crops` (waterEffect watered 1/dry 0.45,
  seasonEffect inSeason 1.15/neutral 1/offSeason 0.5/deadSeason 0, weatherEffect, witherRules, hardyCrops,
  per-crop table with regrow). 4 growth stages: seed/sprout/growing/ready.
- **Upgrades effect mini-language** (`balance.upgradesEffectSpec`): tokens like `milkYield*1.15`,
  `cropGrow*0.8`(<1 faster), `feedCost*0.9`, `priceBonus+0.1`, `capacity+5`, `needsDecay*0.85`, and flags
  `autoMilk,autoFeed,autoWater,autoCollect,bulkSell,rainShelter`. Multiplicative tokens multiply, additive add.
  content.upgrades[].effect is a single string token; parse `TARGET(OP)(VALUE)` with regex, OP in `*+-=`.
- **Achievement/event mini-languages**: `balance.achievementsSpec` (condition tokens: money,netWorth,day,
  season,ranchRank,cows,animals,species,buildings.<id>,totalMilk,totalCheese,totalEggs,totalPets,... with
  >=,>,<=,<,==,!=) and `balance.eventsSpec` (effect tokens: money+N, happinessAll+N, spawnAnimal:<id>,
  give:<item>+N, seeds:<crop>+N, unlock:<type>:<id>, priceAll*F + days:D, spawnDecor:<id>, buff:<t>*F:days).
- **Rank up**: net worth >= `DATA.rankNetWorth[rank+1]` (see `balance.costs`). netWorth formula:
  `cash + sum(animalValue*0.70) + sum(buildingCost*0.60) + sum(product.qty*basePrice) + sum(landPaid*0.50)`.
- **Soft-failure**: zero-cash stipend 150G (cooldown 2 days), optional mentor loan, floor prices. Never
  bankrupt, never delete animals, never hard-lock.

---

## 6. Cuteness / palette quick-ref (visual modules — full recipes in art-bible.md)
Signature grass `#93D95C` (hi `#B6E870`, mid `#6EBB45`, dark `#4F9A37`). Soil `#A9744A`. Water `#6FBDD6`.
Wood `#B77F4E`(dark `#8A5A34`). Roof red `#E27A5F`, dairy roof blue `#7FB4D6`.
UI cream `#FFF6E3`, panel `#FFFBF0`, border `#E7C596`, text warm-brown `#6B4A2F` (NEVER pure black).
Accents: pink `#FF9CC2`/deep `#FF6FA5`/blush `#FFD1E3`, mint `#85E0BE`/deep `#4FC79C`, yellow(coins/stars)
`#FFD84D`, sky `#8FD6F2`, lavender(premium) `#C9B6F2`. Status: alert `#FF6B6B`, amber `#FFB454`, good `#7ED957`.
Products: milk `#FFFDF6`, quality_milk `#FFF6D6`+gold, cheese `#FFCE4E`, butter `#FFE39B`, yogurt `#FFEFF3`,
egg `#FBEFD6`, wool `#F3EDDF`, fine_wool `#ECE6FB`, truffle `#423229`.
Shape language: round & chunky, ~2 heads tall, big eyes with a white highlight + tiny blush, short legs.
Juice: idle bob, blink, waddle walk, happy hop, heart particles on pet, coin pop on sale, sparkle on level-up,
squash on placement. Respect `state.settings.reduceMotion` (dampen) and `showParticles`.

---

## 7. Deliverable
Write ONLY your assigned `src/js/<module>.js` (do not touch other files). Complete, cute, commercial,
zero console errors, follows every rule above. Then RETURN the structured self-report.
