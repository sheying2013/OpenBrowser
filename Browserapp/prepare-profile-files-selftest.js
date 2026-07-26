'use strict';

// Race-safety test for BrowserEngine.prepareProfileFilesForStart (parallelized pre-spawn
// prep). resetZoom + applyProfilePreferences both read-modify-write Default/Preferences and
// are kept in a serialized sub-chain; the rm jobs run in parallel. This drives the real
// method against temp profiles x60 and asserts BOTH Preferences writers survive (no lost
// update) and every rm job ran. prepareProfileFilesForStart's callees use no other `this`,
// so a minimal stub bound to the prototype methods exercises the real code.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { BrowserEngine } = require('./engine.js');

const proto = BrowserEngine.prototype;
const eng = {
  resetZoom: proto.resetZoom, applyProfilePreferences: proto.applyProfilePreferences,
  enforceDataRetention: proto.enforceDataRetention, resetTabs: proto.resetTabs,
  clearProfileCache: proto.clearProfileCache, prepareProfileFilesForStart: proto.prepareProfileFilesForStart,
};
const profile = {
  language: 'ja-JP',
  advanced: { clearCacheOnStart: true, saveCookies: false, savePasswords: true, saveBookmarks: true,
    saveLocalStorage: true, saveIndexedDB: true, saveHistory: true, allowSignin: false, showBookmarkBar: false },
  privacy: { media: 'allow', geoMode: 'allow', fontMode: 'default' },
};

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); passed++; };

async function oneRun(i) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'prep-'));
  const def = path.join(root, 'Default');
  await fsp.mkdir(path.join(def, 'Network'), { recursive: true });
  await fsp.mkdir(path.join(def, 'Sessions'), { recursive: true });
  await fsp.mkdir(path.join(def, 'Cache'), { recursive: true });
  // Seed Preferences with values BOTH resetZoom and applyProfilePreferences must change.
  await fsp.writeFile(path.join(def, 'Preferences'), JSON.stringify({
    partition: { per_host_zoom_levels: { 'http://x': 2 } },
    browser: { default_zoom_level: 5 },
    profile: { exit_type: 'Crashed', exited_cleanly: false },
  }));
  await fsp.writeFile(path.join(def, 'Network', 'Cookies'), 'x');

  await eng.prepareProfileFilesForStart(root, profile, false);

  const prefs = JSON.parse(await fsp.readFile(path.join(def, 'Preferences'), 'utf8'));
  // resetZoom landed:
  const zoomOk = Object.keys(prefs.partition.per_host_zoom_levels).length === 0 && prefs.browser.default_zoom_level === 0;
  // applyProfilePreferences landed (NOT clobbered by resetZoom's write):
  const prefOk = prefs.profile.exit_type === 'Normal' && prefs.profile.exited_cleanly === true
    && prefs.intl && prefs.intl.accept_languages === 'ja-JP,ja';
  // rm jobs ran:
  const tabsGone = !fs.existsSync(path.join(def, 'Sessions'));
  const cacheGone = !fs.existsSync(path.join(def, 'Cache'));
  const cookieGone = !fs.existsSync(path.join(def, 'Network', 'Cookies'));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  return { zoomOk, prefOk, tabsGone, cacheGone, cookieGone };
}

(async () => {
  const N = 60;
  let allZoom = true, allPref = true, allTabs = true, allCache = true, allCookie = true;
  for (let i = 0; i < N; i++) {
    const r = await oneRun(i);
    allZoom &&= r.zoomOk; allPref &&= r.prefOk; allTabs &&= r.tabsGone; allCache &&= r.cacheGone; allCookie &&= r.cookieGone;
  }
  ok(`[x${N}] resetZoom changes survive`, allZoom);
  ok(`[x${N}] applyProfilePreferences changes survive (NO lost update)`, allPref);
  ok(`[x${N}] resetTabs removed Sessions`, allTabs);
  ok(`[x${N}] clearProfileCache removed Cache`, allCache);
  ok(`[x${N}] enforceDataRetention removed Cookies`, allCookie);
  console.log(`  PASS  all ${N} parallel runs kept both Preferences writers + did all rm's`);
  console.log(`\nprepare-profile-files test: ${passed} checks passed (x${N} iterations).`);
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
