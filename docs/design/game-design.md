# 「まきばのしずく」 — Master Game Design Document

**Makiba no Shizuku / _Ranch Droplet_**
A super-vast, adorable commercial ranch-management simulator for the browser.

| | |
|---|---|
| **Working title** | まきばのしずく (Makiba no Shizuku / Ranch Droplet) |
| **Genre** | Cute management / farming-life sim (cozy, systems-driven) |
| **Platform** | Browser, single self-contained `index.html` (Canvas2D world + HTML/CSS UI, vanilla JS) |
| **Renderer** | Canvas2D world; HTML/CSS overlay UI; procedural vector-drawn sprites; WebAudio synth |
| **Language** | Japanese UI (warm, cute, gentle tone) |
| **Session shape** | Cozy drop-in/drop-out; 3-minute check-ins to hour-long builder sessions |
| **Audience** | All ages; players who love kawaii aesthetics, Stardew/Story-of-Seasons cosiness, and idle-management depth |
| **Rating target** | Everyone. No violence, no loss framing, no dark-patterns, no real-money anything |
| **Document owner** | Creative Director (this file is the single source of truth for tone, scope & systems) |

> **How to read this doc:** Sections 1–4 are the vision & pillars. Sections 5–10 are the systems bible (features, economy, progression, goals). Sections 11–13 are UX, onboarding & the cuteness checklist. Sections 14–16 are accessibility, art/audio direction, and the implementer's content catalog (canonical IDs + tuning tables) that all sibling agents must build against.

---

## 1. One-line hook & the fantasy

> **Hook:** _「ぼろぼろの小さな牧場を、世界いちかわいい大牧場に育てよう。」_
> **"Grow one rundown little farm into the cutest, most sprawling ranch in the world — one dewdrop at a time."**

**The fantasy the player lives:** You inherit a tiny, overgrown, run-down ranch and a single lonely cow. With a dewdrop fairy named **シズク (Shizuku)** perched on your shoulder, you nurse the place back to life: you pet animals until they beam with hearts, you plant pasture, you turn fresh milk into cheese, you raise wobbly baby calves, and — season by season, star by star — you watch a muddy little plot bloom into a vast, bustling, postcard-perfect ranch empire that hums like a music box. It is the fantasy of **gentle, visible, compounding care**: nothing you do is punished, everything you touch grows cuter and more valuable, and the world literally fills up with life you made.

**Emotional promise:** _warmth, growth, and "kawaii!" every single minute._ The player should never feel stress — only the happy pull of "just one more animal, one more upgrade, one more morning."

---

## 2. Creative pillars

These four pillars are the tie-breakers for every design decision. When two ideas conflict, the higher pillar wins; when cuteness conflicts with anything, **cuteness usually wins** (Pillar 1 is first for a reason).

### Pillar 1 — 可愛さ最優先 (Cuteness First)
Round shapes, pastel palette, big sparkly eyes, bouncy/squishy motion, blinking, floating hearts, sparkle particles. Every creature is hand-drawn as a chubby vector character. If a feature can't be made adorable, it gets redesigned until it can. The target reaction, minute to minute, is an audible **"kawaii!"**

### Pillar 2 — 超広大 (Vastness)
A big scrollable, zoomable ranch that starts as a cramped muddy corner and expands into a huge multi-region estate. Many species, many crops, many buildings, and a progression long enough that the player crosses several in-game "eras." The map should always have room to dream into.

### Pillar 3 — 経営シム (Management Depth)
A real economy: money, fluctuating market prices, animal needs (hunger / happiness / health / cleanliness), production chains (milk→cheese→…), breeding & genetics-lite, feed & crop farming, upgrades, automation, seasons & weather, and goals/ranks. Depth that rewards planning without demanding it.

### Pillar 4 — 諦めない完成度 (Uncompromising Polish)
Onboarding that teaches by doing, robust save/load, settings, notifications, achievements, and relentless **game feel ("juice")** — squash-and-stretch, particles, screen-pop, satisfying synth SFX and gentle music. No dead-ends, no confusing states, no rough edges. Commercial quality is the floor, not the ceiling.

---

## 3. Tone, mascot & world framing

- **Mascot / guide:** **シズク (Shizuku)** — a tiny, translucent dew-drop fairy with stubby arms and a leaf hat. She is the tutorial voice, the cheerleader, the tip-giver, and the emotional anchor. Her speech is short, warm, and encouraging (「いいかんじ〜♪」). She reacts to everything the player does with little animations. She is the face of the game.
- **Droplet motif:** The title's _しずく_ (droplet) threads through the whole game — morning dew sparkles on the grass, milk falls in fat cute drops, the currency coin has a dewdrop shine, rank stars twinkle like dew, and the save icon is a droplet. It gives the game a coherent, precious, "fresh-morning" identity.
- **No antagonists, no clock-pressure, no debt spiral.** The world is safe. Weather and seasons create variety and mild challenge, never threat.
- **Voice of UI text:** gentle Japanese, hiragana-forward for cuteness, sparing kanji, playful onomatopoeia (もぐもぐ, ぽよん, キラキラ, ぷはー). Numbers and menus stay clear and legible.

---

## 4. The core gameplay loop

The loop is designed as three nested cycles: **minute-to-minute (care)**, **day-to-day (production & spend)**, and **season/rank (expansion & mastery)**. Each inner loop feeds the next, so a 90-second check-in and a 60-minute build session are both satisfying.

### 4.1 Minute-to-minute loop (the "care" loop)
1. **Scan the ranch.** Camera on your animals; happy ones sparkle, needy ones show a soft "!" bubble (never alarming).
2. **Tend a need.** Feed a hungry animal (drop feed / refill a trough), clean a dirty pen (sweep → sparkle), pet a lonely one (hearts float up, it moos/purrs).
3. **Collect production.** Tap a cow with a full milk bubble to collect milk; grab eggs from the coop; shear a fluffy sheep.
4. **Get juice back.** Every action returns instant feedback: squash-and-stretch, a particle pop, a synth blip, a number tick. The care loop is a **petting-zoo dopamine drip**.
5. **Repeat across the herd**, drifting the camera, discovering little idle animations and delight moments as you go.

_This loop alone is pleasant enough to idle in. That's intentional — the "toy" must be fun before the "game" is._

### 4.2 Day-to-day loop (the "business" loop)
1. **Morning (dawn):** dew sparkles, autosave fires, animals wake and stretch, overnight production is ready (milk, eggs), crops advance a growth stage, market prices re-roll.
2. **Harvest & process:** collect raw goods → route some to the **dairy (加工所)** to become higher-value products (milk→cheese/butter/yogurt), store surplus in the **warehouse (倉庫)**.
3. **Sell:** take goods to the **market_stall (直売所)**; read the price board (some goods are up today, some down), decide what to sell now vs. hold.
4. **Spend & invest:** buy feed/seeds, a new animal, a new building, or an upgrade. Plant crops in the **pasture**. Every purchase visibly grows the ranch.
5. **Set up tomorrow:** make sure troughs are full and crops are watered (or let **automation** handle it), then **fast-forward / "sleep to morning"** to roll the day.
6. **Check the goal board:** a milestone likely ticked up; maybe a **rank-up** is one goal away.

### 4.3 Season & rank loop (the "growth" loop)
1. **Chase goals** on the milestone board (e.g., "own 5 cows," "make 100 cheese," "reach 50,000G net worth").
2. **Rank up (★).** Completing a rank's goal set + hitting its net-worth threshold promotes the ranch a star, unlocking new species, buildings, crops, land plots, and automation tiers.
3. **Expand the land.** Buy new plots; the map literally gets bigger and more varied.
4. **Ride the seasons.** Each season shifts crop viability, animal moods, prices, weather, and events — encouraging you to diversify and plan a yearly rhythm.
5. **Return to 4.1** with a bigger, richer ranch and better tools. The loop tightens into a satisfying **flywheel**: care → produce → sell → invest → automate → expand → care for more.

---

## 5. Full feature list

### 5.1 Economy
- **Currency:** **G (ゴールド)**, displayed with a dewdrop-shine coin. Player starts poor (**~500G**).
- **Income sources:** selling raw goods & processed products, fulfilling market **contracts/orders**, rank-up reward bonuses, goal rewards, seasonal event payouts, byproducts (manure → fertilizer sales).
- **Expenses:** animals, buildings, upgrades, seeds & feed, land plots, decor, automation, the occasional vet/feed top-up.
- **Net worth** = cash + valuation of animals + buildings + stored products + land. This is the number that drives rank thresholds (so the player can't just hoard cash and stall).
- **No bankruptcy game-over.** If cash hits 0, Shizuku offers a tiny gentle "応援ボーナス" (a small stipend) and tips; you can always sell goods to recover. Failure is soft (see §8).
- **Price fluctuation:** every good has a **base price** that drifts daily within a band (roughly ±30%), influenced by season, weather, supply you've flooded, and random market "mood." A **7-day price trend sparkline** on the market screen teaches players to sell high and hold low.

### 5.2 Animal needs (the care model)
Every animal has four needs, each a **0–100 bar** with an icon + label + shape (colorblind-safe, see §14):

| Need | Icon | Drains from | Restored by | If neglected (soft) |
|---|---|---|---|---|
| **Hunger (おなか)** | 🍚 rice bowl | time, activity | feeding (feed/crops in trough) | production slows; never dies |
| **Happiness (きもち)** | ❤ heart | loneliness, dirt, bad weather exposure | petting, companions, decor, shelter, treats | lower quality/yield; sad idle anim |
| **Health (けんこう)** | ✚ cross | prolonged hunger/dirt, overcrowding | food + cleanliness + rest + tonic item | slower production; recovers with care |
| **Cleanliness (きれい)** | ✨ sparkle | time, weather (mud/rain) | sweeping pens, sprinkler/well water, grooming | happiness & health dip |

**Design rules:** needs drain **slowly and forgivingly**; neglect only softens output, it never kills or bankrupts. Higher average need-state → **higher yield and higher chance of premium output** (e.g., `quality_milk` instead of `milk`). Automation (feed_trough, sprinkler) offloads the chores as the ranch scales, so late-game is about orchestration, not repetitive clicking.

### 5.3 Production & processing chains
Raw goods are produced by animals; the **dairy (加工所)** and other processors convert them into higher-value products. Chains are the heart of management depth.

**Core chains (all IDs canonical):**
- `cow` → **milk** (daily). Happy/healthy/high-quality-feed cows have a chance to yield **quality_milk**.
- **milk** → **cheese** / **butter** / **yogurt** (via `dairy`; each recipe has a time + optional secondary input like a culture).
- **quality_milk** → premium versions & higher-tier recipes (better margins).
- `chicken` → **egg** (daily).
- `sheep` → **wool** (every few days, shearable); `alpaca` → **fine_wool** (premium).
- `goat` → **goat_milk** → specialty cheese via `dairy`.
- `pig` → **truffle** (forage-based, luxury, slow & valuable).
- All animals → **manure** passively → **fertilizer** (boosts crop growth) or sold cheap.
- `duck`, `rabbit`, `dog`, `cat`, `horse` are **companion/utility/charm** animals (see §16 catalog): they raise area happiness, draw visitors, or are simply adorable pets. `dog` (看板犬) and `cat` (看板看板猫) act as "shop-sign" charmers that lift market traffic/prices slightly. `horse` speeds the player's movement/tasks.

**Processing buildings:** `dairy` (milk products), plus upgrade tiers that unlock more recipes, more parallel slots, and faster cycles. Everything a cow makes should have a satisfying path to becoming something cuter and worth more.

### 5.4 Breeding & baby animals
- Pairs of the same species (with sufficient happiness/health) can **breed**, producing a **tiny baby** (calf, chick, lamb, kid, piglet, etc.). Babies are ~60% scale, wobblier, and _devastatingly cute_.
- Babies **grow over several days** into adults; adults then produce. This creates a "raise your own herd instead of buying" economy choice.
- **Genetics-lite:** offspring inherit a blended **quality/temperament stat** from parents (slightly randomized), so breeding your best animals gradually improves the herd's yield and premium-output chance. Rare traits (e.g., a sparkly coat, heterochromia eyes) can appear at low odds → collectible delight.
- Cross-breed cosmetic surprises kept simple and always cute; no unhappy outcomes.

### 5.5 Crop & feed farming
- Plant on **pasture** tiles. Crops (canonical): `grass`, `hay`, `corn`, `wheat`, `alfalfa` (premium feed), `carrot`, `turnip`, `clover`, `pumpkin`, `sunflower` (decorative).
- **Growth stages** are visible (seed → sprout → mature → harvest-ready), advancing each morning; **water** (well/sprinkler/rain) speeds growth, drought/wrong-season slows it.
- **Feed loop:** grass/hay/corn/alfalfa feed animals (alfalfa = premium feed → premium output). Closing your own feed loop is a key mid-game efficiency unlock (stop buying feed, grow it).
- **Seasonality:** each crop has preferred seasons (e.g., `pumpkin` thrives in autumn, `clover`/`grass` in spring). Off-season planting is possible but slower/lower-yield — nudging variety.
- **Decorative crops** (`sunflower`) and flowers raise nearby happiness and beautify the ranch (screenshot bait).

### 5.6 Buildings & land
Canonical buildings: `barn` (牛舎), `coop` (鶏小屋), `pasture` (放牧地), `silo` (サイロ/feed store), `well` (井戸), `dairy` (加工所), `market_stall` (直売所), `warehouse` (倉庫), `house` (自宅), `windmill` (風車), `sprinkler` (スプリンクラー), `feed_trough` (自動給餌器), `fence` (柵), `pond` (池), `barn_big` (大型牛舎 — barn upgrade).

- **Placement:** grid-snapped, drag-to-place with a green/red validity ghost; free relocation (small fee or free within a grace window) so mistakes never punish.
- **Capacity:** barns/coops house a limited number of animals; upgrading (`barn`→`barn_big`) or building more expands capacity → drives expansion.
- **Land plots:** the world is a large grid revealed in **plots**; buying/clearing plots (with G, gated by rank) grows usable space from a cramped corner to a sprawling estate (Pillar 2).
- **Decor:** `fence`, `pond`, `sunflower`, paths, lamps, seasonal ornaments — cosmetic, small happiness/visitor bonuses, and pure self-expression.

### 5.7 Automation & upgrades
The anti-tedium spine. As the ranch scales, chores must become systems.
- **feed_trough (自動給餌器):** auto-feeds nearby animals from the `silo` stock.
- **sprinkler (スプリンクラー):** auto-waters nearby crops each morning.
- **silo (サイロ):** stores bulk feed to supply troughs.
- **windmill (風車):** area production/growth boost (and it _spins_ adorably); can power efficiency upgrades.
- **Building upgrade tiers:** dairy (more recipes/slots/speed), market_stall (better prices/visitor traffic), warehouse (more storage), well (bigger water radius).
- **Ranch-wide upgrades / "research"-lite:** small unlockable perks (faster growth, auto-collect radius, bulk-sell, calmer needs decay) purchased with G and/or a soft "research" resource earned from goals. Presented as a friendly board, not a spreadsheet tree.
- **Auto-collect & bulk actions:** late-game quality-of-life so the empire runs while you admire it.

### 5.8 Time, seasons & weather
- **Time:** a day/night cycle with dynamic Canvas lighting (warm dawn → bright noon → golden dusk → soft moonlit night). Target ~a few minutes of real time per in-game day at 1×, adjustable via speed controls & "sleep to morning."
- **Calendar:** **Season = 12 days; Year = 48 days** (4 seasons). Long enough to feel like a rhythm, short enough to cycle variety. Years accumulate for long-term prestige/almanac stats.
- **Seasons** (`spring` 春 / `summer` 夏 / `autumn` 秋 / `winter` 冬): change crop viability, animal moods, palette/foliage, prices, weather odds, and available events. Winter is cozy-slow (heating/feed matter more, animals wear tiny scarves); spring is a fresh boom.
- **Weather** (`sunny` 晴 / `cloudy` 曇 / `rainy` 雨 / `snowy` 雪): affects watering (rain waters crops free), cleanliness (mud), happiness (shelter matters), and mood/visuals. Weather is **flavor + mild tactics**, never disaster. A gentle forecast helps players plan.

### 5.9 Market & contracts
- **Market board:** live buy/sell prices with a **7-day trend sparkline** per good, "up/down today" arrows, and a bulk-sell interface.
- **Contracts/orders (受注):** optional timed requests ("deliver 20 cheese by day X for a bonus + reputation"), giving goal-directed selling and price stability for planners. Always optional; expiring one is a soft miss, not a penalty.
- **Supply effects:** dumping huge quantities temporarily depresses that good's price (teaches diversification), recovering over days.
- **Shop side:** buy animals, buildings, seeds, feed, decor, and consumable treats/tonics; categorized, searchable, with clear costs and rank-locks shown as "★3で解放."

### 5.10 Events
- **Seasonal festivals:** e.g., **春の花まつり** (spring flower fair — decor/visitor bonus), **夏の縁日** (summer festival — mini-games/prizes), **秋の収穫祭** (harvest fair — crop contest), **冬のイルミネーション** (winter lights — cozy cosmetics). Events are opt-in, cheerful, and give cosmetics/bonuses.
- **Ranch shows / contests:** enter your best cow/sheep/crop; judged on quality stats; win ribbons, G, and almanac entries. A gentle way to make breeding matter.
- **Traveling merchant:** occasional visitor with rare animals/seeds/decor at special prices → surprise & delight.
- **Micro-events:** a stray kitten appears (adopt for free!), a rainbow after rain (happiness burst), a bumper-crop morning. Small, frequent, always positive.

### 5.11 Achievements & almanac
- **Achievements (じっせき):** dozens of cheerful, always-positive milestones (first cheese, first baby, 100 pets, one of every animal, a full rainbow of crops, etc.) with badge art + small rewards.
- **Almanac / Encyclopedia (ずかん):** an unlockable **collection** of every animal breed, crop, product, recipe, and building, filling in as you encounter them — with cute art, flavor text, care tips, and stats. Completionist catnip and an in-game manual in one. Ties into Pillar 2 (there's always another entry to fill).

### 5.12 Ranch ranks & goals
See §7 for the full framing. In brief: a **Ranch Rank (★1→★7)** gates content and expresses mastery, driven by a **milestone/goal board** plus net-worth thresholds. This is the "win" spine without a hard win/lose.

### 5.13 Save, settings & persistence
- **Autosave** every in-game morning and on tab-close (`beforeunload`); **manual save** anytime; multiple **save slots** with ranch name, rank, net worth, playtime, and a mini thumbnail.
- **localStorage** persistence (per tech constraints). Robust versioned schema with migration so updates never break saves.
- **Settings:** audio (master/SFX/music sliders + mute), game speed, colorblind mode, reduce-motion, reduce-flashing, text size, camera options, re-open tutorial, and a safely-guarded "new game / reset." (Full accessibility list in §14.)

---

## 6. Progression arc (the long, vast climb)

Five named stages take the player from a muddy corner to a legendary estate. Money and size targets are **design tuning targets**, not walls; the pace is meant to feel _long and rewarding_ (Pillar 2). Rank bands overlap stages.

### Stage 1 — 「ちいさな はじまり」 _A Small Beginning_ (★1 → ★2)
- **Vibe:** rundown, overgrown, one lonely cow, cramped starter plot. Everything is manual and intimate.
- **Player is doing:** learning to feed/pet/clean, collecting first milk, planting first `grass`/`hay`, first sales at a rickety `market_stall`, buying the first `chicken` and `coop`.
- **Unlocks by end:** `coop` + `chicken`, first extra land plot, basic `pasture` farming, the goal board.
- **Targets:** **~500G → ~5,000G**; ranch ~1 small plot, 1–3 animals. _Feel: tender, hopeful, hands-on._

### Stage 2 — 「なかまが ふえる」 _Friends Multiply_ (★2 → ★3)
- **Vibe:** the ranch fills with life; first babies; more species.
- **Player is doing:** first **breeding** (baby calf!), adding `sheep`→`wool` and `goat`→`goat_milk`, building a `silo` and `well`, closing a basic feed loop, decorating with `fence`/`sunflower`.
- **Unlocks:** `dairy` (→ `cheese`/`butter`/`yogurt`), `sheep`/`goat`, `silo`, `well`, breeding, second/third plots, first `feed_trough`.
- **Targets:** **~5,000G → ~50,000G**; ranch 2–4 plots, ~8–15 animals. _Feel: cozy growth, the ranch becomes a community._

### Stage 3 — 「おかね まわる」 _Money Flows_ (★3 → ★4)
- **Vibe:** production chains hum; you're a real business now.
- **Player is doing:** running the `dairy` in earnest (milk→cheese pipelines), farming `corn`/`wheat`/`alfalfa` for premium feed, chasing `quality_milk`, reading the market to sell high, taking **contracts**, adding `pig`→`truffle` and `alpaca`→`fine_wool`.
- **Unlocks:** `warehouse`, `barn_big`, `alpaca`, `pig`, `sprinkler`, dairy upgrades, market/contract system, more automation.
- **Targets:** **~50,000G → ~500,000G**; ranch 4–8 plots, ~15–30 animals. _Feel: the flywheel spins; planning pays._

### Stage 4 — 「じどうか じだい」 _Age of Automation_ (★4 → ★6)
- **Vibe:** a big, humming, semi-automated ranch; you orchestrate rather than click.
- **Player is doing:** blanketing pens with `feed_trough`, fields with `sprinkler`, adding `windmill` boosts, upgrading barns, selective **breeding for quality**, entering **contests**, opening a **second region** of land, curating decor & seasonal events.
- **Unlocks:** `windmill`, advanced automation & research perks, `wagyu` (luxury cows), premium breeds (`highland`, `belted_galloway`, `brown_swiss`, `dexter`, `jersey`), second region, event mastery.
- **Targets:** **~500,000G → ~3,000,000G**; ranch 8–16 plots across regions, ~30–60 animals. _Feel: mastery, scale, spectacle._

### Stage 5 — 「しずくの大牧場」 _Shizuku's Grand Ranch_ (★6 → ★7)
- **Vibe:** a sprawling, postcard empire that runs like a music box; the fantasy fully realized.
- **Player is doing:** completing the almanac, perfecting premium herds, filling regions with themed decor, chasing prestige goals & rare cosmetic collectibles (golden/sparkly animals), running festivals, and simply _enjoying the vast, adorable machine they built_.
- **Unlocks:** ★7 legendary status, endgame cosmetics (golden barn, dewdrop fountain), prestige/legacy goals, rare-trait collectibles, "sandbox abundance."
- **Targets:** **~3,000,000G → 15,000,000G+**; ranch fully expanded, 60–120+ animals. _Feel: awe, pride, cozy endlessness — there's always one more cute thing._

> **Vastness guarantee:** even after ★7 the game keeps giving — almanac completion, contest ribbons, rare cosmetic breeds, seasonal event cycles, and decorative masterpiece-building ensure there is **no true end**, only a beautiful plateau to keep tending.

---

## 7. Goal / win framing

**There is no hard "game over" and no single "you win" screen.** Success is expressed as an ever-climbing **Ranch Rank** plus a living **milestone board**. Failure is always **soft** (see §8).

### 7.1 Ranch Rank ★1 → ★7
Rank is the master expression of progress and the primary content gate. To advance a star the player must **(a)** clear that rank's **goal set** (a themed batch of milestones) **and (b)** meet its **net-worth threshold** — so rank means both _achievement_ and _substance_, and can't be cheesed by cash-hoarding or by ignoring the economy.

| Rank | Title (JP) | Net-worth target | Headline unlocks |
|---|---|---|---|
| **★1** | 見習い牧場主 (Apprentice) | ~500G (start) | Core care loop, first cow, market_stall |
| **★2** | かけだし牧場主 | ~5,000G | coop/chicken, pasture farming, +land, goal board |
| **★3** | いちにんまえ牧場主 | ~30,000G | dairy & cheese, sheep/goat, silo/well, breeding |
| **★4** | ベテラン牧場主 | ~150,000G | alpaca/pig, warehouse, barn_big, sprinkler, contracts |
| **★5** | 名人牧場主 | ~750,000G | windmill, advanced automation, premium breeds, region 2 |
| **★6** | 達人牧場主 | ~3,000,000G | wagyu, contests, research perks, event mastery |
| **★7** | しずくの牧場主 (Legend) | ~15,000,000G | endgame cosmetics, prestige goals, rare collectibles |

Rank-up is a **celebration** (confetti, Shizuku spins, a stamped "★UP!", a fanfare, a reward payout) — a peak emotional beat.

### 7.2 Milestone / goal board (もくひょうボード)
- A friendly board of **active goals**, grouped into **current-rank goals** (needed to advance) and **evergreen/optional goals** (extra rewards).
- Goals are concrete & readable: _"ウシを5とう そだてよう" (raise 5 cows), "チーズを100こ つくろう" (make 100 cheese), "しあわせ100%のどうぶつを10ひき" (10 animals at 100% happiness), "しさん50,000Gをこえよう" (exceed 50,000G net worth)._
- Each goal shows a **progress bar**, its **reward** (G, items, decor, research points, almanac entries), and a satisfying **tick + chime** on completion.
- The board is the player's self-directed to-do list and the game's soft **quest system** — always something to aim at, never a forced order.

### 7.3 The "win" feeling
"Winning" is reaching **★7 and a fully realized, adorable, sprawling ranch** — but the design frames it as **arrival, not ending**. The credits/celebration for ★7 explicitly invite continued play ("これからも、すてきな牧場を♪"). The real reward is the vast, living, cute world the player authored.

---

## 8. Soft-failure philosophy

- **No death:** neglected animals get sad and less productive, never die. A sad animal recovers fully with a little care and clearly signals what it needs.
- **No bankruptcy:** at 0G, Shizuku grants a small "応援ボーナス" and a tip; you can always sell stored goods. Debt/loans (if included) are optional, gentle, and never spiral.
- **No missed-window punishment:** expired contracts/events are shrugged off ("またこんど♪"). Nothing is permanently lost.
- **No wrong choices:** buildings/animals can be relocated or sold back for fair value; the game forgives experimentation.
- **Result:** the player is always **safe to relax and safe to experiment** — the cozy promise stays intact.

---

## 9. Onboarding / tutorial — the first 5 minutes

Taught **by doing**, via Shizuku's short speech bubbles + gentle highlights/arrows + one action at a time. **No walls of text; no modal essays.** Each beat is skippable and re-openable from settings.

| Time | Beat | What the player does | What it teaches | Cuteness payoff |
|---|---|---|---|---|
| 0:00 | **Arrival** | Watch a 5-second intro pan over the rundown ranch; Shizuku pops up ("はじめまして！"); **name your ranch**. | Framing, mascot bond, ownership. | Shizuku bounces & sparkles; dewdrops on the grass. |
| 0:30 | **Meet your cow** | Camera glides to your lonely cow; prompt: **pet it** (tap). | Petting = happiness; tap interaction. | Cow blinks, eyes turn `^^`, **hearts float up**, happy "モ〜♪". |
| 1:15 | **Feed it** | Cow shows a soft hunger "!"; harvest a tuft of `grass` (tap) and drop it in the trough. | Needs exist; feeding; harvesting. | Cow does happy もぐもぐ chew, need bar fills with a pop. |
| 2:00 | **Collect milk** | A milk bubble appears over the cow; **tap to collect milk**. | Production; the reason to care. | Fat cute milk-drop flies into your basket with a "ぽよん". |
| 2:45 | **Sell it** | Go to the `market_stall`; **sell the milk** for G. | Economy; income; the market screen. | Coins rain, "チャリン♪" cha-ching, G counter ticks up. |
| 3:30 | **Buy something** | Open the shop; **buy a `chicken`** (or `grass` seeds). | Spending; the shop; growth. | New friend hops out of a gift box with confetti. |
| 4:15 | **First goal** | The **goal board** slides in with a starter goal ("ミルクを5こ うろう"); reward shown. | Goals/progression; the loop's engine. | Goal card stamps in; Shizuku: "がんばろ〜♪". |
| 5:00 | **Hand-off** | Shizuku steps back, leaving a persistent (dismissible) tip pip and the goal board. Free play begins. | Autonomy; where to get help. | Shizuku salutes and perches in the corner, ready to help. |

**Onboarding principles:** one new verb per beat; the world pauses gently around each prompt; highlights point exactly where to tap; every taught action immediately gives its reward so the lesson _feels good_, not instructional. After 5 minutes the player owns the full core loop.

---

## 10. UX flow & screens

**Layout:** Canvas2D world fills the screen; HTML/CSS overlays float on top. Everything is **touch-first** (big tap targets, no hover-dependence) and keyboard-accessible.

### 10.1 Persistent HUD
- **Top bar:** ranch name, **Rank ★s**, **G (money)** with dewdrop coin, **date/season/weather** widget, in-game **clock**, and a **notifications bell** (badge for unread cheerful toasts).
- **Bottom/side dock:** tool selector (pet / feed / clean / harvest / place / collect), **Build/Shop** button, **Goals** button, **Almanac** button, **Menu/Settings** button.
- **Speed controls:** Pause ⏸ / 1× / 2× / 3× / **Sleep-to-morning** ⏭.
- **Camera:** drag/edge-scroll to pan, pinch/scroll to zoom, minimap for the vast map. Tapping empty space deselects; tapping an animal/building opens its inspector.

### 10.2 Shop / Build panel (おみせ)
Tabbed: **Animals / Buildings / Crops & Feed / Decor / Treats**. Each item: cute icon, name, price, short description, rank-lock badge ("★3で解放"), and (for buildings/animals) a **place-mode ghost** preview. Search & filter; "recommended for your rank" hints.

### 10.3 Animal Inspector / Barn view (どうぶつ)
Tap any animal → panel with: name (renamable ✎), species/breed, **age & baby/adult status**, the **four need bars** (icon+label+shape), current production & timer, **quality/temperament** stat, **breeding** button (choose a partner), a big **Pet** button, and a "move/sell" option. A **Barn overview** lists all animals with sortable need states for at-a-glance herd management.

### 10.4 Market panel (しじょう)
Sell interface with per-good **base price, today's up/down arrow, 7-day trend sparkline**, quantity slider, and **bulk-sell**. A **Contracts** tab lists optional orders with rewards, quantities, and gentle deadlines. Reads like a friendly farmer's-market stall, not a stock terminal.

### 10.5 Upgrades / Research board (アップグレード)
Friendly board of building-upgrade tiers and ranch-wide perks, each with cost (G and/or research points), effect, and a clear "before/after." Grouped by theme (Automation / Production / Comfort / Growth). No intimidating tech-tree lines — just tidy, tappable cards.

### 10.6 Goals board (もくひょう)
Current-rank goals (with rank-up progress meter at top) + optional/evergreen goals. Each card: description, progress bar, reward preview. Completed goals animate a satisfying tick and move to a "clear!" pile.

### 10.7 Almanac / Encyclopedia (ずかん)
Tabbed collection: **Animals / Crops / Products / Recipes / Buildings / Achievements**. Filled-in entries show art, flavor text, care tips & stats; undiscovered entries are cute silhouettes ("？"). Doubles as the in-game manual and completion meta-game.

### 10.8 Settings / Menu (せってい)
Audio sliders + mute, speed default, **accessibility** (colorblind mode, reduce-motion, reduce-flashing, text size, dyslexia-friendly font), camera options, **save/load slots**, replay tutorial, credits, and a guarded reset. (See §14.)

### 10.9 Feedback layer (always-on)
Toasts/notifications (cheerful, icon-led, auto-dismiss), floating particles & numbers, and Shizuku's contextual pop-ins. Everything confirmable is confirmable; destructive actions ask once, softly, with **undo** where feasible.

**Navigation model:** one persistent HUD; panels open as **non-blocking overlays** (the world keeps living behind them); a single consistent **✕/back** closes any panel; nothing is ever more than two taps from the world.

---

## 11. Cuteness & delight moments (the "kawaii!" checklist)

A living checklist of concrete delight beats. **Every one must ship** to hit Pillar 1. (Emoji here describe intent; in-world creatures are hand-drawn vectors, per tech constraints.)

1. **Petting a cow:** it blinks, eyes squish to `^^`, **hearts float up**, and it moos a happy pitched "モ〜♪." Repeated pets can play ascending notes (make a little tune).
2. **Tiny babies:** calves/chicks/lambs/kids/piglets spawn at ~60% scale, **wobble-walk**, hop when they change direction, and grow visibly over days.
3. **Idle charm:** cows chew cud & flick tails, chickens peck and **tilt their heads**, sheep bounce, ducks waddle, rabbits do periodic **binky** hops, cats groom themselves.
4. **Milk relief:** on collection the cow does a little jiggle and a "ぷはー" relief bubble; the milk falls as a **fat, glossy dewdrop**.
5. **Nap time:** at night animals curl up with **Zzz bubbles** and faint squeaky snores; the coop dims and the barn glows warm.
6. **Rainy day:** most animals huddle cutely under shelter, but a lone **duck splashes in puddles** with delight; umbrellas pop up; droplets patter.
7. **Snowy day:** animals wear **tiny scarves & earmuffs**, exhale little breath-puffs, and leave **footprints in the snow**; you can place a snowman.
8. **Happiness max:** at 100% a creature throws a "❤満タン！" sparkle and does a **little jump-spin**; occasionally a ★ pops over its head and it trots to greet the camera.
9. **Companion love:** petting a `cat` makes it **purr** (synth) and follow your cursor; the `dog` (看板犬) **wags its tail** and dashes to the gate when you "arrive."
10. **Big sale:** selling a batch triggers a **coin shower**, "チャリン♪" cha-ching, and a tiny fanfare; the G counter rolls up with a satisfying tick.
11. **Alpaca derp:** the `alpaca`'s long neck **sways**; when startled it pulls a **funny face**; its `fine_wool` puffs out when sheared.
12. **Truffle hunt:** a `pig` **wiggles its snout**, kicks up a dirt puff, and a "✨トリュフ発見！" pop rewards the find.
13. **Breeding & hatching:** paired animals emit **heart particles**; eggs **wobble** and crack with a "ぴよ！" as a chick tumbles out.
14. **Seasonal skies:** spring **cherry-petal drift**, summer **fireflies at night**, autumn **falling leaves**, winter **soft snowfall** — the whole palette shifts.
15. **Machines with personality:** the `windmill` **spins**, and `sprinkler`s throw **tiny rainbows** in sunlight; the mill hums a soft note.
16. **Rank-up party:** confetti bursts, Shizuku spins with joy, a big **"★UP！" stamp** slams in, and a warm fanfare plays.
17. **Morning dew:** each dawn the pasture **sparkles with dewdrops** (the title motif) and a soft chime greets the new day.
18. **Micro-surprises:** a **stray kitten** wanders in to adopt for free; a **rainbow** arcs after rain and lifts everyone's happiness; a bumper-crop morning shimmers gold.
19. **Squish physics:** every tap/placement uses **squash-and-stretch**; UI buttons **ぽよん**-bounce; picked-up items pop toward the basket.
20. **Full herd greeting:** occasionally, well-cared-for animals line up at the fence and **look at the camera together** — a wordless "thank you."

---

## 12. Game feel & "juice" direction

- **Squash-and-stretch** on every interactive element (creatures, buttons, harvested items, coins).
- **Particles everywhere (but tasteful):** hearts, sparkles, dust puffs, coin shimmer, dew, petals, fireflies, snow — all **respect Reduce-Motion**.
- **Screen-pop, not screen-shake:** gentle scale/brightness pulses on big beats (rank-up, big sale); avoid harsh shake; **no flashing** (respect Reduce-Flashing).
- **Number juice:** counters roll, progress bars ease, goal ticks stamp.
- **Response < 100ms:** every tap acknowledges instantly with sound + motion; the world always feels alive and reactive.
- **Camera easing:** smooth pans/zooms; the camera gently drifts to important beats during onboarding/events.

---

## 13. Audio direction

- **All synthesized** via WebAudio (no files, per constraints).
- **Music:** gentle, loopable, music-box / marimba / soft-pad textures; a light theme per season (spring bright, summer playful, autumn mellow, winter twinkly-cozy); volume ducks under SFX.
- **SFX:** pet ("もっ"), happy moo (pitched, per-cow), coin cha-ching, harvest pluck, place thunk, UI ぽよん, goal chime, rank fanfare, rain/wind ambience, night crickets, purr, chick peep.
- **Playful interactivity:** tapping animals plays soft pitched notes so players can improvise little melodies — a beloved cozy-game touch.
- **Mixing:** master + separate SFX/music sliders, instant mute; never fatiguing or loud.

---

## 14. Accessibility & QoL

Accessibility is part of Pillar 4, not an afterthought.

- **Pause & speed control:** full pause; 1×/2×/3× speed; **sleep-to-morning** skip. Nothing is real-time-mandatory.
- **Audio control:** master mute + independent **SFX/music sliders**; audio never required to play (all cues have visual twins).
- **Autosave + manual save:** autosave each morning & on close; multiple manual slots; saves are safe and versioned. No progress ever lost to a crash/close.
- **Colorblind-friendly:** need bars and quality tiers use **icon + shape + text label**, never color alone; notifications are icon-led; palette validated for deuteranopia/protanopia/tritanopia; optional pattern overlays on quality tiers. (See dataviz principles for the market sparklines: redundant encoding, sufficient contrast.)
- **Reduce-Motion toggle:** dampens/parallax-limits particles, screen-pop, and camera easing.
- **Reduce-Flashing / photosensitivity:** no strobing; celebratory effects are soft fades, not flashes; a toggle further tones them down.
- **Text & readability:** adjustable text size; high-contrast UI option; optional dyslexia-friendly font; concise, hiragana-forward copy; every icon has a text label available.
- **Touch & motor friendliness:** large tap targets, generous hit-boxes, no reliance on hover, no precision-timing or rapid-click requirements; one-handed play; bulk actions & automation reduce repetitive input.
- **Keyboard support:** number-key tool select, spacebar pause, arrow/WASD camera, Esc closes panels; focus states visible.
- **Forgiveness/QoL:** **undo** window on accidental sell/place; free/cheap relocation; confirm on destructive actions; re-openable tutorial & tips; clear rank-lock labels so nothing feels mysterious; almanac as an always-available manual.
- **Cognitive load:** one persistent HUD, consistent panel patterns, non-blocking overlays, and a soft-failure world mean players never need to hold stress or complex state in their head.

---

## 15. Art & visual direction (summary for artists)

- **Shapes:** rounded, chubby, low-detail-but-expressive; thick soft outlines; large eyes with a highlight sparkle; simple 2-3 frame procedural animation (bob, blink, squash).
- **Palette:** soft pastels — cream, mint, sky-blue, peach, butter-yellow, strawberry-pink; seasonal palette shifts (fresh greens in spring, warm ambers in autumn, cool whites in winter). Ensure contrast & colorblind-safety per §14.
- **World:** tile-based Canvas2D pasture with subtle texture; dynamic day/night lighting overlay (warm/cool gradients + soft shadows); weather layers (rain streaks, snow, cloud shadows); dew/particle layer on top.
- **Sprites are procedural vectors** drawn on canvas (no image files; no emoji-as-creature). Each species has a compact draw routine parameterized by breed color/pattern, age (baby scale), and mood (eye/mouth shape). Emoji allowed only as tiny UI accents.
- **UI:** rounded cards, soft drop-shadows, dewdrop and leaf motifs, bouncy transitions, generous spacing, legible type.

---

## 16. Implementer's content catalog (canonical IDs & tuning targets)

All sibling agents (data, code, art, audio) must build against these **canonical IDs** so files align. Numbers are **starting tuning targets** for the balance/data agent to refine.

### 16.1 Cows (`species: cow`, breeds)
| Breed ID | JP | Role / flavor | Rough tier |
|---|---|---|---|
| `holstein` | ホルスタイン | starter, high milk volume | ★1 (free starter) |
| `jersey` | ジャージー | rich milk → more `quality_milk` | ★3 |
| `brown_swiss` | ブラウンスイス | balanced, hardy | ★4 |
| `highland` | ハイランド牛 (もふもふ) | fluffy, cold-resistant, adorable | ★4 |
| `belted_galloway` | ベルギャロ (オレオ柄) | oreo-pattern charm, decor value | ★4 |
| `wagyu` | 和牛 | luxury, premium output, prestige | ★6 |
| `mini_cow` | ミニ牛 | pet/charm, happiness aura | ★4 |
| `dexter` | デクスター | compact, efficient feed use | ★4 |

### 16.2 Other animals (`species`)
`chicken` (ニワトリ→`egg`), `sheep` (ヒツジ→`wool`), `goat` (ヤギ→`goat_milk`), `pig` (ブタ→`truffle`), `duck` (アヒル, pond charm), `alpaca` (アルパカ→`fine_wool`), `rabbit` (ウサギ, pet), `dog` (イヌ, 看板犬 — visitor/price aura), `cat` (ネコ, 看板猫 — visitor/price aura), `horse` (ウマ, player mobility/task speed).

### 16.3 Crops & feed (`crop`)
`grass` (牧草, fast regrow feed), `hay` (干し草, stored feed), `corn` (トウモロコシ, feed/sell), `wheat` (小麦, sell/process), `alfalfa` (アルファルファ, **premium feed** → premium output), `carrot` (ニンジン, treat/sell), `turnip` (カブ, fast cash), `clover` (クローバー, happiness/spring), `pumpkin` (カボチャ, autumn cash), `sunflower` (ヒマワリ, **decor**/happiness).

### 16.4 Buildings (`building`)
`barn`, `coop`, `pasture`, `silo`, `well`, `dairy`, `market_stall`, `warehouse`, `house`, `windmill`, `sprinkler`, `feed_trough`, `fence`, `pond`, `barn_big` (upgrade of `barn`).

### 16.5 Products (`product`) — base sell-price targets (pre-fluctuation)
| Product ID | JP | ~Base G | Source / chain |
|---|---|---|---|
| `milk` | ミルク | 25 | `cow` daily |
| `quality_milk` | 高級ミルク | 60 | happy/premium-fed `cow` |
| `cheese` | チーズ | 120 | `milk` via `dairy` |
| `butter` | バター | 90 | `milk` via `dairy` |
| `yogurt` | ヨーグルト | 70 | `milk` via `dairy` |
| `egg` | たまご | 15 | `chicken` daily |
| `wool` | 羊毛 | 40 | `sheep` (every ~4 days) |
| `fine_wool` | 高級羊毛 | 150 | `alpaca` |
| `truffle` | トリュフ | 400 | `pig` (slow forage) |
| `goat_milk` | ヤギミルク | 35 | `goat` daily |
| `manure` | 堆肥 | 5 | all animals (passive) → fertilizer/sell |

_Prices fluctuate ±~30% daily by season/weather/supply/mood (see §5.9)._

### 16.6 Seasons & weather (canonical)
Seasons: `spring` / `summer` / `autumn` / `winter`. Weather: `sunny` / `cloudy` / `rainy` / `snowy`. Calendar: **Season = 12 in-game days, Year = 48 days.**

### 16.7 Core numeric targets (for the balance agent)
- **Start state:** ~**500G**, 1 free `holstein` (`cow`), 1 small starter plot, a rickety `market_stall`, a few `grass` tufts.
- **Needs:** four 0–100 bars; slow forgiving decay; higher average state → higher yield & premium-output chance; neglect softens output only (never lethal).
- **Rank thresholds (net worth):** ★2 ~5,000G · ★3 ~30,000G · ★4 ~150,000G · ★5 ~750,000G · ★6 ~3,000,000G · ★7 ~15,000,000G (each also gated by that rank's goal set).
- **Stage money arcs:** S1 500→5k · S2 5k→50k · S3 50k→500k · S4 500k→3M · S5 3M→15M+.
- **Day length:** a few real minutes per in-game day at 1×; adjustable via speed & sleep-to-morning.

### 16.8 Technical alignment note
- One self-contained `index.html`; modules attach to a global **`Game`** namespace (e.g., `Game.data`, `Game.world`, `Game.economy`, `Game.animals`, `Game.ui`, `Game.audio`, `Game.save`).
- **Canvas2D** for the world (tiles, sprites, weather, particles, day/night light); **HTML/CSS** for HUD/panels/shop.
- **WebAudio** synth for all audio; **localStorage** for saves (versioned + migration).
- Sprites are **procedural vector draw routines** (no image/audio files; no emoji creatures; emoji only as tiny UI accents).

---

## 17. Definition of "commercial-grade / done"

The game ships when:
1. The **core loop** (care → produce → sell → invest) is fun in the first 60 seconds and still fun at hour 5.
2. **Cuteness checklist (§11)** is fully implemented and reliably earns a "kawaii!".
3. Progression runs **★1→★7** with the full content catalog, no dead-ends, and a "vast" late game.
4. **Onboarding** teaches the whole loop in 5 minutes with no text walls.
5. **Save/load, settings, accessibility (§14)** are complete and robust.
6. **Game feel & audio** are polished; every action is juicy and satisfying.
7. **Soft-failure** guarantees the player is always safe to relax and experiment.

> _まきばのしずく_ is, at its heart, a promise: care for small cute things, watch them grow into something vast and beautiful, and never once feel rushed or punished. Every system in this document exists to keep that promise. 🐄💧✨
