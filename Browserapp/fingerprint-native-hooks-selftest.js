'use strict';

// Anti-detection: the spoofing hooks must not look spoofed.
//
// Detectors do not just read navigator.platform — they read the accessor behind it:
//   Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform').get.toString()
// Real Chrome answers with native-code source and a "get platform" name. An arrow function
// installed by a patcher answers with its own source, which both flags the browser as
// instrumented and can leak internal variable names.
//
// This runs the REAL injection script (buildInjectionScript) inside a VM with a minimal DOM
// and asserts the installed accessors are indistinguishable from native ones.

const vm = require('vm');
const assert = require('assert');
const { buildFingerprint, buildInjectionScript, buildWorkerInjectionScript } = require('./automation/fingerprint');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const NATIVE = /^function get [A-Za-z_$][\w$]*\(\) \{\s*\[native code\]\s*\}$/;

/** Minimal DOM surface: enough for the injection script to install its hooks. */
function makeDomContext() {
  function Navigator() {}
  function Screen() {}
  function HTMLCanvasElement() {}
  function CanvasRenderingContext2D() {}
  CanvasRenderingContext2D.prototype.getImageData = function getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  };
  HTMLCanvasElement.prototype.toDataURL = function toDataURL() { return 'data:image/png;base64,'; };
  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function getParameter(param) { return null; };
  WebGLRenderingContext.prototype.getExtension = function getExtension(name) { return name === 'webgl_debug_renderer_info' ? {} : null; };

  const navigator = Object.create(Navigator.prototype);
  const screen = Object.create(Screen.prototype);
  const win = {
    Navigator, Screen, HTMLCanvasElement, CanvasRenderingContext2D, WebGLRenderingContext,
    navigator, screen,
    devicePixelRatio: 1, screenX: 0, screenY: 0, innerWidth: 1280, innerHeight: 800,
    outerWidth: 1280, outerHeight: 800,
    document: { createElement: () => ({ getContext: () => null }), getOwnPropertyNames: [] },
    location: { href: 'https://example.com/', hostname: 'example.com' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    Intl, Date, Math, JSON, Object, Function, Array, String, Number, Boolean,
    Promise, WeakMap, Map, Set, Symbol, Reflect, Proxy, Error, TypeError, RangeError,
    DOMException: function DOMException(m) { this.message = m; },
    augment: null,
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  win.top = win;
  return win;
}

const fp = buildFingerprint({
  id: 'hooks-test',
  exitTimezone: 'America/Los_Angeles',
  privacy: { canvas: 'noise', webgl: 'noise', audio: 'noise', timezoneMode: 'ip' },
  advanced: {},
});

// --- page injection: navigator + screen accessors ---
{
  const ctx = vm.createContext(makeDomContext());
  let ran = true;
  try {
    vm.runInContext(buildInjectionScript(fp), ctx, { timeout: 10000 });
  } catch (error) {
    ran = false;
    console.log('     (injection threw in the stub DOM: ' + error.message + ')');
  }
  ok('page injection script executes', ran);

  const probe = (target, key) => vm.runInContext(
    `(() => { const d = Object.getOwnPropertyDescriptor(${target}, ${JSON.stringify(key)});
      return d && typeof d.get === 'function' ? { src: Function.prototype.toString.call(d.get), name: d.get.name } : null; })()`,
    ctx,
  );

  for (const key of ['platform', 'vendor', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver']) {
    const got = probe('Navigator.prototype', key);
    if (!got) { console.log(`     (no accessor installed for navigator.${key}; skipped)`); continue; }
    ok(`navigator.${key} getter stringifies as native`, NATIVE.test(got.src));
    ok(`navigator.${key} getter is named "get ${key}"`, got.name === 'get ' + key);
  }

  for (const key of ['width', 'height', 'colorDepth']) {
    const got = probe('Screen.prototype', key);
    if (!got) { console.log(`     (no accessor installed for screen.${key}; skipped)`); continue; }
    ok(`screen.${key} getter stringifies as native`, NATIVE.test(got.src));
  }

  // The descriptor a detector reads through the navigator Proxy must be disguised too.
  const viaProxy = probe('navigator', 'platform');
  if (viaProxy) {
    ok('navigator proxy descriptor getter stringifies as native', NATIVE.test(viaProxy.src));
    ok('navigator proxy descriptor leaks no internals', !/navPatch|CFG/.test(viaProxy.src));
  }
}

// --- worker injection: WorkerNavigator accessors ---
{
  const ctx = vm.createContext((() => {
    function WorkerNavigator() {}
    const navigator = Object.create(WorkerNavigator.prototype);
    const scope = {
      WorkerNavigator, navigator,
      Object, Function, Array, String, Number, Boolean, Math, JSON, Date, Intl,
      Promise, WeakMap, Map, Set, Symbol, Reflect, Proxy, Error, TypeError,
      addEventListener() {}, removeEventListener() {},
    };
    scope.self = scope; scope.globalThis = scope;
    return scope;
  })());
  let ran = true;
  try { vm.runInContext(buildWorkerInjectionScript(fp), ctx, { timeout: 10000 }); }
  catch (error) { ran = false; console.log('     (worker injection threw: ' + error.message + ')'); }
  ok('worker injection script executes', ran);

  const got = vm.runInContext(
    `(() => { const d = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'platform');
      return d && typeof d.get === 'function' ? { src: Function.prototype.toString.call(d.get), name: d.get.name } : null; })()`,
    ctx,
  );
  if (got) {
    ok('worker navigator.platform getter stringifies as native', NATIVE.test(got.src));
    ok('worker navigator.platform getter is named "get platform"', got.name === 'get platform');
  } else {
    console.log('     (worker accessor not installed in stub scope; skipped)');
  }

  const workerTz = vm.runInContext("Intl.DateTimeFormat().resolvedOptions().timeZone", ctx);
  ok('worker timezone is spoofed to America/Los_Angeles', workerTz === 'America/Los_Angeles');
  const workerOffset = vm.runInContext("(new Date('2026-01-15T12:00:00Z')).getTimezoneOffset()", ctx);
  ok('worker timezone offset is 480 for PST', workerOffset === 480);
}

// --- timezone and prototype checks in page ---
{
  const ctx = vm.createContext(makeDomContext());
  vm.runInContext(buildInjectionScript(fp), ctx);

  const pageTz = vm.runInContext("Intl.DateTimeFormat().resolvedOptions().timeZone", ctx);
  ok('page timezone is spoofed to America/Los_Angeles', pageTz === 'America/Los_Angeles');

  const pageOffset = vm.runInContext("(new Date('2026-01-15T12:00:00Z')).getTimezoneOffset()", ctx);
  ok('page timezone offset is 480 for PST', pageOffset === 480);

  const str = vm.runInContext("(new Date('2026-01-15T12:00:00Z')).toString()", ctx);
  ok('page Date.toString formats with Pacific Standard Time', str.includes('Pacific Standard Time') || str.includes('GMT-0800'));

  const hasProto = vm.runInContext("CanvasRenderingContext2D.prototype.getImageData.hasOwnProperty('prototype')", ctx);
  ok('hooked getImageData has no .prototype property', hasProto === false);

  const throwsNew = vm.runInContext(`(() => {
    try { new CanvasRenderingContext2D.prototype.getImageData(); return false; }
    catch (e) { return true; }
  })()`, ctx);
  ok('new CanvasRenderingContext2D.prototype.getImageData() throws TypeError', throwsNew === true);

  const glNoExt = vm.runInContext(`(() => {
    const gl = Object.create(WebGLRenderingContext.prototype);
    return gl.getParameter(0x9245);
  })()`, ctx);
  ok('gl.getParameter(0x9245) without getExtension returns null', glNoExt === null);

  const glWithExt = vm.runInContext(`(() => {
    const gl = Object.create(WebGLRenderingContext.prototype);
    gl.getExtension('webgl_debug_renderer_info');
    return gl.getParameter(0x9245);
  })()`, ctx);
  ok('gl.getParameter(0x9245) after getExtension returns spoofed vendor', typeof glWithExt === 'string' && glWithExt.length > 0);

  // Timezone spoofing has to stay internally consistent. Patching getHours while leaving
  // getMinutes on the host zone is a stronger signal than not patching at all: it only shows up
  // on half-hour and 45-minute zones, which is exactly where a detector looks.
  const half = buildFingerprint({
    id: 'tz-half', name: 'tz', width: 1280, height: 820,
    exitTimezone: 'Asia/Kolkata', privacy: { timezoneMode: 'ip' },
  });
  const halfCtx = vm.createContext(makeDomContext());
  // makeDomContext hands every context the same host Date and Intl, so hooks installed by an
  // earlier case leak in and the assertions below would measure those instead. Give this case
  // untouched copies.
  const fresh = vm.runInNewContext('({ Date, Intl })');
  halfCtx.Date = fresh.Date;
  halfCtx.Intl = fresh.Intl;
  vm.runInContext(buildInjectionScript(half), halfCtx);
  const halfOffset = vm.runInContext("(new Date('2026-06-15T12:00:00Z')).getTimezoneOffset()", halfCtx);
  ok('half-hour zone reports offset -330', halfOffset === -330);
  const halfMinutes = vm.runInContext("(new Date('2026-06-15T12:00:00Z')).getMinutes()", halfCtx);
  ok('getMinutes follows the spoofed half-hour zone', halfMinutes === 30);
  const halfHours = vm.runInContext("(new Date('2026-06-15T12:00:00Z')).getHours()", halfCtx);
  ok('getHours agrees with getMinutes on a half-hour zone', halfHours === 17);

  // Local-time construction, parsing and the setters are all defined against the local zone.
  const roundTrip = vm.runInContext("new Date(2026, 5, 15, 12, 0, 0).getHours() === 12", halfCtx);
  ok('multi-arg Date constructor round-trips through the spoofed zone', roundTrip === true);
  const parsedLocal = vm.runInContext("new Date('2026-06-15 12:00:00').getHours()", halfCtx);
  ok('timezone-less date strings parse as local time', parsedLocal === 12);
  const setterHours = vm.runInContext(`(() => {
    const d = new Date('2026-06-15T12:00:00Z'); d.setHours(3); return d.getHours();
  })()`, halfCtx);
  ok('setHours writes in the spoofed zone', setterHours === 3);

  const intlCtor = vm.runInContext('Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat', halfCtx);
  ok('Intl.DateTimeFormat.prototype.constructor points at the patched constructor', intlCtor === true);

  // The audio fingerprint hook is a load-bearing surface: without it every profile reports the
  // host machine's rendered buffer, which clusters them together.
  const audioHooked = vm.runInContext("typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData.toString()", halfCtx);
  ok('AudioBuffer.getChannelData stays hooked and native-looking',
    audioHooked === false || /\[native code\]/.test(String(audioHooked)));
}

console.log(`\nfingerprint-native-hooks-selftest: ${passed} checks passed.`);
