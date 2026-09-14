#!/usr/bin/env node
'use strict';

/**
 * Graphics and Media Fingerprint Alignment Selftest
 *
 * Covers:
 *   A. WebGL2 parameter capability mapping & host reconciliation
 *   B. getShaderPrecisionFormat cross-platform precision & brand checks
 *   C. WebGPU adapter features & limits coherence with GPU identity (main window & DedicatedWorker)
 *   D. Media device labels dispatched by persona OS & profile identifier uniqueness
 *   E. ClientRects geometry invariants, zero-dimension preservation, and non-negative bounds
 */

const assert = require('assert');
const vm = require('vm');
const fp = require('./fingerprint');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

// ============================================================================
// Helper: Create a lightweight Mock DOM Window environment
// ============================================================================
function createMockWindow(options = {}) {
  class DOMRect {
    constructor(x = 0, y = 0, w = 0, h = 0) {
      this.x = x; this.y = y; this.width = w; this.height = h;
      this.top = y; this.left = x; this.right = x + w; this.bottom = y + h;
    }
    static fromRect(r = {}) {
      return new DOMRect(r.x, r.y, r.width, r.height);
    }
  }

  class DOMRectList {
    constructor(items = []) {
      this._items = items;
      items.forEach((item, idx) => { this[idx] = item; });
    }
    get length() {
      if (!(this instanceof DOMRectList)) throw new TypeError("Illegal invocation");
      return this._items ? this._items.length : 0;
    }
    item(i) { return this[i] || null; }
    [Symbol.iterator]() {
      let idx = 0;
      return {
        next: () => (idx < this.length ? { value: this[idx++], done: false } : { done: true })
      };
    }
  }

  class Element {
    constructor(rects) {
      this._rects = rects || [new DOMRect(10, 20, 100, 50)];
    }
    getBoundingClientRect() { return this._rects[0]; }
    getClientRects() { return new DOMRectList(this._rects); }
  }

  class WebGLShaderPrecisionFormat {
    constructor(rMin, rMax, prec) {
      this._rMin = rMin; this._rMax = rMax; this._prec = prec;
    }
    get rangeMin() {
      if (!(this instanceof WebGLShaderPrecisionFormat)) throw new TypeError('Illegal invocation');
      return this._rMin;
    }
    get rangeMax() {
      if (!(this instanceof WebGLShaderPrecisionFormat)) throw new TypeError('Illegal invocation');
      return this._rMax;
    }
    get precision() {
      if (!(this instanceof WebGLShaderPrecisionFormat)) throw new TypeError('Illegal invocation');
      return this._prec;
    }
  }

  class WebGLRenderingContext {
    getParameter(param) {
      if (!(this instanceof WebGLRenderingContext)) throw new TypeError('Illegal invocation');
      if (param === 0x846d) return new Float32Array([1, 1024]);
      if (param === 0x0d3a) return new Int32Array([4096, 4096]);
      return 100;
    }
    getShaderPrecisionFormat(st, pt) {
      if (!(this instanceof WebGLRenderingContext)) throw new TypeError('Illegal invocation');
      if (st !== 0x8b30 && st !== 0x8b31) return null;
      return new WebGLShaderPrecisionFormat(127, 127, 23);
    }
  }
  class WebGL2RenderingContext extends WebGLRenderingContext {
    getParameter(param) {
      if (!(this instanceof WebGL2RenderingContext)) throw new TypeError('Illegal invocation');
      if (param === 0x8a30) return 65536;
      return super.getParameter(param);
    }
  }

  class GPUSupportedFeatures {
    constructor(set) { this._set = new Set(set); }
    get size() {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.size;
    }
    has(k) {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.has(k);
    }
    entries() {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.entries();
    }
    keys() {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.keys();
    }
    values() {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.values();
    }
    [Symbol.iterator]() {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set[Symbol.iterator]();
    }
    forEach(fn, thisArg) {
      if (!(this instanceof GPUSupportedFeatures)) throw new TypeError('Illegal invocation');
      return this._set.forEach(fn, thisArg);
    }
  }

  class GPUSupportedLimits {
    constructor(limits) { this._l = { ...limits }; }
    get maxTextureDimension1D() { if (!(this instanceof GPUSupportedLimits)) throw new TypeError('Illegal invocation'); return this._l.maxTextureDimension1D || 8192; }
    get maxTextureDimension2D() { if (!(this instanceof GPUSupportedLimits)) throw new TypeError('Illegal invocation'); return this._l.maxTextureDimension2D || 8192; }
    get maxBufferSize() { if (!(this instanceof GPUSupportedLimits)) throw new TypeError('Illegal invocation'); return this._l.maxBufferSize || 268435456; }
    get minUniformBufferOffsetAlignment() { if (!(this instanceof GPUSupportedLimits)) throw new TypeError('Illegal invocation'); return this._l.minUniformBufferOffsetAlignment || 256; }
  }

  class GPUAdapterInfo {
    constructor(info) { this._i = { ...info }; }
    get vendor() { if (!(this instanceof GPUAdapterInfo)) throw new TypeError('Illegal invocation'); return this._i.vendor || ''; }
    get architecture() { if (!(this instanceof GPUAdapterInfo)) throw new TypeError('Illegal invocation'); return this._i.architecture || ''; }
    get device() { if (!(this instanceof GPUAdapterInfo)) throw new TypeError('Illegal invocation'); return this._i.device || ''; }
    get description() { if (!(this instanceof GPUAdapterInfo)) throw new TypeError('Illegal invocation'); return this._i.description || ''; }
  }

  class GPUAdapter {
    constructor(cfg = {}) {
      this._info = new GPUAdapterInfo(cfg.info || { vendor: 'apple', architecture: 'common-3', device: 'Apple M1', description: 'Apple M1' });
      this._features = new GPUSupportedFeatures(cfg.features || ['texture-compression-astc', 'texture-compression-etc2', 'texture-compression-bc', 'shader-f16']);
      this._limits = new GPUSupportedLimits(cfg.limits || { maxTextureDimension2D: 16384, maxBufferSize: 2147483648, minUniformBufferOffsetAlignment: 256 });
    }
    get info() { if (!(this instanceof GPUAdapter)) throw new TypeError('Illegal invocation'); return this._info; }
    get features() { if (!(this instanceof GPUAdapter)) throw new TypeError('Illegal invocation'); return this._features; }
    get limits() { if (!(this instanceof GPUAdapter)) throw new TypeError('Illegal invocation'); return this._limits; }
    async requestAdapterInfo() { return this._info; }
  }

  class GPU {
    constructor(adapterCfg) { this._adapterCfg = adapterCfg; }
    async requestAdapter() { return new GPUAdapter(this._adapterCfg); }
  }

  const win = {
    DOMRect, DOMRectList, Element,
    WebGLShaderPrecisionFormat, WebGLRenderingContext, WebGL2RenderingContext,
    GPUSupportedFeatures, GPUSupportedLimits, GPUAdapterInfo, GPUAdapter, GPU,
    navigator: {
      gpu: new GPU(options.adapterCfg),
      userAgent: options.userAgent || 'Mozilla/5.0',
      platform: options.platform || 'Win32',
      languages: ['en-US'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    document: {
      createElement: () => ({}),
      fonts: { forEach: () => {} },
    },
    Function, Object, Array, String, Number, Boolean, Symbol, WeakMap, WeakSet, Set, Map,
    TypeError, RangeError, Error, Math, console, Float32Array, Int32Array, Uint8Array, Uint8ClampedArray,
  };
  win.globalThis = win;
  win.window = win;

  const script = fp.buildInjectionScript(options.fingerprint);
  vm.runInNewContext(script, win);
  return { win };
}

// ============================================================================
// Helper: Create a lightweight Mock Worker environment
// ============================================================================
function createMockWorker(options = {}) {
  const { win } = createMockWindow(options);
  const workerScope = {
    WebGLShaderPrecisionFormat: win.WebGLShaderPrecisionFormat,
    WebGLRenderingContext: win.WebGLRenderingContext,
    WebGL2RenderingContext: win.WebGL2RenderingContext,
    GPUSupportedFeatures: win.GPUSupportedFeatures,
    GPUSupportedLimits: win.GPUSupportedLimits,
    GPUAdapterInfo: win.GPUAdapterInfo,
    GPUAdapter: win.GPUAdapter,
    GPU: win.GPU,
    navigator: {
      gpu: new win.GPU(options.adapterCfg),
      userAgent: options.userAgent || 'Mozilla/5.0',
      platform: options.platform || 'Win32',
      languages: ['en-US'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    Function, Object, Array, String, Number, Boolean, Symbol, WeakMap, WeakSet, Set, Map,
    TypeError, RangeError, Error, Math, console, Float32Array, Int32Array, Uint8Array, Uint8ClampedArray,
  };
  workerScope.globalThis = workerScope;
  workerScope.self = workerScope;

  const workerScript = fp.buildWorkerInjectionScript(options.fingerprint);
  vm.runInNewContext(workerScript, workerScope);
  return { worker: workerScope };
}

console.log('Starting Graphics & Media Alignment Selftest...\n');

// ============================================================================
// TASK A: WebGL2 Parameter IDs & Host Capacity Reconciliation
// ============================================================================
check('Task A: WEBGL_PARAM_IDS definitions cover WebGL2 and point size queries', () => {
  const ids = fp.WEBGL_PARAM_IDS;
  assert.strictEqual(ids.MAX_TEXTURE_SIZE, 0x0d33);
  assert.strictEqual(ids.MAX_VIEWPORT_DIMS, 0x0d3a);
  assert.strictEqual(ids.ALIASED_POINT_SIZE_RANGE, 0x846d);
  assert.strictEqual(ids.MAX_CUBE_MAP_TEXTURE_SIZE, 0x851c);
  assert.strictEqual(ids.MAX_RENDERBUFFER_SIZE, 0x84e8);
  assert.strictEqual(ids.MAX_VERTEX_UNIFORM_VECTORS, 0x8dfb);
  assert.strictEqual(ids.MAX_VARYING_VECTORS, 0x8dfc);
  assert.strictEqual(ids.MAX_UNIFORM_BLOCK_SIZE, 0x8a30);
  assert.strictEqual(ids.UNIFORM_BUFFER_OFFSET_ALIGNMENT, 0x8a34);
  assert.strictEqual(ids.MAX_VERTEX_UNIFORM_BLOCKS, 0x8a2b);
  assert.strictEqual(ids.MAX_FRAGMENT_UNIFORM_BLOCKS, 0x8a2d);
  assert.strictEqual(ids.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 0x8b4d);
});

check('Task A: webglParameterOverrides maps vendor limits accurately', () => {
  const apple = fp.webglParameterOverrides({ vendor: 'apple', architecture: 'common-3' });
  assert.strictEqual(apple[fp.WEBGL_PARAM_IDS.ALIASED_POINT_SIZE_RANGE], 511, 'Apple pointSize should be 511');
  assert.strictEqual(apple[fp.WEBGL_PARAM_IDS.MAX_VERTEX_UNIFORM_BLOCKS], 12, 'Apple maxVertexUniformBlocks should be 12');
  assert.strictEqual(apple[fp.WEBGL_PARAM_IDS.MAX_FRAGMENT_UNIFORM_BLOCKS], 12, 'Apple maxFragmentUniformBlocks should be 12');
  assert.strictEqual(apple[fp.WEBGL_PARAM_IDS.MAX_COMBINED_TEXTURE_IMAGE_UNITS], 80, 'Apple maxCombinedTextureImageUnits should be 80');

  const nvidia = fp.webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' });
  assert.strictEqual(nvidia[fp.WEBGL_PARAM_IDS.ALIASED_POINT_SIZE_RANGE], 1024, 'NVIDIA pointSize should be 1024');
  assert.strictEqual(nvidia[fp.WEBGL_PARAM_IDS.MAX_COMBINED_TEXTURE_IMAGE_UNITS], 192, 'NVIDIA maxCombinedTextureImageUnits should be 192');

  const qualcomm = fp.webglParameterOverrides({ vendor: 'qualcomm', architecture: 'adreno-700' });
  assert.strictEqual(qualcomm[fp.WEBGL_PARAM_IDS.UNIFORM_BUFFER_OFFSET_ALIGNMENT], 64, 'Qualcomm alignment should be 64');
});

check('Task A: Host limits reconciliation never exceeds physical capacity', () => {
  const clamped = fp.webglParameterOverrides(
    { vendor: 'nvidia', architecture: 'ampere' },
    {
      reconcileHost: true,
      hostLimits: {
        maxTextureSize: 8192,
        maxRenderbufferSize: 8192,
        aliasedPointSizeRange: [1, 511],
        maxUniformBlockSize: 32768,
        maxVertexUniformBlocks: 10,
        maxFragmentUniformBlocks: 10,
        maxCombinedTextureImageUnits: 64,
        uniformBufferOffsetAlignment: 512,
      },
    }
  );
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 8192, 'Texture size must be clamped to host 8192');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.ALIASED_POINT_SIZE_RANGE], 511, 'Point size must be clamped to host 511');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.MAX_UNIFORM_BLOCK_SIZE], 32768, 'Block size clamped to host 32768');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.MAX_VERTEX_UNIFORM_BLOCKS], 10, 'Vertex blocks clamped to host 10');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.MAX_FRAGMENT_UNIFORM_BLOCKS], 10, 'Fragment blocks clamped to host 10');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.MAX_COMBINED_TEXTURE_IMAGE_UNITS], 64, 'Combined units clamped to host 64');
  assert.strictEqual(clamped[fp.WEBGL_PARAM_IDS.UNIFORM_BUFFER_OFFSET_ALIGNMENT], 512, 'Alignment must be >= host alignment 512');
});

check('Task A: Injected getParameter returns native-typed ALIASED_POINT_SIZE_RANGE and WebGL2 limits', () => {
  const customFp = {
    webgl: {
      mode: 'noise',
      metaMode: 'noise',
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'common-3' },
      limits: {
        0x846d: 511,
        0x8a30: 65536,
        0x8b4d: 80,
      }
    }
  };
  const { win } = createMockWindow({ fingerprint: customFp });
  const gl2 = new win.WebGL2RenderingContext();
  const pointRange = gl2.getParameter(0x846d);
  assert(pointRange instanceof win.Float32Array, 'ALIASED_POINT_SIZE_RANGE must be Float32Array');
  assert.strictEqual(pointRange.length, 2);
  assert.strictEqual(pointRange[0], 1);
  assert.strictEqual(pointRange[1], 511);

  assert.strictEqual(gl2.getParameter(0x8a30), 65536, 'WebGL2 returns MAX_UNIFORM_BLOCK_SIZE');
  assert.strictEqual(gl2.getParameter(0x8b4d), 80, 'MAX_COMBINED_TEXTURE_IMAGE_UNITS matches Apple');
});

// ============================================================================
// TASK B: getShaderPrecisionFormat Cross-Platform Precision & Brand Checks
// ============================================================================
check('Task B: Desktop persona receives standard high-precision float (127, 127, 23)', () => {
  const desktopFp = fp.buildFingerprint({
    id: 'desktop-prec-test',
    privacy: { os: 'windows', webgl: 'noise' },
    fingerprint: {
      os: 'windows',
      platform: 'Win32',
      webgl: { mode: 'noise', vendor: 'Google Inc. (NVIDIA)', renderer: 'NVIDIA RTX 3080' }
    }
  });
  const { win } = createMockWindow({ fingerprint: desktopFp });
  const gl = new win.WebGLRenderingContext();
  const prec = gl.getShaderPrecisionFormat(0x8b30 /* FRAGMENT_SHADER */, 0x8df1 /* MEDIUM_FLOAT */);
  assert(prec instanceof win.WebGLShaderPrecisionFormat, 'Must be instance of WebGLShaderPrecisionFormat');
  assert.strictEqual(prec.rangeMin, 127);
  assert.strictEqual(prec.rangeMax, 127);
  assert.strictEqual(prec.precision, 23);
});

check('Task B: Mobile persona receives mobile medium float precision (14, 14, 10)', () => {
  const mobileFp = fp.buildFingerprint({
    id: 'mobile-prec-test',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
    privacy: { webgl: 'noise' },
    fingerprint: {
      os: 'android',
      mobile: true,
      platform: 'Linux armv8l',
      webgl: { mode: 'noise', vendor: 'Qualcomm', renderer: 'Adreno (TM) 730', gpu: { vendor: 'qualcomm', architecture: 'adreno-700' } }
    }
  });
  const { win } = createMockWindow({ fingerprint: mobileFp });
  const gl = new win.WebGLRenderingContext();
  const medFloat = gl.getShaderPrecisionFormat(0x8b30 /* FRAGMENT_SHADER */, 0x8df1 /* MEDIUM_FLOAT */);
  assert(medFloat instanceof win.WebGLShaderPrecisionFormat, 'instanceof WebGLShaderPrecisionFormat');
  assert.strictEqual(medFloat.rangeMin, 14, 'Mobile MEDIUM_FLOAT rangeMin must be 14');
  assert.strictEqual(medFloat.rangeMax, 14, 'Mobile MEDIUM_FLOAT rangeMax must be 14');
  assert.strictEqual(medFloat.precision, 10, 'Mobile MEDIUM_FLOAT precision must be 10');

  const lowFloat = gl.getShaderPrecisionFormat(0x8b30 /* FRAGMENT_SHADER */, 0x8df0 /* LOW_FLOAT */);
  assert.strictEqual(lowFloat.rangeMin, 14);
  assert.strictEqual(lowFloat.rangeMax, 14);
  assert.strictEqual(lowFloat.precision, 10);

  const highFloat = gl.getShaderPrecisionFormat(0x8b30 /* FRAGMENT_SHADER */, 0x8df2 /* HIGH_FLOAT */);
  assert.strictEqual(highFloat.rangeMin, 127);
  assert.strictEqual(highFloat.rangeMax, 127);
  assert.strictEqual(highFloat.precision, 23);
});

check('Task B: Illegal invocation on WebGLShaderPrecisionFormat prototype getters throws TypeError', () => {
  const { win } = createMockWindow({
    fingerprint: {
      webgl: { mode: 'noise', metaMode: 'noise', vendor: 'NVIDIA', renderer: 'RTX' }
    }
  });
  for (const prop of ['rangeMin', 'rangeMax', 'precision']) {
    const desc = Object.getOwnPropertyDescriptor(win.WebGLShaderPrecisionFormat.prototype, prop);
    let threw = false;
    try {
      desc.get.call({});
    } catch (e) {
      if (e instanceof win.TypeError) threw = true;
    }
    assert(threw, `Getter ${prop} on illegal receiver must throw TypeError`);
  }
});

// ============================================================================
// TASK C: WebGPU Adapter Features / Limits Coherence with Identity
// ============================================================================
check('Task C: Desktop Intel WebGPU filters mobile compression features (ASTC/ETC2)', async () => {
  const intelFp = {
    webgpu: {
      mode: 'webgl',
      gpu: { vendor: 'intel', architecture: 'gen9', device: 'Intel UHD 620' }
    }
  };
  const { win } = createMockWindow({
    fingerprint: intelFp,
    adapterCfg: {
      features: ['texture-compression-astc', 'texture-compression-etc2', 'texture-compression-bc', 'shader-f16'],
      limits: { maxTextureDimension2D: 16384, maxBufferSize: 2147483648 }
    }
  });

  const adapter = await win.navigator.gpu.requestAdapter();
  assert.strictEqual(adapter.features.has('texture-compression-astc'), false, 'Desktop Intel must not have ASTC');
  assert.strictEqual(adapter.features.has('texture-compression-etc2'), false, 'Desktop Intel must not have ETC2');
  assert.strictEqual(adapter.features.has('shader-f16'), false, 'Intel Gen9 must not have shader-f16');
  assert.strictEqual(adapter.features.has('texture-compression-bc'), true, 'Desktop Intel must retain BC');
  assert.strictEqual(adapter.features.size, 1, 'Filtered features size must equal 1');

  // Iterators must reflect filtered set
  const iterValues = Array.from(adapter.features);
  assert.deepStrictEqual(iterValues, ['texture-compression-bc']);

  // Illegal invocation traps
  let threwHas = false;
  try { win.GPUSupportedFeatures.prototype.has.call({}, 'texture-compression-bc'); } catch (e) { if (e instanceof win.TypeError) threwHas = true; }
  assert(threwHas, 'features.has on illegal receiver must throw TypeError');

  let threwSize = false;
  try { Object.getOwnPropertyDescriptor(win.GPUSupportedFeatures.prototype, 'size').get.call({}); } catch (e) { if (e instanceof win.TypeError) threwSize = true; }
  assert(threwSize, 'features.size on illegal receiver must throw TypeError');

  let threwLimits = false;
  try { Object.getOwnPropertyDescriptor(win.GPUSupportedLimits.prototype, 'maxTextureDimension2D').get.call({}); } catch (e) { if (e instanceof win.TypeError) threwLimits = true; }
  assert(threwLimits, 'limits getter on illegal receiver must throw TypeError');
});

check('Task C: DedicatedWorker maintains identical WebGPU feature filtering and brand checks', async () => {
  const nvidiaFp = {
    webgpu: {
      mode: 'webgl',
      gpu: { vendor: 'nvidia', architecture: 'ampere' }
    }
  };
  const { worker } = createMockWorker({
    fingerprint: nvidiaFp,
    adapterCfg: {
      features: ['texture-compression-astc', 'texture-compression-bc', 'shader-f16'],
      limits: { maxTextureDimension2D: 16384 }
    }
  });

  const adapter = await worker.navigator.gpu.requestAdapter();
  assert.strictEqual(adapter.features.has('texture-compression-astc'), false, 'Worker NVIDIA must filter ASTC');
  assert.strictEqual(adapter.features.has('texture-compression-bc'), true, 'Worker NVIDIA retains BC');
  assert.strictEqual(adapter.features.size, 2, 'Worker filtered features size must be 2');

  let threwWorkerHas = false;
  try { worker.GPUSupportedFeatures.prototype.has.call({}, 'texture-compression-bc'); } catch (e) { if (e instanceof worker.TypeError) threwWorkerHas = true; }
  assert(threwWorkerHas, 'Worker features.has on illegal receiver throws TypeError');
});

// ============================================================================
// TASK D: Media Device Labels Dispatched by Persona OS & Profile Uniqueness
// ============================================================================
check('Task D: Media device templates are dispatched correctly by persona OS', () => {
  const winDevs = fp.createMediaDevicesFromSeed('profile-1', { os: 'windows' });
  assert(winDevs.some(d => d.label.includes('Realtek') || d.label.includes('Conexant') || d.label.includes('Synaptics')), 'Windows audio label');
  assert(winDevs.some(d => d.label.includes('Integrated Camera')), 'Windows camera label');

  const macDevs = fp.createMediaDevicesFromSeed('profile-1', { os: 'macos' });
  assert(macDevs.some(d => d.label.includes('Built-in') || d.label.includes('MacBook') || d.label.includes('Mac mini')), 'macOS audio label');
  assert(macDevs.some(d => d.label.includes('FaceTime HD Camera')), 'macOS camera label');

  const androidDevs = fp.createMediaDevicesFromSeed('profile-1', { os: 'android' });
  assert(androidDevs.some(d => d.label.includes('Built-in Audio') || d.label.includes('Built-in Microphone') || d.label.includes('Phone') || d.label.includes('Internal Audio')), 'Android audio label');
  assert(androidDevs.some(d => d.label.includes('Back Camera') || d.label.includes('Front Camera') || d.label.includes('Rear Camera')), 'Android camera label');

  const linuxDevs = fp.createMediaDevicesFromSeed('profile-1', { os: 'linux' });
  assert(linuxDevs.some(d => d.label.includes('Built-in Audio Analog Stereo') || d.label.includes('PulseAudio')), 'Linux audio label');

  // Chrome shape: 64-char hex
  for (const dev of [...winDevs, ...macDevs, ...androidDevs, ...linuxDevs]) {
    assert(/^[0-9a-f]{64}$/.test(dev.deviceId), 'deviceId must be 64-character hex');
    assert(/^[0-9a-f]{64}$/.test(dev.groupId), 'groupId must be 64-character hex');
  }

  // Cross-profile uniqueness
  const macDevs2 = fp.createMediaDevicesFromSeed('profile-2', { os: 'macos' });
  assert.notStrictEqual(macDevs[0].deviceId, macDevs2[0].deviceId, 'Distinct profiles must have distinct deviceIds');
  assert.notStrictEqual(macDevs[0].groupId, macDevs2[0].groupId, 'Distinct profiles must have distinct groupIds');

  // Empty labels mode
  const empty = fp.createMediaDevicesFromSeed('profile-1', { os: 'macos', emptyLabels: true });
  assert.strictEqual(empty[0].label, '', 'emptyLabels mode must produce empty string label');
});

// ============================================================================
// TASK E: ClientRects Geometry Invariants & Zero-Dimension Preservation
// ============================================================================
check('Task E: Zero-sized boxes keep exact 0 dimensions with negative noise step', () => {
  // Construct a profile with negative sizeStep: mark = 5 => (5 % 5) - 2 = -2. noiseSize = -0.0002
  const negativeStepFp = fp.buildFingerprint({
    id: 'clientrect-neg-test',
    privacy: { clientRects: 'noise' },
    fingerprint: { clientRectsId: 5 }
  });

  const { win } = createMockWindow({ fingerprint: negativeStepFp });

  // 1. Zero element (width: 0, height: 0)
  const zeroElem = new win.Element([new win.DOMRect(20, 30, 0, 0)]);
  const zeroRect = zeroElem.getBoundingClientRect();
  assert.strictEqual(zeroRect.width, 0, 'Zero width must remain exactly 0');
  assert.strictEqual(zeroRect.height, 0, 'Zero height must remain exactly 0');
  assert.strictEqual(zeroRect.right, zeroRect.x, 'right must equal x for zero width');
  assert.strictEqual(zeroRect.bottom, zeroRect.y, 'bottom must equal y for zero height');
  assert(zeroRect.width >= 0, 'width must never be negative');
  assert(zeroRect.height >= 0, 'height must never be negative');

  // 2. getClientRects list on zero element
  const zeroList = zeroElem.getClientRects();
  assert.strictEqual(zeroList.length, 1);
  assert.strictEqual(zeroList[0].width, 0, 'List rect width must be 0');
  assert.strictEqual(zeroList[0].height, 0, 'List rect height must be 0');
  assert.strictEqual(zeroList[0].right, zeroList[0].x);
  assert.strictEqual(zeroList[0].bottom, zeroList[0].y);

  // 3. Micro dimension element (width: 0.0001, height: 0.0001) - clamped by Math.max(0, ...)
  const microElem = new win.Element([new win.DOMRect(10, 10, 0.0001, 0.0001)]);
  const microRect = microElem.getBoundingClientRect();
  assert.strictEqual(microRect.width, 0, 'Micro rect width clamped to 0, never negative');
  assert.strictEqual(microRect.height, 0, 'Micro rect height clamped to 0, never negative');

  // 4. Non-zero element (width: 120, height: 60)
  const regularElem = new win.Element([new win.DOMRect(10, 20, 120, 60)]);
  const regularRect = regularElem.getBoundingClientRect();
  assert(regularRect.width > 0, 'Regular width must be positive');
  assert.notStrictEqual(regularRect.width, 120, 'Regular width must be perturbed');
  assert.notStrictEqual(regularRect.height, 60, 'Regular height must be perturbed');
  // Ensure x/y perturbation still active for cross-profile entropy
  assert.notStrictEqual(regularRect.x, 10, 'x coordinate must be perturbed');
  assert.notStrictEqual(regularRect.y, 20, 'y coordinate must be perturbed');
});

// Summary report
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} checks passed.`);
if (passed !== total) {
  process.exitCode = 1;
}
