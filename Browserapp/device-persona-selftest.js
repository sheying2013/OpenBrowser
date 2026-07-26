'use strict';

// Coherent device personas — and, just as importantly, proof that turning them on did not
// disturb anybody's existing fingerprint.
//
// Hardware axes drawn independently can describe machines that do not exist (4 cores with
// 32 GB, a non-Retina Mac, a laptop carrying a workstation GPU). Detectors score the whole
// combination, so an impossible pairing gives more away than any single spoofed value.
//
// Personas are opt-in precisely because a fingerprint is an identity: silently re-rolling the
// hardware of a profile that already has accounts signed in on it is its own hazard. The
// golden values below are captured from the pre-persona build, so a regression here means an
// existing profile's fingerprint moved — which must never happen without opting in.

const assert = require('assert');
const { buildFingerprint } = require('./automation/fingerprint');
const { PERSONAS_BY_OS, pickPersona, isCoherent, personasForOs } = require('./automation/device-personas');

// Captured from the build before personas existed. Any drift here means an existing
// profile's fingerprint moved without opting in.
const GOLDEN = {
  "legacy-a": {
    "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "platform": "Linux x86_64",
    "hardwareConcurrency": 8,
    "deviceMemory": 8,
    "screen": {
      "width": 1280,
      "height": 820,
      "availWidth": 1280,
      "availHeight": 780,
      "availLeft": 0,
      "availTop": 0,
      "screenX": 0,
      "screenY": 0,
      "colorDepth": 24,
      "pixelDepth": 24,
      "devicePixelRatio": 1
    },
    "webglVendor": "Google Inc. (NVIDIA)",
    "webglRenderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.6)",
    "languages": [
      "en-US"
    ],
    "seed": "655c53155857aae2"
  },
  "legacy-b": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "platform": "Win32",
    "hardwareConcurrency": 6,
    "deviceMemory": 8,
    "screen": {
      "width": 1280,
      "height": 820,
      "availWidth": 1280,
      "availHeight": 780,
      "availLeft": 0,
      "availTop": 0,
      "screenX": 0,
      "screenY": 0,
      "colorDepth": 24,
      "pixelDepth": 24,
      "devicePixelRatio": 1
    },
    "webglVendor": "Google Inc. (NVIDIA)",
    "webglRenderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "languages": [
      "en-US"
    ],
    "seed": "a9b8e4570504b1b3"
  },
  "legacy-c": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "platform": "Win32",
    "hardwareConcurrency": 12,
    "deviceMemory": 8,
    "screen": {
      "width": 1280,
      "height": 820,
      "availWidth": 1280,
      "availHeight": 780,
      "availLeft": 0,
      "availTop": 0,
      "screenX": 0,
      "screenY": 0,
      "colorDepth": 30,
      "pixelDepth": 30,
      "devicePixelRatio": 1
    },
    "webglVendor": "Google Inc. (NVIDIA)",
    "webglRenderer": "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "languages": [
      "en-US"
    ],
    "seed": "7a8c56e4a3295772"
  },
  "win-user": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "platform": "Win32",
    "hardwareConcurrency": 6,
    "deviceMemory": 8,
    "screen": {
      "width": 1280,
      "height": 820,
      "availWidth": 1280,
      "availHeight": 780,
      "availLeft": 0,
      "availTop": 0,
      "screenX": 0,
      "screenY": 0,
      "colorDepth": 24,
      "pixelDepth": 24,
      "devicePixelRatio": 2
    },
    "webglVendor": "Google Inc. (AMD)",
    "webglRenderer": "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "languages": [
      "en-US"
    ],
    "seed": "a56d1b6fe308960e"
  },
  "mac-user": {
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "platform": "MacIntel",
    "hardwareConcurrency": 4,
    "deviceMemory": 16,
    "screen": {
      "width": 1280,
      "height": 820,
      "availWidth": 1280,
      "availHeight": 795,
      "availLeft": 0,
      "availTop": 0,
      "screenX": 0,
      "screenY": 0,
      "colorDepth": 30,
      "pixelDepth": 30,
      "devicePixelRatio": 1.5
    },
    "webglVendor": "Google Inc. (Apple)",
    "webglRenderer": "ANGLE (Apple, Apple M2, OpenGL 4.1)",
    "languages": [
      "en-US"
    ],
    "seed": "5187a2af003d3f3b"
  }
};

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const base = (id, extra = {}) => ({ id, privacy: {}, advanced: {}, ...extra });
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- 1. every shipped persona is internally coherent ---
{
  let all = 0; let bad = [];
  for (const [os, pool] of Object.entries(PERSONAS_BY_OS)) {
    for (const persona of pool) {
      all += 1;
      if (!isCoherent(persona)) bad.push(`${os}: ${persona.webgl.renderer}`);
    }
  }
  ok(`all shipped personas are coherent (${all} checked)`, bad.length === 0);
  if (bad.length) bad.forEach((b) => console.log('     x ' + b));
}

// --- 2. existing profiles are untouched (golden fixture from the pre-persona build) ---
{
  const cases = {
    'legacy-a': {}, 'legacy-b': {}, 'legacy-c': {},
    'win-user': { userAgent: WIN_UA },
    'mac-user': { userAgent: MAC_UA },
  };
  let drifted = [];
  for (const [id, extra] of Object.entries(cases)) {
    const fp = buildFingerprint(base(id, extra));
    const expected = GOLDEN[id];
    const actual = {
      userAgent: fp.userAgent, platform: fp.platform,
      hardwareConcurrency: fp.hardwareConcurrency, deviceMemory: fp.deviceMemory,
      screen: fp.screen, webglVendor: fp.webgl && fp.webgl.vendor, webglRenderer: fp.webgl && fp.webgl.renderer,
      languages: fp.languages, seed: fp.seed,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) drifted.push(id);
  }
  ok('profiles without the opt-in keep their exact pre-persona fingerprint', drifted.length === 0);
  if (drifted.length) console.log('     drifted: ' + drifted.join(', '));
}

// --- 3. opting in yields a coherent, real-world combination ---
{
  const fp = buildFingerprint(base('persona-win', { userAgent: WIN_UA, privacy: { deviceProfile: 'persona' } }));
  const combo = {
    os: 'windows',
    cores: fp.hardwareConcurrency, memory: fp.deviceMemory,
    colorDepth: fp.screen.colorDepth, devicePixelRatio: fp.screen.devicePixelRatio,
    screen: { width: fp.screen.width, height: fp.screen.height },
    webgl: { vendor: fp.webgl.vendor, renderer: fp.webgl.renderer },
  };
  ok('opted-in Windows profile reports a coherent machine', isCoherent(combo));
  ok('opted-in Windows profile uses a Direct3D GPU string', /D3D11/.test(fp.webgl.renderer));

  const mac = buildFingerprint(base('persona-mac', { userAgent: MAC_UA, privacy: { deviceProfile: 'persona' } }));
  ok('opted-in macOS profile uses a Metal GPU string', /Metal/.test(mac.webgl.renderer));
  ok('opted-in macOS profile is Retina (dpr >= 2)', mac.screen.devicePixelRatio >= 2);
}

// --- 4. impossible pairings the old independent sampling could produce are gone ---
{
  let impossible = [];
  for (let i = 0; i < 200; i += 1) {
    const fp = buildFingerprint(base('persona-scan-' + i, { userAgent: WIN_UA, privacy: { deviceProfile: 'persona' } }));
    const cores = fp.hardwareConcurrency; const memory = fp.deviceMemory;
    if (cores <= 4 && memory > 16) impossible.push(`${cores}c/${memory}g`);
    if (cores >= 12 && memory < 8) impossible.push(`${cores}c/${memory}g`);
  }
  ok('200 opted-in profiles produce no impossible cpu/memory pairing', impossible.length === 0);
  if (impossible.length) console.log('     e.g. ' + impossible.slice(0, 5).join(', '));
}

// --- 5. a persona is stable for a profile and varies across profiles ---
{
  const a1 = buildFingerprint(base('stable-1', { userAgent: WIN_UA, privacy: { deviceProfile: 'persona' } }));
  const a2 = buildFingerprint(base('stable-1', { userAgent: WIN_UA, privacy: { deviceProfile: 'persona' } }));
  ok('same profile gets the same persona across builds', a1.webgl.renderer === a2.webgl.renderer && a1.hardwareConcurrency === a2.hardwareConcurrency);

  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const fp = buildFingerprint(base('spread-' + i, { userAgent: WIN_UA, privacy: { deviceProfile: 'persona' } }));
    seen.add(fp.webgl.renderer + '|' + fp.hardwareConcurrency);
  }
  ok(`personas spread across profiles (${seen.size} distinct of ${personasForOs('windows').length} available)`, seen.size > 1);
}

// --- 6. explicit user overrides still win over the persona ---
{
  const fp = buildFingerprint(base('override', {
    userAgent: WIN_UA,
    privacy: { deviceProfile: 'persona', fingerprint: { cores: 24, memory: 64 } },
  }));
  ok('explicit cores override beats the persona', fp.hardwareConcurrency === 24);
  ok('explicit memory override beats the persona', fp.deviceMemory === 64);
}

// --- 7. pickPersona is deterministic and bounded ---
{
  ok('pickPersona is stable for the same index', pickPersona('windows', 7) === pickPersona('windows', 7));
  ok('pickPersona wraps out-of-range indexes', Boolean(pickPersona('windows', 999999)));
  ok('unknown OS still yields a persona', Boolean(pickPersona('plan9', 3)));
}

console.log(`\ndevice-persona-selftest: ${passed} checks passed.`);
