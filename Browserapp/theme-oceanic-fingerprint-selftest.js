#!/usr/bin/env node
/**
 * Verify Oceanic Fingerprint theme frontend/backend wiring and CSS completeness.
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
const css = read('oceanic-fingerprint.css');

// 1. Backend & IPC & Chrome
ok(/['"]oceanic-fingerprint['"]\s*:\s*\{\s*nameKey:\s*['"]theme\.oceanic\.name['"]/.test(renderer), 'renderer UI_THEMES registers oceanic-fingerprint');
ok(/colorScheme:\s*['"]dark['"]/.test(renderer.match(/'oceanic-fingerprint':\s*\{[\s\S]*?\}/)?.[0] || ''), 'oceanic-fingerprint colorScheme is dark');
ok(main.includes("'oceanic-fingerprint': { bg: '#080e1e', overlay: '#0d172e', symbol: '#e2ebf8' }"), 'main THEME_CHROME has oceanic-fingerprint chrome');


// 1.1 Support Color Mode (Dark & Light)
ok(/['"]oceanic-fingerprint['"][\s\S]*?supportsColorMode:\s*true/.test(renderer), 'oceanic-fingerprint supportsColorMode is enabled');
ok(css.includes('html[data-ui-theme="oceanic-fingerprint"][data-color-mode="light"]'), 'oceanic-fingerprint light mode variables defined');

// 2. HTML & i18n
ok(index.includes('oceanic-fingerprint.css'), 'index loads oceanic-fingerprint.css');
ok(index.includes('data-ui-theme-option="oceanic-fingerprint"'), 'index theme picker has oceanic-fingerprint option');
ok(i18n.includes("'theme.oceanic'") && i18n.includes("'theme.oceanic.name'") && i18n.includes("'theme.oceanic.desc'"), 'i18n has theme.oceanic keys');
ok(i18n.includes('深海指纹') && i18n.includes('Oceanic Fingerprint') && i18n.includes('深海指紋'), 'i18n zh+en+ja labels present');

// 3. CSS Scope & Design Tokens
ok(css.includes('html[data-ui-theme="oceanic-fingerprint"]'), 'oceanic-fingerprint.css scopes to data-ui-theme');
ok(css.includes('--oceanic-bg') && css.includes('--oceanic-blue') && css.includes('--oceanic-border'), 'core oceanic palette variables defined');
ok(css.includes('#060b17') && css.includes('#0c172e') && css.includes('#2a69f6'), 'abyss navy and electric blue brand colors present');

// 4. Critical UI Component Coverage
ok(css.includes('.sidebar') && css.includes('.brand') && css.includes('.new-browser'), 'sidebar, brand, new-browser styled');
ok(css.includes('.nav') && css.includes('.nav.active') && css.includes('.nav-sub'), 'nav items, active state, sub-menus styled');
ok(css.includes('.table-card') && css.includes('thead th') && css.includes('tbody td'), 'table cards and row cells styled');
ok(css.includes('.primary') && css.includes('.outline') && css.includes('.danger'), 'primary, outline, danger buttons covered');
ok(css.includes('input[type="text"]') && css.includes('select') && css.includes('textarea'), 'form controls fully covered');
ok(css.includes('.status-compact') && css.includes('.status-compact.running'), 'status badge and running state covered');
ok(css.includes('.start-progress') && css.includes('.start-progress-fill'), 'startup progress bar styled');
ok(css.includes('dialog') && css.includes('.dialog-head') && css.includes('.toast'), 'dialogs, headers, and toast alerts covered');
ok(css.includes('.themed-select') && css.includes('.themed-select-button') && css.includes('.themed-select-menu'), 'custom dropdown component covered');
ok(css.includes('#view-profile-editor') && css.includes('.editor-tabs'), 'profile editor view covered');
ok(css.includes('.extension-card') && css.includes('#view-sync') && css.includes('.rpa-panel'), 'extensions, sync, rpa covered');
ok(css.includes('.log-card') && css.includes('.log-row') && css.includes('.settings-grid'), 'logs and local system settings covered');

// 5. Theme Preview Tile
ok(css.includes('.theme-option[data-ui-theme-option="oceanic-fingerprint"] > i'), 'oceanic theme option preview tile styled with fingerprint icon aesthetics');

// 6. Contrast & Safety Smoke
ok(!/background:\s*#ffffff;\s*color:\s*#ffffff/.test(css), 'no white-on-white collisions');
ok(!/background:\s*#000000;\s*color:\s*#000000/.test(css), 'no black-on-black collisions');

if (fails.length) {
  console.error('\nFAIL ' + fails.length);
  for (const f of fails) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nPASS theme-oceanic-fingerprint-selftest (' + (css.match(/html\[data-ui-theme="oceanic-fingerprint"\]/g) || []).length + ' scoped selectors verified)');
