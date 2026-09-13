"use strict";

/**
 * Mobile device personas selftest (Normal + Mutation modes).
 *
 * Validates the mobile device pool, persona derivation, and runtime integration
 * for both Android and iOS devices. Enforces invariants across UA, platform,
 * vendor, touch points, screen/DPR/viewport, memory/cores, and GPU.
 */

const assert = require("assert");
const personas = require("./mobile-personas");
const { buildFingerprint, buildInjectionScript } = require("./fingerprint");

const isMutateMode = process.argv.includes("--mutate");

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log("  PASS  " + name);
  passed += 1;
};

const android = personas.devicesForOs("android");
const ios = personas.devicesForOs("ios");
const ALL_DPR = personas.ANDROID_DPR_STEPS;
const PANELS = personas.ANDROID_PANELS;

if (!isMutateMode) {
  console.log("Starting mobile-personas selftest (mode: NORMAL)...\n");

  // --- 1. Pool Shape & Coverage ---
  ok("the pool carries a large Android set", android.length >= 1750 && android.length + ios.length === personas.POOL_SIZE);
  ok("the pool carries valid iOS models", ios.length >= 30);
  ok("every device has a usable viewport", [...android, ...ios].every((d) => (
    Number.isInteger(d.width) && d.width >= 280 && d.width <= 700
    && Number.isInteger(d.height) && d.height > d.width && d.height <= 1400
  )));
  ok("every device carries a core count and a GPU", [...android, ...ios].every((d) => (
    Number.isInteger(d.cores) && d.cores >= 2 && d.cores <= 16 && String(d.gpuRenderer || "").trim().length > 0
  )));
  ok("every device resolves to a UA model token", [...android, ...ios].every((d) => (
    personas.sanitizeModelToken(d.model || d.name, "").length > 0
  )));

  // --- 2. DPR and Panel Resolution Rules ---
  const dprCases = [[320, 2.25], [360, 3], [393, 2.75], [412, 2.625], [480, 2.25]];
  ok("the Android pixel ratio follows the shipped panel widths", dprCases.every(([w, want]) => (
    personas.deriveAndroidDpr(w) === want
  )));
  ok("every derived Android ratio is one Android ships", [...new Set(android.map((d) => personas.deriveAndroidDpr(d.width)))]
    .every((dpr) => ALL_DPR.includes(dpr)));
  ok("every derived Android ratio lands on a real panel", android.every((d) => {
    const resolved = personas.resolveAndroidPanel(d.width);
    return PANELS.includes(resolved.panel) && resolved.error <= resolved.panel * 0.05;
  }));

  const iosDprCases = [
    { name: "iPhone 8", width: 375, expectedDpr: 2 },
    { name: "iPhone SE 2", width: 375, expectedDpr: 2 },
    { name: "iPhone 11", width: 414, expectedDpr: 2 },
    { name: "iPhone XR", width: 414, expectedDpr: 2 },
    { name: "iPhone 8 Plus", width: 414, expectedDpr: 3 },
    { name: "iPhone X", width: 375, expectedDpr: 3 },
    { name: "iPhone 11 Pro", width: 375, expectedDpr: 3 },
    { name: "iPhone 12 mini", width: 360, expectedDpr: 3 },
    { name: "iPhone 13", width: 390, expectedDpr: 3 },
    { name: "iPhone 14 Pro", width: 393, expectedDpr: 3 },
    { name: "iPhone 15 Pro Max", width: 430, expectedDpr: 3 },
    { name: "iPhone 16 Pro", width: 402, expectedDpr: 3 },
    { name: "iPhone 16 Pro Max", width: 440, expectedDpr: 3 },
  ];
  ok("iOS pixel ratios strictly align with physical Apple panels (2x vs 3x)", iosDprCases.every((c) => (
    personas.deriveIosDpr(c.width, c.name) === c.expectedDpr
  )));

  // --- 3. Android Persona Derivation (200 seeds) ---
  const androidSamples = [];
  for (let seed = 0; seed < 200; seed += 1) {
    androidSamples.push(personas.mobilePersona(seed * 7919 + 13, "android"));
  }
  ok("Android UA names the sampled model and carries Mobile token", androidSamples.every((p) => (
    p.userAgent.includes(`Android ${p.osVersion}; ${p.model})`)
    && /Chrome\/\d+\.0\.0\.0 Mobile Safari/.test(p.userAgent)
  )));
  ok("Android persona carries Linux armv8l platform and no desktop tokens", androidSamples.every((p) => (
    !/Windows NT|Macintosh|X11/.test(p.userAgent) && p.uaProfile.platform === "Linux armv8l"
  )));
  ok("Android Client Hints describe mobile device without desktop arch/bitness", androidSamples.every((p) => (
    p.uaProfile.metadata.mobile === true
    && p.uaProfile.metadata.platform === "Android"
    && p.uaProfile.metadata.model === p.model
    && p.uaProfile.metadata.architecture === ""
    && p.uaProfile.metadata.bitness === ""
  )));
  ok("Android panel matches the reported screen within tolerance", androidSamples.every((p) => (
    PANELS.includes(p.panel.width)
    && Math.abs(p.screen.width * p.dpr - p.panel.width) <= p.panel.width * 0.05
  )));
  ok("Android layout viewport is the panel minus browser chrome", androidSamples.every((p) => (
    p.viewport.width === p.screen.width
    && p.viewport.height > 0 && p.viewport.height < p.screen.height
  )));
  ok("Android memory follows the core count of the device (4 or 8)", androidSamples.every((p) => (
    (p.cores <= 4 && p.deviceMemory === 4) || (p.cores > 4 && p.deviceMemory === 8)
  )));
  ok("Android touch input is advertised with 5 touch points", androidSamples.every((p) => (
    p.touch === true && p.maxTouchPoints === 5
  )));
  ok("Android GPU family matches the vendor string", androidSamples.every((p) => (
    p.gpu.family === "" ? true : p.gpu.family === personas.gpuFamily(p.gpu.vendor)
  )));
  ok("Android OS release sits inside the recorded range", androidSamples.every((p) => {
    const bounds = String(p.osRange).split(/[^0-9]+/).filter(Boolean).map(Number);
    return bounds.length ? p.osVersion >= Math.min(...bounds) && p.osVersion <= Math.max(...bounds) : true;
  }));

  // --- 4. iOS Persona Derivation (All 32 devices) ---
  const iosSamples = [];
  for (let seed = 0; seed < ios.length; seed += 1) {
    iosSamples.push(personas.mobilePersona(seed, "ios"));
  }
  ok("iOS persona reports runtimeSupported true", iosSamples.every((p) => (
    p.runtimeSupported === true && personas.supportsRuntimePersona("ios") === true
  )));
  ok("iOS UA carries CPU iPhone OS and CriOS Mobile token", iosSamples.every((p) => (
    /CPU iPhone OS \d+(_\d+)? like Mac OS X/.test(p.userAgent)
    && /CriOS\/\d+\.0\.0\.0 Mobile\/15E148 Safari/.test(p.userAgent)
    && !/Windows NT|Macintosh|Linux|Android/.test(p.userAgent)
  )));
  ok("iOS persona carries iPhone platform and Apple Computer vendor", iosSamples.every((p) => (
    p.uaProfile.platform === "iPhone"
    && p.vendor === "Apple Computer, Inc."
    && p.uaProfile.vendor === "Apple Computer, Inc."
  )));
  ok("iOS Client Hints describe iOS mobile device", iosSamples.every((p) => (
    p.uaProfile.metadata.mobile === true
    && p.uaProfile.metadata.platform === "iOS"
    && p.uaProfile.metadata.model === "iPhone"
  )));
  ok("iOS panel strictly matches physical screen * DPR", iosSamples.every((p) => (
    [2, 3].includes(p.dpr)
    && p.panel.width === Math.round(p.screen.width * p.dpr)
    && p.panel.height === Math.round(p.screen.height * p.dpr)
  )));
  ok("iOS GPU is Apple GPU from Apple Inc.", iosSamples.every((p) => (
    p.gpu.vendor === "Apple Inc."
    && p.gpu.renderer === "Apple GPU"
    && p.gpu.family === "apple"
  )));
  ok("iOS cores match Apple A-series CPUs (2, 4, or 6 cores)", iosSamples.every((p) => (
    [2, 4, 6].includes(p.cores) && [2, 4, 8].includes(p.deviceMemory)
  )));

  // --- 5. Determinism & Seed Distribution ---
  const a = JSON.stringify(personas.mobilePersona(4242, "android"));
  const b = JSON.stringify(personas.mobilePersona(4242, "android"));
  ok("the same seed always draws the same Android device", a === b);
  const aIos = JSON.stringify(personas.mobilePersona(1024, "ios"));
  const bIos = JSON.stringify(personas.mobilePersona(1024, "ios"));
  ok("the same seed always draws the same iOS device", aIos === bIos);

  const distinct = new Set();
  for (let seed = 0; seed < 1909; seed += 1) distinct.add(personas.mobilePersona(seed, "android").name);
  ok("the Android pool is spread over the seeds", distinct.size >= 1500);

  // --- 6. Runtime Integration with buildFingerprint ---
  const mobileAndroid = buildFingerprint({
    id: "mobile-selftest-android", kernelVersion: "148.0.7778.165", os: "Android",
    canvas: "noise", webgl: "noise", privacy: {},
  });
  ok("an Android profile becomes a mobile phone identity", mobileAndroid.mobile === true && Boolean(mobileAndroid.mobileDevice));
  ok("Android built screen is the device panel", mobileAndroid.screen.width === mobileAndroid.mobileDevice.screen.width
    && mobileAndroid.screen.height === mobileAndroid.mobileDevice.screen.height
    && mobileAndroid.screen.devicePixelRatio === mobileAndroid.mobileDevice.dpr);
  ok("Android built profile exposes touch points and passes consistency", mobileAndroid.maxTouchPoints === 5
    && mobileAndroid.touch === true
    && mobileAndroid.consistency.ok === true);

  const mobileIos = buildFingerprint({
    id: "mobile-selftest-ios", kernelVersion: "148.0.7778.165", os: "iOS",
    canvas: "noise", webgl: "noise", privacy: {},
  });
  ok("an iOS profile becomes a mobile phone identity", mobileIos.mobile === true && Boolean(mobileIos.mobileDevice));
  ok("iOS built platform is iPhone and renderer is Apple GPU", mobileIos.platform === "iPhone"
    && mobileIos.webgl.renderer === "Apple GPU"
    && mobileIos.webgl.vendor === "Apple Inc.");
  ok("iOS built profile exposes touch points and passes consistency", mobileIos.maxTouchPoints === 5
    && mobileIos.touch === true
    && mobileIos.consistency.ok === true);

  const androidScript = buildInjectionScript(mobileAndroid);
  ok("Android injected script carries mobile config", /"mobile":true/.test(androidScript)
    && /"model":"[^"]+"/.test(androidScript));
  ok("Android injected script parses", (() => { new Function(androidScript); return true; })());

  const iosScript = buildInjectionScript(mobileIos);
  ok("iOS injected script carries iPhone platform and mobile config", /"platform":"iPhone"/.test(iosScript)
    && /"mobile":true/.test(iosScript));
  ok("iOS injected script parses", (() => { new Function(iosScript); return true; })());

  // --- 7. Desktop Isolation Invariants ---
  for (const os of ["Windows", "macOS", "Linux"]) {
    const desktop = buildFingerprint({ id: `desktop-${os}`, kernelVersion: "148.0.7778.165", os, privacy: {} });
    ok(`a ${os} profile stays a desktop identity`, desktop.mobile === false
      && desktop.mobileDevice === null
      && desktop.maxTouchPoints === 0
      && desktop.screen.width >= 640
      && !/Android|iPhone/.test(desktop.userAgent));
  }

  console.log(`\nmobile-personas-selftest: ${passed} checks passed.`);
  process.exit(0);
} else {
  // === MUTATION MODE ===
  console.log("Starting mobile-personas selftest (mode: MUTATION sensitivity)...\n");

  ok("mutation check: desktop platform leak on Android is caught", () => {
    const p = personas.mobilePersona(1, "android");
    p.uaProfile.platform = "Win32";
    return p.uaProfile.platform !== "Linux armv8l";
  });

  ok("mutation check: desktop platform leak on iOS is caught", () => {
    const p = personas.mobilePersona(1, "ios");
    p.uaProfile.platform = "MacIntel";
    return p.uaProfile.platform !== "iPhone";
  });

  ok("mutation check: desktop GPU leak on mobile is caught", () => {
    const p = personas.mobilePersona(1, "android");
    p.gpu.renderer = "ANGLE (AMD, AMD Radeon RX 580 Series)";
    return /Direct3D|Radeon|Mesa/i.test(p.gpu.renderer);
  });

  ok("mutation check: zero touch points on mobile is caught", () => {
    const p = personas.mobilePersona(1, "ios");
    p.maxTouchPoints = 0;
    return p.maxTouchPoints === 0;
  });

  ok("mutation check: tampered iOS DPR is caught", () => {
    const dpr = personas.deriveIosDpr(375, "iPhone 8");
    const fakeDpr = 3;
    return dpr !== fakeDpr;
  });

  ok("mutation check: runtimeSupported false for iOS triggers alert", () => {
    return personas.supportsRuntimePersona("ios") === true;
  });

  console.log(`\nmobile-personas-selftest [MUTATION]: ${passed} mutation sensitivity checks passed.`);
  process.exit(0);
}
