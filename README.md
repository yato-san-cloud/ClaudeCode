# Ook! &amp; Cow Workbench

A single-page workbench for two gloriously impractical esoteric languages —
[**Ook!**](https://esolangs.org/wiki/Ook!) and [**Cow (COW)**](https://esolangs.org/wiki/COW) —
plus their common ancestor, [Brainfuck](https://esolangs.org/wiki/Brainfuck).

The joke is that these languages are famously *useless*; the app is the practical
part. It lets you actually **write, run, single-step and debug** programs in all
three, watch the memory tape move cell by cell, **convert** a program from any
language to any other, and **compile arbitrary text** (including 日本語 and emoji)
into a working program that prints it.

> Open `index.html` in a browser — no build step, no dependencies, no server.

## Features

- **Run & debug** — run to completion, single-step, or *animate* the execution
  while a live memory-tape visualiser shows each cell's value, its ASCII
  character, and the data pointer.
- **Interactive Play mode** — press **Play ⌨** to run a program that reads input
  *live*, one keystroke per turn. Ships with a playable **guess-the-number**
  game (`buildGuessGame`) as proof that turn-based games really do work in these
  languages.
- **Three languages, one engine** — Ook!, Cow and Brainfuck. The UI re-tints to
  the language you're in (Ook! amber, Cow teal, Brainfuck periwinkle).
- **Converter** — translate between all three. Ook! and Brainfuck are exact
  twins; Cow is a superset, so the converter warns when a Cow-only instruction
  (`OOO`, `MMM`, `OOM`, `oom`, `mOO`) has no Brainfuck/Ook! equivalent.
- **Text → code generator** — turn any string into a program. It emits compact
  Brainfuck using multiplication loops, then lowers to the target language.
- **Instruction reference** — a per-language cheat-sheet, always on screen.

## The languages, briefly

| Concept        | Brainfuck | Ook!         | Cow   |
| -------------- | :-------: | ------------ | ----- |
| pointer right  | `>`       | `Ook. Ook?`  | `moO` |
| pointer left   | `<`       | `Ook? Ook.`  | `mOo` |
| increment      | `+`       | `Ook. Ook.`  | `MoO` |
| decrement      | `-`       | `Ook! Ook!`  | `MOo` |
| output byte    | `.`       | `Ook! Ook.`  | `Moo` |
| input byte     | `,`       | `Ook. Ook!`  | `Moo` |
| loop start     | `[`       | `Ook! Ook?`  | `MOO` |
| loop end       | `]`       | `Ook? Ook!`  | `moo` |

Cow adds six more instructions on top of the Brainfuck core: `OOO` (zero the
cell), `MMM` (copy/paste a one-slot register), `OOM` (print the cell as a decimal
integer), `oom` (read an integer), and `mOO` (execute the cell's value *as* an
instruction — Cow's self-modifying trick). `Moo` is context-sensitive: it reads
when the current cell is `0` and prints otherwise.

## Architecture

Everything runs through a single **intermediate representation (IR)**. Each
language is parsed into one normalised opcode stream, one virtual machine
executes that IR, and every converter is just *parse source → IR → emit target*.
That keeps the three languages in perfect sync and makes conversion between any
pair fall out for free.

```
 Ook!  ─┐                              ┌─►  Ook!
 Cow   ─┼─►  parse  ─►  IR opcodes ─►  emit  ─►  Cow
 BF    ─┘              │                       └─►  BF
                       ▼
                 virtual machine  ─►  output + memory tape
```

- **`esolang.js`** — the whole engine, with no dependencies. It runs unchanged in
  the browser (`window.Esolang`) and in Node (`module.exports`), so the exact
  same code powers the UI and the tests. Public surface: `parse`, `emit`,
  `convert`, `run`, `Machine` (a stepper), `generate`, `textToBrainfuck`,
  `LANGS`, `EXAMPLES`.
- **`index.html`** — the workbench UI (self-contained styles + glue), which loads
  `esolang.js`.
- **`test.js`** — a dependency-free Node test suite for the engine.
- **`build.js`** — inlines the engine to produce single-file builds in `dist/`.

Cells are unsigned and wrap at 0–255; the pointer starts at cell 0; `,` reads
UTF-8 bytes and treats end-of-input as 0. A step limit guards against infinite
loops.

## Commands

```sh
node test.js      # run the engine test suite (no dependencies)
node build.js     # write dist/index.html (standalone) + dist/artifact.html
```

There is no build step required to use the app — `node build.js` only exists to
bundle everything into one portable file. To run a single behaviour in
isolation, call the engine directly:

```sh
node -e "console.log(require('./esolang.js').run('cow', 'MoO MoO MoO OOM').output)"  # -> 3
```
