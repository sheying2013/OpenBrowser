#!/usr/bin/env node
/**
 * Verify Oceanic Fingerprint theme frontend/backend wiring and CSS completeness.
 *
 * Static contracts only (no browser): chrome colors come from main.js via vm, compared to CSS tokens.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else console.log('ok  ' + msg); };

const renderer = read('renderer.js');
const main = read('main.js');
const index = read('index.html');
const i18n = read('i18n.js');
const css = read('oceanic-fingerprint.css');

// --- Evaluate the real chrome table + resolver from main.js source ----------
const chromeStart = main.indexOf('const THEME_CHROME = {');
const chromeEnd = main.indexOf('function applyWindowChrome');
ok(chromeStart >= 0 && chromeEnd > chromeStart, 'main.js exposes THEME_CHROME + chromeForTheme source');
let THEME_CHROME = {};
let chromeForTheme = () => ({});
if (chromeStart >= 0 && chromeEnd > chromeStart) {
  const src = main.slice(chromeStart, chromeEnd) +
    '\n;({ THEME_CHROME, chromeForTheme })';
  ({ THEME_CHROME, chromeForTheme } = vm.runInNewContext(src, {}, { timeout: 2000 }));
}

// --- Extract the theme's own token blocks (dark root / light override) ------
const cssBlock = (selector) => {
  const i = css.indexOf(selector + ' {');
  if (i < 0) return '';
  const j = css.indexOf('\n}', i);
  return j > i ? css.slice(i, j) : '';
};
const token = (block, name) => (new RegExp('--' + name + '\\s*:\\s*([^;]+);').exec(block)?.[1] || '').trim().toLowerCase();
const darkBlock = cssBlock('html[data-ui-theme="oceanic-fingerprint"]');
const lightBlock = cssBlock('html[data-ui-theme="oceanic-fingerprint"][data-color-mode="light"]');
ok(!!darkBlock && !!lightBlock, 'oceanic-fingerprint dark and light token blocks are present');

// 1. Backend & IPC & Chrome
ok(/['"]oceanic-fingerprint['"]\s*:\s*\{\s*nameKey:\s*['"]theme\.oceanic\.name['"]/.test(renderer), 'renderer UI_THEMES registers oceanic-fingerprint');
ok(/colorScheme:\s*['"]dark['"]/.test(renderer.match(/'oceanic-fingerprint':\s*\{[\s\S]*?\}/)?.[0] || ''), 'oceanic-fingerprint colorScheme is dark');

// 1.1 Fused title bar chrome must match the CSS tokens it visually belongs to.
const darkChrome = THEME_CHROME['oceanic-fingerprint'] || {};
const lightChrome = chromeForTheme('oceanic-fingerprint', 'light');
ok(darkChrome.bg === token(darkBlock, 'ink-abyss') && darkChrome.bg === '#0d1518', 'dark chrome bg equals CSS --ink-abyss (dark)');
ok(darkChrome.overlay === token(darkBlock, 'ink-abyss'), 'dark chrome overlay equals CSS --ink-abyss (dark)');
ok(darkChrome.symbol === token(darkBlock, 'ink-text-primary'), 'dark chrome symbol equals CSS --ink-text-primary (dark)');
ok(lightChrome && lightChrome.bg === token(lightBlock, 'ink-abyss') && lightChrome.bg === '#eef2f1', 'light chrome bg equals CSS --ink-abyss (light)');
ok(lightChrome && lightChrome.overlay === token(lightBlock, 'ink-abyss'), 'light chrome overlay equals CSS --ink-abyss (light)');
ok(lightChrome && lightChrome.symbol === token(lightBlock, 'ink-text-primary'), 'light chrome symbol equals CSS --ink-text-primary (light)');
ok(chromeForTheme('oceanic-fingerprint', 'dark').bg === darkChrome.bg, 'chromeForTheme dark resolves the dark oceanic chrome');
ok(chromeForTheme('nonexistent-theme').bg === THEME_CHROME.default.bg, 'chromeForTheme falls back to default chrome');

// 1.2 Support Color Mode (Dark & Light)
ok(/['"]oceanic-fingerprint['"][\s\S]*?supportsColorMode:\s*true/.test(renderer), 'oceanic-fingerprint supportsColorMode is enabled');
ok(!!lightBlock, 'oceanic-fingerprint light mode variables defined');
ok(/color-scheme\s*:\s*dark/.test(darkBlock), 'dark root declares color-scheme: dark');
ok(/color-scheme\s*:\s*light/.test(lightBlock), 'light root declares color-scheme: light');

// 2. HTML & i18n
ok(index.includes('oceanic-fingerprint.css'), 'index loads oceanic-fingerprint.css');
ok(index.includes('data-ui-theme-option="oceanic-fingerprint"'), 'index theme picker has oceanic-fingerprint option');
ok(i18n.includes("'theme.oceanic'") && i18n.includes("'theme.oceanic.name'") && i18n.includes("'theme.oceanic.desc'"), 'i18n has theme.oceanic keys');
ok(i18n.includes('深海指纹') && i18n.includes('Oceanic Fingerprint') && i18n.includes('深海指紋'), 'i18n zh+en+ja labels present');

// 3. CSS Scope & Design Tokens
ok(css.includes('html[data-ui-theme="oceanic-fingerprint"]'), 'oceanic-fingerprint.css scopes to data-ui-theme');
ok(css.includes('--oceanic-bg') && css.includes('--oceanic-blue') && css.includes('--oceanic-border'), 'core oceanic palette variables defined');

// Both modes must define the same complete palette, with mode-distinct values.
const paletteTokens = [
  'ink-abyss', 'ink-surface-1', 'ink-surface-2', 'ink-surface-3',
  'ink-border-subtle', 'ink-border-default', 'ink-border-focus',
  'ink-cyan-primary', 'ink-cyan-hover', 'ink-cyan-active',
  'ink-text-primary', 'ink-text-secondary', 'ink-text-muted',
  'ink-status-online', 'ink-status-danger', 'ink-status-warning',
];
const missingDark = paletteTokens.filter((t) => !token(darkBlock, t));
const missingLight = paletteTokens.filter((t) => !token(lightBlock, t));
ok(!missingDark.length && !missingLight.length,
  'palette tokens complete in dark and light' + (missingDark.length || missingLight.length ? ' (missing: ' + [...new Set([...missingDark, ...missingLight])].join(', ') + ')' : ''));
const sameValue = paletteTokens.filter((t) => token(darkBlock, t) && token(darkBlock, t) === token(lightBlock, t));
ok(paletteTokens.length > 0 && sameValue.length === 0, 'dark and light palette values differ per mode');

// 4. Critical UI Component Coverage
ok(css.includes('.sidebar') && css.includes('.brand') && css.includes('.new-browser'), 'sidebar, brand, new-browser styled');
ok(css.includes('.nav') && css.includes('.nav.active') && css.includes('.nav-sub'), 'nav items, active state, sub-menus styled');
ok(css.includes('.table-card') && css.includes('thead th') && css.includes('tbody td'), 'table cards and row cells styled');
ok(css.includes('.primary') && css.includes('.outline') && css.includes('.danger'), 'primary, outline, danger buttons covered');

// Form contract: bare `input:where(:not(...))` must cover implicit and text-like types.
const inputExclusion = /input:where\(:not\(([^)]*)\)\)/.exec(css);
const exclusions = inputExclusion?.[1] || '';
const bareInputCovered = /[^\w-]input:where\(:not\(/.test(css) && !/input\[type=/.test(inputExclusion?.[0] || 'input:where');
const mustCoverTypes = ['text', 'search', 'url', 'email', 'password', 'number', 'tel', 'date', 'datetime-local', 'month', 'time', 'week'];
const wronglyExcluded = mustCoverTypes.filter((t) => new RegExp('type=["\']' + t + '["\']').test(exclusions));
ok(!!inputExclusion && bareInputCovered,
  'form contract covers bare input (implicit type), not only input[type="text"]');
ok(!!inputExclusion && wronglyExcluded.length === 0,
  'form contract does not exclude url/number/email/text-like input types' + (wronglyExcluded.length ? ' (excluded: ' + wronglyExcluded.join(', ') + ')' : ''));
ok(css.includes('textarea') && /select(?![-\w])/.test(css), 'textarea and select covered by form rules');

ok(css.includes('.status-compact') && css.includes('.status-compact.running'), 'status badge and running state covered');
ok(css.includes('.start-progress') && css.includes('.start-progress-fill'), 'startup progress bar styled');
ok(css.includes('dialog') && css.includes('.dialog-head') && css.includes('.toast'), 'dialogs, headers, and toast alerts covered');
ok(css.includes('.themed-select') && css.includes('.themed-select-button') && css.includes('.themed-select-menu'), 'custom dropdown component covered');
ok(css.includes('#view-profile-editor') && css.includes('.editor-tabs'), 'profile editor view covered');
ok(css.includes('.extension-card') && css.includes('#view-sync') && css.includes('.rpa-panel'), 'extensions, sync, rpa covered');
ok(css.includes('.log-card') && css.includes('.log-row') && css.includes('.settings-grid'), 'logs and local system settings covered');

// 5. Theme Preview Tile
ok(css.includes('.theme-option[data-ui-theme-option="oceanic-fingerprint"] > i'), 'oceanic theme option preview tile styled with fingerprint icon aesthetics');

// 6. pre/code rule must not drag in console/sync-command UI selectors.
const rules = [];
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(css))) rules.push({ selector: m[1].trim(), body: m[2] });
const codeRules = rules.filter((r) => r.body.includes('--theme-code-bg'));
ok(codeRules.length > 0, 'a pre/code rule uses --theme-code-bg');
const leaked = codeRules.filter((r) => /\.(console|sync-command|log-[\w-]+)\b/.test(r.selector));
ok(codeRules.length > 0 && leaked.length === 0,
  'console/sync-command not grouped into pre/code rule' + (leaked.length ? ' (leaked: ' + leaked.map((r) => r.selector).join(' | ') + ')' : ''));
const targets = (sel) => sel.split(',').map((s) => s.trim().split(/\s+/).pop()).filter(Boolean);
ok(codeRules.some((r) => targets(r.selector).includes('pre') && targets(r.selector).includes('code')),
  'pre and code remain the shared code-surface selectors');

// 7. Contrast & Safety Smoke
ok(!/background:\s*#ffffff;\s*color:\s*#ffffff/.test(css), 'no white-on-white collisions');
ok(!/background:\s*#000000;\s*color:\s*#000000/.test(css), 'no black-on-black collisions');

if (fails.length) {
  console.error('\nFAIL ' + fails.length);
  for (const f of fails) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nPASS theme-oceanic-fingerprint-selftest (static contracts)');
