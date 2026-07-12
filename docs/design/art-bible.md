# 🎨 まきばのしずく — ART & CUTENESS BIBLE

> The single source of truth for how **Ranch Droplet** looks and *feels*.
> Everything here is drawn **procedurally in Canvas2D** — no image files, no emoji-as-sprite for creatures. Emoji are allowed only as tiny UI accents.
> **Prime directive:** every frame should make the player quietly go *「かわいい…！」*.

---

## 0. The Cuteness Doctrine (read this first)

Six rules that every sprite, panel, and animation obeys. If a design choice violates one of these, it is wrong.

1. **Round beats sharp.** No hard corners anywhere. Corners get radius, silhouettes are built from circles and ellipses. Even the barn roof is softened.
2. **Chunky beats realistic.** Big heads, tiny legs, stubby bodies. Proportions are *chibi* (see §2). Never anatomically correct.
3. **Eyes are the soul.** Big, dark, glossy eyes with a bright highlight. The eyes carry 80% of the charm. When in doubt, make the eyes bigger.
4. **Everything breathes.** Nothing is ever perfectly still. Idle bob, blink, tail flick, grass sway. A frozen sprite reads as "broken," not "calm."
5. **Soft light, warm world.** Pastel palette, gentle gradients, soft shadows (never pure black). The world feels sunlit and safe.
6. **Reward with joy.** Every player action gets a squish, a pop, a sparkle, or a heart. Feedback is instant and adorable ("juice," §7).

**Global look:** storybook / picture-book (絵本) meets soft-toy (ぬいぐるみ). Think felt plushies on a sunny hill. Vector-clean fills with a subtle darker outline, gentle inner shading, tiny specular highlights.

---

## 1. Color Palette

All colors are **pastel, warm, high-value**. Saturation is kept moderate so nothing screams. Outlines are **not** pure black — use the darkest tone of the object's own hue at ~85% (a "warm outline") for a soft toy look.

Colors are grouped into tokens. Ship them as a single JS object `Game.Palette` (see §14). Token naming: `group.role`.

### 1.1 Sky

| Token | Hex | Usage |
|---|---|---|
| `sky.dawn.top` | `#8FA9D8` | Early morning zenith (soft periwinkle) |
| `sky.dawn.mid` | `#F3B7C0` | Dawn mid-band (rosy) |
| `sky.dawn.low` | `#FDE9C8` | Dawn horizon (warm cream) |
| `sky.day.top` | `#6FC3EE` | Midday zenith (clear pastel blue) |
| `sky.day.mid` | `#A5DEF5` | Day mid-band |
| `sky.day.low` | `#DCF4FB` | Day horizon haze (pale) |
| `sky.dusk.top` | `#5B4E8C` | Dusk zenith (dusty violet) |
| `sky.dusk.mid` | `#EF9A7A` | Dusk mid-band (coral) |
| `sky.dusk.low` | `#FBD79E` | Dusk horizon (golden peach) |
| `sky.night.top` | `#172443` | Night zenith (deep navy) |
| `sky.night.mid` | `#283A6B` | Night mid-band |
| `sky.night.low` | `#46568F` | Night horizon glow |

### 1.2 Ground — Grass, Soil, Water

| Token | Hex | Usage |
|---|---|---|
| `grass.light` | `#B6E870` | Top highlight of grass tiles, sunlit blades |
| `grass.base` | `#93D95C` | Default grass fill (the world's signature green) |
| `grass.mid` | `#6EBB45` | Tile shading, mowed rows |
| `grass.dark` | `#4F9A37` | Grass shadow / blade underside |
| `grass.blade` | `#57A83A` | Individual accent blades scattered on tiles |
| `soil.light` | `#CBA074` | Dry tilled soil highlight |
| `soil.base` | `#A9744A` | Path / bare earth |
| `soil.dark` | `#7E5230` | Soil shadow, furrow depth |
| `soil.till` | `#8A5A38` | Freshly tilled + watered (damp) row |
| `water.light` | `#9FD9E8` | Pond/well highlight, ripple crest |
| `water.base` | `#6FBDD6` | Water body fill |
| `water.dark` | `#4E9CBB` | Water depth / shadow under edges |

### 1.3 Materials — Wood, Roof, Stone

| Token | Hex | Usage |
|---|---|---|
| `wood.light` | `#DBA772` | Plank highlight, sunlit wood |
| `wood.base` | `#B77F4E` | Standard timber |
| `wood.dark` | `#8A5A34` | Wood shadow, beams, outlines |
| `wood.plank` | `#C99461` | Fence & panel face |
| `roof.red` | `#E27A5F` | Barn / coop roof (soft terracotta) |
| `roof.red.dark` | `#C15A44` | Roof shadow / underside |
| `roof.blue` | `#7FB4D6` | Dairy roof (differentiator) |
| `roof.blue.dark` | `#5E93B6` | Dairy roof shadow |
| `stone.light` | `#C9CBD6` | Well rim, path stones highlight |
| `stone.base` | `#A6A9B8` | Stone fill |
| `stone.dark` | `#7C8092` | Stone shadow / mortar |

### 1.4 UI — Cream & Brown

| Token | Hex | Usage |
|---|---|---|
| `ui.cream` | `#FFF6E3` | Main panel background (parchment) |
| `ui.parchment` | `#FBEAC8` | Secondary/inset panel |
| `ui.panel` | `#FFFBF0` | Bright card / tooltip |
| `ui.border` | `#E7C596` | Panel border (light) |
| `ui.border.dark` | `#C89B63` | Panel border shadow line |
| `ui.wood` | `#B77F4E` | Wooden UI frame / header bar |
| `ui.text` | `#6B4A2F` | Primary text (warm brown, never black) |
| `ui.text.soft` | `#9A7B5C` | Secondary / muted text |
| `ui.shadow` | `#3A2A1A` | Soft shadow color (used at ~12–20% alpha) |

### 1.5 Accents & Status

| Token | Hex | Usage |
|---|---|---|
| `accent.pink` | `#FF9CC2` | Hearts, love, primary cute accent |
| `accent.pink.deep` | `#FF6FA5` | Pressed pink button, heart core |
| `accent.pink.light` | `#FFD1E3` | Blush, soft pink fills |
| `accent.mint` | `#85E0BE` | Confirm / secondary buttons |
| `accent.mint.deep` | `#4FC79C` | Pressed mint, healthy indicator |
| `accent.mint.light` | `#C4F3E2` | Mint fills, clean/health highlight |
| `accent.yellow` | `#FFD84D` | Coins, stars, sparkles, level-up |
| `accent.sky` | `#8FD6F2` | Info highlights, water droplet motif |
| `accent.lav` | `#C9B6F2` | Premium / rare accent (fine wool, wagyu tag) |
| `status.alert` | `#FF6B6B` | Warnings, unhappy/hungry (softened red) |
| `status.amber` | `#FFB454` | Caution, "getting low" |
| `status.good` | `#7ED957` | Good/happy/full status |

### 1.6 Products (icon & drop colors)

| Token | Hex | Usage |
|---|---|---|
| `prod.milk` | `#FFFDF6` | `milk` — cream white |
| `prod.milk.shade` | `#EAE6D6` | milk shading / bottle depth |
| `prod.quality_milk` | `#FFF6D6` | `quality_milk` — pearly cream (add gold sparkle) |
| `prod.cheese` | `#FFCE4E` | `cheese` — golden wheel |
| `prod.cheese.shade` | `#E0A82F` | cheese shading / holes |
| `prod.butter` | `#FFE39B` | `butter` — pale gold block |
| `prod.yogurt` | `#FFEFF3` | `yogurt` — pink-white |
| `prod.egg` | `#FBEFD6` | `egg` — warm shell |
| `prod.egg.shade` | `#E7D2A9` | egg shading |
| `prod.wool` | `#F3EDDF` | `wool` — cream fluff |
| `prod.wool.shade` | `#DAD2BE` | wool shading |
| `prod.fine_wool` | `#ECE6FB` | `fine_wool` — lavender-tinted premium |
| `prod.truffle` | `#423229` | `truffle` — dark cocoa |
| `prod.truffle.shade` | `#2C2018` | truffle shadow |
| `prod.goat_milk` | `#F6FBEF` | `goat_milk` — faint green-white |
| `prod.manure` | `#6B4E37` | `manure` — earthy brown |

### 1.7 Per-Season Grass Tint

Applied as an **overlay/multiply tint** on top of `grass.base` and foliage (lerp 0.6–0.85 strength). Also shifts particle accents.

| Season | Grass tint | Foliage accent | Notes |
|---|---|---|---|
| `spring` | `#A9EE6B` | sakura `#FFC7DD` | Fresh, faint lime; petals drift |
| `summer` | `#74C63F` | pollen `#FFE27A` | Deep lush; heat shimmer, pollen |
| `autumn` | `#CDA64C` | leaf `#E8894B` / `#D45E3C` / `#E9B84C` | Golden amber, drying; falling leaves |
| `winter` | `#DDEBE4` | snow `#FFFFFF` / frost `#DDF0F5` | Frosted pale green; snow accumulation |

### 1.8 Light & Weather Overlays

| Token | Hex | Usage |
|---|---|---|
| `light.night` | `#101C3A` | Night multiply overlay (alpha ramps 0→0.45) |
| `light.lamp` | `#FFE7A8` | Warm window/lamp glow (radial) |
| `light.moon` | `#FDF6E3` | Moon disc |
| `light.star` | `#FFFDF0` | Stars |
| `light.sun` | `#FFF3B0` | Sun disc / god-ray tint |
| `wx.cloud` | `#FFFFFF` | Cloud body |
| `wx.cloud.shade` | `#DCE6EE` | Cloud underside |
| `wx.rain` | `#A9D8EC` | Rain streak (alpha ~0.5) |
| `wx.fog` | `#EAF2F4` | Fog / mist sheet (alpha ~0.25) |
| `wx.snow` | `#FFFFFF` | Snowflake |

---

## 2. Shape Language & Proportions

**Master unit `U`** = one tile edge in logical px (base `U = 48`). All sprite sizes are expressed as multiples of `U` so they scale with zoom.

### 2.1 The chibi rule
- **Creatures are ~2 heads tall.** Head diameter `≈ H/2`, where `H` is the creature's nominal height. The head is *huge* relative to the body.
- **Bodies are bean/blob shaped** — a wide rounded ellipse or superellipse, wider than tall, sitting low.
- **Legs are tiny stubs** — short capsules, `~0.12–0.18 U` long. They exist mostly to bob during the waddle; they never look like real legs.
- **Necks barely exist** (except alpaca/horse, which get a cute stubby-but-longer neck as their signature).

### 2.2 Construction primitives
Build every creature from this kit, drawn back-to-front:
1. **Contact shadow** — soft dark ellipse on the ground, `ui.shadow` @ 15–22% alpha, width ≈ body width, height ≈ 0.25× its width. Always present; it grounds the sprite and drives the "hop" read (shadow shrinks as sprite rises).
2. **Body blob** — filled ellipse/superellipse, breed base color, with a **1.5px warm outline** (darkest breed tone).
3. **Belly/underside patch** — a lighter ellipse low-front (base color +18% lightness) for volume.
4. **Top-light gradient** — subtle vertical gradient on the body (top +8% L, bottom −6% L) baked via a clipped linear gradient. Keeps sprites soft, not flat.
5. **Head circle** — big circle overlapping the upper-front of the body.
6. **Face kit** (§2.3).
7. **Ears / horns / fluff / tail** — breed accessories.

### 2.3 The Face Kit (the money-maker)
- **Eyes:** two large **vertical ellipses** (taller than wide), `~0.14 U` wide, spaced `~0.18 U` apart. Fill with a very dark brown (`#3A2A2A`, never pure black). Each eye gets:
  - a **big highlight** — white circle at upper-left, `~40%` of eye width.
  - a **tiny secondary sparkle** — smaller white dot lower-right, `~15%` eye width.
- **Blink:** scale eye `scaleY` from 1 → 0.08 over 90 ms, hold 60 ms, back over 90 ms. (See §7.)
- **Blush:** two soft pink ovals (`accent.pink.light`, alpha 0.55) under/beside the eyes, `~0.12 U` wide. On by default for babies/pets; appears on happy/pet for adults.
- **Mouth:** minimal — a tiny `w`-curve, `‿` smile, or `3` cat-mouth, 1.5px stroke `ui.text`. Often omitted; the eyes do the work.
- **Muzzle** (hooved animals): a lighter rounded patch low on the head with two small nostril dots.

### 2.4 Outline & shading style
- Outline: 1.5px (at `U=48`), color = object's darkest tone, **not** black. Slightly rounded joins.
- One flat base fill + one lighter belly + one soft gradient + tiny specular. **Max 3 shades per material.** Cel-shaded, clean, no gradients-on-gradients.
- Every creature fits in a **bounding "plush" silhouette**: if you filled the whole sprite black, it should still read as a cute round toy.

---

## 3. Cow Breed Recipes

All 8 canonical breeds. Each is a variation on the generic cow build below. `size` is a multiplier on `H` (base cow `H ≈ 0.85 U`). Draw order per §2.2. Cows are drawn in a **3/4 front view**, horizontally flipped for facing left/right.

**Generic cow build:** shadow → back legs (2 stubs) → body bean → belly patch → spots (clipped to body path) → tail (thin curve + tuft) → front legs (2 stubs) → head circle (upper-front) → ears (2 rounded, sides) → horns → muzzle patch + 2 nostrils → eyes (face kit) → blush → optional forelock. A little **udder** hint (small pale pink rounded bump low-rear) may show on milk breeds — keep it tiny and cute, not detailed.

| id | Base body | Spots / pattern | Horns / fluff | Size | Signature |
|---|---|---|---|---|---|
| `holstein` | white `#FFFDF6`, belly `#FFFFFF` | irregular **black** blobs `#3A3A3E` — 3–5 rounded-random patches clipped to body, one always over the rump, optional one over an eye | tiny cream nubs `#EAD9B4` | 1.00 | The classic. Pink muzzle `#F4B8C4`. Reads instantly as "cow." |
| `jersey` | warm fawn/caramel `#C8925A`, belly `#E4BC8A` | none (solid); darker **eye rings** `#8A5E3C` giving doe-eyed look; dark muzzle ring `#6B4A34` around light muzzle `#D8B48C` | small dark horns `#5A4632`; long **eyelashes** (3 tiny strokes per eye) | 0.92 | Dainty, big-eyed sweetheart. Dark hooves. |
| `brown_swiss` | soft mocha grey-brown `#A89078`, belly + dorsal stripe cream `#E8DCC8` | none; pale muzzle ring `#E8DCC8`; slightly **fuzzy** body edge (tiny bumps on outline) | big soft rounded ears, short pale horns `#D8C9AA` | 1.06 | Gentle giant. Broad, sturdy, calm face. |
| `highland` | shaggy ginger `#C57A3E`, under-fluff `#D89A5C` | none — coat is **long fur**: draw 12–18 overlapping downward wavy strokes (bezier) over body & a **fringe over the eyes**; eyes peek out as two glints under the fringe | huge sweeping pale horns `#E8D6B0` curving out-up; extra fluff everywhere | 1.10 | Mega-floof. Bangs cover eyes. Peak plush. |
| `belted_galloway` | black `#2E2C30`, belly darker `#26242A` | one wide **white belt** `#F4F0E6` wrapping the torso middle (vertical band across the bean, ~35% of body width); rest solid black | small black nubs `#1E1C22`; slightly fluffy | 1.00 | "Oreo cow." The belt is the whole gag — keep it crisp. |
| `wagyu` | deep glossy near-black brown `#3B2F2C`, subtle warm sheen highlight `#5A463E` | none; a soft **specular sheen streak** along the back (premium gloss) | neat dark horns `#4A3A32`; tiny **gold ribbon/tag** `accent.yellow` on ear | 0.98 | High-class. Poised, refined. Occasional lone sparkle. |
| `mini_cow` | white `#FFFDF6` + small black spots `#3A3A3E` (like a chibi holstein) | 2–3 tiny spots; everything rounder & softer | tiny nubs; **bell collar** (mint `#85E0BE` strap + `accent.yellow` bell) | 0.70 | Pocket pet. Head nearly = body (1:1). Max blush always on. |
| `dexter` | solid glossy black `#2A2A2E` (dun variant `#5A4B3A` allowed as rare recolor), belly `#242428` | none; compact & stocky, **short legs** even for a cow | small neat horns `#3A3A40` | 0.82 | Feisty mini. Stocky, low to the ground, glossy. |

### 3.1 Personality & Idle Behavior (per cow)
Idle behaviors loop while the cow is content; they layer *on top of* the universal idle bob + blink.

- **`holstein` — 元気 (genki / cheerful).** The reliable friendly one. Bobs a touch faster, moos most often, does a little happy hop when pet, looks toward the player/cursor when nearby.
- **`jersey` — 内気 (shy).** Timid. When tapped, briefly **turns away** then peeks back over its shoulder; blushes hard; long slow blinks. Rarely moos (soft "むぅ"). Hearts appear smaller but more of them.
- **`brown_swiss` — 穏やか (calm).** Gentle giant. Slowest bob, frequent long blinks, occasional drowsy head-droop then perk back up. Never startled. Deep slow "もぉ〜".
- **`highland` — ねむねむ (sleepy-fluffy).** Dozes often — lies down with **Zzz** particles, fringe hides eyes. Slowest to react. LOVES being pet: extra-large heart burst + a rare happy shake that ripples the fluff.
- **`belted_galloway` — やんちゃ (playful/mischievous).** Bouncy. Does spontaneous **happy hops**, jogs a few steps then stops, tilts head. Cookie mascot energy. Quick reactions.
- **`wagyu` — 気高い (proud/elegant).** Poised. Stands tall, chin slightly up, moves little. Idle **sparkle** near its head now and then. When pet, gives a slow dignified blink + single big heart (not a burst).
- **`mini_cow` — あまえんぼ (clingy pet).** Hyper-affectionate. **Follows the cursor/player** within its pen, does rapid tiny hops, squeaky "も！も！", constantly wants pets (heart icon bubbles above it periodically).
- **`dexter` — 負けん気 (feisty/spunky).** Small but mighty. Quick sharp bobs, occasional **nudge/headbutt** lunge at nothing, energetic little stamps. Big attitude in a small body.

---

## 4. Other Animal Recipes

Same chibi kit. Sizes relative to a cow (`H_cow ≈ 0.85 U`).

- **`chicken` → egg.** Round egg-shaped white body `#FBF7EC`; red comb `#E8607A` (3 little bumps on top) + tiny wattle; orange triangle beak `#F2A63C`; dot eyes with highlight; stubby orange legs `#F2A63C`; wings = side arcs; small upswept tail feathers. Size ~0.45. **Idle:** peck-peck (head dips to ground rhythmically), scratch-scratch (foot rakes soil → tiny dust), sudden startled flap-flap. On lay: squats, an `egg` pops out with a sparkle + "こっ！".
- **`sheep` → wool.** Body = **bumpy cloud** (chain of arcs) in wool cream `#F3EDDF`; small tan face `#E9C9A0` with floppy ears; tiny dark legs `#6B5540`; optional tiny horns. Size ~0.75. **Idle:** nibble grass (head down, jaw wiggle), whole-body fluff jiggle, little hops. On shear: body **slims** to pale pink-cream skin `#F5D9CE` for a day + emits `wool` (or `fine_wool` if upgraded feed) — briefly embarrassed blush.
- **`goat` → goat_milk.** Slim beige body `#EFE6D2`, a bit more side-profile; small **backward-curved horns** `#C9B48A`; little chin **beard tuft**; floppy ears; stylized rectangular pupils drawn as small horizontal dashes (cute, not creepy). Size ~0.7. **Idle:** headbutt-nudge, hops up onto anything (rock, silo step), chews sideways, curious stare. Mischief energy.
- **`pig` → truffle.** Round pink body `#F6B8C0`; big round **snout** `#EE9AA8` with 2 nostril dots; floppy triangle ears; **curly spiral tail**; tiny trotters. Size ~0.65. **Idle:** snuffle/root the ground (snout down → dust puffs), happy wiggle, flops to side. On find: roots up a `truffle` with a proud "ぶひ！" + sparkle. (In autumn, may roll → gets a `manure`/mud speckle, wipes off.)
- **`duck`.** Rounded yellow body `#FFD95C` (white recolor allowed); flat orange **bill** `#F2953C`; tiny wing arc; big dot eyes. Size ~0.5. **Idle:** exaggerated **waddle** (big side-to-side), sits & floats on `pond` with a V-ripple, dabbles head-under-tail-up, "くわっ". Adorable on water.
- **`alpaca` → fine_wool.** Signature **stubby-long neck**: fluffy oval body cream `#F1E9D6` atop a curved fluff neck; small round head with **big eyes + topknot fringe**; banana-shaped ears; slender-but-stubby legs. Size ~0.95 (tall silhouette). **Idle:** gentle neck sway, soft hum, curious neck turns toward things, rare comedic **spit-pfft** (tiny puff particle, then looks away innocently). Premium fluff shimmer.
- **`rabbit` (pet).** Tiny round body white/grey `#F4EFE6`; **huge tall ears** (2 rounded, can flop one); cotton-ball **tail**; big eyes; pink nose. Size ~0.35. **Idle:** nose-twitch (rapid tiny scale), ear-flick, **binky** (joyful mid-air half-twist hop), foot-thump when startled. Peak small-cute.
- **`dog` (看板犬 / signboard dog).** Round puppy, tan/cream `#E2B27C`; floppy ears; big eyes; tongue-out pant (little pink tongue `#FF9CB0`); fast **waggy tail**. Size ~0.55. **Idle:** tail wag (fast sinusoid), pant (tongue bobs), head-tilt, **runs to greet** the player/cursor, sits by `house`. Passive: small happiness aura to nearby animals.
- **`cat` (看板猫 / signboard cat).** Round cat, calico-orange `#F0A55A` (grey `#B9BEC7` recolor); pointy ears; long **curly tail**; whiskers (3 thin strokes each side); `ω`/`3` mouth. Size ~0.5. **Idle:** **loaf** (paws tucked, eyes half-closed), tail-tip flick, **slow love-blink**, grooming lick (paw to ear), naps on `fence`/roof. Aloof but adorable.
- **`horse`.** Larger elegant-but-chibi; chestnut body `#B5713E` (recolors: bay, cream, grey); flowing **mane + tail** `#6B4A2F` (cream variant `#EAD9B4`); longer-but-still-stubby legs; optional white **star blaze** on forehead. Size ~1.15. **Idle:** tail swish, ear swivel, head toss, occasional trot-in-place, soft whinny + a hoof paw at the ground.

---

## 5. Animation & JUICE

Everything uses **normalized easing** on a delta-time loop. Prefer springy, overshooting motion. Baseline tween palette:

- `easeOutBack` (overshoot) — placements, pops, button press-release.
- `easeInOutSine` — idle bobs, sways, breathing, grass.
- `easeOutElastic` (gentle, low amplitude) — level-up badge, big rewards.
- `easeOutCubic` — UI panels sliding, camera pans.
- `easeOutQuad` — particle rises/fades.

### 5.1 Universal idle
- **Idle bob:** body offset `y = sin(t·speed + phase) · amp`. amp `≈ 1.5px` (@U=48), speed ~1.4 rad/s. **Each creature gets a random phase** so a herd never bobs in sync. `scaleY` breathes ±2% anti-phase to the bob (squash at bottom).
- **Blink:** per-creature timer, next blink at `random(2.5s … 6s)`. Blink = eye `scaleY` 1→0.08→1 over ~240 ms (down 90 / hold 60 / up 90). Occasional **double-blink**. Sleepy breeds blink slower & longer.
- **Look-at:** when the player/cursor is within ~2 tiles, eyes/head rotate up to ~8° toward it (eased), adds life & connection.

### 5.2 Locomotion
- **Walk waddle:** body **tilts** ±5° left/right in sync with a side-to-side `x` sway; legs alternate a tiny up-down; a small **squash on each footfall**. Ducks & pigs exaggerate (±9°). Speed of waddle scales with move speed.
- **Turn:** don't rotate the sprite — **flip horizontally** with a quick 120 ms `scaleX` 1→0→1 "card flip" so it reads as turning around cutely.

### 5.3 Emotive beats
- **Eating:** head dips to food, jaw/whole-head does a small rhythmic `scaleY` chew (0.94↔1.0) ~3×, tiny crumb/leaf particles, a `‿` happy mouth, one heart on finish. Happiness/hunger meter ticks with a soft pop.
- **Sleeping:** creature lowers (`y+`, `scaleY` 0.9), eyes become `‿ ‿` closed curves, **Zzz** particles rise & fade (three `Z`s of increasing size, drifting up-right, loop ~2.5s). Highland/cat do this often.
- **Happy hop:** `easeOutBack` jump — `y` up ~6px then down, shadow shrinks then snaps back, land with a **squash** (`scaleY` 0.85 / `scaleX` 1.12) recovering via tiny elastic. 1–3 hearts pop.
- **Pet reaction (player taps/pets an animal):** immediate **squish** (`scaleY` 0.88) → spring back, **heart burst** (3–6 hearts, §6), blush ramps up, a happy sound. Shy breeds turn away first (§3.1).
- **Startle:** quick tiny hop + `!` bubble, ears perk, then settle. Used on sudden weather/night predator flavor (no real danger — it's cozy).

### 5.4 Interaction & economy juice
- **Placement (drop a building/animal):** sprite drops from ~10px up with `easeOutBack`, lands with **squish** + a **dust-puff ring** (§6) + soft *pom* sound. A quick 1-frame white flash at 20% sells the "placed!" moment.
- **Coin pop (on sale / income):** golden coin(s) `accent.yellow` spawn at the source, arc up with `easeOutQuad`, spin (`scaleX` wobble), then **fly toward the money HUD**; on arrival the HUD counter **bumps** (scale 1.15→1) and does a rolling number tween. *cha-ching* SFX.
- **Level-up / rank-up:** central badge scales in with `easeOutElastic`, a **sparkle ring** bursts outward, screen edges get a brief warm vignette glow, celebratory jingle. Confetti hearts + stars rain briefly.
- **Meter fill (needs satisfied):** bar fills with a leading **shine sweep**; when it hits full, a tiny star pops at the bar's end.
- **Harvest / collect:** product icon **pops** up from the tile (`easeOutBack`), does a happy wiggle, flies to inventory; sparkle on premium products (`quality_milk`, `fine_wool`, `truffle`).

### 5.5 Screen shake (STRICT limits)
Cozy game — shake is a seasoning, never a main course.
- **Max amplitude 3px**, **max duration 180 ms**, always `easeOutQuad` decay.
- Allowed only for: big building complete, rank-up, thunder (rare). **Never** on routine taps/sales.
- Provide a **"reduce motion"** setting that halves all amplitudes and disables shake entirely.

### 5.6 Timing cheat-sheet
| Action | Duration | Easing |
|---|---|---|
| Button press → release | 70 / 120 ms | back |
| Panel open / close | 220 / 160 ms | outCubic |
| Placement drop | 260 ms | outBack |
| Blink | 240 ms | linear-ish |
| Happy hop | 380 ms | outBack |
| Coin arc to HUD | 500 ms | outQuad |
| Level-up badge | 700 ms | outElastic |
| Toast slide-in | 300 ms | outBack |

---

## 6. Particle Effects Catalog

One lightweight pooled particle system. Each particle: `pos, vel, gravity, life, scale, rotation, color, drawKind`. Keep counts modest (mobile-friendly); cap total on screen ~250.

| Effect | Trigger | Look & motion |
|---|---|---|
| **Hearts** | pet, happy, love | Pink `accent.pink` heart, spawns at creature head, rises + slight side-drift, gentle rotate wobble, scales up then fades. Burst = 3–6 with staggered delay. |
| **Sparkles** | premium product, level-up, clean, wagyu idle | 4-point twinkle star `accent.yellow`/white, appears, scales 0→1→0 with a rotation, very short life. Often in small clusters. |
| **Coins** | sale, income | Gold disc `accent.yellow` with lighter rim, arcs & spins, flies to HUD. |
| **Dust puff** | placement, footfall, root/scratch | Small soft tan ring `soil.light`/`grass.light`, expands outward & fades fast (~300 ms), low to ground. |
| **Zzz** | sleeping | Soft blue-grey `Z` glyphs, three sizes, drift up-right, slow loop. |
| **Splash / ripple** | duck on pond, rain on water, well use | Concentric `water.light` rings expanding + fading on the water surface. |
| **Rain** | rainy weather | Thin `wx.rain` streaks falling at slight angle, plus tiny impact rings on ground/water. Density scales with intensity. |
| **Snow** | snowy weather | White `wx.snow` dots, slow wobbly fall (sine drift), varied sizes, settle-fade near ground. Cold-breath puffs on animals. |
| **Falling leaves** | autumn ambient | Leaf shapes `#E8894B / #D45E3C / #E9B84C`, tumble-rotate, sway side to side as they fall, land & fade. |
| **Sakura petals** | spring ambient | Pale pink `#FFC7DD` petals, gentle flutter-drift, occasional swirl. |
| **Pollen / motes** | summer sunny ambient | Tiny warm `#FFE27A` floating dots, slow upward drift, faint glow, low density. |
| **Confetti** | rank-up, achievement, festival | Mixed pastel squares + hearts + stars, burst up then flutter down. |
| **Steam / puff** | dairy processing, hot food, alpaca spit | Small soft white puffs rising & expanding from `dairy` chimney / trough. |
| **Water droplet 💧** | watering, milking, well, the game's motif (しずく) | Signature teardrop `accent.sky`, falls & splashes into a ripple. Used generously — it's the game's namesake. |
| **Crumbs / leaf bits** | eating | Tiny food-colored specks scatter briefly at the mouth. |

---

## 7. Building Visual Recipes

Buildings use a **storybook front-elevation** with a thin top/side face for gentle depth (near-flat, slightly high-angle), sitting on a soft footprint shadow. All corners rounded. Cream trim everywhere. Each has a tiny **idle detail** (smoke, spin, flag) so the ranch feels alive. Occupied buildings show a small **status pip** or peeking animal.

- **`barn` (牛舎).** Rounded-box body `wood.base` with vertical plank lines `wood.dark`; big **gambrel roof** `roof.red` (two-slope, rounded ridge) with `roof.red.dark` underside; round-top **hay door** with cream `ui.border` trim + an X-brace; a **heart-shaped window** (`accent.pink.light` glow when occupied); little **weathervane** (spins slowly, cow-shaped). A cow face may peek from the door.
- **`barn_big` (大型牛舎 / upgrade).** Same language, **wider & taller**, twin gambrel roofs, a cupola on top, two doors, an extra hay-loft window. More weathervanes. Reads as a proud upgrade of `barn`.
- **`coop` (鶏小屋).** Small `wood.light` hut, `roof.red` slanted roof, a **round entry hole** + tiny ramp, a mini perch pole. Chicken heads bob in the window. A tiny egg icon pip when eggs are ready.
- **`pasture` (放牧地).** Open fenced area (see `fence`) over lush grass; a simple **wooden gate**, a water trough, maybe a shade tree (round pastel canopy `grass.mid`+`grass.light`). Animals roam inside.
- **`silo` (サイロ / feed store).** Tall rounded cylinder `stone.light`/`stone.base` with horizontal bands, a **domed cap** `roof.blue`; a small feed-level window showing golden feed inside; little ladder. Rounded, friendly, not industrial.
- **`well` (井戸).** Round `stone.base` rim with `stone.light` top, a little **peaked roof** `wood.base` on two posts, a rope + **bucket**; water shimmer `water.light` inside; rope bobs, droplet 💧 particle on use.
- **`dairy` (加工所).** Cozy cottage `ui.parchment` walls with **blue roof** `roof.blue` (the milk-product differentiator), a **chimney** puffing steam, a shop-style window showing cheese/butter, a hanging cheese-wheel sign. Steam puffs while processing.
- **`market_stall` (直売所).** Cute open-front stall: `wood.base` counter, **striped awning** (cream + `accent.pink` or `accent.mint` stripes, scalloped edge), baskets of products out front, a small chalkboard price sign, a tiny flag. Coins pop here on sale.
- **`warehouse` (倉庫).** Sturdy wide `wood.dark`-trimmed shed, `roof.red` roof, big double doors with a **crate/box motif** stacked beside; a capacity gauge plaque. Homely, not industrial.
- **`house` (自宅).** The player's home: warm cottage `ui.parchment` + `roof.red`, **round door** with a wreath, flower boxes under windows (`accent.pink`/`accent.yellow` dots), chimney smoke in the morning/evening, warm `light.lamp` window glow at night. The `dog`/`cat` often sits out front.
- **`windmill` (風車).** Tall tapered tower `ui.cream`/`wood.base`, **4 rounded sail-blades** that **rotate** (speed tied to wind/weather), a little balcony, a pointed cap. Iconic skyline piece — place on hills.
- **`sprinkler` (スプリンクラー).** Small post with a rotating head; emits **arcing water droplet 💧** particles over nearby crops; tiny rainbow shimmer when it sprays in sun.
- **`feed_trough` (自動給餌器).** Low `wood.base` trough with a small hopper; shows a **feed level** (golden fill); animals gather at it; a little "clunk" + refill animation when restocked.
- **`fence` (柵).** Modular: rounded posts + 2 horizontal rails `wood.plank`, corner posts slightly taller with a **round cap**. Auto-tiles into runs & corners. Cats nap on it. Keep it low and friendly.
- **`pond` (池).** Irregular rounded water body `water.base` with `water.light` rim highlight & `water.dark` depth, **lily pads** (round `grass.mid` discs + tiny `accent.pink` flower), reeds on the edge, gentle looping ripples. Ducks float here; frogs/dragonfly flavor optional.

**Placement feedback:** every building placement uses the §5.4 drop-squish + dust-ring + *pom*. Under-construction state = translucent wireframe outline in `accent.mint` with a progress ring.

---

## 8. Crop Growth Visual Stages

Crops grow in a tilled `soil.till` plot. **4 universal stages** + a wilt state, all with a subtle idle sway (`easeInOutSine`, phase-randomized) and a soft ground shadow.

1. **Seed / planted:** a small mound of `soil.till` with 2–3 tiny seed specks; a 💧 on watering. Barely anything — anticipation.
2. **Sprout:** two tiny `grass.light` cotyledon leaves on a short stem, very bouncy sway.
3. **Growing:** taller stem `grass.mid`, more leaves, a **bud** forming (color hints at the crop). Sways more.
4. **Ready:** full plant with its signature fruit/head in product color, a gentle **bob**, and a periodic **sparkle** to signal "harvest me!". Harvest = §5.4 pop.

- **Wilted (needs water / neglect):** droops (leaves rotate down), desaturates toward `status.amber`; recoverable with water (perks back up with a 💧 + relief bounce).

**Notable crops:**
- `grass` (牧草): low turf clump; regrows fast; "ready" = fuller tuft. Base feed.
- `hay` (干し草): golden dried bundles `#E9C77A`; ready state = tied round bale.
- `corn` (トウモロコシ): **tall** stalk (can exceed 1 tile), broad leaves, a bright `#FFD84D` cob peeking from a husk; sways top-heavy.
- `wheat` (小麦): slender golden stalks `#E7C15A` with a bushy grain head; **wind ripple** across a field (offset sway by x-position) is a signature beauty shot.
- `alfalfa` (アルファルファ / premium feed): leafy green with tiny purple `accent.lav` flowers; faint premium sparkle.
- `carrot` (ニンジン): feathery `grass.light` top; orange `#F2953C` shoulder peeking above soil; full pull-out reveal on harvest.
- `turnip` (カブ): round white-`#F7F3E8`/purple-top `accent.lav` bulb half above soil; chubby and cute.
- `clover` (クローバー): low trefoil leaves; occasional **four-leaf** sparkle variant (lucky!). Bee flavor.
- `pumpkin` (カボチャ): big round orange `#EE8A3C` gourd on a curly vine, ridged; heavy bob. Autumn hero crop.
- `sunflower` (ヒマワリ / decoration): tall stalk, big `accent.yellow` face with `soil.dark` center; **head slowly tracks the sun's x-position** across the day. Pure decoration joy.

---

## 9. Day / Night & Weather Rendering

### 9.1 Time-of-day
Drive everything from a normalized day time `t ∈ [0,1)`. Define keyframe skies and **lerp** the 3-stop vertical gradient between them:

| Phase | ~t | top → mid → low |
|---|---|---|
| Dawn | 0.20–0.28 | `sky.dawn.top` → `sky.dawn.mid` → `sky.dawn.low` |
| Day | 0.30–0.72 | `sky.day.top` → `sky.day.mid` → `sky.day.low` |
| Dusk | 0.74–0.82 | `sky.dusk.top` → `sky.dusk.mid` → `sky.dusk.low` |
| Night | 0.84–0.16 | `sky.night.top` → `sky.night.mid` → `sky.night.low` |

- **Sun:** `light.sun` disc with a soft radial glow, arcs along a shallow parabola across the sky from dawn(east) to dusk(west); x maps to `t`. Casts warm tint; at noon the world is brightest.
- **Moon:** `light.moon` crescent/disc, arcs across the night; subtle glow.
- **Stars:** `light.star` dots fade in during dusk→night (alpha follows a night factor), twinkle via slow per-star sine on alpha. A few tiny shooting stars occasionally.
- **Night light overlay:** full-screen `light.night` multiply, alpha ramps `0` (day) → `~0.45` (deep night) via a smooth night-factor curve. **Warm exceptions:** building windows, `house` chimney, lamps punch through as **radial `light.lamp` glows** drawn *over* the overlay. Animals get a subtle warm rim near light sources.
- **Golden hour:** near dawn/dusk, tint the whole world with a low-alpha warm overlay (`sky.dusk.mid` @ ~12%) for that cozy postcard look.

### 9.2 Weather (per canonical ids)
Weather is a lightweight overlay layer + particle system + tint. Transitions **cross-fade** over ~2–3 s (clouds roll in first).

- **`sunny` (晴):** default clarity; slightly higher saturation; ambient **pollen/petal** motes by season; occasional lens-style sparkle on water & premium items. Sprinklers make mini rainbows.
- **`cloudy` (曇):** drifting `wx.cloud` puffs cast soft moving **shadow blobs** on the ground (low alpha); global saturation −10%, a thin `wx.cloud.shade` sheet at ~10% cools the scene. Gentle, calm mood.
- **`rainy` (雨):** `wx.rain` streak particles + ground/water **impact ripples**; darker via a `#3A4A6A` overlay ~18%; **puddles** form (reflective `water.light` blobs) and dry after; animals may huddle or sport tiny leaf/umbrella flavor; crops perk (auto-watered). Distant soft thunder rare (respect shake limits).
- **`snowy` (雪):** `wx.snow` particles with wobble-drift; **accumulation** = white `wx.snow` caps grow on roofs, fences, ground (progressive alpha mask); world tint toward cool `winter` palette; **cold-breath puffs** from animals; ponds may freeze (matte `water.light` sheet + shine). Cozy, quiet, muffled feel.
- **Fog / mist (dawn ambient, optional):** `wx.fog` sheet at ~20–30% alpha, denser low on screen, thins as day warms. Dreamy mornings.

**Rule:** weather never hurts readability — keep overlays low-alpha and always let the cute sprites shine through.

---

## 10. UI Visual Style

**Vibe:** a warm wooden ranch notebook / picture-book menu. Cream parchment cards in soft wooden frames, rounded everything, bouncy tactile buttons, generous padding, big friendly numbers.

### 10.1 Panels & cards
- Background `ui.cream`; inset areas `ui.parchment`; bright cards `ui.panel`.
- **Border radius large** (12–20px). Border = 2px `ui.border` with a 1px inner `ui.border.dark` line (soft bevel). Optional **wood frame** (`ui.wood`) header bar with rounded top.
- **Soft drop shadow:** `ui.shadow` @ 12–18% alpha, blur ~12px, y-offset ~4px. Never harsh.
- Section headers on a little wooden plaque / ribbon; tabs are rounded "tab" shapes that lift when active.

### 10.2 Buttons
- Pill or rounded-rect, chunky. Primary = `accent.mint`→`accent.mint.deep`; love/confirm-cute = `accent.pink`; neutral = `ui.parchment`.
- 2px darker bottom edge (`accent.mint.deep`) for a soft **3D "candy button"** look.
- **Press:** `scaleY` 0.92 + edge collapses (button "sinks"), release springs back (`easeOutBack`) with a soft *pop* SFX. Hover: slight scale 1.03 + brighten.
- Disabled = desaturated parchment, no bottom edge.

### 10.3 HUD (always-on)
- **Top bar:** money `G` (coin icon + rolling number), current **day / season(春夏秋冬) / weather** icon, clock or time-of-day sun/moon dial. Compact wooden ribbon.
- **Side/bottom:** build/shop menu button, notifications bell, settings gear. All icons drawn or with a *small* emoji accent.
- **Selected-animal card:** floats near the animal — portrait + need meters (hunger🍽 / happiness❤ / health✚ / cleanliness✨) as rounded bars in status colors, with cute icons.

### 10.4 Meters & feedback
- Rounded-capsule bars, `ui.parchment` track, fill in status color, a **shine sweep** highlight. Low values pulse gently in `status.alert`. Full = tiny star pop.

### 10.5 Notifications / toasts
- Slide in from top-right on a small parchment card with an icon; **bob** to land (`easeOutBack`); auto-dismiss with fade; stack neatly. Good news = mint/pink tint + sparkle; warnings = amber; never alarming.

### 10.6 Typography & icons
- **CSS system stack**, favoring rounded/friendly: `"Hiragino Maru Gothic ProN", "Quicksand", "Rounded Mplus 1c", "Yu Gothic", "Segoe UI", system-ui, sans-serif`. Rounded gothic for JP is essential to the cute tone.
- Numbers a touch **bold and large**; use tabular figures for money so it doesn't jitter while rolling.
- **Icons:** prefer small drawn vector icons (canvas or inline SVG-in-CSS) matching sprite style. Emoji allowed **only** as tiny inline UI accents (❤ ✨ 🌸 🥛 🧀), never for animals/buildings.
- Copy tone: warm, gentle, encouraging Japanese (「やったね！」「ミルクがとれたよ🥛」). No harsh error language — reframe as friendly nudges.

### 10.7 Onboarding & empty states
- Tutorial via a cute **guide character** speech bubble (rounded, little tail, portrait). Empty plots show a faint dashed rounded outline + a "+" invitation. No dead-ends: always a suggested next action.

---

## 11. Sound Design Direction (for the audio programmer)

All **synthesized** (WebAudio), no files. Overall: soft, warm, toy-like, mostly **pentatonic/major**, gentle attacks, short tails, low-passed so nothing is harsh. Music = slow, sparse, cozy loop that shifts subtly by **season**; day is bright, night is soft & sparse (fewer voices, add a music-box shimmer). Keep a master limiter + a global **volume/mute** in settings. Layer a **quiet ranch ambience bed** (birds by day, crickets by night, wind, rain when raining).

Timbre = describe the synth character, not a file.

| Action | Mood | Timbre direction |
|---|---|---|
| Button press | tactile, friendly | short sine/triangle "pop," quick pitch blip up, tiny click transient |
| Panel open / close | soft whoosh | filtered-noise swell up (open) / down (close), very short |
| Place building | satisfying thud-pop | low soft sine "pom" + a wooden knock (short filtered noise burst) |
| Coin / sale | rewarding sparkle | bright triangle two-note up (5th), a light "ching" (short metallic FM ping), scales with amount |
| Level-up / rank-up | triumphant but gentle | rising pentatonic arpeggio + soft bell/glockenspiel + shimmer pad swell |
| Achievement | delighted | short music-box motif + sparkle chimes |
| Pet animal | affection | tiny kissy "pu-pu" blip + a soft heart "ting" |
| Cow moo | warm, comedic-cute | low breathy triangle glide "もぉ〜," lightly detuned; per-breed pitch (mini high, brown_swiss low) |
| Chicken | perky | short clucky staccato blips "こっこっ" |
| Sheep/goat | soft bleat | nasal reedy waver "めぇ" (goat a bit raspier) |
| Duck | silly | buzzy quacky square blip "くわっ" |
| Small pets (rabbit/cat/dog) | adorable | rabbit = tiny squeak; cat = soft "にゃ" (bandpassed meow); dog = gentle "わん" bark, warm |
| Eating | cozy | soft rhythmic "munch" (filtered noise nibbles) + tiny gulp |
| Milking / watering (💧) | fresh, signature | liquid "drip-plop" (pitch-bent sine into a short noise splash) — the game's water-droplet motif |
| Harvest crop | wholesome | soft "pluck" + leaf rustle (short noise) + a bright pling |
| Dairy processing | busy-cozy | gentle bubbling loop + a soft "ding" when a product is ready |
| Sprinkler / rain start | soothing | filtered-noise patter, looped, low volume |
| Notification / toast | friendly | soft two-note "pi-po" chime, non-alarming |
| Error / can't-do | gentle nudge | soft low "bloop" (never a buzzer); pair with a head-shake, not a scare |
| Day → night transition | ambient shift | slow crossfade of ambience beds + a low pad swell; a single owl hoot at night |
| Weather change | atmospheric | thunder = soft distant rumble (rare); wind = filtered-noise gust; snow = near-silence + faint sparkle |

---

## 12. Layering & Draw Order (world)

Back-to-front render order so overlaps read correctly:
1. Sky gradient + sun/moon/stars/clouds
2. Ground tiles (grass/soil, season-tinted) + tile decals (flowers, mown rows, paths)
3. Water bodies (`pond`, well shimmer) + their ripples
4. Ground-level structures & shadows (all creature/building **contact shadows** here)
5. Crops (by y for depth)
6. Buildings & fences (y-sorted)
7. Animals (y-sorted, so lower-on-screen draws in front)
8. Ground particles (dust, splash, leaves-landed)
9. Air particles (hearts, sparkles, Zzz, rain, snow, petals)
10. Weather overlays (cloud shadows, fog, rain tint) + **night light overlay** + lamp glows
11. Golden-hour / weather color tint
12. UI / HUD / toasts / cursor (screen space, above everything)

**Y-sorting:** sort movable sprites by their **feet y** each frame so animals correctly walk in front of / behind buildings and each other.

---

## 13. Accessibility & Performance Notes

- **Reduce-motion** setting: halves bob/particle amplitude, disables screen shake, slows blinks. Keep the game fully playable & still cute.
- **Colorblind-safe status:** never rely on red/green alone — pair meters with icons (🍽❤✚✨) and shape/position.
- **Contrast:** UI text `ui.text` on `ui.cream` meets comfortable contrast; avoid low-contrast pastel-on-pastel for anything readable.
- **Perf:** pool particles (cap ~250), pre-render static building/tile sprites to offscreen canvases and blit, only redraw dynamic layers, cull off-screen sprites, throttle to devicePixelRatio-aware sizing. Aim 60fps on mid mobile; degrade particle counts before framerate.

---

## 14. Palette as Code (drop-in)

Ship the palette on the global namespace so every module references the same tokens:

```js
Game.Palette = {
  sky: {
    dawn: { top:'#8FA9D8', mid:'#F3B7C0', low:'#FDE9C8' },
    day:  { top:'#6FC3EE', mid:'#A5DEF5', low:'#DCF4FB' },
    dusk: { top:'#5B4E8C', mid:'#EF9A7A', low:'#FBD79E' },
    night:{ top:'#172443', mid:'#283A6B', low:'#46568F' },
  },
  grass: { light:'#B6E870', base:'#93D95C', mid:'#6EBB45', dark:'#4F9A37', blade:'#57A83A' },
  soil:  { light:'#CBA074', base:'#A9744A', dark:'#7E5230', till:'#8A5A38' },
  water: { light:'#9FD9E8', base:'#6FBDD6', dark:'#4E9CBB' },
  wood:  { light:'#DBA772', base:'#B77F4E', dark:'#8A5A34', plank:'#C99461' },
  roof:  { red:'#E27A5F', redDark:'#C15A44', blue:'#7FB4D6', blueDark:'#5E93B6' },
  stone: { light:'#C9CBD6', base:'#A6A9B8', dark:'#7C8092' },
  ui: {
    cream:'#FFF6E3', parchment:'#FBEAC8', panel:'#FFFBF0',
    border:'#E7C596', borderDark:'#C89B63', wood:'#B77F4E',
    text:'#6B4A2F', textSoft:'#9A7B5C', shadow:'#3A2A1A',
  },
  accent: {
    pink:'#FF9CC2', pinkDeep:'#FF6FA5', pinkLight:'#FFD1E3',
    mint:'#85E0BE', mintDeep:'#4FC79C', mintLight:'#C4F3E2',
    yellow:'#FFD84D', sky:'#8FD6F2', lav:'#C9B6F2',
  },
  status: { alert:'#FF6B6B', amber:'#FFB454', good:'#7ED957' },
  prod: {
    milk:'#FFFDF6', milkShade:'#EAE6D6', quality_milk:'#FFF6D6',
    cheese:'#FFCE4E', cheeseShade:'#E0A82F', butter:'#FFE39B',
    yogurt:'#FFEFF3', egg:'#FBEFD6', eggShade:'#E7D2A9',
    wool:'#F3EDDF', woolShade:'#DAD2BE', fine_wool:'#ECE6FB',
    truffle:'#423229', truffleShade:'#2C2018', goat_milk:'#F6FBEF', manure:'#6B4E37',
  },
  season: { spring:'#A9EE6B', summer:'#74C63F', autumn:'#CDA64C', winter:'#DDEBE4' },
  light: { night:'#101C3A', lamp:'#FFE7A8', moon:'#FDF6E3', star:'#FFFDF0', sun:'#FFF3B0' },
  wx: { cloud:'#FFFFFF', cloudShade:'#DCE6EE', rain:'#A9D8EC', fog:'#EAF2F4', snow:'#FFFFFF' },
};
```

**Breed base colors (quick ref for sprite code):**
```js
Game.CowColors = {
  holstein:       { body:'#FFFDF6', spot:'#3A3A3E', muzzle:'#F4B8C4', horn:'#EAD9B4' },
  jersey:         { body:'#C8925A', belly:'#E4BC8A', ring:'#8A5E3C', muzzle:'#D8B48C', horn:'#5A4632' },
  brown_swiss:    { body:'#A89078', stripe:'#E8DCC8', muzzle:'#E8DCC8', horn:'#D8C9AA' },
  highland:       { body:'#C57A3E', fluff:'#D89A5C', horn:'#E8D6B0' },
  belted_galloway:{ body:'#2E2C30', belt:'#F4F0E6', horn:'#1E1C22' },
  wagyu:          { body:'#3B2F2C', sheen:'#5A463E', horn:'#4A3A32', tag:'#FFD84D' },
  mini_cow:       { body:'#FFFDF6', spot:'#3A3A3E', collar:'#85E0BE', bell:'#FFD84D' },
  dexter:         { body:'#2A2A2E', bellyShade:'#242428', horn:'#3A3A40' },
};
```

---

*Keep it round. Keep it soft. Keep it bouncing. 「かわいいは正義！」* 🐄💧
