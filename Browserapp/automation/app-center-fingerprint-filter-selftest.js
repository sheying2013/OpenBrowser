'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AppCenter, RECOMMENDED_APPS } = require('./app-center');

console.log('AppCenter fingerprint conflict filter & close-action-card selftest\n');

// 1. RECOMMENDED_APPS does not contain conflicting extensions
const excludedIds = [
  'rec-canvas-defender',
  'rec-webrtc-control',
  'rec-spoof-timezone',
  'rec-audioctx-defender',
];

for (const id of excludedIds) {
  assert.strictEqual(
    RECOMMENDED_APPS.some((app) => app.id === id),
    false,
    `RECOMMENDED_APPS must not contain ${id}`
  );
}
console.log('  PASS  conflicting anti-fingerprint extensions removed from RECOMMENDED_APPS');

// 2. Catalog size is sufficient
assert.ok(RECOMMENDED_APPS.length >= 5, 'recommended catalog must have at least 5 apps');
assert.strictEqual(RECOMMENDED_APPS.length, 20, 'catalog size matches expected after removing 4 conflicting apps');
console.log('  PASS  recommended catalog size assertion verified (count: ' + RECOMMENDED_APPS.length + ')');

// 3. AppCenter.list() does not expose excluded extensions
const fakeEngine = {
  getProfileDataRoot: () => '/tmp',
  listProfiles: () => [],
};
const appCenter = new AppCenter({ engine: fakeEngine });
const recommendedList = appCenter.list({ tab: 'recommended' });
assert.ok(Array.isArray(recommendedList.list));
for (const id of excludedIds) {
  assert.strictEqual(
    recommendedList.list.some((app) => app.id === id),
    false,
    `appCenter.list(recommended) must not contain ${id}`
  );
}
console.log('  PASS  appCenter.list({ tab: "recommended" }) verified clean');

// 4. Comment explaining architectural decision exists
const appCenterSource = fs.readFileSync(path.join(__dirname, 'app-center.js'), 'utf8');
assert.ok(
  appCenterSource.includes('排除防指纹类扩展') || appCenterSource.includes('唯一权威来源'),
  'app-center.js must document the rationale for excluding anti-fingerprint extensions'
);
console.log('  PASS  app-center.js documentation comments verified');

// 5. Verify renderer.js hides close-action-card on darwin
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
assert.ok(
  rendererSource.includes("info?.platform === 'darwin'"),
  "renderer.js must check info?.platform === 'darwin' for closeActionCard"
);
assert.ok(
  rendererSource.includes("closeActionCard.hidden = true"),
  "renderer.js must set closeActionCard.hidden = true on darwin"
);
console.log('  PASS  renderer.js closeActionCard darwin platform check verified');

console.log('\nAll app-center & close-action-card selftests passed.');
