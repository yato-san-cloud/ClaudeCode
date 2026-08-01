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
- **`S`** is the global game state; **`S.cur`** accumulates the current patient's per-phase scores,
  which `Result.show()` folds into a weighted average via `WEIGHT`.
- **`SPINE` / `spineLayout()` / `drawVertebra()`** are shared by the title animation, the palpation
  view, and the zoomed contact view. Landmark coordinates in `LM` are ratios of the *drawn* vertebra's
  width/height, so they stay aligned at any scale.
- **`Snd`** synthesizes every sound at call time — no audio files. It must be resumed from a user
  gesture before it will play.
- **Patient data** lives in the `PATIENTS` array; adding a case means adding one object there
  (target segment, correct technique, correct contact landmark, drive angle, red/yellow flag, dialogue).

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
