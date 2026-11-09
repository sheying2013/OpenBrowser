'use strict';

/** Regression checks for profile table layout and dynamic action icons. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const { backgroundNetworkFlagsForProfile } = require('../engine');
const { buildFingerprint } = require('./fingerprint');

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

check('Merge Gateway keeps the selected profile-editor segmented option legible', () => {
  const css = read('xai-console.css');
  const rule = 'html[data-ui-theme="merge-gateway"] #view-profile-editor .editor-form .segmented label:has(input:checked)';
  const ruleIndex = css.lastIndexOf(rule);
  assert.notStrictEqual(ruleIndex, -1, 'selected segmented labels need an editor-specific override');
  const bodyStart = css.indexOf('{', ruleIndex);
  const bodyEnd = css.indexOf('}', bodyStart);
  const body = css.slice(bodyStart + 1, bodyEnd);
  assert.match(body, /color:\s*var\(--xai-inverse\)/,
    'selected label text must contrast with the ink-console background');
  assert.ok(ruleIndex > css.lastIndexOf('#view-profile-editor .editor-form label:not(.check-row)'),
    'the segmented override must follow the broader editor label color rule');
  assert.match(css, /#view-profile-editor \.editor-form \.segmented input\[type="radio"\][\s\S]*?accent-color:\s*var\(--xai-ink-console\)/,
    'the selected radio control should use the theme accent color');
});

check('Merge Gateway resets checkbox geometry inside editor check rows', () => {
  const css = read('xai-console.css');
  assert.match(css, /#view-profile-editor \.editor-form \.check-row input\[type="checkbox"\][\s\S]*?padding:\s*0;/,
    'editor checkboxes must not inherit text-input padding');
});


check('X push notifications retain Chromium background networking when allowed', () => {
  const allowed = backgroundNetworkFlagsForProfile({ advanced: { blockNotifications: false } });
  assert.ok(!allowed.includes('--disable-background-networking'),
    'allowing site notifications must not disable Chromium background networking');
  assert.ok(allowed.includes('--disable-component-update'),
    'notification support must retain unrelated background/update reducers');

  const blocked = backgroundNetworkFlagsForProfile({ advanced: { blockNotifications: true } });
  assert.ok(blocked.includes('--disable-background-networking'),
    'the explicit block-notifications setting keeps the background network disabled');

  const legacy = backgroundNetworkFlagsForProfile({ advanced: {} });
  assert.ok(legacy.includes('--disable-background-networking'),
    'legacy profiles without a notification preference keep the previous default');
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

check('custom userAgent validates Chrome major version against kernelMajor and emits ua-kernel-version-mismatch', () => {
  const fpSource = read('automation/fingerprint.js');
  assert.match(fpSource, /ua-kernel-version-mismatch/, 'fingerprint.js must emit ua-kernel-version-mismatch');
  assert.match(fpSource, /kernelMajor/, 'fingerprint.js must compare against kernelMajor');
  assert.match(fpSource, /uaMajor/, 'fingerprint.js must extract uaMajor from uaOverride');

  const events = [];
  const mockEngine = { emit: (ev) => events.push(ev) };
  const customUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Mismatch: UA major 120 vs kernel major 148
  const fpMismatch = buildFingerprint({
    id: 'profile-mismatch-test',
    userAgent: customUa,
    kernelVersion: '148.0.7777.0',
    engine: mockEngine,
  });
  // Must respect user UA
  assert.strictEqual(fpMismatch.userAgent, customUa, 'user UA must be respected even when versions differ');
  assert.strictEqual(events.length, 1, 'must emit mismatch event when UA version differs from kernel');
  assert.strictEqual(events[0].type, 'ua-kernel-version-mismatch');
  assert.strictEqual(events[0].uaMajor, 120);
  assert.strictEqual(events[0].kernelMajor, 148);
  assert.strictEqual(events[0].id, 'profile-mismatch-test');

  // Match: UA major 148 vs kernel major 148
  events.length = 0;
  const matchUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  const fpMatch = buildFingerprint({
    id: 'profile-match-test',
    userAgent: matchUa,
    kernelVersion: '148.0.7777.0',
    engine: mockEngine,
  });
  assert.strictEqual(fpMatch.userAgent, matchUa);
  assert.strictEqual(events.length, 0, 'no mismatch event when UA version matches kernel');
});

check('virtual scroll measures container before clearing table and supports >25 rows cleanly', () => {
  const renderer = read('renderer.js');
  const renderIdx = renderer.indexOf('function renderProfiles()');
  const tail = renderer.slice(renderIdx, renderIdx + 2500);
  const measureIdx = tail.indexOf('const rawClientHeight = card?.clientHeight || 0');
  const scrollSaveIdx = tail.indexOf('const savedScrollTop = card ? card.scrollTop : 0');
  const clearIdx = tail.indexOf('table.replaceChildren()');
  assert.ok(measureIdx > 0 && scrollSaveIdx > 0 && clearIdx > measureIdx, 'renderProfiles must measure card.clientHeight and scrollTop before table.replaceChildren()');
  assert.match(renderer, /let measuredProfileRowHeight = 56;/, 'default virtual row height must be 56px');

  const profileList = require('../ui/ui-profile-list');
  const r0 = profileList.calculateVirtualRange({ total: 50, scrollTop: 0, viewportHeight: 600, rowHeight: 56, overscan: 5 });
  assert.strictEqual(r0.startIndex, 0);
  assert.ok(r0.endIndex >= 16, 'must render visible rows + overscan on initial load');
  const rBottom = profileList.calculateVirtualRange({ total: 50, scrollTop: 2200, viewportHeight: 600, rowHeight: 56, overscan: 5 });
  assert.strictEqual(rBottom.endIndex, 50, 'scrolling to bottom must reach row 50 without gap');
});

check('localStorage quota guard and SQLite authoritative merge preserve forceDeviceScaleFactor', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /profiles:\s*hasRealBackend\s*\?\s*\[\]\s*:/, 'save() must omit ui.profiles when real backend is active');
  assert.match(renderer, /\.\.\.remote,\s*\n\s*proxyId:/, 'initialize() must use remote as authoritative base');
  assert.match(renderer, /forceDeviceScaleFactor:/, 'normalizeProfileSettings & editorDraft must preserve privacy.forceDeviceScaleFactor');
  assert.match(renderer, /invalidateAndRefreshProfiles\(/, 'renderer must expose invalidateAndRefreshProfiles helper');
});

check('ACTION_ICON_SVGS defines bot icon and CookieRobot uses canonical events + Number.isFinite', () => {
  const renderer = read('renderer.js');
  const html = read('index.html');
  assert.match(renderer, /bot:\s*'<path d="M12 8V4H8"/, 'ACTION_ICON_SVGS must define bot icon');
  assert.doesNotMatch(renderer, /['"]cookie-robot-(started|progress|finished|failed)['"]/, 'CookieRobot must only subscribe to canonical robot-* events');
  assert.match(renderer, /robot-disconnected/, 'CookieRobot must handle robot-disconnected');
  assert.match(renderer, /Number\.isFinite\(n\)/, 'CookieRobot numeric parsing must use Number.isFinite so 0 is preserved');
  assert.match(renderer, /ua-kernel-version-mismatch/, 'renderer must listen for ua-kernel-version-mismatch');
  assert.match(renderer, /local-api-status-endpoint/, 'renderer must update #local-api-status-endpoint');
  assert.doesNotMatch(html, /id="editor-ua-chrome-major"[^>]*value="131"/, '#editor-ua-chrome-major must not hardcode value="131"');
  assert.doesNotMatch(html, /id="cookie-robot-status-box"[^>]*rgba\(0,0,0,0\.03\)/, 'cookie-robot-status-box must not hardcode black background');
});

check('all 12 i18n languages define every data-i18n key in index.html', () => {
  global.localStorage = { getItem: () => null, setItem: () => {} };
  const I = require('../i18n.js');
  const html = read('index.html');
  const keys = [...html.matchAll(/(?:data-i18n|data-i18n-placeholder|data-i18n-title|data-i18n-aria)="([^"]+)"/g)].map((m) => m[1]);
  const langs = ['en', 'zh-CN', 'ja', 'vi', 'fr', 'de', 'th', 'id', 'ko', 'ru', 'es', 'pt'];
  for (const lang of langs) {
    I.setPreference(lang, { persist: false, silent: true });
    for (const k of keys) {
      const val = I.t(k);
      assert.notStrictEqual(val, k, `Missing i18n key "${k}" in language "${lang}"`);
    }
  }
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
