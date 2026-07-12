/*
 * esolang.js — a small, correct engine for the Ook!, Cow (COW) and Brainfuck
 * family of esoteric languages.
 *
 * Design: every language is parsed into a single normalised opcode stream (the
 * "IR"). One virtual machine executes the IR, and every converter is just
 * "parse source -> IR -> emit target". This keeps the three languages in sync
 * and makes conversion between any pair free.
 *
 * The module works unchanged in the browser (attaches `window.Esolang`) and in
 * Node.js (`module.exports`), so the same code powers the playground UI and the
 * automated tests.
 *
 * IR opcodes (single tokens):
 *   >  move pointer right          <  move pointer left
 *   +  increment cell              -  decrement cell
 *   .  output cell as a byte       ,  read a byte into cell
 *   [  loop start (jump if zero)   ]  loop end   (jump if non-zero)
 *   Z  set cell to zero            (COW: OOO)
 *   R  register copy/paste toggle  (COW: MMM)
 *   P  print cell as an integer    (COW: OOM)
 *   Q  read an integer into cell   (COW: oom)
 *   M  COW char I/O: read if cell==0, otherwise print   (COW: Moo)
 *   X  execute cell value as an instruction             (COW: mOO)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Esolang = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- byte helpers (work in both Node and the browser) -------------------
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  function toBytes(str) { return Array.from(enc.encode(str || '')); }
  function fromBytes(bytes) { return dec.decode(new Uint8Array(bytes)); }

  // =========================================================================
  //  Parsers: source -> IR
  // =========================================================================

  // Brainfuck: any character that is not a command is a comment.
  var BF_COMMANDS = '><+-.,[]';
  function parseBrainfuck(src) {
    var ops = [];
    for (var i = 0; i < src.length; i++) {
      if (BF_COMMANDS.indexOf(src[i]) !== -1) ops.push(src[i]);
    }
    return ops;
  }

  // Ook!: three tokens (Ook.  Ook?  Ook!) grouped into pairs.
  var OOK_PAIRS = {
    '.?': '>', '?.': '<', '..': '+', '!!': '-',
    '!.': '.', '.!': ',', '!?': '[', '?!': ']'
  };
  function parseOok(src) {
    // Collect the punctuation that follows each "Ook" word.
    var marks = [];
    var re = /Ook([.?!])/gi;
    var m;
    while ((m = re.exec(src)) !== null) marks.push(m[1]);
    if (marks.length % 2 !== 0) {
      throw new SyntaxError('Ook! programs need an even number of "Ook" words (got ' + marks.length + ').');
    }
    var ops = [];
    for (var i = 0; i < marks.length; i += 2) {
      var key = marks[i] + marks[i + 1];
      var op = OOK_PAIRS[key];
      if (!op) throw new SyntaxError('Invalid Ook! pair: "Ook' + marks[i] + ' Ook' + marks[i + 1] + '".');
      ops.push(op);
    }
    return ops;
  }

  // Cow (COW): twelve three-letter words, case sensitive.
  var COW_WORDS = {
    'moo': ']', 'mOo': '<', 'moO': '>', 'mOO': 'X', 'Moo': 'M', 'MOo': '-',
    'MoO': '+', 'MOO': '[', 'OOO': 'Z', 'MMM': 'R', 'OOM': 'P', 'oom': 'Q'
  };
  function parseCow(src) {
    var ops = [];
    var tokens = src.match(/[a-zA-Z]{3}/g) || [];
    for (var i = 0; i < tokens.length; i++) {
      var op = COW_WORDS[tokens[i]];
      // Only real COW words count; other 3-letter runs are treated as comments.
      if (op) ops.push(op);
    }
    return ops;
  }

  var PARSERS = { brainfuck: parseBrainfuck, ook: parseOok, cow: parseCow };
  function parse(lang, src) {
    var p = PARSERS[lang];
    if (!p) throw new Error('Unknown language: ' + lang);
    return p(src);
  }

  // =========================================================================
  //  Emitters: IR -> source
  // =========================================================================

  function emitBrainfuck(ops) {
    var warnings = [];
    var out = '';
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (BF_COMMANDS.indexOf(op) !== -1) out += op;
      else if (op === 'Z') out += '[-]';           // set-to-zero has a BF idiom
      else if (op === 'M') out += '.';             // COW char I/O -> assume print
      else warnings.push('Dropped instruction "' + op + '" (no Brainfuck equivalent).');
    }
    return { code: out, warnings: dedupe(warnings) };
  }

  var IR_TO_OOK = { '>': '.?', '<': '?.', '+': '..', '-': '!!', '.': '!.', ',': '.!', '[': '!?', ']': '?!' };
  function emitOok(ops) {
    // Ook! only speaks the eight core Brainfuck commands, so lower through BF.
    var bf = emitBrainfuck(ops);
    var pieces = [];
    for (var i = 0; i < bf.code.length; i++) {
      var pair = IR_TO_OOK[bf.code[i]];
      pieces.push('Ook' + pair[0] + ' Ook' + pair[1]);
    }
    return { code: pieces.join(' '), warnings: bf.warnings };
  }

  var IR_TO_COW = {
    '>': 'moO', '<': 'mOo', '+': 'MoO', '-': 'MOo', '[': 'MOO', ']': 'moo',
    '.': 'Moo', ',': 'Moo', 'Z': 'OOO', 'R': 'MMM', 'P': 'OOM', 'Q': 'oom', 'M': 'Moo', 'X': 'mOO'
  };
  function emitCow(ops) {
    var words = [];
    for (var i = 0; i < ops.length; i++) words.push(IR_TO_COW[ops[i]]);
    return { code: words.join(' '), warnings: [] };
  }

  var EMITTERS = { brainfuck: emitBrainfuck, ook: emitOok, cow: emitCow };
  function emit(lang, ops) {
    var e = EMITTERS[lang];
    if (!e) throw new Error('Unknown language: ' + lang);
    return e(ops);
  }

  function dedupe(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    return out;
  }

  // convert(from, to, src) -> { code, warnings }
  function convert(from, to, src) {
    return emit(to, parse(from, src));
  }

  // =========================================================================
  //  The virtual machine
  // =========================================================================

  // Build a jump table for [ ] with nesting. (COW's MOO/moo are treated as
  // ordinary brackets; the spec's self-modifying "skip" quirk only matters for
  // programs that abuse mOO, which practical code never does.)
  function buildJumps(ops) {
    var jumps = {}, stack = [];
    for (var i = 0; i < ops.length; i++) {
      if (ops[i] === '[') stack.push(i);
      else if (ops[i] === ']') {
        if (!stack.length) throw new SyntaxError('Unmatched loop-end at instruction ' + i + '.');
        var open = stack.pop();
        jumps[open] = i;
        jumps[i] = open;
      }
    }
    if (stack.length) throw new SyntaxError('Unmatched loop-start at instruction ' + stack.pop() + '.');
    return jumps;
  }

  // The COW instruction table, indexed by value, for the X (mOO) meta command.
  var COW_BY_VALUE = [']', '<', '>', 'X', 'M', '-', '+', '[', 'Z', 'R', 'P', 'Q'];

  function Machine(ops, options) {
    options = options || {};
    this.ops = ops;
    this.jumps = buildJumps(ops);
    this.cellSize = options.cellSize || 256;
    this.maxSteps = options.maxSteps || 5000000;
    this.maxTape = options.maxTape || 100000;
    this.interactive = !!options.interactive; // pause on a read when input runs out
    this.input = toBytes(options.input);
    this.reset();
  }

  Machine.prototype.reset = function () {
    this.tape = [0];
    this.ptr = 0;
    this.pc = 0;
    this.inPtr = 0;
    this.register = null;      // COW MMM register; null means "empty"
    this.steps = 0;
    this.maxPtr = 0;
    this.outBytes = [];
    this.halted = false;
    this.waiting = false;      // interactive mode: blocked on input
    this.error = null;
    this.lastWrote = -1;       // pointer position of the most recent write (for the UI)
  };

  // In interactive mode a read blocks (rather than seeing EOF) when the input
  // buffer is empty; the host feeds a keystroke and resumes stepping.
  Machine.prototype.needsInput = function (op) {
    if (this.inPtr < this.input.length) return false;
    if (op === ',' || op === 'Q') return true;
    if (op === 'M') return this.cell() === 0; // COW Moo only reads when cell is 0
    return false;
  };
  Machine.prototype.feedInput = function (str) {
    var b = toBytes(str);
    for (var i = 0; i < b.length; i++) this.input.push(b[i]);
    this.waiting = false;
  };

  Machine.prototype.cell = function () { return this.tape[this.ptr] || 0; };
  Machine.prototype.writeCell = function (v) {
    v = ((v % this.cellSize) + this.cellSize) % this.cellSize;
    this.tape[this.ptr] = v;
    this.lastWrote = this.ptr;
  };
  Machine.prototype.nextByte = function () {
    return this.inPtr < this.input.length ? this.input[this.inPtr++] : 0; // EOF -> 0
  };
  Machine.prototype.nextInt = function () {
    while (this.inPtr < this.input.length && !/[0-9-]/.test(String.fromCharCode(this.input[this.inPtr]))) this.inPtr++;
    var s = '';
    if (this.input[this.inPtr] === 45) { s = '-'; this.inPtr++; }        // '-'
    while (this.inPtr < this.input.length && this.input[this.inPtr] >= 48 && this.input[this.inPtr] <= 57) {
      s += String.fromCharCode(this.input[this.inPtr++]);
    }
    var n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  };

  // Execute a single opcode. `op` defaults to the instruction at the pc, but the
  // X (meta) command reuses this to run an instruction decoded from a cell.
  Machine.prototype.exec = function (op, isMeta) {
    switch (op) {
      case '>':
        this.ptr++;
        if (this.ptr >= this.maxTape) throw new Error('Pointer ran past the end of the tape.');
        if (this.tape[this.ptr] === undefined) this.tape[this.ptr] = 0;
        if (this.ptr > this.maxPtr) this.maxPtr = this.ptr;
        break;
      case '<':
        this.ptr--;
        if (this.ptr < 0) throw new Error('Pointer moved to the left of cell 0.');
        break;
      case '+': this.writeCell(this.cell() + 1); break;
      case '-': this.writeCell(this.cell() - 1); break;
      case '.': this.outBytes.push(this.cell()); break;
      case ',': this.writeCell(this.nextByte()); break;
      case 'Z': this.writeCell(0); break;
      case 'P': for (var d = 0, s = String(this.cell()); d < s.length; d++) this.outBytes.push(s.charCodeAt(d)); break;
      case 'Q': this.writeCell(this.nextInt()); break;
      case 'M': // COW Moo: read when the cell is 0, otherwise print.
        if (this.cell() === 0) this.writeCell(this.nextByte());
        else this.outBytes.push(this.cell());
        break;
      case 'R': // COW MMM register toggle.
        if (this.register === null) this.register = this.cell();
        else { this.writeCell(this.register); this.register = null; }
        break;
      case '[':
        if (this.cell() === 0) this.pc = this.jumps[this.pc];
        break;
      case ']':
        if (this.cell() !== 0) this.pc = this.jumps[this.pc];
        break;
      case 'X': // COW mOO: execute the current cell value as an instruction.
        if (isMeta) throw new Error('Refusing to meta-execute a meta-execute (would loop forever).');
        var v = this.cell();
        if (v === 3) throw new Error('mOO on a cell holding 3 would loop forever.');
        if (v < 0 || v >= COW_BY_VALUE.length) { this.halted = true; break; } // invalid -> exit
        var decoded = COW_BY_VALUE[v];
        if (decoded === '[' || decoded === ']') throw new Error('mOO cannot meta-execute a loop instruction.');
        this.exec(decoded, true);
        break;
      default: break;
    }
  };

  Machine.prototype.step = function () {
    if (this.halted) return false;
    if (this.pc >= this.ops.length) { this.halted = true; return false; }
    var op = this.ops[this.pc];
    if (this.interactive && this.needsInput(op)) { this.waiting = true; return false; }
    this.waiting = false;
    if (this.steps >= this.maxSteps) throw new Error('Step limit reached (' + this.maxSteps + '). Possible infinite loop.');
    this.exec(op, false);
    this.pc++;
    this.steps++;
    if (this.pc >= this.ops.length) this.halted = true;
    return !this.halted;
  };

  Machine.prototype.output = function () { return fromBytes(this.outBytes); };

  // Run to completion and return a result summary. Parse and construction
  // errors (unmatched brackets, bad Ook! pairs) are captured too, so callers
  // always get a result object rather than a thrown exception.
  function run(lang, src, options) {
    var vm = null, ops = [];
    try {
      ops = parse(lang, src);
      vm = new Machine(ops, options);
      while (!vm.halted) vm.step();
    } catch (e) {
      if (vm) vm.error = e.message;
      else return { output: '', error: e.message, steps: 0, pointer: 0, tape: [0], opCount: ops.length };
    }
    return {
      output: vm.output(),
      error: vm.error,
      steps: vm.steps,
      pointer: vm.ptr,
      tape: vm.tape.slice(0, Math.max(vm.maxPtr + 1, 1)),
      opCount: ops.length
    };
  }

  // =========================================================================
  //  Text -> code generator
  // =========================================================================

  // Produce Brainfuck that adds `n` (0..255) to the current cell, using a
  // multiplication loop when that is shorter than a run of +/-.
  function buildDelta(n, plus, minus) {
    if (n === 0) return '';
    var naive = new Array(n + 1).join(plus);
    var best = naive;
    for (var a = 2; a <= 16; a++) {
      var b = Math.round(n / a);
      var rem = n - a * b;                       // may be negative
      var loop = '>' + rep('+', a) + '[<' + rep(plus, b) + '>-]<' +
                 (rem >= 0 ? rep(plus, rem) : rep(minus, -rem));
      if (loop.length < best.length) best = loop;
    }
    return best;
  }
  function rep(s, n) { return n > 0 ? new Array(n + 1).join(s) : ''; }

  // Generate Brainfuck that prints exactly `text` (UTF-8, so any script works).
  function textToBrainfuck(text) {
    var bytes = toBytes(text);
    var code = '';
    var cur = 0;
    for (var i = 0; i < bytes.length; i++) {
      var target = bytes[i];
      var up = (target - cur + 256) % 256;       // additions needed going up
      var down = (256 - up) % 256;               // subtractions needed going down
      code += (up <= down) ? buildDelta(up, '+', '-') : buildDelta(down, '-', '+');
      code += '.';
      cur = target;
    }
    return code;
  }

  // Generate a printing program in the requested language.
  function generate(lang, text) {
    var bf = textToBrainfuck(text);
    if (lang === 'brainfuck') return bf;
    return emit(lang, parseBrainfuck(bf)).code;
  }

  // =========================================================================
  //  Metadata + curated examples
  // =========================================================================

  var LANGS = {
    brainfuck: { name: 'Brainfuck', hint: 'The 8-command classic these two are built on.' },
    ook: { name: 'Ook!', hint: 'Brainfuck for orangutans — Ook. Ook? Ook!' },
    cow: { name: 'Cow (COW)', hint: '12 moo-based commands, a superset of Brainfuck.' }
  };

  var EXAMPLES = [
    {
      name: 'Brainfuck · Hello World',
      lang: 'brainfuck',
      code: '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.'
    },
    {
      name: 'Brainfuck · Echo (cat)',
      lang: 'brainfuck',
      code: ',[.,]',
      input: 'type me back'
    },
    {
      name: 'Ook! · Hello World',
      lang: 'ook',
      code: null // filled in below by the generator so it is guaranteed to run
    },
    {
      name: 'Cow · Hello World',
      lang: 'cow',
      code: null
    },
    {
      name: 'Cow · Count 1..5 (integers)',
      lang: 'cow',
      // MoO x5 seeds a counter; the loop prints the value then a newline and
      // decrements — showing OOM (print int), OOO (zero) and the char I/O.
      code: buildCowCounter()
    },
    {
      name: 'Brainfuck · Guess the number (interactive)',
      lang: 'brainfuck',
      interactive: true,
      note: 'Press Play ⌨, then type a digit 1–9 and hit a key each turn.',
      // A real, playable game: read a digit, say too high / too low / correct,
      // loop until solved. Proof that turn-based games work — see buildGuessGame.
      code: buildGuessGame(7)
    }
  ];

  // A hand-built COW program that prints "1\n2\n3\n4\n5\n" to show integer I/O.
  // Esolangs have no easy "compare", so the 1..5 loop is unrolled by hand.
  function buildCowCounter() {
    var out = ['MoO'];                 // cell0 = 1 (the counter's starting value)
    for (var i = 1; i <= 5; i++) {
      if (i > 1) out.push('MoO');      // advance the counter to i
      out.push('OOM');                 // print counter as an integer
      // newline: move to cell1, build 10 ('\n'), print it, zero it, move back
      out.push('moO', 'OOO');          // -> cell1, cell1 = 0
      for (var k = 0; k < 10; k++) out.push('MoO'); // cell1 = 10
      out.push('Moo', 'OOO', 'mOo');   // print '\n', zero cell1, back to cell0
    }
    return out.join(' ');
  }

  // Generate a playable "guess the number" game as Brainfuck. Rather than write
  // fragile comparison code by hand, we assemble the opcodes with a tiny
  // cell-addressed helper: dispatch on the typed digit with an equality test and
  // print a per-digit verdict decided at build time. Reads block in interactive
  // mode (one keypress per turn) and stop on EOF, so it also runs in batch.
  //   cells: 0 playing · 1 input · 2 result · 3,4 temps · 5 print scratch
  function buildGuessGame(secret) {
    var code = '', p = 0;
    var PLAY = 0, G = 1, RES = 2, T1 = 3, T2 = 4, MSG = 5;
    function at(t) { while (p < t) { code += '>'; p++; } while (p > t) { code += '<'; p--; } }
    function add(t, n) { at(t); code += (n >= 0 ? '+' : '-').repeat(Math.abs(n)); }
    function zero(t) { at(t); code += '[-]'; }
    function out(t) { at(t); code += '.'; }
    function readc(t) { at(t); code += ','; }
    function loopc(t, body) { at(t); code += '['; body(); at(t); code += ']'; }
    function emitStr(s, cell) { for (var i = 0; i < s.length; i++) { zero(cell); add(cell, s.charCodeAt(i)); out(cell); } }
    function copy(a, b, t) {                    // b = a, preserving a (t is scratch)
      zero(b); zero(t);
      loopc(a, function () { add(b, 1); add(t, 1); add(a, -1); });
      loopc(t, function () { add(a, 1); add(t, -1); });
    }
    function eqConst(a, k) {                     // RES = (a == k) ? 1 : 0
      copy(a, T1, T2); add(T1, -k);
      zero(RES); add(RES, 1);
      loopc(T1, function () { zero(RES); zero(T1); });
    }
    add(PLAY, 1);                                // playing = 1
    loopc(PLAY, function () {
      emitStr('Guess 1-9: ', MSG);
      readc(G);
      eqConst(G, 0);                             // EOF (0) → quit cleanly (batch mode)
      loopc(RES, function () { zero(PLAY); zero(RES); });
      for (var k = 1; k <= 9; k++) {
        eqConst(G, 48 + k);                      // does the typed digit equal k?
        (function (k) {
          loopc(RES, function () {
            var verdict = (k === secret) ? ('Correct! It was ' + secret + '.\n')
                        : (k < secret ? 'Too low!\n' : 'Too high!\n');
            emitStr(verdict, MSG);
            if (k === secret) zero(PLAY);        // solved → stop looping
            zero(RES);
          });
        })(k);
      }
    });
    emitStr('Bye!\n', MSG);
    return code;
  }

  // Fill in the generated examples.
  for (var i = 0; i < EXAMPLES.length; i++) {
    if (EXAMPLES[i].code === null) {
      EXAMPLES[i].code = generate(EXAMPLES[i].lang, 'Hello, World!\n');
    }
  }

  // =========================================================================
  //  Public surface
  // =========================================================================
  return {
    parse: parse,
    parseOok: parseOok,
    parseCow: parseCow,
    parseBrainfuck: parseBrainfuck,
    emit: emit,
    convert: convert,
    run: run,
    Machine: Machine,
    generate: generate,
    textToBrainfuck: textToBrainfuck,
    buildGuessGame: buildGuessGame,
    LANGS: LANGS,
    EXAMPLES: EXAMPLES,
    COW_WORDS: COW_WORDS,
    OOK_PAIRS: OOK_PAIRS
  };
});
