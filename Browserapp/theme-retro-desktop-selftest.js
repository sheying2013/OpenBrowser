#!/usr/bin/env node
/** Verify retro-desktop macOS 10 / Aqua skin — rounded metal, soft shadows, distinct from pixel. */
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
const css = read('retro-desktop.css');
const styles = read('styles.css');
const pixel = read('pixel-workstation.css');
const nes = read('nes-light.css');

ok(/['"]retro-desktop['"]\s*:\s*\{\s*nameKey:\s*['"]theme\.retro\.name['"]/.test(renderer), 'renderer registers retro-desktop');
ok(main.includes("'retro-desktop': { bg: '#d8d8d8'"), 'main chrome brushed metal');
ok(index.includes('retro-desktop.css'), 'index loads retro-desktop.css');
ok(index.includes('assets/fonts/pixelify-sans.css'), 'index loads local Pixelify font CSS');
ok(i18n.includes('macOS 10 圆润界面') && i18n.includes('macOS 10 Aqua UI'), 'i18n macOS 10 Aqua desc');
ok(css.includes('html[data-ui-theme="retro-desktop"]'), 'css scoped');
ok(css.includes('#4a90d9') && css.includes('#d8d8d8'), 'aqua blue + metal palette');
ok(css.includes('--ui-radius: 10px') || css.includes('border-radius: 10px') || css.includes('border-radius: 12px'), 'rounded radii present');
ok(css.includes('border-radius: 999px') || css.includes('border-radius: 12px'), 'pill/round controls present');
ok(!css.includes('border-color: #fff #404040 #404040 #fff'), 'no Win95 outset bevel');
ok(!css.includes('border-color: #808080 #fff #fff #808080'), 'no Win95 inset bevel');
ok(!/\.sidebar\s*\{[\s\S]*?margin:\s*8px/.test(css), 'sidebar not floating with 8px margin');
ok(!/\.content\s*\{[\s\S]*?margin:\s*8px/.test(css), 'content not floating with 8px margin');
ok(/\.app-shell\s*\{[\s\S]*?margin:\s*0 !important/.test(css), 'app-shell flush margin 0');
ok(!css.includes('background-size: 32px 32px') && !css.includes('background-size: 16px 16px'), 'no pixel grid');
ok(!css.includes('#008C4B') && !css.includes('#4f8f93'), 'not pixel accents');
ok(css.includes('logo-native.png'), 'native logo');
ok(styles.split('retro-desktop').length <= 2, 'styles.css no longer hosts retro skin rules');
ok(pixel.includes('background-size: 16px 16px'), 'pixel still grid');
ok(nes.includes('16px 16px') && /linear-gradient\(90deg/.test(nes), 'nes still grid');
// dual-surface: dark chrome uses bright body text; light tables keep dark --ui-text
ok(/html\[data-ui-theme="pixel-workstation"\] body \{[\s\S]*?color:\s*#e9f1eb/.test(pixel) || pixel.includes('color: #e9f1eb'), 'pixel body text bright');
ok(pixel.includes('--ui-text: #11181f') || pixel.includes('--theme-text: #11181f'), 'pixel table/surface text is dark ink');
ok(nes.includes('color: #27231b') || nes.includes('--ui-text: #27231b'), 'nes text clean dark ink');
// local fonts + CJK pixel (Ark Pixel OFL) + OS fallbacks
const fontCss = path.join(root, 'assets/fonts/pixelify-sans.css');
const fontCssText = fs.readFileSync(fontCss, 'utf8');
ok(fs.existsSync(fontCss), 'local pixel font CSS exists');
ok(fs.existsSync(path.join(root, 'assets/fonts/PixelifySans-400.ttf')), 'PixelifySans-400.ttf present');
ok(fs.existsSync(path.join(root, 'assets/fonts/PixelifySans-700.ttf')), 'PixelifySans-700.ttf present');
ok(fs.existsSync(path.join(root, 'assets/fonts/ArkPixel12-zh_cn.woff2')), 'ArkPixel zh_cn woff2 present');
ok(fs.existsSync(path.join(root, 'assets/fonts/ArkPixel12-latin.woff2')), 'ArkPixel latin woff2 present');
ok(fs.existsSync(path.join(root, 'assets/fonts/OFL-ark-pixel.txt')), 'Ark Pixel OFL license present');
ok(fontCssText.includes("font-family: 'Ark Pixel'") && fontCssText.includes('ArkPixel12-zh_cn.woff2'), 'font CSS declares Ark Pixel');
ok(pixel.includes('Ark Pixel') && nes.includes('Ark Pixel'), 'pixel themes request Ark Pixel');
ok(pixel.includes('Microsoft YaHei') && pixel.includes('PingFang SC'), 'pixel has Win+mac CJK fallbacks');
ok(nes.includes('Microsoft YaHei') && nes.includes('PingFang SC'), 'nes has Win+mac CJK fallbacks');
ok(css.includes('Microsoft YaHei') && css.includes('PingFang SC'), 'retro has Win+mac CJK fallbacks');
ok(!/font-family:\s*"Ark Pixel"[^;]*monospace\s*!important/.test(pixel), 'pixel sidebar not mono-only after Ark Pixel');
ok(!/font-family:\s*"Ark Pixel"[^;]*monospace\s*!important/.test(nes), 'nes sidebar not mono-only after Ark Pixel');
ok(/\.sidebar \.nav \{[\s\S]*?font-size:\s*16px !important/.test(pixel) || pixel.includes('font-size: 16px !important'), 'pixel sidebar nav larger');
ok(/\.sidebar \.nav \{[\s\S]*?font-size:\s*16px !important/.test(nes) || nes.includes('font-size: 16px !important'), 'nes sidebar nav larger');

const rules = (css.match(/html\[data-ui-theme="retro-desktop"\]/g) || []).length;
ok(rules >= 80, `retro selector coverage ${rules}`);

if (fails.length) {
  console.error('\nFAIL');
  fails.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('\nPASS theme-retro-desktop-selftest (' + rules + ' selectors)');
