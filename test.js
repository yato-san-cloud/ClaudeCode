/*
 * Node test suite for esolang.js. Run with:  node test.js
 * No dependencies — just assertions and a tiny runner.
 */
var E = require('./esolang.js');

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + '\n      expected: ' + JSON.stringify(expected) + '\n      actual:   ' + JSON.stringify(actual));
}
function section(title) { console.log('\n' + title); }

// ---------------------------------------------------------------------------
section('Brainfuck');
eq(E.run('brainfuck',
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.').output,
  'Hello World!\n', 'classic BF hello world');
eq(E.run('brainfuck', ',[.,]', { input: 'cat!' }).output, 'cat!', 'cat program echoes input');
eq(E.run('brainfuck', '+++ +++ [ ->+< ] >.', {}).output, String.fromCharCode(6), 'addition loop yields 6');

// ---------------------------------------------------------------------------
section('Ook!');
// Ook! is Brainfuck 1:1, so the same hello world converted must run identically.
var ookHello = E.convert('brainfuck', 'ook',
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.').code;
eq(E.run('ook', ookHello).output, 'Hello World!\n', 'converted Ook! hello world runs');
ok(/^Ook[.?!] Ook[.?!]/.test(ookHello), 'Ook! output looks like Ook');
// Round-trip: BF -> Ook! -> BF is identity on the 8 core commands.
var bfSrc = '+>-<[.,]';
eq(E.convert('ook', 'brainfuck', E.convert('brainfuck', 'ook', bfSrc).code).code, bfSrc, 'BF->Ook->BF round-trips');

// ---------------------------------------------------------------------------
section('Cow (COW)');
// Every COW command parses.
eq(Object.keys(E.COW_WORDS).length, 12, 'COW has 12 instructions');
// Superset check: converted BF hello world runs as COW.
var cowHello = E.convert('brainfuck', 'cow',
  '++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.>++.').code;
eq(E.run('cow', cowHello).output, 'Hello World!\n', 'converted Cow hello world runs');
// OOO (set zero): put 5 in a cell then zero it, print -> NUL byte value 0.
eq(E.run('cow', 'MoO MoO MoO MoO MoO OOO OOM').output, '0', 'OOO zeroes the cell, OOM prints 0');
// OOM prints integers, not bytes: 5 -> "5".
eq(E.run('cow', 'MoO MoO MoO MoO MoO OOM').output, '5', 'OOM prints integer value');
// MMM register: copy 7, move right, paste -> both cells 7; print second as int.
eq(E.run('cow', 'MoO MoO MoO MoO MoO MoO MoO MMM moO MMM OOM').output, '7', 'MMM copies value across cells');
// oom reads an integer; add 1; print.
eq(E.run('cow', 'oom MoO OOM', { input: '41' }).output, '42', 'oom reads an integer from input');
// mOO meta-execute: cell holds 6 (=MoO/increment); executing it makes cell 7.
eq(E.run('cow', 'MoO MoO MoO MoO MoO MoO mOO OOM').output, '7', 'mOO meta-executes increment');
// The curated integer-counter example prints exactly 1..5, newline-separated.
eq(E.EXAMPLES.filter(function (x) { return /Count 1..5/.test(x.name); })[0] &&
   E.run('cow', E.EXAMPLES.filter(function (x) { return /Count 1..5/.test(x.name); })[0].code).output,
   '1\n2\n3\n4\n5\n', 'Cow counter example prints 1..5');

// ---------------------------------------------------------------------------
section('Text -> code generator');
['Hi!', 'Hello, World!\n', 'esolang 42', 'こんにちは'].forEach(function (t) {
  eq(E.run('brainfuck', E.generate('brainfuck', t)).output, t, 'generate BF prints ' + JSON.stringify(t));
  eq(E.run('ook', E.generate('ook', t)).output, t, 'generate Ook! prints ' + JSON.stringify(t));
  eq(E.run('cow', E.generate('cow', t)).output, t, 'generate Cow prints ' + JSON.stringify(t));
});

// ---------------------------------------------------------------------------
section('Curated examples all run without error');
E.EXAMPLES.forEach(function (ex) {
  var r = E.run(ex.lang, ex.code, { input: ex.input });
  ok(r.error === null, ex.name + ' runs clean (' + (r.error || 'ok') + ')');
  ok(r.output.length > 0, ex.name + ' produces output: ' + JSON.stringify(r.output));
});

// ---------------------------------------------------------------------------
section('Interactive input (pause on read)');
(function () {
  var m = new E.Machine(E.parseBrainfuck(',.'), { interactive: true });
  while (m.step()) {}                       // steps until it blocks on the read
  ok(m.waiting === true && !m.halted, 'machine pauses waiting for input');
  m.feedInput('A');                          // host supplies a keystroke
  while (!m.halted && m.step()) {}
  eq(m.output(), 'A', 'resumes and echoes the fed byte');
})();

// ---------------------------------------------------------------------------
section('Guess-the-number game (generated)');
function playGuess(secret, keys) { return E.run('brainfuck', E.buildGuessGame(secret), { input: keys }).output; }
ok(/Too low!/.test(playGuess(7, '3')), 'guess below secret says Too low');
ok(/Too high!/.test(playGuess(7, '9')), 'guess above secret says Too high');
ok(/Correct! It was 7\./.test(playGuess(7, '7')), 'exact guess is Correct');
(function () {
  var o = playGuess(7, '397');               // low, then high, then win
  ok(/Too low![\s\S]*Too high![\s\S]*Correct! It was 7\./.test(o), 'full session low→high→win in order');
})();
ok(/Bye!/.test(playGuess(4, '9')) && !/Correct/.test(playGuess(4, '9')), 'runs out of input → quits with Bye!');
ok(E.run('brainfuck', E.buildGuessGame(7), { input: '7' }).error === null, 'winning game halts (no step-limit)');
// every digit 1..9 gets exactly one verdict against secret 5
[1,2,3,4,5,6,7,8,9].forEach(function (g) {
  var o = playGuess(5, String(g));
  var want = g === 5 ? 'Correct! It was 5.' : (g < 5 ? 'Too low!' : 'Too high!');
  ok(o.indexOf(want) !== -1, 'digit ' + g + ' vs secret 5 → ' + want.replace('\n',''));
});

// ---------------------------------------------------------------------------
section('Error handling');
ok(E.run('brainfuck', '[').error !== null, 'unmatched [ is reported');
ok(E.run('brainfuck', '+[]', { maxSteps: 1000 }).error !== null, 'infinite loop hits step limit');
ok(E.run('brainfuck', '<').error !== null, 'pointer underflow is reported');
try { E.parseOok('Ook.'); ok(false, 'odd Ook count should throw'); }
catch (e) { ok(true, 'odd Ook count throws'); }

// ---------------------------------------------------------------------------
console.log('\n' + (failed ? '✗' : '✓') + ' ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
