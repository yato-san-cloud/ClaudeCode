# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Status

The remote is `yato-san-cloud/ClaudeCode` on a local proxy. The repository currently holds one project:

- `index.html` — ボキボキ・クリニック, a chiropractic adjustment simulator game. See `README.md`.

There is no build system, package manager, linter, or test runner configured, and no dependencies.

## Build / Run / Test

- **Run:** open `index.html` in a browser. No build step, no server, no install.
- **Test:** there is no test suite in the repo. Changes to `index.html` were verified by driving the
  page with Playwright + the pre-installed Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  (install Playwright into a scratch directory with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`).
  When changing game logic, re-verify by scripting a full patient flow and asserting zero `pageerror`
  and zero `console.error`.

## Architecture — index.html

Everything (markup, CSS, game logic, Canvas rendering, WebAudio synthesis) lives in the single file.
No external assets or network requests, so it works offline and from `file://`.

- **Screens** are `<section class="screen">` elements toggled by `go(id)`. One `requestAnimationFrame`
  loop calls whatever `setDraw(fn)` last registered, so each screen owns its own draw function and
  screens with no canvas call `setDraw(null)`.
- **Phase modules** (`Intake`, `Palp`, `Tech`, `Contact`, `Thrust`, `After`, `Result`) are plain object
  literals, each with `open()` and their own state. They hand off to each other directly.
- **The flow branches at `Tech.pick()`** into three routes, and later phases differ per route:
  - default → `Contact` → `Thrust`
  - `gonstead` → `Nervo` → `Listing` → `Contact('gonstead')` → `Thrust('gonstead')`
  - `toggle` (offered only when the marked segment is C1/C2) → `Atlas` → `Contact('toggle')` → `Thrust('toggle')`
  In the Gonstead route the correct contact and drive angle are *derived* from the true listing by
  `gsDerive()`, not read from the patient's `contact`/`drive` fields — so a misread film propagates
  into a wrong setup. `atDerive()` does the same for the atlas listing.
- **`S`** is the global game state; **`S.cur`** accumulates the current patient's per-phase scores,
  which `Result.show()` folds into a weighted average via `WEIGHT`.
- **Phase 5 is a scene, not a gauge.** `Body` draws the patient on the table in a normalized
  1000-unit space and `Body.camera()` zooms to the target region; `Thrust` projects pointer
  displacement onto the drive vector chosen in phase 4. Slack is that projection; the thrust is
  detected from **frame-to-frame** velocity crossing a threshold, and amplitude is the distance
  travelled from that moment. Crossing the drive-through line resolves immediately without waiting
  for release. `Thrust.giveUp()` guarantees the phase always terminates (3 aborts or 42 seconds).
- **`SPINE` / `spineLayout()` / `drawVertebra()`** are shared by the title animation, the palpation
  view, the zoomed contact view, and the spine drawn through the patient's skin in phase 5. Landmark coordinates in `LM` are ratios of the *drawn* vertebra's
  width/height, so they stay aligned at any scale.
- **`Snd`** synthesizes every sound at call time — no audio files. It must be resumed from a user
  gesture before it will play.
- **`Practice`** re-runs individual phases standalone. Every phase hand-off goes through
  `Practice.next(continueFn, stepName)`, which calls `continueFn()` verbatim when practice is off —
  so adding a phase means adding one more hook, not branching inside the phase.
- **Patient data** lives in the `PATIENTS` array; adding a case means adding one object there
  (target segment, correct technique, correct contact landmark, drive angle, red/yellow flag, dialogue).
  Every patient also needs a `gs` listing for the Gonstead route; **any patient whose target is C1 or
  C2 additionally needs `atlas`**, because `Tech.open()` offers toggle recoil based on region alone.
  A C2 patient shipped without it, and `Atlas.draw()` threw every frame while `Atlas.confirm()` threw
  on click, leaving the phase unfinishable. `Atlas.open()` now derives a fallback listing, but the
  data should still be present.
- **Sample pointer motion on a fixed cadence, and size the measurement window to the gesture.**
  Pointer event cadence varies by device, so deriving velocity from event deltas makes the result
  depend on the device rather than on the user. Both input bugs shipped in this file came from
  getting the window wrong:
  - `Nervo` is a *sustained glide*, so it needs a time window (170ms) and must record by **span
    covered** — fill every segment between the last sampled position and the current one — otherwise
    dropped frames punch holes in the trace. A per-frame estimate once read an entire drag as
    "too fast" and produced 0% coverage.
  - `Thrust` is a *flick*, which lasts a few frames, so a windowed average smears it below the
    detection threshold. It uses the frame-to-frame delta instead, sampled from `draw()` rather than
    from `pointermove`, so a pause mid-drag (waiting for end-expiration) cannot stale the history.

### Conventions

- UI text is Japanese; code identifiers and comments are a mix of English and Japanese.
- The game is fiction. Keep the in-game and README disclaimers stating it is not medical advice,
  and do not present the simplified mechanics as real clinical procedure.

## Git Workflow

- Claude-authored changes go on the branch named in the task, not on the default branch
- Push with `git push -u origin <branch-name>`; retry up to 4 times with exponential backoff (2s, 4s, 8s, 16s) on network errors only
- Do not open pull requests unless the user explicitly requests one
- GitHub interactions must go through the `mcp__github__*` tools; `gh` CLI is not available
- MCP GitHub tools are scoped to `yato-san-cloud/claudecode` only
