'use strict';

// Guards the mobile device pool and the identity derived from it.
//
// The pool is the only place a phone model, panel, pixel ratio, core count and GPU come from, so
// the invariants that make a phone plausible all live here: a viewport that belongs to a real
// panel, a pixel ratio Android actually ships, a core count from the same record, and a UA that
// names the sampled model. Everything is checked without launching a browser.

const assert = require('assert');
const personas = require('./mobile-personas');
const { buildFingerprint, buildInjectionScript } = require('./fingerprint');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

const android = personas.devicesForOs('android');
const ios = personas.devicesForOs('ios');
const ALL_DPR = personas.ANDROID_DPR_STEPS;
const PANELS = personas.ANDROID_PANELS;

// --- pool shape ---
ok('the pool carries a large Android set', android.length >= 1750 && android.length + ios.length === personas.POOL_SIZE);
ok('the pool carries the iOS rows for future work', ios.length >= 30);
ok('every device has a usable viewport', [...android, ...ios].every((d) => (
  Number.isInteger(d.width) && d.width >= 280 && d.width <= 700
  && Number.isInteger(d.height) && d.height > d.width && d.height <= 1400
)));
ok('every device carries a core count and a GPU', [...android, ...ios].every((d) => (
  Number.isInteger(d.cores) && d.cores >= 2 && d.cores <= 16 && String(d.gpuRenderer || '').trim().length > 0
)));
ok('every device resolves to a UA model token', [...android, ...ios].every((d) => (
  personas.sanitizeModelToken(d.model || d.name, '').length > 0
)));

// --- pixel ratio rule ---
const dprCases = [[320, 2.25], [360, 3], [393, 2.75], [412, 2.625], [480, 2.25]];
ok('the pixel ratio follows the shipped panel widths', dprCases.every(([w, want]) => (
  personas.deriveAndroidDpr(w) === want
)));
ok('every derived ratio is one Android ships', [...new Set(android.map((d) => personas.deriveAndroidDpr(d.width)))]
  .every((dpr) => ALL_DPR.includes(dpr)));
ok('every derived ratio lands on a real panel', android.every((d) => {
  const resolved = personas.resolveAndroidPanel(d.width);
  return PANELS.includes(resolved.panel) && resolved.error <= resolved.panel * 0.05;
}));

// --- persona derivation ---
const samples = [];
for (let seed = 0; seed < 200; seed += 1) samples.push(personas.mobilePersona(seed * 7919 + 13, 'android'));
ok('the user agent names the sampled model', samples.every((p) => (
  p.userAgent.includes(`Android ${p.osVersion}; ${p.model})`)
  && /Chrome\/\d+\.0\.0\.0 Mobile Safari/.test(p.userAgent)
)));
ok('the persona carries no desktop platform', samples.every((p) => (
  !/Windows NT|Macintosh|X11/.test(p.userAgent) && p.uaProfile.platform === 'Linux armv8l'
)));
ok('Client Hints describe a mobile device', samples.every((p) => (
  p.uaProfile.metadata.mobile === true
  && p.uaProfile.metadata.platform === 'Android'
  && p.uaProfile.metadata.model === p.model
  && p.uaProfile.metadata.architecture === ''
  && p.uaProfile.metadata.bitness === ''
)));
ok('the panel matches the reported screen', samples.every((p) => (
  PANELS.includes(p.panel.width)
  && Math.abs(p.screen.width * p.dpr - p.panel.width) <= p.panel.width * 0.05
)));
ok('the layout viewport is the panel minus browser chrome', samples.every((p) => (
  p.viewport.width === p.screen.width
  && p.viewport.height > 0 && p.viewport.height < p.screen.height
)));
ok('memory follows the core count of the same device', samples.every((p) => (
  (p.cores <= 4 && p.deviceMemory === 4) || (p.cores > 4 && p.deviceMemory === 8)
)));
ok('touch input is advertised', samples.every((p) => p.touch === true && p.maxTouchPoints === 5));
ok('the GPU family matches the vendor string', samples.every((p) => (
  p.gpu.family === '' ? true : p.gpu.family === personas.gpuFamily(p.gpu.vendor)
)));
ok('the android release sits inside the recorded range', samples.every((p) => {
  const bounds = String(p.osRange).split(/[^0-9]+/).filter(Boolean).map(Number);
  return bounds.length ? p.osVersion >= Math.min(...bounds) && p.osVersion <= Math.max(...bounds) : true;
}));

// --- determinism and spread ---
const a = JSON.stringify(personas.mobilePersona(4242, 'android'));
const b = JSON.stringify(personas.mobilePersona(4242, 'android'));
ok('the same seed always draws the same device', a === b);
const distinct = new Set();
for (let seed = 0; seed < 1909; seed += 1) distinct.add(personas.mobilePersona(seed, 'android').name);
ok('the pool is actually spread over the seeds', distinct.size >= 1500);

// --- runtime wiring ---
const mobile = buildFingerprint({
  id: 'mobile-selftest', kernelVersion: '148.0.7778.165', os: 'Android',
  canvas: 'noise', webgl: 'noise', privacy: {},
});
ok('an Android profile becomes a phone identity', mobile.mobile === true && Boolean(mobile.mobileDevice));
ok('the built screen is the device panel', mobile.screen.width === mobile.mobileDevice.screen.width
  && mobile.screen.height === mobile.mobileDevice.screen.height
  && mobile.screen.devicePixelRatio === mobile.mobileDevice.dpr);
ok('the built profile exposes touch points', mobile.maxTouchPoints === 5 && mobile.touch === true);
ok('the built profile stays internally consistent', mobile.consistency.ok === true,
);
const mobileScript = buildInjectionScript(mobile);
ok('the injected config carries the phone identity', /"mobile":true/.test(mobileScript)
  && /"userAgentMetadata":\{"brands"/.test(mobileScript)
  && /"model":"[^"]+"/.test(mobileScript));
ok('the injected script parses', (() => { new Function(mobileScript); return true; })());

for (const os of ['Windows', 'macOS', 'Linux']) {
  const desktop = buildFingerprint({ id: `desktop-${os}`, kernelVersion: '148.0.7778.165', os, privacy: {} });
  ok(`a ${os} profile stays a desktop identity`, desktop.mobile === false
    && desktop.mobileDevice === null
    && desktop.maxTouchPoints === 0
    && desktop.screen.width >= 640
    && !/Android/.test(desktop.userAgent));
}

console.log(`\nmobile-personas-selftest: ${passed} checks passed.`);
process.exit(0);
