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
  assert.match(source, /element\(\'strong\', '', `\$\{engineName\} \$\{displayVersion\}`\)/);
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
  const lucide = read('assets/vendor/lucide.min.js');
  assert.ok(lucide.includes('createElement'), 'bundled Lucide runtime must expose createElement');
  assert.ok(lucide.includes('createIcons'), 'bundled Lucide runtime must expose createIcons');
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
