# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A LINE-based shopping checklist. A couple writes shopping requests into a LINE chat in
free-form Japanese; the bot parses them into a checklist grouped by supermarket aisle,
served as a LIFF mini-app. It learns purchase cycles and pre-drafts the next list.

See `README.md` for the product-level description and the full LINE/Cloudflare setup.

## Commands

```bash
npm install
npm run dev                # wrangler dev (needs .dev.vars — copy .dev.vars.example)
npm test                   # vitest, 198 unit tests
npm test -- parser         # single file: matches test/parser.test.ts
npm test -- -t '長音符'     # single test by name
npm run typecheck          # tsc --noEmit
npm run db:migrate:local   # apply migrations/ to the local D1
npm run db:migrate         # apply to the remote D1
npm run deploy             # wrangler deploy
```

`npx wrangler deploy --dry-run --outdir=<dir>` builds the bundle without deploying —
useful for checking that the Worker compiles.

Local end-to-end check: `npm run db:migrate:local && npm run dev`, then drive
`/line/webhook` with an HMAC-SHA256 signature over the raw body using
`LINE_CHANNEL_SECRET`, and the `/api/*` routes with an `x-dev-user` header matching
`DEV_USER_ID`.

## Architecture

Single Cloudflare Worker (`src/index.ts`) with three entry points:

- `POST /line/webhook` — LINE events. Verifies the signature against the **raw request
  bytes**, returns 200 immediately, and processes in `waitUntil` (parsing can take
  seconds when it falls through to the Claude API).
- `/api/*` (Hono, `src/api/routes.ts`) — JSON API for the LIFF mini-app. Every route
  authenticates a LINE ID token and checks household membership.
- `scheduled()` — daily cron that posts a pre-filled draft list the day before the
  household's learned shopping day.

Static assets in `public/` are served by the Workers assets binding; unmatched paths
fall through to the Worker. State lives in D1 (`migrations/0001_init.sql`).

### Parsing is two-tier, and tier 1 must stand alone

`src/parser/index.ts` orchestrates:

1. **Rule-based** (`rules.ts` → `segment.ts` → `units.ts` + `domain/categories.ts`).
   Dictionary and regex only. No network.
2. **Claude API** (`llm.ts`) — called only when tier 1 reports `needsLlm`.

**Invariant: the shopping list works when the LLM does not.** `parseWithLlm` never
throws; it returns `null` on any failure (network, rate limit, refusal, truncation) and
the caller falls back to tier 1. Keep it that way. `ANTHROPIC_API_KEY` is optional.

`llm.ts` uses `client.beta.messages.create` with `output_config.format` (JSON schema),
`effort: 'low'`, `cache_control` on the static system prompt, and
`fallbacks: 'default'`. It checks `stop_reason` before reading `content`.

### Parser invariants worth knowing before editing

These are load-bearing and each is covered by a regression test:

- **`normalize()` collapses whitespace, including newlines.** `segment()` splits on
  newlines *before* normalizing. Reversing that order silently flattens multi-line
  memos into one item.
- **Never strip `ー` as a trailing particle.** It destroys katakana product names
  (`トイレットペーパー` → `トイレットペーパ`). `stripParticles` lives in `segment.ts`,
  not `normalize.ts`, because it needs `isKnownItem` to decide whether a trailing
  hiragana is a particle (`牛乳を`) or part of the noun (`さかな`).
- **Splitting on the particle `と` is deliberately conservative.** Only split when the
  left side ends in a quantity+unit, or when both sides are dictionary items. Otherwise
  `とうもろこし` and `たまごとうふ` get cut in half. Prefer under-splitting; the LLM
  tier catches the rest.
- **Quantity stays `null` when unwritten.** Do not default to 1 — `卵` and `卵1パック`
  are different requests.

`domain/categories.ts` does double duty: aisle ordering for the shopping route *and*
the known-item dictionary that drives parser confidence. Adding keywords there improves
both.

### Learning

`domain/suggest.ts` and `domain/route.ts` are pure (no DB) so prediction can be tested
with a fixed clock; `domain/routeStore.ts` holds the D1 access for route data.

Learning advances **only** on list completion (`completeList`), not on checking items
off. One call writes `purchase_events`, updates the purchase-interval EMA (α = 0.3,
with outlier guards discarding intervals under 12 hours or over 120 days), re-infers
the shopping day, records the aisle ordering, and votes on `other`-item categories.

**Route learning** turns check-off order into the store's aisle order. Three invariants
hold it together, each with a regression test:

- **Rank only the categories currently on the list**, never all of them. Copeland
  scores aggregate over every pair, so ranking the full set gives categories near the
  front of the built-in order a structural advantage that real observations cannot
  overcome. `rankCategories` takes the subject set for this reason — passing
  `DEFAULT_ROUTE` is only correct in tests.
- **Normalize each pair to a preference in [-1, +1]**, not raw counts. Summing raw
  counts lets a frequently co-bought pair dominate the whole ordering.
- **Precedence counts, not averaged positions.** A trip covering only two aisles pins
  one at 0.0 and the other at 1.0 regardless of where they actually sit; pairwise
  precedence is immune to that. Normalized position is still used, but only for
  ordering *within* one aisle, where the bias is low-stakes.

The built-in order enters as a prior worth `PRIOR_STRENGTH` observations in the same
denominator, so there is no learned/unlearned branch: zero observations reproduce the
default exactly, and roughly four consistent trips flip a pair.

`other` is excluded from ranking and pinned last — it is a grab bag whose average
position is meaningless. Its members escape via `inferCategoryFromNeighbors` +
Boyer-Moore majority voting (`PROMOTE_VOTES` consistent observations promote an item
to a real aisle).

**Race records** (`domain/race.ts`) turn a trip into a time trial. Two rules:
timing starts at the *first check-off*, not list creation (a list is often created
days before the trip); and records are stored as **seconds per item**, so a 5-item
trip and a 25-item trip are comparable — raw duration would make big trips
permanently worse than the personal best. Trips under `MIN_ITEMS_FOR_RECORD` items or
over `MAX_TRIP_MS` are excluded from records rather than allowed to set a bogus best.
`raceResult` receives history that excludes the current trip, so a trip cannot fail to
beat itself.

**Co-purchase detection** (`domain/basket.ts`, pure; `domain/companions.ts` for the D1
side) is the differentiating feature — the product gap identified in the competitive
survey (see README). Purchase history is grouped into baskets by `list_id` and mined for
association rules: for a trigger already on the list, surface items usually bought with
it that are missing today.

- **Lift is not optional.** Confidence alone promotes staples — milk appears in every
  basket, so `confidence(curry → milk)` is 1.0 without any real association. The
  `MIN_LIFT` filter is what makes this a *conditional* signal rather than a second
  frequency ranking; `suggest.ts` already owns frequency and cycle. Dropping the lift
  check collapses the two features into one.
- Thresholds (`MIN_BASKETS`, `MIN_TOGETHER`, `MIN_CONFIDENCE`, `MIN_LIFT`) are tuned for
  silence over recall. A false "did you forget X?" is nagging, and a nagging bot in a
  group chat gets muted.
- In LINE the hint is attached **only when the trigger was just added in that message**
  (`webhook.ts` intersects companions with the items from this parse). Repeating it on
  every message is the same nagging failure.

## Front end (`public/`)

Plain HTML/CSS/JS, no bundler — it is served directly by the Workers assets binding.
The perceived-speed work is load-bearing, not decoration; three things hold it up:

- **Optimistic check-off.** The strike-through lands before the request goes out.
  `state.pending` holds the optimistic value and is cleared only when a poll returns
  the matching server value (`reconcilePending`) — clearing it on response would let
  a stale poll undo the user's tap.
- **Keyed diff rendering.** `renderList` reconciles against `itemNodes` / `groupNodes`
  instead of rebuilding. A full rebuild every 4s kills in-flight animations and drops
  scroll position. `setText` writes only on change; `placeAfter` moves a node only
  when it is out of order.
- **Server-anchored timer.** The API returns `elapsedMs`; the client derives
  `anchor = Date.now() - elapsedMs` so a skewed device clock never shows a wrong time.
  The anchor is only re-set when it drifts more than a second, otherwise the display
  jitters.

Anything that reacts to check-off state must be driven from `renderList`, not from
`loadList`. `toggleItem` deliberately does not re-fetch, so a state derived in
`loadList` only updates on the next 4-second poll. `updateCompanionUrgency` is split out
of `renderCompanions` for exactly this reason: the highlight has to land with the tap
(it fires at ≥60% done and ≤3 remaining — the moment before leaving the store), while
the card's DOM is rebuilt only when the companion data itself changes.

Two CSS traps already paid for, both caught by the browser check:

- A class rule that sets `display` beats the UA's `[hidden] { display: none }`. The
  global `[hidden] { display: none !important }` at the top of `style.css` exists
  because `.boot { display: grid }` kept the splash occupying a screen of layout after
  it was hidden.
- Flex children stretch by default. `.item-body` needs `align-items: flex-start` or
  `.item-name` fills the row and the strike-through pseudo-element runs several times
  past the end of the text.

## Conventions

- Comments and user-facing strings are Japanese; identifiers and types are English.
- Comments explain *why*, especially where a simpler-looking implementation is wrong
  (see the parser invariants above). Don't narrate what the next line does.
- Pure logic goes in modules with no D1 import so it stays unit-testable; D1 access is
  confined to `domain/*.ts` and `api/routes.ts`.
- Domain functions take `now: number = Date.now()` as a trailing parameter so tests can
  fix the clock.
- Every API route resolves the household from the authenticated user and verifies
  membership. Never trust a `householdId` from the request body alone.

## Git Workflow

- Active development branch for Claude-authored changes: `claude/line-shopping-checklist-r3s5zr`
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
