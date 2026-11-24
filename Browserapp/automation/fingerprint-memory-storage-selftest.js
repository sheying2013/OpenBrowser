'use strict';

// The injected deviceMemory must equal what buildFingerprint declared (null = keep the host value) in both page and worker, and the storage-quota override must agree across both scopes; the real scripts run in a VM over stub Navigator / WorkerNavigator / StorageManager.

const vm = require('vm');
const assert = require('assert');
const { buildFingerprint, buildInjectionScript, buildWorkerInjectionScript } = require('./fingerprint');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

const HOST_MEMORY = 2;

function pageSandbox() {
  const context = vm.createContext({});
  vm.runInContext(`(function () {
    function Navigator() {}
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      configurable: true, enumerable: true, get() { return ${HOST_MEMORY}; },
    });
    function Screen() {}
    function HTMLCanvasElement() {}
    function CanvasRenderingContext2D() {}
    CanvasRenderingContext2D.prototype.getImageData = function () {
      return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    };
    HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,'; };
    function WebGLRenderingContext() {}
    WebGLRenderingContext.prototype.getParameter = function () { return null; };
    WebGLRenderingContext.prototype.getExtension = function () { return null; };
    function StorageManager() {}
    StorageManager.prototype.estimate = function estimate() {
      return Promise.resolve({ quota: 123, usage: 7, usageDetails: { caches: 3 } });
    };
    this.Navigator = Navigator; this.Screen = Screen;
    this.HTMLCanvasElement = HTMLCanvasElement;
    this.CanvasRenderingContext2D = CanvasRenderingContext2D;
    this.WebGLRenderingContext = WebGLRenderingContext;
    this.StorageManager = StorageManager;
    this.navigator = Object.create(Navigator.prototype);
    this.screen = Object.create(Screen.prototype);
    this.devicePixelRatio = 1; this.screenX = 0; this.screenY = 0;
    this.innerWidth = 1280; this.innerHeight = 800;
    this.outerWidth = 1280; this.outerHeight = 800;
    this.document = { createElement: () => ({ getContext: () => null }), getOwnPropertyNames: () => [] };
    this.location = { href: 'https://example.com/', hostname: 'example.com' };
    this.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    this.addEventListener = function () {}; this.removeEventListener = function () {};
    this.DOMException = function DOMException(message) { this.message = message; };
    this.window = this; this.self = this; this.top = this;
  }).call(globalThis);`, context);
  return context;
}

function workerSandbox() {
  const context = vm.createContext({});
  vm.runInContext(`(function () {
    function WorkerNavigator() {}
    Object.defineProperty(WorkerNavigator.prototype, 'deviceMemory', {
      configurable: true, enumerable: true, get() { return ${HOST_MEMORY}; },
    });
    function StorageManager() {}
    StorageManager.prototype.estimate = function estimate() {
      return Promise.resolve({ quota: 123, usage: 7, usageDetails: { caches: 3 } });
    };
    this.WorkerNavigator = WorkerNavigator;
    this.StorageManager = StorageManager;
    this.__origEstimate = StorageManager.prototype.estimate;
    this.navigator = Object.create(WorkerNavigator.prototype);
    this.addEventListener = function () {}; this.removeEventListener = function () {};
    this.DOMException = function DOMException(message) { this.message = message; };
    this.self = globalThis;
  }).call(globalThis);`, context);
  return context;
}

function boot(kind, fp) {
  const context = kind === 'page' ? pageSandbox() : workerSandbox();
  const source = kind === 'page' ? buildInjectionScript(fp) : buildWorkerInjectionScript(fp);
  vm.runInContext(source, context, { timeout: 15000 });
  return context;
}

const read = (context, expression) => vm.runInContext(expression, context);

async function main() {
  // --- declared value reaches the page and the worker unchanged ---
  for (const memory of [0.25, 0.5, 4, 8]) {
    const fp = buildFingerprint({ id: 'mem-' + String(memory).replace('.', '_'), privacy: { fingerprint: { memory } } });
    const page = boot('page', fp);
    const worker = boot('worker', fp);
    ok(`memory ${memory}: fingerprint declares it`, fp.deviceMemory === memory);
    ok(`memory ${memory}: page reports ${memory}`, read(page, 'navigator.deviceMemory') === memory);
    ok(`memory ${memory}: worker reports the same value`, read(worker, 'navigator.deviceMemory') === memory);
  }

  // --- memory 0 means "real": host value stays, no fake accessor is installed ---
  {
    const fp = buildFingerprint({ id: 'mem-real', privacy: { fingerprint: { memory: 0 } } });
    const page = pageSandbox();
    const hostGetter = read(page, "Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get");
    vm.runInContext(buildInjectionScript(fp), page, { timeout: 15000 });
    const worker = boot('worker', fp);
    ok('memory 0: fingerprint leaves the host value alone', fp.deviceMemory === null);
    ok('memory 0: page keeps the host reading', read(page, 'navigator.deviceMemory') === HOST_MEMORY);
    ok('memory 0: worker keeps the host reading', read(worker, 'navigator.deviceMemory') === HOST_MEMORY);
    ok('memory 0: page deviceMemory accessor is not replaced',
      read(page, "Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory').get") === hostGetter);
  }

  // --- storage quota: page and worker agree, per OS class; usage details survive ---
  const QUOTA_DESKTOP = 64424509440;
  const QUOTA_DESKTOP_SMALL = 32212254720;
  const QUOTA_MOBILE = 16106127360;
  const QUOTA_MOBILE_SMALL = 10737418240;
  const expectations = [
    ['windows', 8, QUOTA_DESKTOP],
    ['windows', 4, QUOTA_DESKTOP_SMALL],
    ['android', 8, QUOTA_MOBILE],
    ['android', 4, QUOTA_MOBILE_SMALL],
    ['ios', 8, QUOTA_MOBILE],
    ['ios', 4, QUOTA_MOBILE_SMALL],
  ];
  for (const [os, memory, expectedQuota] of expectations) {
    const fp = buildFingerprint({ id: `quota-${os}-${memory}`, os, privacy: { fingerprint: { memory } } });
    const page = boot('page', fp);
    const worker = boot('worker', fp);
    const pageEstimate = await read(page, 'new StorageManager().estimate()');
    const workerEstimate = await read(worker, 'new StorageManager().estimate()');
    ok(`${os}/${memory}: page quota ${expectedQuota}`, pageEstimate.quota === expectedQuota);
    ok(`${os}/${memory}: worker quota matches the page`, workerEstimate.quota === pageEstimate.quota);
    ok(`${os}/${memory}: usage and usageDetails are preserved`,
      pageEstimate.usage === 7 && pageEstimate.usageDetails.caches === 3
      && workerEstimate.usage === 7 && workerEstimate.usageDetails.caches === 3);
    ok(`${os}/${memory}: page estimate is a replaced function`, read(page, "StorageManager.prototype.estimate.toString().includes('[native code]')"));
    // The worker wrapper is installed and answers the persona quota; its toString disguise goes
    // through the worker-scope sources map, which is a separate concern from this regression.
    ok(`${os}/${memory}: worker estimate was replaced`,
      read(worker, 'StorageManager.prototype.estimate !== __origEstimate'));
  }

  // --- illegal receiver is rejected with TypeError, not answered ---
  for (const kind of ['page', 'worker']) {
    const fp = buildFingerprint({ id: 'quota-receiver-' + kind, privacy: { fingerprint: { memory: 8 } } });
    const context = boot(kind, fp);
    const outcome = await read(context, `(() => StorageManager.prototype.estimate.call({})
      .then(() => 'ACCEPTED', (error) => error && error.name))()`);
    ok(`${kind}: illegal receiver rejects with TypeError`, outcome === 'TypeError');
  }

  console.log(`\nfingerprint-memory-storage-selftest: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
