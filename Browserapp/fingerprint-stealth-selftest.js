'use strict';

const vm = require('vm');
const assert = require('assert');
const { buildFingerprint, buildInjectionScript } = require('./automation/fingerprint');

const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  PASS  ' + name);
};

const fp = buildFingerprint({
  id: 'stealth-test',
  exitTimezone: 'America/New_York',
  privacy: { canvas: 'noise', webgl: 'noise', audio: 'noise', timezoneMode: 'ip' },
  advanced: {},
});

function createMockDom() {
  function Navigator() {}
  function Screen() {}
  function HTMLCanvasElement() {}
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: function getContext() { return null; },
    writable: true,
    enumerable: false,
    configurable: true,
  });
  function CanvasRenderingContext2D() {}
  CanvasRenderingContext2D.prototype.getImageData = function getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  };
  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function getParameter(param) { return null; };
  WebGLRenderingContext.prototype.getExtension = function getExtension() { return null; };
  WebGLRenderingContext.prototype.getSupportedExtensions = function getSupportedExtensions() { return ['OES_texture_float']; };

  function AudioBuffer() {
    this._data = new Float32Array(256);
    for (let i = 0; i < 256; i++) this._data[i] = (i + 1) / 256;
  }
  AudioBuffer.prototype.getChannelData = function getChannelData() { return this._data; };
  AudioBuffer.prototype.copyFromChannel = function copyFromChannel(dest, ch, start) {
    const s = start || 0;
    for (let i = 0; i < dest.length && (s + i) < this._data.length; i++) dest[i] = this._data[s + i];
  };

  function AnalyserNode() {}
  AnalyserNode.prototype.getFloatFrequencyData = function getFloatFrequencyData(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = -50 + i * 0.1;
  };
  AnalyserNode.prototype.getByteFrequencyData = function getByteFrequencyData(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
  };

  function NavigatorUAData() {}

  function HTMLIFrameElement() {
    this._subWin = {
      Date: class SubDate extends Date {},
      Intl: {
        DateTimeFormat: function SubDateTimeFormat() {
          return { resolvedOptions: () => ({ timeZone: 'Europe/London' }) };
        }
      },
      Navigator: class SubNavigator extends Navigator {},
      Screen: class SubScreen extends Screen {},
      WebGLRenderingContext: class SubWebGLRenderingContext extends WebGLRenderingContext {},
    };
    this._subWin.navigator = new this._subWin.Navigator();
    this._subWin.screen = new this._subWin.Screen();
  }
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() { return this._subWin; },
    configurable: true,
  });

  function Permissions() {}
  function PermissionStatus() {}
  Object.defineProperty(PermissionStatus.prototype, 'state', {
    get: function() { return 'prompt'; },
    configurable: true,
    enumerable: true,
  });
  Permissions.prototype.query = async function query(desc) {
    return new PermissionStatus();
  };

  const navigator = Object.create(Navigator.prototype);
  navigator.userAgentData = Object.create(NavigatorUAData.prototype);
  navigator.permissions = new Permissions();
  const screen = Object.create(Screen.prototype);

  const win = {
    Navigator, Screen, HTMLCanvasElement, CanvasRenderingContext2D, WebGLRenderingContext,
    AudioBuffer, AnalyserNode, NavigatorUAData, HTMLIFrameElement,
    Permissions, PermissionStatus,
    Notification: { permission: 'default' },
    navigator, screen,
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
    document: { createElement: (tag) => tag === 'iframe' ? new HTMLIFrameElement() : ({ getContext: () => null }) },
    location: { href: 'https://example.com/', hostname: 'example.com' },
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;
  return win;
}

const ctx = vm.createContext(createMockDom());
vm.runInContext(buildInjectionScript(fp), ctx);

// 1. userAgentData checks
const uaOwn = vm.runInContext("Object.getOwnPropertyNames(navigator.userAgentData)", ctx);
ok('navigator.userAgentData has zero own properties', Array.isArray(uaOwn) && uaOwn.length === 0);

const uaInstance = vm.runInContext("navigator.userAgentData instanceof NavigatorUAData", ctx);
ok('navigator.userAgentData is instanceof NavigatorUAData', uaInstance === true);

const brandsNative = vm.runInContext("Function.prototype.toString.call(Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'brands')?.get)", ctx);
ok('NavigatorUAData.prototype.brands getter stringifies as native', /\[native code\]/.test(brandsNative));

const jsonVal = vm.runInContext("navigator.userAgentData.toJSON()", ctx);
ok('userAgentData.toJSON returns brands/mobile/platform', jsonVal && Array.isArray(jsonVal.brands) && typeof jsonVal.platform === 'string');

const toJSONDesc = vm.runInContext("Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'toJSON')", ctx);
ok('NavigatorUAData.prototype.toJSON is non-enumerable', toJSONDesc.enumerable === false);

const getHighEntropyValuesDesc = vm.runInContext("Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, 'getHighEntropyValues')", ctx);
ok('NavigatorUAData.prototype.getHighEntropyValues is non-enumerable', getHighEntropyValuesDesc.enumerable === false);

// 2. AudioBuffer checks
ctx.buf = vm.runInContext("new AudioBuffer()", ctx);
const chData = vm.runInContext("buf.getChannelData(0)", ctx);
ctx.copyDest = new Float32Array(chData.length);
vm.runInContext("buf.copyFromChannel(copyDest, 0)", ctx);
let matched = true;
for (let i = 0; i < chData.length; i++) {
  if (chData[i] !== ctx.copyDest[i]) { matched = false; break; }
}
ok('AudioBuffer.copyFromChannel matches getChannelData bit-for-bit', matched === true);

// 3. AnalyserNode frequency noise check
ctx.analyser = vm.runInContext("new AnalyserNode()", ctx);
ctx.freqData = new Float32Array(64);
vm.runInContext("analyser.getFloatFrequencyData(freqData)", ctx);
let hasPerturbation = false;
for (let i = 0; i < ctx.freqData.length; i++) {
  const originalVal = -50 + i * 0.1;
  if (Math.abs(ctx.freqData[i] - originalVal) > 1e-9) { hasPerturbation = true; break; }
}
ok('AnalyserNode.getFloatFrequencyData has subtle noise', hasPerturbation === true);

// 4. HTMLCanvasElement.prototype.getContext enumerable & native
const ctxDesc = vm.runInContext("Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')", ctx);
const ctxStr = vm.runInContext("HTMLCanvasElement.prototype.getContext.toString()", ctx);
ok('HTMLCanvasElement.prototype.getContext is non-enumerable and native', ctxDesc.enumerable === false && /\[native code\]/.test(ctxStr));

// 5. iframe timezone & environment sync check
ctx.iframe = vm.runInContext("new HTMLIFrameElement()", ctx);
ctx.iframeWin = vm.runInContext("iframe.contentWindow", ctx);
const iframeTz = vm.runInContext("iframeWin.Intl.DateTimeFormat().resolvedOptions().timeZone", ctx);
ok('iframe.contentWindow inherits spoofed timezone', iframeTz === 'America/New_York');
const iframeDateSame = vm.runInContext("iframeWin.Date === Date", ctx);
ok('iframe.contentWindow shares Date implementation', iframeDateSame === true);
const iframePlatform = vm.runInContext("iframeWin.navigator.platform", ctx);
const topPlatform = vm.runInContext("navigator.platform", ctx);
ok('iframe.contentWindow inherits navigator.platform without illegal invocation', iframePlatform === topPlatform);

// 6. Permissions consistency check (no own property state on status)
async function testPermissions() {
  const permRes = await vm.runInContext("navigator.permissions.query({ name: 'notifications' })", ctx);
  ctx.permRes = permRes;
  const hasOwnState = vm.runInContext("permRes.hasOwnProperty('state')", ctx);
  ok('permissions status has NO own state property', hasOwnState === false);
  const stateVal = vm.runInContext("permRes.state", ctx);
  ok('permissions status state resolves to prompt', stateVal === 'prompt');
}

// 7. WebGL software fallback check
ctx.gl = vm.runInContext("new WebGLRenderingContext()", ctx);
const exts = vm.runInContext("gl.getSupportedExtensions()", ctx);
ok('WebGL debug info extension added when supported', exts.includes('WEBGL_debug_renderer_info'));

vm.runInContext("gl.getExtension('WEBGL_debug_renderer_info')", ctx);
const unmaskedVendor = vm.runInContext("gl.getParameter(0x9245)", ctx);
ok('WebGL unmasked vendor is spoofed even if native getExtension was null', typeof unmaskedVendor === 'string' && unmaskedVendor.length > 0);

// 8. iframe WebGL sync check
ctx.subGl = vm.runInContext("new iframeWin.WebGLRenderingContext()", ctx);
vm.runInContext("subGl.getExtension('WEBGL_debug_renderer_info')", ctx);
const subVendor = vm.runInContext("subGl.getParameter(0x9245)", ctx);
ok('iframe.contentWindow WebGL vendor matches parent window', subVendor === unmaskedVendor);

testPermissions().then(() => {
  console.log("\nfingerprint-stealth-selftest: ALL CHECKS PASSED.");
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
