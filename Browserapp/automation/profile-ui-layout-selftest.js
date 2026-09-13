'use strict';

/** Regression checks for profile table layout and dynamic action icons. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
  }
}

check('profile engine label keeps the full version in the tooltip only', () => {
  const source = read('renderer.js');
  assert.match(source, /const fullVersion = versionMatch \? versionMatch\[1\] : '130'/);
  assert.match(source, /const displayVersion = String\(fullVersion\)\.split\('\.'\)\[0\] \|\| fullVersion/);
  assert.match(source, /element\('strong', '', `\$\{engineName\} \$\{displayVersion\}`\)/);
  assert.match(source, /wrap\.title = `\$\{engineName\} \$\{fullVersion\} · \$\{kernelSub\}`/);
});

check('profile table cannot be shrunk below the readable column budget', () => {
  const shell = read('ui-shell.css');
  const pixel = read('pixel-workstation.css');
  const nes = read('nes-light.css');
  assert.ok(shell.includes('min-width: 980px !important'), 'base profile table minimum width must stay readable');
  assert.ok(pixel.includes('min-width: 980px !important'), 'pixel theme must not override the profile table minimum width');
  assert.ok(nes.includes('min-width: 980px !important'), 'nes-light theme must not override the profile table minimum width');
  assert.ok(!pixel.includes('min-width: 0 !important'), 'pixel theme must not collapse the profile table');
  assert.ok(!nes.includes('min-width: 0 !important'), 'nes-light theme must not collapse the profile table');
});

check('action buttons create real SVG nodes synchronously', () => {
  const source = read('renderer.js');
  assert.ok(source.includes('window.lucide?.createElement'), 'Lucide createElement must be used for real SVG nodes');
  assert.ok(source.includes('button.append(iconEl)'), 'icon node must be attached to the action button immediately');
  assert.ok(source.includes('if (iconEl.tagName === \'I\''), 'placeholder icon fallback must still schedule a refresh');
  const lucide = read('assets/vendor/lucide.min.js');
  assert.ok(lucide.includes('createElement'), 'bundled Lucide runtime must expose createElement');
  assert.ok(lucide.includes('createIcons'), 'bundled Lucide runtime must expose createIcons');
});

check('the system defaults action keeps WebGPU on the product default', () => {
  const source = read('renderer.js');
  assert.match(source, /function useSystemEditorDefaults\(\)\s*\{/);
  const tail = source.slice(source.indexOf('function useSystemEditorDefaults()'));
  const body = tail.slice(0, tail.indexOf('\n}') + 2);
  assert.ok(body.includes("editorSet('#editor-webgpu', 'webgl')"),
    'reading local defaults must not switch WebGPU to the host adapter');
  assert.ok(!body.includes("editorSet('#editor-webgpu', 'real')"),
    'an explicit real WebGPU default contradicts the profile WebGL identity');
});

check('every editor control the renderer reaches for exists in the page', () => {
  // A renamed or deleted control makes the setting silently fall back to its default: the profile
  // saves something the user never chose, and nothing errors. Both directions are checked here.
  const renderer = read('renderer.js');
  const html = read('index.html');
  const referenced = new Set(
    [...renderer.matchAll(/['"]#(editor-[a-z0-9-]+)['"]/gi)].map((match) => match[1])
  );
  assert.ok(referenced.size >= 100, `expected the editor to drive many controls (found ${referenced.size})`);
  const missing = [...referenced].filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [], `renderer references controls that do not exist: ${missing.join(', ')}`);
});

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  if (item.ok) console.log('  PASS  ' + item.name);
  else console.error('  FAIL  ' + item.name + ': ' + item.error);
}
if (failed.length) {
  console.error(`profile-ui-layout-selftest: FAIL ${results.length - failed.length}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`profile-ui-layout-selftest: OK ${results.length}/${results.length}`);
}
