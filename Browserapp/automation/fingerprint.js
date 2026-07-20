'use strict';

/**
 * Deterministic fingerprint profile for multi-open isolation.
 *
 * Stock Chromium path (no custom kernel):
 *  - isolated user-data-dir
 *  - CDP Emulation (timezone / geo / UA-CH / locale / device metrics)
 *  - document-start JS injection for navigator, canvas/webgl/audio/clientRects noise,
 *    mediaDevices, speech voices, WebRTC policy, WebGPU adapter info
 *
 * Config is split into:
 *  - staticConfig: stable noise identity (marks, cores, platform, devices, webgl payload)
 *  - dynamicConfig: exit-IP layer (timezone, geoposition, webrtc address/mode)
 *
 * Kernel-only surfaces (MAC, device name, file-protocol static/dynamic consumers,
 * full TLS/JA3 gateway) are out of scope for this module.
 */

const crypto = require('crypto');
const {
  buildUaProfile,
  randomUaForSeed,
  chromeArgsForUa,
  cdpUserAgentOverride,
  buildUaInjectionScript,
  parseOsFromUa,
  OS_PRESETS,
} = require('./user-agent');

function hashSeed(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest();
}

function u32(buf, offset = 0) {
  return buf.readUInt32BE(offset % (buf.length - 3));
}

function mulberry32(a) {
  return function next() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// WebGL vendor/renderer presets + optional GPUAdapterInfo
const WEBGL_PRESETS = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'gcn-4' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
  ],
  macos: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)', gpu: { vendor: 'apple', architecture: 'common-3' } },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)', gpu: { vendor: 'apple', architecture: 'common-3' } },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)', gpu: { vendor: 'intel', architecture: 'gen9' } },
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series (RADV POLARIS10), OpenGL 4.6)', gpu: { vendor: 'amd', architecture: 'gcn-4' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.6)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
  ],
};

const MEDIA_DEVICE_TEMPLATES = [
  { input: 'Microphone Array (2- Realtek High Definition Audio)', output: 'Speaker/Headphone (2- Realtek High Definition Audio)' },
  { input: 'Microphone Array (Realtek High Definition Audio)', output: 'Speaker/Headphone (Realtek High Definition Audio)' },
  { input: 'Microphone Array (Realtek(R) Audio)', output: 'Speaker (Realtek(R) Audio)' },
  { input: 'Microphone Array (Conexant SmartAudio HD)', output: 'Speaker (Conexant SmartAudio HD)' },
  { input: 'Microphone Array (2- Conexant SmartAudio HD)', output: 'Speaker (2- Conexant SmartAudio HD)' },
  { input: 'Microphone Array (Synaptics Audio)', output: 'Speaker (Synaptics Audio)' },
];

const SPEECH_VOICE_POOL = [
  { name: 'Alex', lang: 'en-US' }, { name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' },
  { name: 'Ting-Ting', lang: 'zh-CN' }, { name: 'Mei-Jia', lang: 'zh-TW' }, { name: 'Kyoko', lang: 'ja-JP' },
  { name: 'Yuna', lang: 'ko-KR' }, { name: 'Thomas', lang: 'fr-FR' }, { name: 'Anna', lang: 'de-DE' },
  { name: 'Monica', lang: 'es-ES' }, { name: 'Alice', lang: 'it-IT' }, { name: 'Zira', lang: 'en-US' },
  { name: 'Google US English', lang: 'en-US' }, { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
  { name: 'Microsoft David - English (United States)', lang: 'en-US' },
];


/** High-risk hosts where canvas/webgl noise stays tighter for session consistency. */
const DEFAULT_STABILITY_HOSTS = [
  'amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it',
  'amazonaws.com', 'smile.amazon.com',
  'shopee.com', 'shopee.sg', 'shopee.co.id', 'shopee.tw', 'shopee.vn', 'shopee.co.th', 'shopee.ph', 'shopee.com.my', 'shopee.com.br',
  'lazada.com', 'lazada.sg', 'lazada.co.id', 'lazada.com.my', 'lazada.vn', 'lazada.co.th', 'lazada.ph',
  'tiktok.com', 'tiktokv.com', 'bytedance.com',
  'ebay.com', 'ebay.co.uk', 'ebay.de',
  'paypal.com', 'stripe.com', 'checkout.stripe.com',
  'binance.com', 'coinbase.com', 'okx.com', 'bybit.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'google.com', 'accounts.google.com', 'gmail.com',
  'microsoft.com', 'login.live.com', 'account.microsoft.com',
  'apple.com', 'icloud.com',
  'browserleaks.com', 'browserleaks.org', 'creepjs.com', 'amiunique.org', 'coveryourtracks.eff.org',
  'fingerprintjs.com', 'fingerprint.com', 'pixelscan.net', 'sannysoft.com', 'bot.sannysoft.com',
  'iphey.com', 'whoer.net', 'whatismybrowser.com', 'deviceinfo.me',
];

/** Hosts that should keep normal noise even when parent domains match. */
const DEFAULT_STABILITY_SKIP_HOSTS = [
  'sephora.com', 'whatsapp.com', 'web.whatsapp.com', 'dhgate.com', 'cdn.', 'static.',
];

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '');
}

function hostMatchesPattern(host, pattern) {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!h || !p) return false;
  if (p.endsWith('.')) return h === p.slice(0, -1) || h.endsWith('.' + p.slice(0, -1)) || h.startsWith(p);
  if (h === p) return true;
  return h.endsWith('.' + p);
}

function listIncludesHost(list, host) {
  if (!Array.isArray(list) || !list.length) return false;
  const h = normalizeHost(host);
  if (!h) return false;
  return list.some((item) => hostMatchesPattern(h, item));
}

/**
 * Resolve site-aware canvas/webgl stability.
 * mode: off | auto | force
 * On high-risk hosts (not skipped): reduced noise amplitude for tighter consistency.
 */
function resolveStabilityPolicy(privacy = {}, options = {}) {
  const fpIn = privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : {};
  const modeRaw = String(options.mode || fpIn.stabilityMode || privacy.stabilityMode || 'auto').toLowerCase();
  const mode = ['off', 'auto', 'force'].includes(modeRaw) ? modeRaw : 'auto';
  const customHosts = Array.isArray(fpIn.stabilityHosts)
    ? fpIn.stabilityHosts
    : (Array.isArray(privacy.stabilityHosts) ? privacy.stabilityHosts : null);
  const customSkip = Array.isArray(fpIn.stabilitySkipHosts)
    ? fpIn.stabilitySkipHosts
    : (Array.isArray(privacy.stabilitySkipHosts) ? privacy.stabilitySkipHosts : null);
  const hosts = (customHosts && customHosts.length ? customHosts : DEFAULT_STABILITY_HOSTS)
    .map(normalizeHost).filter(Boolean).slice(0, 800);
  const skipHosts = (customSkip && customSkip.length ? customSkip : DEFAULT_STABILITY_SKIP_HOSTS)
    .map(normalizeHost).filter(Boolean).slice(0, 200);
  const hamming = Math.min(64, Math.max(1, Number(fpIn.stabilityHamming ?? privacy.stabilityHamming) || 12));
  const maxWidth = Math.min(4096, Math.max(64, Number(fpIn.stabilityMaxWidth ?? privacy.stabilityMaxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(64, Number(fpIn.stabilityMaxHeight ?? privacy.stabilityMaxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(fpIn.stabilitySquare ?? privacy.stabilitySquare) || 8));
  const host = normalizeHost(options.host || options.hostname || '');
  const skipped = host ? listIncludesHost(skipHosts, host) : false;
  const matched = host ? listIncludesHost(hosts, host) : false;
  let active = false;
  if (mode === 'force') active = !skipped;
  else if (mode === 'auto') active = matched && !skipped;
  // reduced amplitude: 1 (stable) vs 3 (default) pixel delta range
  const noiseAmplitude = active ? 1 : 3;
  const sampleStepDivisor = active ? 128 : 64;
  return {
    mode,
    active,
    matched,
    skipped,
    host: host || null,
    hosts,
    skipHosts,
    hamming,
    maxWidth,
    maxHeight,
    square,
    noiseAmplitude,
    sampleStepDivisor,
  };
}

function matchStabilityHost(host, privacy = {}) {
  return resolveStabilityPolicy(privacy, { host }).active;
}

/** Sample R-channel block origins for canvas consistency checks. */
function sampleCanvasBlocks(data, width, height, options = {}) {
  const maxWidth = Math.min(4096, Math.max(1, Number(options.maxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(1, Number(options.maxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(options.square) || 8));
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const limitW = w > 0 ? Math.min(w, maxWidth) : 0;
  const limitH = h > 0 ? Math.min(h, maxHeight) : 0;
  const samples = [];
  if (!data || !limitW || !limitH) return samples;
  const len = data.length;
  for (let y = 0; y < limitH; y += square) {
    for (let x = 0; x < limitW; x += square) {
      const px = ((y * w) + x) * 4;
      if (px >= len) continue;
      samples.push(data[px] & 0xff);
    }
  }
  return samples;
}

/** Bit-level Hamming distance between equal-length byte arrays / number arrays. */
function hammingDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const n = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < n; i += 1) {
    let x = (a[i] ^ b[i]) & 0xff;
    // popcount
    x = x - ((x >>> 1) & 0x55);
    x = (x & 0x33) + ((x >>> 2) & 0x33);
    dist += (((x + (x >>> 4)) & 0x0f) * 0x01) & 0xff;
  }
  dist += Math.abs((a.length || 0) - (b.length || 0)) * 8;
  return dist;
}

/**
 * Apply deterministic block noise and optionally lock deltas for session consistency.
 * When lockMap is provided and key exists, reuses prior deltas so repeated reads stay within hamming threshold.
 */
function applyStableCanvasNoise(imageData, mark, options = {}) {
  const data = imageData && imageData.data;
  if (!data) return imageData;
  const width = imageData.width || 0;
  const height = imageData.height || 0;
  const maxWidth = Math.min(4096, Math.max(1, Number(options.maxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(1, Number(options.maxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(options.square) || 8));
  const amp = Math.max(1, Number(options.noiseAmplitude) || 1);
  const seedNum = Number(options.seedNum) || 1;
  const noise = typeof options.noise === 'function'
    ? options.noise
    : ((n) => {
      let x = Math.sin((n + 1) * seedNum) * 10000;
      return x - Math.floor(x);
    });
  const limitW = width > 0 ? Math.min(width, maxWidth) : width;
  const limitH = height > 0 ? Math.min(height, maxHeight) : height;
  const lockMap = options.lockMap || null;
  const lockKey = options.lockKey || `${width}x${height}:${mark}:${square}:${amp}`;
  let locked = lockMap && lockMap.get ? lockMap.get(lockKey) : null;
  if (!locked) {
    locked = [];
    for (let y = 0; y < (limitH || height); y += square) {
      for (let x = 0; x < (limitW || width); x += square) {
        const px = ((y * width) + x) * 4;
        if (px + 3 >= data.length) continue;
        const delta = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
        locked.push({ px, delta });
      }
    }
    if (lockMap && lockMap.set) lockMap.set(lockKey, locked);
  }
  for (const item of locked) {
    const px = item.px;
    if (px + 3 >= data.length) continue;
    data[px] = Math.max(0, Math.min(255, data[px] + item.delta));
  }
  return imageData;
}

/** True when two sample vectors are within the configured Hamming threshold. */
function withinHammingThreshold(a, b, threshold = 12) {
  const limit = Math.min(64, Math.max(0, Number(threshold) || 12));
  return hammingDistance(a, b) <= limit;
}



/** Deterministic battery snapshot derived from seed. */
function createBatteryFromSeed(seedInput, override = null) {
  if (override && typeof override === 'object') {
    const level = Math.min(1, Math.max(0, Number(override.level)));
    const charging = override.charging !== false && override.charging !== 0 && override.charging !== '0';
    return {
      charging,
      // null means "unknown / Infinity" for JSON-safe transport into injection
      chargingTime: Number.isFinite(Number(override.chargingTime))
        ? Math.max(0, Number(override.chargingTime))
        : (charging ? 0 : null),
      dischargingTime: Number.isFinite(Number(override.dischargingTime))
        ? Math.max(0, Number(override.dischargingTime))
        : (charging ? null : 7200),
      level: Number.isFinite(level) ? level : 0.87,
    };
  }
  const seed = hashSeed(String(seedInput || 'battery'));
  const levelRaw = 55 + (u32(seed, 0) % 40); // 0.55 - 0.94
  const charging = (u32(seed, 4) % 5) !== 0; // mostly charging on desktop
  const level = levelRaw / 100;
  if (charging) {
    return {
      charging: true,
      chargingTime: 600 + (u32(seed, 8) % 5400),
      dischargingTime: null,
      level,
    };
  }
  return {
    charging: false,
    chargingTime: null,
    dischargingTime: 1800 + (u32(seed, 12) % 14400),
    level,
  };
}

/** Seed-stable mic/camera/speaker labels for mediaDevices spoof. */
function createMediaDevicesFromSeed(seedInput, options = {}) {
  const raw = String(seedInput || 'default');
  let acc = 0;
  let hex = '';
  for (let i = 0; i < raw.length; i += 1) {
    acc += raw.charCodeAt(i);
    hex += acc.toString(16);
  }
  let head = hex.slice(0, 4);
  let tail = hex.slice(-4);
  const pad = ['c', 'd', 'e', 'f'];
  if (head.length < 4) {
    for (let i = 0; i < 4 - head.length; i += 1) {
      head += pad[i];
      tail += pad[pad.length - 1 - i];
    }
  }
  const tpl = MEDIA_DEVICE_TEMPLATES[acc % MEDIA_DEVICE_TEMPLATES.length] || MEDIA_DEVICE_TEMPLATES[0];
  const emptyLabels = options.emptyLabels === true;
  const labelOverride = options.labels && typeof options.labels === 'object' ? options.labels : null;
  const inputLabel = emptyLabels ? '' : String(labelOverride?.audioinput || labelOverride?.input || tpl.input);
  const videoLabel = emptyLabels ? '' : String(labelOverride?.videoinput || labelOverride?.video || `Integrated Camera (${head}:${tail})`);
  const outputLabel = emptyLabels ? '' : String(labelOverride?.audiooutput || labelOverride?.output || tpl.output);
  const devices = [
    { kind: 'audioinput', label: inputLabel, deviceId: `ob-ai-${head}`, groupId: `ob-g-${tail}` },
    { kind: 'videoinput', label: videoLabel, deviceId: `ob-vi-${tail}`, groupId: `ob-g-${tail}` },
    { kind: 'audiooutput', label: outputLabel, deviceId: `ob-ao-${head}${tail.slice(0, 2)}`, groupId: `ob-g-${tail}` },
  ];
  if (Array.isArray(options.extra) && options.extra.length) {
    for (const item of options.extra.slice(0, 8)) {
      if (item && item.kind) devices.push({
        kind: String(item.kind),
        label: String(item.label || ''),
        deviceId: String(item.deviceId || `ob-x-${devices.length}`),
        groupId: String(item.groupId || `ob-g-${tail}`),
      });
    }
  }
  return devices;
}

/** Pick a stable default speech voice matching the primary language. */
function createSpeechVoicesFromSeed(seedInput, languages = ['en-US'], mode = 'noise') {
  if (mode === 'blocked') return [];
  if (mode === 'real') return null;
  const primary = String(languages[0] || 'en-US');
  const primaryLang = primary.split('-')[0].toLowerCase();
  const seed = hashSeed(String(seedInput || primary));
  const count = 4 + (u32(seed, 4) % 5);
  const picked = [];
  const used = new Set();
  for (let i = 0; i < SPEECH_VOICE_POOL.length && picked.length < count; i += 1) {
    const idx = (u32(seed, 8 + i) + i * 3) % SPEECH_VOICE_POOL.length;
    const base = SPEECH_VOICE_POOL[idx];
    const key = `${base.name}|${base.lang}`;
    if (used.has(key)) continue;
    used.add(key);
    picked.push({
      name: base.name,
      lang: base.lang,
      default: false,
      localService: true,
      voiceURI: `ob-voice://${encodeURIComponent(base.name)}/${base.lang}`,
    });
  }
  let def = picked.find((v) => v.lang === primary) || picked.find((v) => v.lang.toLowerCase().startsWith(primaryLang));
  if (!def && picked.length) def = picked[0];
  if (def) {
    def.default = true;
    def.localService = true;
  }
  return picked;
}

/** Audio noise mark: sum(charCode) % 2000 - 1000 */
function audioMarkFromSeed(seedInput) {
  const s = String(seedInput || '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) n += s.charCodeAt(i);
  return (n % 2000) - 1000 || 1;
}

/** ClientRect noise mark: hash % 20000 - 10000 */
function clientRectMarkFromSeed(seedBufOrStr) {
  if (Buffer.isBuffer(seedBufOrStr)) {
    const v = (u32(seedBufOrStr, 40) % 20000) - 10000;
    return v === 0 ? 1 : v;
  }
  const s = String(seedBufOrStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const v = (Math.abs(h) % 20000) - 10000;
  return v === 0 ? 1 : v;
}

/** WebGL fingerprint payload: vendor/renderer + optional GPUAdapterInfo. */
function buildWebglFpPayload(webgl = {}) {
  const payload = {
    UNMASKED_VENDOR_WEBGL: webgl.vendor || '',
    UNMASKED_RENDERER_WEBGL: webgl.renderer || '',
    SUPPORTED_EXTENSIONS: Array.isArray(webgl.extensions) ? webgl.extensions : [],
  };
  if (webgl.gpu && (webgl.gpu.vendor || webgl.gpu.architecture)) {
    payload.GPUAdapterInfo = {
      vendor: String(webgl.gpu.vendor || ''),
      architecture: String(webgl.gpu.architecture || ''),
    };
  }
  return payload;
}

function desktopOs(os) {
  return ['windows', 'macos', 'macos_arm', 'linux'].includes(os) ? os : null;
}

function webglPresetsForOs(os) {
  if (os === 'macos' || os === 'macos_arm') return WEBGL_PRESETS.macos;
  if (os === 'linux') return WEBGL_PRESETS.linux;
  return WEBGL_PRESETS.windows;
}

function expectedClientHintPlatform(os) {
  if (os === 'macos' || os === 'macos_arm') return 'macOS';
  if (os === 'linux') return 'Linux';
  return 'Windows';
}

/**
 * Build fingerprint config from profile + optional privacy.fingerprint overrides.
 */
function buildFingerprint(profile = {}) {
  const stableIdentity = profile.id || profile.name || 'default';
  const launchSeed = String(profile.fingerprintLaunchSeed || '').trim();
  const seed = hashSeed(launchSeed ? `${stableIdentity}:${launchSeed}` : stableIdentity);
  const rnd = mulberry32(u32(seed, 0));
  const privacy = profile.privacy || {};
  const fpIn = privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : {};

  const rawCoresOverride = fpIn.cores ?? privacy.cores;
  const rawMemoryOverride = fpIn.memory ?? privacy.memory;
  const coresOverride = rawCoresOverride === '' || rawCoresOverride === null || rawCoresOverride === undefined ? NaN : Number(rawCoresOverride);
  const memoryOverride = rawMemoryOverride === '' || rawMemoryOverride === null || rawMemoryOverride === undefined ? NaN : Number(rawMemoryOverride);
  const useRealCores = coresOverride === 0;
  const useRealMemory = memoryOverride === 0;
  const cores = Number.isFinite(coresOverride) && coresOverride > 0
    ? Math.min(64, Math.max(1, Math.round(coresOverride)))
    : [4, 6, 8, 12, 16][u32(seed, 12) % 5];
  const memory = Number.isFinite(memoryOverride) && memoryOverride > 0
    ? Math.min(128, Math.max(1, Math.round(memoryOverride)))
    : [4, 8, 8, 16, 32][u32(seed, 16) % 5];
  const width = Number(profile.width) || 1280;
  const height = Number(profile.height) || 820;
  const colorDepth = [24, 24, 30][u32(seed, 20) % 3];
  const devicePixelRatio = [1, 1, 1.25, 1.5, 2][u32(seed, 24) % 5];

  // Numeric noise marks (canvas/webgl ±10000; audio/clientRects from seed formulas unless overridden)
  const canvasId = (u32(seed, 28) % 20000) - 10000 || 1;
  const webglId = (u32(seed, 32) % 20000) - 10000 || 1;
  const audioIdDefault = audioMarkFromSeed(seed.toString('hex'));
  const clientRectsIdDefault = clientRectMarkFromSeed(seed);
  const audioId = Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioIdDefault;
  const clientRectsId = Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsIdDefault;

  const mode = (name, allowed, fallback) => {
    const value = fpIn[name] ?? privacy[name];
    return allowed.includes(String(value || '')) ? String(value) : fallback;
  };

  const canvasMode = mode('canvas', ['real', 'noise', 'blocked'], privacy.canvas === 'blocked' ? 'blocked' : 'noise');
  const webglMode = mode('webgl', ['real', 'noise', 'blocked'], privacy.webgl === 'blocked' ? 'blocked' : 'noise');
  // Metadata (UNMASKED vendor/renderer) can stay real while image noise still runs.
  const webglMetaMode = mode('webglMeta', ['real', 'noise', 'blocked', 'custom'], privacy.webglMeta === 'real' ? 'real' : (privacy.webglMeta === 'blocked' ? 'blocked' : (privacy.webglMeta === 'custom' ? 'custom' : 'noise')));
  const audioMode = mode('audio', ['real', 'noise', 'muted'], privacy.audio === 'muted' ? 'muted' : 'noise');
  const clientRectsMode = mode('clientRects', ['real', 'noise'], 'noise');
  const webrtcMode = mode('webrtc', ['real', 'proxy', 'disabled'], privacy.webrtc || 'proxy');
  // Numeric shadow of webrtc mode only (not an independent control).
  const webrtcPolicy = webrtcMode === 'disabled' ? 0 : (webrtcMode === 'proxy' ? 3 : 1);
  const mediaDevicesMode = mode('mediaDevices', ['real', 'noise', 'empty'], privacy.mediaDevices === 'real' ? 'real' : (privacy.mediaDevices === 'empty' ? 'empty' : (privacy.media === 'noise' ? 'noise' : (privacy.media === 'blocked' ? 'empty' : 'noise'))));
  const speechMode = mode('speech', ['real', 'noise', 'blocked'], privacy.speech === 'blocked' ? 'blocked' : (privacy.speech === 'noise' ? 'noise' : 'real'));
  const batteryMode = mode('battery', ['real', 'noise', 'blocked'], privacy.battery === 'blocked' ? 'blocked' : (privacy.battery === 'real' ? 'real' : 'noise'));
  const webgpuMode = mode('webgpu', ['real', 'blocked', 'webgl'], privacy.webgpu === 'blocked' ? 'blocked' : (privacy.webgpu === 'webgl' ? 'webgl' : 'real'));
  const stability = resolveStabilityPolicy(privacy, {
    host: fpIn.stabilityHost || privacy.stabilityHost || profile.stabilityHost || '',
    mode: fpIn.stabilityMode || privacy.stabilityMode,
  });

  // --- User-Agent + Client Hints ---
  // Custom profile.userAgent wins; otherwise deterministic seeded UA.
  // clientHints / privacy.fingerprint.clientHints feed UserAgentMetadata.
  const uaOverride = String(fpIn.userAgent || profile.userAgent || '').trim();
  const clientHintsIn = (fpIn.clientHints && typeof fpIn.clientHints === 'object')
    ? fpIn.clientHints
    : (privacy.clientHints && typeof privacy.clientHints === 'object' ? privacy.clientHints : {});
  const kernelMajor = Number(String(profile.kernelVersion || '').match(/^\d+/)?.[0]) || 0;
  let uaProfile;
  if (uaOverride) {
    const osFromUa = parseOsFromUa(uaOverride);
    uaProfile = buildUaProfile({
      userAgent: uaOverride,
      os: fpIn.os || clientHintsIn.os || osFromUa,
      chromeMajor: Number(fpIn.chromeMajor || clientHintsIn.chromeMajor) || undefined,
      chromeFull: fpIn.ua_full_version || clientHintsIn.ua_full_version || fpIn.fullVersion,
      platform: fpIn.platform,
      architecture: clientHintsIn.architecture || fpIn.architecture,
      platform_version: clientHintsIn.platform_version || fpIn.platformVersion,
      model: clientHintsIn.model,
      mobile: clientHintsIn.mobile,
      wow64: clientHintsIn.wow64,
      bitness: clientHintsIn.bitness,
      ua_full_version: clientHintsIn.ua_full_version || fpIn.ua_full_version,
    });
  } else {
    uaProfile = randomUaForSeed(u32(seed, 44), {
      majors: kernelMajor ? [kernelMajor] : undefined,
      // The UA is the source of truth for every OS-facing fingerprint surface.
      osList: ['windows', 'windows', 'macos', 'linux'],
    });
    // Apply explicit clientHints overrides on top of seeded UA
    if (Object.keys(clientHintsIn).length) {
      uaProfile = buildUaProfile({
        userAgent: uaProfile.userAgent,
        os: uaProfile.os,
        chromeMajor: uaProfile.chromeMajor,
        ...clientHintsIn,
        ua_full_version: clientHintsIn.ua_full_version || uaProfile.chromeFull,
      });
    }
  }

  const uaOs = desktopOs(uaProfile.os) || desktopOs(parseOsFromUa(uaProfile.userAgent)) || 'windows';
  const webglOptions = webglPresetsForOs(uaOs);
  const webglPreset = webglOptions[u32(seed, 8) % webglOptions.length];
  const webglGpu = (fpIn.webgpu && typeof fpIn.webgpu === 'object')
    ? {
      vendor: String(fpIn.webgpu.vendor || fpIn.gpuVendor || webglPreset.gpu?.vendor || ''),
      architecture: String(fpIn.webgpu.architecture || fpIn.gpuArchitecture || webglPreset.gpu?.architecture || ''),
    }
    : (webglPreset.gpu || null);

  // Prefer already-resolved profile.language (engine sets JP→ja-JP when languageMode=ip)
  let languagePrimary = String(profile.language || 'en-US').trim() || 'en-US';
  try {
    const { resolveProfileLanguage } = require('./locale-from-country');
    languagePrimary = resolveProfileLanguage(profile, {
      countryCode: profile.exitCountryCode,
    }) || languagePrimary;
  } catch (_) {}
  const languages = String(languagePrimary).split(',').map((s) => s.trim()).filter(Boolean);
  if (!languages.length) languages.push('en-US');

  const screenWidth = Math.max(640, Math.round(Number(fpIn.screenWidth) || width));
  const screenHeight = Math.max(480, Math.round(Number(fpIn.screenHeight) || height));
  const taskbarHeight = Math.max(0, Math.round(Number(fpIn.taskbarHeight) || (uaOs === 'macos' || uaOs === 'macos_arm' ? 25 : 40)));
  const availLeft = Math.round(Number(fpIn.availLeft) || 0);
  const availTop = Math.round(Number(fpIn.availTop) || 0);
  const availWidth = Math.min(screenWidth, Math.max(1, Math.round(Number(fpIn.availWidth) || screenWidth)));
  const availHeight = Math.min(screenHeight, Math.max(1, Math.round(Number(fpIn.availHeight) || (screenHeight - taskbarHeight))));
  const screenX = Math.max(availLeft, Math.round(Number(fpIn.screenX) || availLeft));
  const screenY = Math.max(availTop, Math.round(Number(fpIn.screenY) || availTop));

  const mediaLabelTemplates = (fpIn.mediaLabels && typeof fpIn.mediaLabels === 'object')
    ? fpIn.mediaLabels
    : ((privacy.mediaLabels && typeof privacy.mediaLabels === 'object') ? privacy.mediaLabels : null);
  const mediaDevices = mediaDevicesMode === 'real'
    ? null
    : createMediaDevicesFromSeed(stableIdentity + ':' + seed.toString('hex').slice(0, 12), {
      emptyLabels: mediaDevicesMode === 'empty',
      extra: Array.isArray(fpIn.mediaDevices) ? fpIn.mediaDevices : null,
      labels: mediaLabelTemplates,
    });
  const battery = batteryMode === 'real'
    ? null
    : (batteryMode === 'blocked'
      ? { blocked: true }
      : createBatteryFromSeed(stableIdentity + ':battery:' + seed.toString('hex').slice(0, 8), fpIn.battery || privacy.batterySnapshot || null));
  const speechVoices = createSpeechVoicesFromSeed(
    stableIdentity + ':speech:' + seed.toString('hex').slice(0, 8),
    Array.isArray(fpIn.languages) ? fpIn.languages : languages,
    speechMode
  );

  // Dynamic layer: may change with proxy/exit IP without rebuilding static seeds
  const webrtcAddress = String(
    fpIn.webrtcAddress
    || privacy.webrtcAddress
    || profile.exitIp
    || profile.exitIP
    || ''
  ).trim() || null;
  const timezoneDynamic = String(
    profile.exitTimezone
    || (privacy.timezoneMode === 'custom' ? privacy.timezone : '')
    || privacy.timezone
    || ''
  ).trim() || null;
  let geoposition = null;
  if (privacy.geoMode === 'custom' && Number.isFinite(Number(privacy.latitude)) && Number.isFinite(Number(privacy.longitude))) {
    geoposition = {
      latitude: Number(privacy.latitude),
      longitude: Number(privacy.longitude),
      accuracy: Number(privacy.accuracy) || 100,
    };
  } else if (privacy.geoMode !== 'disabled' && privacy.geoMode !== 'prompt') {
    const lat = Number(profile.exitLatitude);
    const lon = Number(profile.exitLongitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      geoposition = { latitude: lat, longitude: lon, accuracy: Number(privacy.accuracy) || 1000 };
    }
  }

  const webglVendor = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : (fpIn.webglVendor || webglPreset.vendor));
  const webglRenderer = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : (fpIn.webglRenderer || webglPreset.renderer));
  const webgl = {
    mode: webglMode,
    metaMode: webglMetaMode,
    vendor: webglVendor,
    renderer: webglRenderer,
    mark: Number.isFinite(Number(fpIn.webglId)) ? Number(fpIn.webglId) : webglId,
    gpu: webglMetaMode === 'real' ? null : webglGpu,
    stability,
  };
  webgl.fpPayload = buildWebglFpPayload(webgl);

  const fingerprint = {
    seed: seed.toString('hex').slice(0, 16),
    profileId: profile.id,
    platform: fpIn.platform || uaProfile.platform || OS_PRESETS[uaOs].platformNav,
    userAgent: uaProfile.userAgent,
    uaProfile,
    clientHints: uaProfile.clientHints,
    userAgentMetadata: uaProfile.metadata,
    languages: Array.isArray(fpIn.languages) ? fpIn.languages : languages,
    hardwareConcurrency: useRealCores ? null : (Number(fpIn.hardwareConcurrency) > 0 ? Number(fpIn.hardwareConcurrency) : cores),
    deviceMemory: useRealMemory ? null : (Number(fpIn.deviceMemory) > 0 ? Number(fpIn.deviceMemory) : memory),
    screen: {
      width: screenWidth,
      height: screenHeight,
      availWidth,
      availHeight,
      availLeft,
      availTop,
      screenX,
      screenY,
      colorDepth: Number(fpIn.colorDepth) || colorDepth,
      pixelDepth: Number(fpIn.colorDepth) || colorDepth,
      devicePixelRatio: Number(fpIn.devicePixelRatio) || devicePixelRatio,
    },
    webgl,
    canvas: {
      mode: canvasMode,
      mark: Number.isFinite(Number(fpIn.canvasId)) ? Number(fpIn.canvasId) : canvasId,
      stability,
    },
    audio: {
      mode: audioMode,
      mark: Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioId,
    },
    clientRects: {
      mode: clientRectsMode,
      mark: Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsId,
    },
    webrtc: webrtcMode,
    webrtcPolicy,
    webrtcAddress,
    battery: {
      mode: batteryMode,
      value: battery,
    },
    webgpu: {
      mode: webgpuMode,
      gpu: webglGpu,
    },
    mediaDevices: {
      mode: mediaDevicesMode,
      devices: mediaDevices,
      labels: mediaLabelTemplates,
    },
    stability,
    speech: {
      mode: speechMode,
      voices: speechVoices,
    },
    maxTouchPoints: Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0,
    vendor: fpIn.vendor || 'Google Inc.',
    doNotTrack: privacy.dnt ? '1' : null,
    // Static noise identity vs dynamic exit-IP layer
    staticConfig: {
      hardwareConcurrency: useRealCores ? null : (Number(fpIn.hardwareConcurrency) > 0 ? Number(fpIn.hardwareConcurrency) : cores),
      deviceMemory: useRealMemory ? null : (Number(fpIn.deviceMemory) > 0 ? Number(fpIn.deviceMemory) : memory),
      platform: fpIn.platform || uaProfile.platform || OS_PRESETS[uaOs].platformNav,
      langs: Array.isArray(fpIn.languages) ? fpIn.languages : languages,
      canvasMark: Number.isFinite(Number(fpIn.canvasId)) ? Number(fpIn.canvasId) : canvasId,
      webglMark: Number.isFinite(Number(fpIn.webglId)) ? Number(fpIn.webglId) : webglId,
      audioFp: Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioId,
      clientRectFp: Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsId,
      maxTouchPoints: Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0,
      mediaDevices,
      mediaLabels: mediaLabelTemplates,
      battery,
      webrtcPolicy,
      stability,
      userAgentMetadata: uaProfile.metadata,
      webglFp: webgl.fpPayload,
    },
    dynamicConfig: {
      timezone: timezoneDynamic,
      geoposition,
      webrtcAddress,
      webrtc: webrtcMode,
    },
    // deterministic random for scripts
    _r0: rnd(),
  };
  fingerprint.consistency = fingerprintConsistencyIssues(fingerprint);
  return fingerprint;
}

/**
 * Report contradictions that make a configured desktop environment implausible.
 * Overrides remain supported; callers can surface these warnings before launch.
 */
function fingerprintConsistencyIssues(fp) {
  const issues = [];
  const uaOs = desktopOs(fp?.uaProfile?.os) || desktopOs(parseOsFromUa(fp?.userAgent)) || 'windows';
  const expectedPlatform = OS_PRESETS[uaOs]?.platformNav || OS_PRESETS.windows.platformNav;
  const expectedChPlatform = expectedClientHintPlatform(uaOs);
  const renderer = String(fp?.webgl?.renderer || '');
  const vendor = String(fp?.webgl?.vendor || '');

  const add = (code, message, severity = 'warning') => issues.push({ code, severity, message });
  if (fp?.platform !== expectedPlatform) {
    add('platform-ua-mismatch', `navigator.platform (${fp?.platform || 'empty'}) does not match the ${uaOs} user agent.`);
  }
  if (fp?.userAgentMetadata?.platform !== expectedChPlatform) {
    add('client-hints-ua-mismatch', `Client Hints platform (${fp?.userAgentMetadata?.platform || 'empty'}) does not match the ${uaOs} user agent.`);
  }
  if (uaOs === 'windows' && /Apple M[0-9]|OpenGL 4\.1|Mesa|RADV/i.test(renderer)) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a Windows renderer.');
  }
  if ((uaOs === 'macos' || uaOs === 'macos_arm') && (/Direct3D|D3D11|Mesa|RADV/i.test(renderer) || !/Apple|Intel/i.test(vendor + renderer))) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a macOS renderer.');
  }
  if (uaOs === 'linux' && (/Direct3D|D3D11|Apple M[0-9]/i.test(renderer) || !/Mesa|RADV|OpenGL/i.test(renderer))) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a Linux renderer.');
  }
  const screen = fp?.screen || {};
  if (!(Number(screen.width) > 0 && Number(screen.height) > 0 && Number(screen.availWidth) > 0 && Number(screen.availHeight) > 0)) {
    add('screen-invalid', 'Screen dimensions must be positive.', 'error');
  } else if (Number(screen.availWidth) > Number(screen.width) || Number(screen.availHeight) > Number(screen.height)) {
    add('screen-available-invalid', 'Available screen dimensions cannot exceed total screen dimensions.', 'error');
  }
  if (Number(screen.availLeft) + Number(screen.availWidth) > Number(screen.width)
      || Number(screen.availTop) + Number(screen.availHeight) > Number(screen.height)) {
    add('screen-origin-invalid', 'Available screen origin and dimensions must remain inside the screen.', 'error');
  }
  if (Number(screen.screenX) < Number(screen.availLeft) || Number(screen.screenY) < Number(screen.availTop)) {
    add('window-origin-invalid', 'Window origin must not precede the available screen origin.', 'error');
  }
  if (!(Number(screen.devicePixelRatio) > 0 && Number(screen.devicePixelRatio) <= 4)) {
    add('device-pixel-ratio-invalid', 'devicePixelRatio must be within the supported desktop range.', 'error');
  }
  if (fp?.hardwareConcurrency != null && !(Number(fp.hardwareConcurrency) >= 1 && Number(fp.hardwareConcurrency) <= 64)) {
    add('cores-invalid', 'hardwareConcurrency must be between 1 and 64 when overridden.', 'error');
  }
  if (fp?.deviceMemory != null && !(Number(fp.deviceMemory) >= 1 && Number(fp.deviceMemory) <= 128)) {
    add('memory-invalid', 'deviceMemory must be between 1 and 128 when overridden.', 'error');
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

/**
 * Document-start injection implementing noise/block modes.
 */
function buildInjectionScript(fp) {
  const stability = fp.stability || fp.canvas?.stability || resolveStabilityPolicy({}, {});
  const json = JSON.stringify({
    platform: fp.platform,
    userAgent: fp.userAgent,
    languages: fp.languages,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    screen: fp.screen,
    webgl: {
      mode: fp.webgl?.mode,
      metaMode: fp.webgl?.metaMode || 'noise',
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
    },
    canvas: fp.canvas,
    audio: fp.audio,
    clientRects: fp.clientRects,
    webrtc: fp.webrtc,
    webrtcPolicy: fp.webrtcPolicy,
    webrtcAddress: fp.webrtcAddress || null,
    battery: fp.battery || null,
    webgpu: fp.webgpu || null,
    mediaDevices: fp.mediaDevices || null,
    speech: fp.speech || null,
    maxTouchPoints: fp.maxTouchPoints,
    vendor: fp.vendor || fp.uaProfile?.vendor || 'Google Inc.',
    doNotTrack: fp.doNotTrack,
    seed: fp.seed,
    stability: {
      mode: stability.mode,
      active: Boolean(stability.active),
      noiseAmplitude: Number(stability.noiseAmplitude) || 3,
      sampleStepDivisor: Number(stability.sampleStepDivisor) || 64,
      hamming: Number(stability.hamming) || 12,
      maxWidth: Number(stability.maxWidth) || 600,
      maxHeight: Number(stability.maxHeight) || 600,
      square: Number(stability.square) || 8,
      hosts: Array.isArray(stability.hosts) ? stability.hosts.slice(0, 800) : [],
      skipHosts: Array.isArray(stability.skipHosts) ? stability.skipHosts.slice(0, 200) : [],
    },
  });

  // UA + Client Hints (userAgentData) injected first
  const uaScript = fp.uaProfile
    ? buildUaInjectionScript(fp.uaProfile)
    : (fp.userAgent ? buildUaInjectionScript(buildUaProfile({ userAgent: fp.userAgent, platform: fp.platform })) : '');

  return `${uaScript}
(() => {
  try {
  const CFG = ${json};
  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => {
    let x = Math.sin((n + 1) * seedNum) * 10000;
    return x - Math.floor(x);
  };
  const normalizeHost = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/.*$/, '')
    .replace(/:\\d+$/, '')
    .replace(/^\\*\\./, '');
  const hostMatches = (host, pattern) => {
    const h = normalizeHost(host);
    const p = normalizeHost(pattern);
    if (!h || !p) return false;
    if (h === p) return true;
    return h.endsWith('.' + p);
  };
  const listHasHost = (list, host) => Array.isArray(list) && list.some((item) => hostMatches(host, item));
  const currentHost = () => {
    try { return normalizeHost(location && location.hostname); } catch (_) { return ''; }
  };
  const stabilityActiveNow = () => {
    const st = CFG.stability || {};
    if (st.mode === 'force') {
      return !listHasHost(st.skipHosts, currentHost());
    }
    if (st.mode === 'off') return false;
    const host = currentHost();
    if (!host) return Boolean(st.active);
    if (listHasHost(st.skipHosts, host)) return false;
    if (listHasHost(st.hosts, host)) return true;
    return Boolean(st.active);
  };
  const noiseAmplitudeNow = () => stabilityActiveNow() ? (Number(CFG.stability?.noiseAmplitude) || 1) : 3;
  const sampleStepDivisorNow = () => stabilityActiveNow() ? (Number(CFG.stability?.sampleStepDivisor) || 128) : 64;
  const canvasNoiseLocks = new Map();
  const applyCanvasNoise = (imageData, mark) => {
    try {
      const data = imageData.data;
      const amp = noiseAmplitudeNow();
      const maxW = Number(CFG.stability?.maxWidth) || 600;
      const maxH = Number(CFG.stability?.maxHeight) || 600;
      const width = imageData.width || 0;
      const height = imageData.height || 0;
      const limitW = width > 0 ? Math.min(width, maxW) : width;
      const limitH = height > 0 ? Math.min(height, maxH) : height;
      const square = Math.max(2, Number(CFG.stability?.square) || 8);
      const stable = stabilityActiveNow();
      // On high-risk hosts, lock first-read deltas so repeated samples stay within hamming threshold.
      if (stable) {
        const key = width + 'x' + height + ':' + mark + ':' + square + ':' + amp;
        let locked = canvasNoiseLocks.get(key);
        if (!locked) {
          locked = [];
          for (let y = 0; y < (limitH || height); y += square) {
            for (let x = 0; x < (limitW || width); x += square) {
              const px = ((y * width) + x) * 4;
              if (px + 3 >= data.length) continue;
              const delta = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
              locked.push({ px: px, delta: delta });
            }
          }
          canvasNoiseLocks.set(key, locked);
        }
        for (let i = 0; i < locked.length; i += 1) {
          const item = locked[i];
          if (item.px + 3 >= data.length) continue;
          data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
        }
        return imageData;
      }
      for (let y = 0; y < (limitH || height); y += square) {
        for (let x = 0; x < (limitW || width); x += square) {
          const px = ((y * width) + x) * 4;
          if (px + 3 >= data.length) continue;
          const n = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
          data[px] = Math.max(0, Math.min(255, data[px] + n));
        }
      }
    } catch (_) {}
    return imageData;
  };
  const nativeSource = new WeakMap();
  const originalToString = Function.prototype.toString;
  const nativeLike = (wrapper, original) => {
    try { Object.defineProperty(wrapper, 'name', { configurable: true, value: original.name }); } catch (_) {}
    try { Object.defineProperty(wrapper, 'length', { configurable: true, value: original.length }); } catch (_) {}
    try { nativeSource.set(wrapper, originalToString.call(original)); } catch (_) {}
    return wrapper;
  };
  try {
    if (!nativeSource.has(Function.prototype.toString)) {
      const patchedToString = nativeLike(function toString() {
        if (nativeSource.has(this)) return nativeSource.get(this);
        return originalToString.call(this);
      }, originalToString);
      Object.defineProperty(Function.prototype, 'toString', {
        configurable: true,
        writable: true,
        value: patchedToString,
      });
    }
  } catch (_) {}
  const replaceMethod = (proto, key, factory) => {
    try {
      if (!proto || typeof proto[key] !== 'function') return null;
      const original = proto[key];
      const replacement = nativeLike(factory(original), original);
      Object.defineProperty(proto, key, {
        configurable: true,
        enumerable: Object.getOwnPropertyDescriptor(proto, key)?.enumerable || false,
        writable: true,
        value: replacement,
      });
      return original;
    } catch (_) { return null; }
  };

  // --- hide automation (navigator.webdriver / AutomationControlled) ---
  // Real Chrome without automation reports webdriver === false
  try {
    const hideWd = { configurable: true, enumerable: true, get: () => false };
    try { Object.defineProperty(Navigator.prototype, 'webdriver', hideWd); } catch (_) {}
    try { Object.defineProperty(navigator, 'webdriver', hideWd); } catch (_) {}
    try {
      if (navigator.webdriver === true) {
        delete navigator.webdriver;
        Object.defineProperty(navigator, 'webdriver', hideWd);
      }
    } catch (_) {}
  } catch (_) {}
  // cdc_ / $cdc_ selenium leftovers if present
  try {
    for (const key of Object.getOwnPropertyNames(document)) {
      if (/^\\$?cdc_|__selenium|__webdriver|__driver_/.test(key)) {
        try { delete document[key]; } catch (_) {}
      }
    }
  } catch (_) {}

  // --- navigator (non-UA fields; UA handled by uaScript) ---
  // Chromium often installs non-writable prototype getters; force delete + redefine
  // on both Navigator.prototype and the live navigator instance.
  const navPatch = {
    platform: { get: () => CFG.platform },
    maxTouchPoints: { get: () => CFG.maxTouchPoints },
    vendor: { get: () => CFG.vendor },
    languages: { get: () => Object.freeze([...CFG.languages]) },
    language: { get: () => CFG.languages[0] || 'en-US' },
    webdriver: { get: () => false },
  };
  if (CFG.hardwareConcurrency != null) navPatch.hardwareConcurrency = { get: () => CFG.hardwareConcurrency };
  if (CFG.deviceMemory != null) navPatch.deviceMemory = { get: () => CFG.deviceMemory };
  if (CFG.doNotTrack != null) navPatch.doNotTrack = { get: () => CFG.doNotTrack };
  const forceNavProp = (target, key, desc) => {
    try {
      if (!target) return false;
      const full = { configurable: true, enumerable: true, ...desc };
      try {
        const existing = Object.getOwnPropertyDescriptor(target, key);
        if (existing && existing.configurable === false) {
          // Cannot delete/redefine non-configurable; try instance only later.
          return false;
        }
        if (existing) {
          try { delete target[key]; } catch (_) {}
        }
      } catch (_) {}
      Object.defineProperty(target, key, full);
      return true;
    } catch (_) {
      try {
        Object.defineProperty(target, key, { configurable: true, enumerable: true, ...desc });
        return true;
      } catch (__) { return false; }
    }
  };
  try {
    for (const [key, desc] of Object.entries(navPatch)) {
      try {
        forceNavProp(typeof Navigator !== 'undefined' ? Navigator.prototype : null, key, desc);
        forceNavProp(navigator, key, desc);
      } catch (_) {}
    }
  } catch (_) {}

  // Hard override via window.navigator getter + Proxy.
  // Bind methods with Reflect.apply so pages never hit Illegal invocation
  // when they do navigator.x.bind / call through a proxied navigator.
  try {
    const navTarget = navigator;
    const handler = {
      get(t, prop, receiver) {
        try {
          if (Object.prototype.hasOwnProperty.call(navPatch, prop) && navPatch[prop] && typeof navPatch[prop].get === 'function') {
            return navPatch[prop].get();
          }
        } catch (_) {}
        let v;
        try {
          v = Reflect.get(t, prop, t);
        } catch (_) {
          try { v = t[prop]; } catch (__) { return undefined; }
        }
        if (typeof v === 'function') {
          return function (...args) {
            try { return Reflect.apply(v, t, args); }
            catch (_) {
              try { return Function.prototype.apply.call(v, t, args); } catch (__) { return undefined; }
            }
          };
        }
        return v;
      },
      getOwnPropertyDescriptor(t, prop) {
        if (Object.prototype.hasOwnProperty.call(navPatch, prop)) {
          return { configurable: true, enumerable: true, get: () => navPatch[prop].get() };
        }
        try { return Reflect.getOwnPropertyDescriptor(t, prop); } catch (_) { return undefined; }
      },
      has(t, prop) {
        return Object.prototype.hasOwnProperty.call(navPatch, prop) || Reflect.has(t, prop);
      },
      ownKeys(t) {
        try { return Reflect.ownKeys(t); } catch (_) { return []; }
      },
    };
    const proxied = new Proxy(navTarget, handler);
    try {
      Object.defineProperty(window, 'navigator', { configurable: true, enumerable: true, get: () => proxied });
    } catch (_) {
      try { window.navigator = proxied; } catch (__) {}
    }
  } catch (_) {}

  // --- screen ---
  try {
    const s = CFG.screen || {};
    for (const [key, value] of Object.entries({
      width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight,
      availLeft: s.availLeft, availTop: s.availTop,
      colorDepth: s.colorDepth, pixelDepth: s.pixelDepth,
    })) {
      if (value == null) continue;
      try { Object.defineProperty(Screen.prototype, key, { configurable: true, get: () => value }); } catch (_) {}
    }
    try { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => s.devicePixelRatio || 1 }); } catch (_) {}
    for (const [key, value] of Object.entries({ screenX: s.screenX, screenY: s.screenY, screenLeft: s.screenX, screenTop: s.screenY })) {
      try { Object.defineProperty(window, key, { configurable: true, get: () => value || 0 }); } catch (_) {}
    }
  } catch (_) {}

  // --- canvas ---
  if (CFG.canvas && CFG.canvas.mode === 'blocked') {
    const deny = () => { throw new DOMException('Canvas reading is disabled by this profile', 'SecurityError'); };
    try {
      replaceMethod(globalThis.HTMLCanvasElement?.prototype, 'toDataURL', () => deny);
      replaceMethod(globalThis.HTMLCanvasElement?.prototype, 'toBlob', () => function(callback) {
        if (typeof callback === 'function') queueMicrotask(() => callback(null));
      });
      replaceMethod(globalThis.CanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
      replaceMethod(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
      replaceMethod(globalThis.OffscreenCanvas?.prototype, 'convertToBlob', () => function() {
        return Promise.reject(new DOMException('Canvas reading is disabled by this profile', 'SecurityError'));
      });
    } catch (_) {}
  } else if (CFG.canvas && CFG.canvas.mode === 'noise') {
    const mark = Number(CFG.canvas.mark) || 1;
    try {
      const ctxProto = CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
      const originalGet = ctxProto && ctxProto.getImageData ? ctxProto.getImageData : null;
      if (originalGet) {
        replaceMethod(ctxProto, 'getImageData', (original) => function(x, y, w, h) {
          return applyCanvasNoise(original.call(this, x, y, w, h), mark);
        });
      }
      // toDataURL / toBlob: offscreen copy + noise (uses unpatched getImageData to avoid double noise)
      const noiseCanvas = (source) => {
        const w = source.width | 0;
        const h = source.height | 0;
        if (!w || !h || !originalGet) return null;
        const copy = document.createElement('canvas');
        copy.width = w;
        copy.height = h;
        const c2 = copy.getContext('2d');
        if (!c2) return null;
        c2.drawImage(source, 0, 0);
        const image = applyCanvasNoise(originalGet.call(c2, 0, 0, w, h), mark);
        c2.putImageData(image, 0, 0);
        return copy;
      };
      if (HTMLCanvasElement && HTMLCanvasElement.prototype.toDataURL) {
        replaceMethod(HTMLCanvasElement.prototype, 'toDataURL', (original) => function(...args) {
          try {
            const copy = noiseCanvas(this);
            if (copy) return original.apply(copy, args);
          } catch (_) {}
          return original.apply(this, args);
        });
      }
      if (HTMLCanvasElement && HTMLCanvasElement.prototype.toBlob) {
        replaceMethod(HTMLCanvasElement.prototype, 'toBlob', (originalBlob) => function(cb, ...rest) {
          try {
            const copy = noiseCanvas(this);
            if (copy) return originalBlob.call(copy, cb, ...rest);
          } catch (_) {}
          return originalBlob.call(this, cb, ...rest);
        });
      }
      const offscreenProto = globalThis.OffscreenCanvasRenderingContext2D?.prototype;
      if (offscreenProto?.getImageData) {
        replaceMethod(offscreenProto, 'getImageData', (original) => function(x, y, w, h) {
          return applyCanvasNoise(original.call(this, x, y, w, h), mark);
        });
      }
      if (globalThis.OffscreenCanvas?.prototype?.convertToBlob) {
        replaceMethod(OffscreenCanvas.prototype, 'convertToBlob', (original) => async function(options) {
          const blob = await original.call(this, options);
          try {
            const bitmap = await createImageBitmap(blob);
            const copy = new OffscreenCanvas(this.width, this.height);
            const context = copy.getContext('2d');
            if (!context || !offscreenProto?.getImageData) return blob;
            context.drawImage(bitmap, 0, 0);
            bitmap.close?.();
            const image = offscreenProto.getImageData.call(context, 0, 0, copy.width, copy.height);
            context.putImageData(image, 0, 0);
            return original.call(copy, options);
          } catch (_) { return blob; }
        });
      }
    } catch (_) {}
  }

  // --- webgl ---
  if (CFG.webgl && CFG.webgl.mode === 'blocked') {
    try {
      const block = () => null;
      const blockContext = (proto) => replaceMethod(proto, 'getContext', (target) => function(...argArray) {
          const type = String(argArray[0] || '');
          if (type.includes('webgl') || type === 'experimental-webgl') return null;
          return Reflect.apply(target, this, argArray);
      });
      blockContext(globalThis.HTMLCanvasElement?.prototype);
      blockContext(globalThis.OffscreenCanvas?.prototype);
    } catch (_) {}
  } else if (CFG.webgl && (CFG.webgl.mode === 'noise' || (CFG.webgl.metaMode && CFG.webgl.metaMode !== 'real'))) {
    // mode=noise: pixel + meta; mode=real + metaMode=noise/custom/blocked: meta only
    // (native-kernel inject strips pixel noise but keeps meta spoof — see fingerprintForNativeKernelInject)
    try {
      const mark = Number(CFG.webgl.mark) || 1;
      const metaMode = String(CFG.webgl.metaMode || 'noise');
      const pixelNoise = CFG.webgl.mode === 'noise';
      const patchGetParameter = (proto) => {
        if (!proto || !proto.getParameter) return;
        if (metaMode === 'real') return;
        replaceMethod(proto, 'getParameter', (original) => function(param) {
          const UNMASKED_VENDOR_WEBGL = 0x9245;
          const UNMASKED_RENDERER_WEBGL = 0x9246;
          if (param === UNMASKED_VENDOR_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
          if (param === UNMASKED_RENDERER_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
          return original.apply(this, arguments);
        });
      };
      // Subtle deterministic readPixels noise so WebGL hashers diverge per env
      const patchReadPixels = (proto) => {
        if (!pixelNoise || !proto || !proto.readPixels) return;
        replaceMethod(proto, 'readPixels', (original) => function(...args) {
          const result = original.apply(this, args);
          try {
            const pixels = args[6];
            if (pixels && pixels.length) {
              const amp = noiseAmplitudeNow();
              const step = Math.max(4, Math.floor(pixels.length / sampleStepDivisorNow()));
              for (let i = 0; i < pixels.length; i += step) {
                const n = Math.floor(noise(i + mark) * amp) - Math.floor(amp / 2);
                pixels[i] = Math.max(0, Math.min(255, (pixels[i] || 0) + n));
              }
            }
          } catch (_) {}
          return result;
        });
      };
      if (globalThis.WebGLRenderingContext) {
        patchGetParameter(WebGLRenderingContext.prototype);
        patchReadPixels(WebGLRenderingContext.prototype);
      }
      if (globalThis.WebGL2RenderingContext) {
        patchGetParameter(WebGL2RenderingContext.prototype);
        patchReadPixels(WebGL2RenderingContext.prototype);
      }
      // Wrap getContext so every GL instance inherits patched getParameter even if
      // prototypes were frozen after first context creation.
      try {
        const wrapCtx = (proto) => {
          if (!proto || !proto.getContext) return;
          const original = proto.getContext;
          Object.defineProperty(proto, 'getContext', {
            configurable: true,
            writable: true,
            value: function(...args) {
              const ctx = original.apply(this, args);
              try {
                if (ctx && typeof ctx.getParameter === 'function' && metaMode !== 'real') {
                  const origGP = ctx.getParameter.bind(ctx);
                  ctx.getParameter = function(param) {
                    if (param === 0x9245) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
                    if (param === 0x9246) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
                    return origGP(param);
                  };
                }
              } catch (_) {}
              return ctx;
            },
          });
        };
        wrapCtx(globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype);
        wrapCtx(globalThis.OffscreenCanvas && OffscreenCanvas.prototype);
      } catch (_) {}
    } catch (_) {}
  }

  // --- audio ---
  if (CFG.audio && CFG.audio.mode === 'noise') {
    try {
      const mark = Number(CFG.audio.mark) || 1;
      if (globalThis.AudioBuffer && AudioBuffer.prototype.getChannelData) {
        const processed = new WeakMap();
        replaceMethod(AudioBuffer.prototype, 'getChannelData', (original) => function() {
          const data = original.apply(this, arguments);
          try {
            const channel = Number(arguments[0]) || 0;
            let channels = processed.get(this);
            if (!channels) { channels = new Set(); processed.set(this, channels); }
            if (!channels.has(channel)) {
              for (let i = 0; i < data.length; i += 1) {
                data[i] = data[i] + (noise(i + channel * 4099 + mark) - 0.5) * 1e-7;
              }
              channels.add(channel);
            }
          } catch (_) {}
          return data;
        });
      }
    } catch (_) {}
  }

  // --- client rects ---
  if (CFG.clientRects && CFG.clientRects.mode === 'noise') {
    try {
      const mark = Number(CFG.clientRects.mark) || 1;
      const noisePx = ((mark % 7) - 3) * 0.0001;
      const patch = (proto, method) => {
        if (!proto || !proto[method]) return;
        replaceMethod(proto, method, (original) => function() {
          const rect = original.apply(this, arguments);
          if (!rect) return rect;
          try {
            const x = rect.x + noisePx, y = rect.y + noisePx;
            return DOMRect.fromRect ? DOMRect.fromRect({ x, y, width: rect.width, height: rect.height }) : rect;
          } catch (_) { return rect; }
        });
      };
      const patchList = (proto, method) => {
        if (!proto || !proto[method]) return;
        replaceMethod(proto, method, (original) => function() {
          const list = original.apply(this, arguments);
          try {
            const rects = Array.from(list, (rect) => DOMRect.fromRect
              ? DOMRect.fromRect({ x: rect.x + noisePx, y: rect.y + noisePx, width: rect.width, height: rect.height })
              : rect);
            rects.item = (index) => rects[index] || null;
            return rects;
          } catch (_) { return list; }
        });
      };
      patch(Element.prototype, 'getBoundingClientRect');
      patchList(Element.prototype, 'getClientRects');
      if (globalThis.Range) {
        patch(Range.prototype, 'getBoundingClientRect');
        patchList(Range.prototype, 'getClientRects');
      }
    } catch (_) {}
  }

  // --- webrtc ---
  if (CFG.webrtc === 'disabled') {
    try {
      const blocked = function() { throw new DOMException('WebRTC is disabled by this profile', 'NotAllowedError'); };
      if (globalThis.RTCPeerConnection) window.RTCPeerConnection = blocked;
      if (globalThis.webkitRTCPeerConnection) window.webkitRTCPeerConnection = blocked;
    } catch (_) {}
  } else if (CFG.webrtc === 'proxy' && CFG.webrtcAddress) {
    // Keep WebRTC but pin host candidates toward exit IP when exposed
    try {
      const targetIp = String(CFG.webrtcAddress || '');
      const wrapPc = (Original) => {
        if (!Original) return Original;
        const Wrapped = function(...args) {
          const pc = new Original(...args);
          try {
            const rewriteSdp = (desc) => {
              if (!desc || typeof desc.sdp !== 'string' || !targetIp) return desc;
              try {
                return Object.assign({}, desc, {
                  sdp: desc.sdp.replace(/(\\n)a=candidate:.* typ host .*/g, (line) => {
                    return line.replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/, targetIp);
                  }),
                });
              } catch (_) { return desc; }
            };
            const originalCreateOffer = pc.createOffer?.bind(pc);
            if (originalCreateOffer) {
              pc.createOffer = async function(...oArgs) {
                return rewriteSdp(await originalCreateOffer(...oArgs));
              };
            }
            const originalCreateAnswer = pc.createAnswer?.bind(pc);
            if (originalCreateAnswer) {
              pc.createAnswer = async function(...aArgs) {
                return rewriteSdp(await originalCreateAnswer(...aArgs));
              };
            }
            const originalSetLocal = pc.setLocalDescription?.bind(pc);
            if (originalSetLocal) {
              pc.setLocalDescription = async function(desc) {
                return originalSetLocal(rewriteSdp(desc));
              };
            }
          } catch (_) {}
          return pc;
        };
        Wrapped.prototype = Original.prototype;
        try { Object.setPrototypeOf(Wrapped, Original); } catch (_) {}
        return Wrapped;
      };
      if (globalThis.RTCPeerConnection) window.RTCPeerConnection = wrapPc(RTCPeerConnection);
      if (globalThis.webkitRTCPeerConnection) window.webkitRTCPeerConnection = wrapPc(webkitRTCPeerConnection);
    } catch (_) {}
  }

  // --- mediaDevices ---
  if (CFG.mediaDevices && CFG.mediaDevices.mode && CFG.mediaDevices.mode !== 'real' && Array.isArray(CFG.mediaDevices.devices)) {
    try {
      const devices = CFG.mediaDevices.devices.map((d) => ({
        deviceId: String(d.deviceId || ''),
        kind: String(d.kind || ''),
        label: String(d.label || ''),
        groupId: String(d.groupId || ''),
        toJSON() { return { deviceId: this.deviceId, kind: this.kind, label: this.label, groupId: this.groupId }; },
      }));
      const enumerate = async function enumerateDevices() { return devices.slice(); };
      if (navigator.mediaDevices) {
        try {
          Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
            configurable: true, writable: true, value: nativeLike(enumerate, navigator.mediaDevices.enumerateDevices || enumerate),
          });
        } catch (_) {
          try { navigator.mediaDevices.enumerateDevices = enumerate; } catch (__) {}
        }
      }
    } catch (_) {}
  }

  // --- speech voices ---
  if (CFG.speech && CFG.speech.mode === 'blocked') {
    try {
      if (globalThis.speechSynthesis) {
        try { speechSynthesis.cancel(); } catch (_) {}
        Object.defineProperty(speechSynthesis, 'getVoices', { configurable: true, value: () => [] });
      }
    } catch (_) {}
  } else if (CFG.speech && CFG.speech.mode === 'noise' && Array.isArray(CFG.speech.voices)) {
    try {
      const voices = CFG.speech.voices.map((v) => {
        const voice = {
          name: String(v.name || ''),
          lang: String(v.lang || 'en-US'),
          default: Boolean(v.default),
          localService: v.localService !== false,
          voiceURI: String(v.voiceURI || v.name || ''),
        };
        return voice;
      });
      if (globalThis.speechSynthesis) {
        const getVoices = function getVoices() { return voices.slice(); };
        Object.defineProperty(speechSynthesis, 'getVoices', {
          configurable: true, value: nativeLike(getVoices, speechSynthesis.getVoices || getVoices),
        });
      }
    } catch (_) {}
  }


  // --- battery ---
  if (CFG.battery && CFG.battery.mode === 'blocked') {
    try {
      if (navigator.getBattery) {
        const blocked = function getBattery() {
          return Promise.reject(new DOMException('Battery status is disabled by this profile', 'NotAllowedError'));
        };
        Object.defineProperty(navigator, 'getBattery', {
          configurable: true, writable: true, value: nativeLike(blocked, navigator.getBattery),
        });
      }
    } catch (_) {}
  } else if (CFG.battery && CFG.battery.mode === 'noise' && CFG.battery.value && !CFG.battery.value.blocked) {
    try {
      const snap = CFG.battery.value;
      const makeManager = () => {
        const manager = {
          charging: Boolean(snap.charging),
          chargingTime: snap.chargingTime == null ? Infinity : Number(snap.chargingTime),
          dischargingTime: snap.dischargingTime == null ? Infinity : Number(snap.dischargingTime),
          level: Math.min(1, Math.max(0, Number(snap.level) || 0)),
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; },
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
        };
        return manager;
      };
      if (navigator.getBattery) {
        const spoofed = function getBattery() { return Promise.resolve(makeManager()); };
        Object.defineProperty(navigator, 'getBattery', {
          configurable: true, writable: true, value: nativeLike(spoofed, navigator.getBattery),
        });
      }
    } catch (_) {}
  }

  // --- WebGPU adapter info when gpu vendor/architecture is configured ---
  if (CFG.webgl && CFG.webgl.gpu && (CFG.webgl.gpu.vendor || CFG.webgl.gpu.architecture) && navigator.gpu) {
    try {
      const gpuInfo = {
        vendor: String(CFG.webgl.gpu.vendor || ''),
        architecture: String(CFG.webgl.gpu.architecture || ''),
        device: '',
        description: '',
      };
      const originalRequestAdapter = navigator.gpu.requestAdapter?.bind(navigator.gpu);
      if (originalRequestAdapter) {
        navigator.gpu.requestAdapter = async function(...args) {
          const adapter = await originalRequestAdapter(...args);
          if (!adapter) return adapter;
          try {
            Object.defineProperty(adapter, 'info', { configurable: true, get: () => gpuInfo });
            if (typeof adapter.requestAdapterInfo === 'function') {
              adapter.requestAdapterInfo = async () => gpuInfo;
            }
          } catch (_) {}
          return adapter;
        };
      }
    } catch (_) {}
  }
} catch (e) { try { console.warn('[OpenBrowser] fingerprint inject', e && e.message || e); } catch (_) {} }
})();`;
}

/** Worker-safe subset injected before attached workers are resumed. */
function buildWorkerInjectionScript(fp) {
  const stability = fp.stability || fp.canvas?.stability || resolveStabilityPolicy({}, {});
  const json = JSON.stringify({
    platform: fp.platform,
    userAgent: fp.userAgent,
    appVersion: fp.uaProfile?.appVersion || String(fp.userAgent || '').replace(/^Mozilla\//, ''),
    vendor: fp.vendor || fp.uaProfile?.vendor || 'Google Inc.',
    userAgentMetadata: fp.userAgentMetadata,
    languages: fp.languages,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    webgl: {
      mode: fp.webgl?.mode,
      metaMode: fp.webgl?.metaMode || 'noise',
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
    },
    canvas: fp.canvas,
    seed: fp.seed,
    stability: {
      active: Boolean(stability.active),
      mode: String(stability.mode || 'auto'),
      hosts: Array.isArray(stability.hosts) ? stability.hosts : [],
      skipHosts: Array.isArray(stability.skipHosts) ? stability.skipHosts : [],
      noiseAmplitude: Number(stability.noiseAmplitude) || 3,
      sampleStepDivisor: Number(stability.sampleStepDivisor) || 64,
      maxWidth: Number(stability.maxWidth) || 600,
      maxHeight: Number(stability.maxHeight) || 600,
      square: Number(stability.square) || 8,
    },
  });
  return `(() => {
  const CFG = ${json};
  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => { const x = Math.sin((n + 1) * seedNum) * 10000; return x - Math.floor(x); };
  const square = Math.max(2, Number(CFG.stability?.square) || 8);
  const workerLocks = new Map();
  const normalizeHost = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\\d+$/, '')
    .replace(/^\\*\\./, '');
  const hostMatches = (host, pattern) => {
    const h = normalizeHost(host);
    const p = normalizeHost(pattern);
    if (!h || !p) return false;
    if (h === p) return true;
    return h.endsWith('.' + p);
  };
  const listHasHost = (list, host) => Array.isArray(list) && list.some((item) => hostMatches(host, item));
  const currentHost = () => {
    try { return normalizeHost(self && self.location && self.location.hostname); } catch (_) { return ''; }
  };
  // Match main-thread stabilityActiveNow: evaluate host at noise-time, not only at launch.
  const stabilityActiveNow = () => {
    const st = CFG.stability || {};
    if (st.mode === 'force') return !listHasHost(st.skipHosts, currentHost());
    if (st.mode === 'off') return false;
    const host = currentHost();
    if (!host) return Boolean(st.active);
    if (listHasHost(st.skipHosts, host)) return false;
    if (listHasHost(st.hosts, host)) return true;
    return Boolean(st.active);
  };
  const noiseAmplitudeNow = () => stabilityActiveNow() ? 1 : (Number(CFG.stability?.noiseAmplitude) || 3);
  const sampleStepDivisorNow = () => stabilityActiveNow()
    ? (Number(CFG.stability?.sampleStepDivisor) || 128)
    : 64;
  const applyNoise = (imageData, mark) => {
    try {
      const data = imageData.data;
      const width = imageData.width || 0;
      const height = imageData.height || 0;
      const maxW = Number(CFG.stability?.maxWidth) || 600;
      const maxH = Number(CFG.stability?.maxHeight) || 600;
      const limitW = width > 0 ? Math.min(width, maxW) : width;
      const limitH = height > 0 ? Math.min(height, maxH) : height;
      const amp = noiseAmplitudeNow();
      const stableWorker = stabilityActiveNow();
      if (width > 0 && height > 0) {
        if (stableWorker) {
          const key = width + 'x' + height + ':' + mark + ':' + square + ':' + amp;
          let locked = workerLocks.get(key);
          if (!locked) {
            locked = [];
            for (let y = 0; y < limitH; y += square) {
              for (let x = 0; x < limitW; x += square) {
                const px = ((y * width) + x) * 4;
                if (px + 3 >= data.length) continue;
                locked.push({ px: px, delta: Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2) });
              }
            }
            workerLocks.set(key, locked);
          }
          for (let i = 0; i < locked.length; i += 1) {
            const item = locked[i];
            if (item.px + 3 >= data.length) continue;
            data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
          }
          return imageData;
        }
        for (let y = 0; y < limitH; y += square) {
          for (let x = 0; x < limitW; x += square) {
            const px = ((y * width) + x) * 4;
            if (px + 3 >= data.length) continue;
            const n = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
            data[px] = Math.max(0, Math.min(255, data[px] + n));
          }
        }
      } else {
        for (let i = 0; i < data.length; i += 4) {
          const n = Math.floor(noise(i + mark) * amp) - Math.floor(amp / 2);
          data[i] = Math.max(0, Math.min(255, data[i] + n));
        }
      }
    } catch (_) {}
    return imageData;
  };
  const sources = new WeakMap();
  const originalToString = Function.prototype.toString;
  const nativeLike = (wrapper, original) => {
    try { Object.defineProperty(wrapper, 'name', { configurable: true, value: original.name }); } catch (_) {}
    try { Object.defineProperty(wrapper, 'length', { configurable: true, value: original.length }); } catch (_) {}
    try { sources.set(wrapper, originalToString.call(original)); } catch (_) {}
    return wrapper;
  };
  try {
    const patched = nativeLike(function toString() {
      if (sources.has(this)) return sources.get(this);
      return originalToString.call(this);
    }, originalToString);
    Object.defineProperty(Function.prototype, 'toString', { configurable: true, writable: true, value: patched });
  } catch (_) {}
  const replace = (proto, key, factory) => {
    try {
      if (!proto || typeof proto[key] !== 'function') return;
      const original = proto[key];
      Object.defineProperty(proto, key, { configurable: true, writable: true, value: nativeLike(factory(original), original) });
    } catch (_) {}
  };
  try {
    const navProto = globalThis.WorkerNavigator?.prototype;
    if (navProto) {
      const navValues = {
        platform: CFG.platform,
        userAgent: CFG.userAgent,
        appVersion: CFG.appVersion,
        vendor: CFG.vendor,
        languages: Object.freeze([...(CFG.languages || [])]),
        language: (CFG.languages || [])[0] || 'en-US',
      };
      if (CFG.hardwareConcurrency != null) navValues.hardwareConcurrency = CFG.hardwareConcurrency;
      if (CFG.deviceMemory != null) navValues.deviceMemory = CFG.deviceMemory;
      for (const [key, value] of Object.entries(navValues)) {
        try { Object.defineProperty(navProto, key, { configurable: true, enumerable: true, get: () => value }); } catch (_) {}
      }
      const metadata = CFG.userAgentMetadata || {};
      const brands = Object.freeze((metadata.brands || []).map((item) => Object.freeze({ brand: String(item.brand), version: String(item.version) })));
      const fullVersionList = Object.freeze((metadata.fullVersionList || brands).map((item) => Object.freeze({ brand: String(item.brand), version: String(item.version) })));
      const uaData = Object.freeze({
        brands,
        mobile: Boolean(metadata.mobile),
        platform: String(metadata.platform || ''),
        getHighEntropyValues(hints) {
          const values = {
            brands,
            fullVersionList,
            fullVersion: String(metadata.fullVersion || metadata.uaFullVersion || ''),
            uaFullVersion: String(metadata.uaFullVersion || metadata.fullVersion || ''),
            platform: String(metadata.platform || ''),
            platformVersion: String(metadata.platformVersion || ''),
            architecture: String(metadata.architecture || ''),
            model: String(metadata.model || ''),
            mobile: Boolean(metadata.mobile),
            bitness: String(metadata.bitness || '64'),
            wow64: Boolean(metadata.wow64),
          };
          const out = { brands, mobile: values.mobile, platform: values.platform };
          for (const hint of Array.isArray(hints) ? hints : []) if (hint in values) out[hint] = values[hint];
          return Promise.resolve(out);
        },
        toJSON() { return { brands, mobile: Boolean(metadata.mobile), platform: String(metadata.platform || '') }; },
      });
      try { Object.defineProperty(navProto, 'userAgentData', { configurable: true, enumerable: true, get: () => uaData }); } catch (_) {}
    }
  } catch (_) {}
  const canvasMark = Number(CFG.canvas?.mark) || 1;
  if (CFG.canvas?.mode === 'blocked') {
    const deny = () => { throw new DOMException('Canvas reading is disabled by this profile', 'SecurityError'); };
    replace(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
    replace(globalThis.OffscreenCanvas?.prototype, 'convertToBlob', () => function() {
      return Promise.reject(new DOMException('Canvas reading is disabled by this profile', 'SecurityError'));
    });
  } else if (CFG.canvas?.mode === 'noise') {
    replace(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', (original) => function(...args) {
      return applyNoise(original.apply(this, args), canvasMark);
    });
    replace(globalThis.OffscreenCanvas?.prototype, 'convertToBlob', (original) => async function(options) {
      const blob = await original.call(this, options);
      try {
        const bitmap = await createImageBitmap(blob);
        const copy = new OffscreenCanvas(this.width, this.height);
        const context = copy.getContext('2d');
        if (!context) return blob;
        context.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const image = context.getImageData(0, 0, copy.width, copy.height);
        context.putImageData(image, 0, 0);
        return original.call(copy, options);
      } catch (_) { return blob; }
    });
  }
  if (CFG.webgl?.mode === 'blocked') {
    replace(globalThis.OffscreenCanvas?.prototype, 'getContext', (original) => function(type, ...rest) {
      const value = String(type || '');
      if (value.includes('webgl') || value === 'experimental-webgl') return null;
      return original.call(this, type, ...rest);
    });
  } else if (CFG.webgl && (CFG.webgl.mode === 'noise' || (CFG.webgl.metaMode && CFG.webgl.metaMode !== 'real'))) {
    const mark = Number(CFG.webgl?.mark) || 1;
    const pixelNoise = CFG.webgl.mode === 'noise';
    const patch = (proto) => {
      const metaMode = String(CFG.webgl?.metaMode || 'noise');
      if (metaMode !== 'real') {
        replace(proto, 'getParameter', (original) => function(param) {
          if (param === 0x9245) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
          if (param === 0x9246) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
          return original.apply(this, arguments);
        });
      }
      if (!pixelNoise) return;
      replace(proto, 'readPixels', (original) => function(...args) {
        const result = original.apply(this, args);
        try {
          const pixels = args[6];
          const ampW = noiseAmplitudeNow();
          const stepDiv = sampleStepDivisorNow();
          const step2 = Math.max(4, Math.floor((pixels?.length || 0) / stepDiv));
          for (let i = 0; pixels && i < pixels.length; i += step2) {
            const n = Math.floor(noise(i + mark) * ampW) - Math.floor(ampW / 2);
            pixels[i] = Math.max(0, Math.min(255, (pixels[i] || 0) + n));
          }
        } catch (_) {}
        return result;
      });
    };
    patch(globalThis.WebGLRenderingContext?.prototype);
    patch(globalThis.WebGL2RenderingContext?.prototype);
  }
})();`;
}

function chromeArgsForFingerprint(fp, profile = {}) {
  const args = [];
  // Critical: without this, Chromium/CDP sets navigator.webdriver = true
  args.push('--disable-blink-features=AutomationControlled');
  // Never enable automation switch (some launchers add it by default)
  if (fp.userAgent) args.push(`--user-agent=${fp.userAgent}`);
  // TLS extension permutation by Chrome major from UA
  if (fp.uaProfile) {
    for (const flag of chromeArgsForUa(fp.uaProfile)) {
      // merge enable/disable-features carefully below
      if (flag.startsWith('--enable-features=') || flag.startsWith('--disable-features=')) {
        const key = flag.split('=')[0];
        const val = flag.slice(key.length + 1);
        const existing = args.findIndex((a) => a.startsWith(key + '='));
        if (existing >= 0) {
          const cur = args[existing].slice(key.length + 1).split(',').filter(Boolean);
          for (const part of val.split(',')) {
            if (part && !cur.includes(part)) cur.push(part);
          }
          args[existing] = key + '=' + cur.join(',');
        } else {
          args.push(flag);
        }
      } else if (!args.includes(flag)) {
        args.push(flag);
      }
    }
  }
  if (fp.screen?.width && fp.screen?.height) {
    args.push(`--window-size=${fp.screen.width},${fp.screen.height}`);
  }
  if (fp.webrtc === 'disabled' || fp.webrtc === 'proxy') {
    args.push(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check'
    );
  }
  if (fp.webgl?.mode === 'blocked') args.push('--disable-webgl', '--disable-webgl2', '--disable-3d-apis');
  if (fp.audio?.mode === 'muted' || profile.privacy?.audio === 'muted') args.push('--mute-audio');
  if (fp.doNotTrack === '1' || profile.privacy?.dnt || profile.privacy?.dntMode === 'on') args.push('--do-not-track');
  // Use full BCP47 when present (ja-JP / zh-CN); Chrome accepts --lang=ja-JP
  const lang = (fp.languages && fp.languages[0]) || profile.language;
  if (lang) {
    const tag = String(lang).trim();
    const primary = tag.split(',')[0].trim();
    if (primary) args.push(`--lang=${primary}`);
  }
  // Cloudflare 验证优化：关闭时更激进（可能卡盾）；开启时减少部分干扰
  if (profile.privacy?.cfOptimize === false) {
    // keep aggressive isolation defaults already applied by noise modes
  } else {
    // prefer not to hard-disable site features that CF challenge pages need
    // (no --disable-webgl here unless user chose blocked webgl above)
  }
  return args;
}

async function applyFingerprintToTab(cdpCall, webSocketDebuggerUrl, fp, profile = {}) {
  const privacy = profile.privacy || {};
  const timezone = privacy.timezoneMode === 'custom'
    ? privacy.timezone
    : privacy.timezoneMode === 'real'
      ? ''
      : (profile.exitTimezone || '');
  // geoMode: custom coords | disabled/prompt (no override) | ip/allow (from exit IP)
  let latitude = null;
  let longitude = null;
  if (privacy.geoMode === 'custom') {
    latitude = Number(privacy.latitude);
    longitude = Number(privacy.longitude);
  } else if (privacy.geoMode === 'disabled' || privacy.geoMode === 'prompt') {
    latitude = null;
    longitude = null;
  } else {
    latitude = Number(profile.exitLatitude);
    longitude = Number(profile.exitLongitude);
  }

  // cdpCall may be:
  //  1) (wsUrl, method, params) — classic page WebSocket path
  //  2) (method, params) — flattened session path (sessionId bound by caller)
  const invoke = async (method, params = {}) => {
    if (typeof cdpCall !== 'function') throw new Error('CDP call function required');
    if (webSocketDebuggerUrl == null) return cdpCall(method, params);
    return cdpCall(webSocketDebuggerUrl, method, params);
  };

  // Page domain must be enabled or addScriptToEvaluateOnNewDocument is a no-op on some hosts.
  await invoke('Page.enable', {}).catch(() => {});
  await invoke('Runtime.enable', {}).catch(() => {});

  // Soft overrides: CDP rejects a second setLocale/setTimezone with
  // "Another locale override is already in effect" — must not abort the whole inject.
  const softOverride = async (method, params) => {
    try {
      await invoke(method, params);
    } catch (error) {
      const msg = String(error && error.message || error || '');
      if (/already in effect|cannot be overridden|not available/i.test(msg)) return;
      throw error;
    }
  };

  // Network/Emulation.setUserAgentOverride + UserAgentMetadata (Client Hints)
  if (fp.userAgent || fp.uaProfile) {
    const uaProfile = fp.uaProfile || buildUaProfile({
      userAgent: fp.userAgent,
      platform: fp.platform,
    });
    const acceptLanguage = (fp.languages || []).join(',');
    const override = cdpUserAgentOverride(uaProfile, acceptLanguage);
    // Emulation affects navigator + most page JS
    await softOverride('Emulation.setUserAgentOverride', override);
    // Network affects HTTP headers (User-Agent + sec-ch-ua*)
    await softOverride('Network.enable', {});
    await softOverride('Network.setUserAgentOverride', {
      userAgent: override.userAgent,
      acceptLanguage: override.acceptLanguage,
      platform: override.platform,
      userAgentMetadata: override.userAgentMetadata,
    });
  }
  if (fp.screen) {
    await softOverride('Emulation.setDeviceMetricsOverride', {
      width: fp.screen.width,
      height: fp.screen.height,
      deviceScaleFactor: fp.screen.devicePixelRatio || 1,
      mobile: false,
    });
  }
  if (timezone) {
    await softOverride('Emulation.setTimezoneOverride', { timezoneId: timezone });
  }
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    await softOverride('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy: privacy.accuracy || 100,
    });
  }
  if (fp.languages?.[0]) {
    await softOverride('Emulation.setLocaleOverride', { locale: fp.languages[0] });
  }

  const source = buildInjectionScript(fp);
  // Register for future documents first (start page navigation depends on this).
  // Must not silently drop registration failures — otherwise navigation paints host FP.
  let documentStartOk = false;
  try {
    await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
    documentStartOk = true;
  } catch (error) {
    const msg = String(error && error.message || error || '');
    if (!/already|duplicate|exists/i.test(msg)) {
      // Retry once after re-enabling Page domain.
      await invoke('Page.enable', {}).catch(() => {});
      try {
        await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
        documentStartOk = true;
      } catch (retryError) {
        const retryMsg = String(retryError && retryError.message || retryError || '');
        if (!/already|duplicate|exists/i.test(retryMsg)) {
          // Soft: still try Runtime.evaluate on current document.
          documentStartOk = false;
        } else {
          documentStartOk = true;
        }
      }
    } else {
      documentStartOk = true;
    }
  }
  // Already-open documents: best-effort patch. Never abort startup if evaluate throws
  // (Chromium often reports "Uncaught" for redefine races; document-start still applies on next nav).
  try {
    const evaluated = await invoke('Runtime.evaluate', {
      expression: source,
      returnByValue: false,
      awaitPromise: false,
    });
    if (evaluated && evaluated.exceptionDetails) {
      // leave a soft signal for callers that inspect return value; do not throw
      const text = evaluated.exceptionDetails.text
        || evaluated.exceptionDetails.exception?.description
        || 'Uncaught';
      const err = new Error(text);
      err.softInject = true;
      err.exceptionDetails = evaluated.exceptionDetails;
      err.documentStartOk = documentStartOk;
      // Soft path: swallow so keepDefaultTab can still open the welcome page.
    }
  } catch (error) {
    const msg = String(error && error.message || error || '');
    if (!/Uncaught|already in effect|cannot be overridden/i.test(msg)) {
      // unexpected CDP transport errors still surface
      throw error;
    }
  }
}

module.exports = {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
  fingerprintConsistencyIssues,
  hashSeed,
  createMediaDevicesFromSeed,
  createSpeechVoicesFromSeed,
  createBatteryFromSeed,
  buildWebglFpPayload,
  audioMarkFromSeed,
  clientRectMarkFromSeed,
  resolveStabilityPolicy,
  matchStabilityHost,
  sampleCanvasBlocks,
  hammingDistance,
  applyStableCanvasNoise,
  withinHammingThreshold,
  DEFAULT_STABILITY_HOSTS,
  DEFAULT_STABILITY_SKIP_HOSTS,
  WEBGL_PRESETS,
  // re-export UA helpers for UI / selftest
  buildUaProfile,
  randomUaForSeed,
  OS_PRESETS,
};
