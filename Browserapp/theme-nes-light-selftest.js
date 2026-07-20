#!/usr/bin/env node
/**
 * Verify NES light theme frontend/backend wiring (no Electron required).
 */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else console.log('ok  ' + msg); };

const renderer = read('renderer.js');
const main = read('main.js');
const index = read('index.html');
const i18n = read('i18n.js');
const css = read('nes-light.css');
const pixel = read('pixel-workstation.css');

ok(/['"]nes-light['"]\s*:\s*\{\s*nameKey:\s*['"]theme\.nes\.name['"]/.test(renderer), 'renderer UI_THEMES registers nes-light');
ok(/colorScheme:\s*['"]light['"]/.test(renderer.match(/'nes-light':[\s\S]*?\}/)?.[0] || ''), 'nes-light colorScheme is light');
ok(renderer.includes("Object.hasOwn(UI_THEMES, value)"), 'applyUiTheme uses UI_THEMES whitelist');
ok(renderer.includes("setUiChrome"), 'renderer pushes setUiChrome to main');
ok(main.includes("'nes-light': { bg: '#c2b59c', overlay: '#d0c4aa', symbol: '#27231b' }"), 'main THEME_CHROME has nes-light kraft chrome');
ok(main.includes("system:set-ui-chrome") || main.includes('set-ui-chrome'), 'main exposes ui chrome IPC');
ok(index.includes('nes-light.css'), 'index loads nes-light.css');
ok(index.includes('assets/fonts/pixelify-sans.css'), 'index loads local Pixelify font CSS');
ok(index.includes('data-ui-theme-option="nes-light"'), 'index theme picker has nes-light option');
ok(i18n.includes("'theme.nes'") && i18n.includes("'theme.nes.name'") && i18n.includes("'theme.nes.desc'"), 'i18n has zh/en theme.nes keys');
ok(i18n.includes('浅色像素风') && i18n.includes('Light Pixel'), 'i18n zh+en labels present');
ok(i18n.includes('浅色像素界面') && i18n.includes('Light pixel UI'), 'i18n zh+en nes desc present');
ok(css.includes('html[data-ui-theme="nes-light"]'), 'nes-light.css scopes to data-ui-theme');
ok(!css.includes('pixel-workstation'), 'nes-light.css does not reference pixel-workstation');
ok(css.includes('#cdc1a9') && css.includes('#51787a') && css.includes('#c2b59c') && css.includes('#e7ddc8'), 'kraft paper palette present');
ok(!css.includes('#209cee') && !css.includes('#c381b5') && !css.includes('#e76e55') && !css.includes('#f7d51d'), 'neon/AI leftovers removed');
ok(css.includes('color-scheme: light'), 'nes-light declares light color-scheme');
ok(css.includes('.start-progress'), 'nes-light styles start progress bar');
ok(/linear-gradient\(90deg/.test(css) && css.includes('16px 16px'), 'nes-light has grid background');
ok(/\.log-card[\s\S]*?background:\s*\#e7ddc8/.test(css), 'log page kraft paper');
ok(css.includes('#c2b59c') && css.includes('titlebar-integrated'), 'integrated titlebar kraft sidebar');
ok(!/titlebar-integrated[\s\S]*?background:\s*#212529 !important/.test(css), 'integrated titlebar no longer forces dark sidebar');
ok(css.includes('assets/logo-pixel.png'), 'brand logo uses assets/logo-pixel.png');
ok(/\.rpa-log[\s\S]*?background:\s*\#e7ddc8/.test(css) && !/html\[data-ui-theme="nes-light"\] \.rpa-log \{[\s\S]*?#25221e/.test(css), 'RPA run log kraft paper not dark island');
ok(css.includes('6px 0 0') || css.includes('box-shadow: 6px 0 0'), 'sidebar has raised hard depth shadow');
ok(css.includes('9px 9px 0 rgba') || css.includes('5px 5px 0'), 'cards have dual hard+ambient depth shadow');
ok(pixel.includes('pixel-workstation') && !pixel.includes('nes-light'), 'pixel theme remains independent');
ok(css.includes('height: auto !important') && css.includes('min(68vw, 820px)'), 'nes header auto height for long subtitles');
ok(pixel.includes('height: auto !important') && pixel.includes('min(68vw, 820px)'), 'pixel header auto height for long subtitles');
ok(!/\[data-platform="macos"\] \.content > header \{ height: 52px/.test(css), 'nes mac header no longer fixed 52px');
ok(!/\[data-platform="macos"\] \.content > header \{ height: 52px/.test(pixel), 'pixel mac header no longer fixed 52px');

// structural: selector count comparable to pixel theme (clone coverage)
const count = (text, re) => (text.match(re) || []).length;
const pixelRules = count(pixel, /html\[data-ui-theme="pixel-workstation"\]/g);
const nesRules = count(css, /html\[data-ui-theme="nes-light"\]/g);
ok(nesRules >= Math.floor(pixelRules * 0.9), `nes selector coverage ${nesRules} ≈ pixel ${pixelRules}`);

// package does not exclude css skins
const pack = read('scripts/package-portable.js');
ok(!/nes-light\.css/.test(pack) || !/excluded/.test(pack), 'packager does not special-case exclude nes-light');
ok(pack.includes("CODE_OVERVIEW.md"), 'packager still excludes only CODE_OVERVIEW among docs');

// contrast smoke: no white-on-white head
ok(!/background:\s*#ffffff;\s*color:\s*#ffffff/.test(css), 'no white-on-white color pairs');
ok(!/background:\s*#ffffff !important;\s*color:\s*#ffffff/.test(css), 'no white-on-white !important pairs');

if (fails.length) {
  console.error('\nFAIL ' + fails.length);
  for (const f of fails) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nPASS theme-nes-light-selftest (' + (pixelRules + nesRules) + ' selectors checked)');
