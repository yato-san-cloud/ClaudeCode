/*
 * build.js — produce single-file, self-contained builds of the workbench.
 *
 *   node build.js
 *
 * Writes two files into dist/:
 *   dist/index.html    a standalone page with esolang.js inlined (open it
 *                      directly, host it anywhere, no separate files needed)
 *   dist/artifact.html the same page as a body-only fragment, ready to hand to
 *                      a host that supplies its own <head>/<body> wrapper
 */
var fs = require('fs');
var path = require('path');

var root = __dirname;
var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
var engine = fs.readFileSync(path.join(root, 'esolang.js'), 'utf8');

// Inline the engine in place of the external <script src>.
var inlined = html.replace(
  /<script src="esolang\.js"><\/script>/,
  '<script>\n' + engine + '\n</script>'
);
if (inlined === html) {
  console.error('build: could not find <script src="esolang.js"> to inline.');
  process.exit(1);
}

// Body-only fragment: the <style> block plus everything inside <body>.
var style = (inlined.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
var bodyInner = (inlined.match(/<body[^>]*>([\s\S]*)<\/body>/) || [null, ''])[1];
var fragment = style + '\n' + bodyInner.trim() + '\n';

var outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), inlined);
fs.writeFileSync(path.join(outDir, 'artifact.html'), fragment);

function kb(s) { return (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB'; }
console.log('build: wrote dist/index.html    (' + kb(inlined) + ', self-contained)');
console.log('build: wrote dist/artifact.html (' + kb(fragment) + ', body-only fragment)');
