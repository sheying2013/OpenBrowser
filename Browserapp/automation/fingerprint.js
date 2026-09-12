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
const { mergeFlags, LIST_VALUE_FLAGS } = require('./command-line-flags');
const { pickPersona, fontsForOs, exclusiveFontsForOtherOs } = require('./device-personas');
const { mobilePersona, supportsRuntimePersona } = require('./mobile-personas');
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
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'alchemist' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen12' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen12' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'gcn-4' } },
    // Expanded modern GPU presets (appended so legacy profiles maintain bit-exact stability)
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'alchemist' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon 680M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
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
  { name: 'Alex', lang: 'en-US' }, { name: 'Samantha', lang: 'en-US' }, { name: 'Victoria', lang: 'en-US' },
  { name: 'Fred', lang: 'en-US' }, { name: 'Junior', lang: 'en-US' }, { name: 'Kathy', lang: 'en-US' },
  { name: 'Daniel', lang: 'en-GB' }, { name: 'Kate', lang: 'en-GB' }, { name: 'Oliver', lang: 'en-GB' },
  { name: 'Serena', lang: 'en-GB' }, { name: 'Moira', lang: 'en-IE' }, { name: 'Fiona', lang: 'en-GB' },
  { name: 'Karen', lang: 'en-AU' }, { name: 'Lee', lang: 'en-AU' }, { name: 'Tessa', lang: 'en-ZA' },
  { name: 'Google US English', lang: 'en-US' }, { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'Google UK English Male', lang: 'en-GB' },
  { name: 'Microsoft David - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
  { name: 'Microsoft Mark - English (United States)', lang: 'en-US' },
  { name: 'Ting-Ting', lang: 'zh-CN' }, { name: 'Sin-ji', lang: 'zh-HK' }, { name: 'Mei-Jia', lang: 'zh-TW' },
  { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' }, { name: 'Google 粤語（香港）', lang: 'zh-HK' },
  { name: 'Google 國語（臺灣）', lang: 'zh-TW' },
  { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { name: 'Microsoft Kangkang - Chinese (Simplified, PRC)', lang: 'zh-CN' },
  { name: 'Microsoft Hanhan - Chinese (Traditional, Taiwan)', lang: 'zh-TW' },
  { name: 'Microsoft Tracy - Chinese (Traditional, Hong Kong S.A.R.)', lang: 'zh-HK' },
  { name: 'Kyoko', lang: 'ja-JP' }, { name: 'Otoya', lang: 'ja-JP' },
  { name: 'Google 日本語', lang: 'ja-JP' },
  { name: 'Microsoft Haruka - Japanese', lang: 'ja-JP' },
  { name: 'Microsoft Ichiro - Japanese', lang: 'ja-JP' },
  { name: 'Yuna', lang: 'ko-KR' }, { name: 'Google 한국의', lang: 'ko-KR' },
  { name: 'Microsoft Heami - Korean', lang: 'ko-KR' },
  { name: 'Thomas', lang: 'fr-FR' }, { name: 'Amelie', lang: 'fr-CA' }, { name: 'Audrey', lang: 'fr-FR' },
  { name: 'Google français', lang: 'fr-FR' },
  { name: 'Microsoft Hortense - French', lang: 'fr-FR' },
  { name: 'Anna', lang: 'de-DE' }, { name: 'Helena', lang: 'de-DE' }, { name: 'Markus', lang: 'de-DE' },
  { name: 'Google Deutsch', lang: 'de-DE' },
  { name: 'Microsoft Hedda - German', lang: 'de-DE' },
  { name: 'Monica', lang: 'es-ES' }, { name: 'Paulina', lang: 'es-MX' }, { name: 'Jorge', lang: 'es-ES' },
  { name: 'Google español', lang: 'es-ES' }, { name: 'Google español de Estados Unidos', lang: 'es-US' },
  { name: 'Microsoft Helena - Spanish', lang: 'es-ES' },
  { name: 'Alice', lang: 'it-IT' }, { name: 'Luca', lang: 'it-IT' },
  { name: 'Google italiano', lang: 'it-IT' },
  { name: 'Microsoft Cosimo - Italian', lang: 'it-IT' },
  { name: 'Luciana', lang: 'pt-BR' }, { name: 'Joana', lang: 'pt-PT' },
  { name: 'Google português do Brasil', lang: 'pt-BR' },
  { name: 'Microsoft Maria - Portuguese (Brazil)', lang: 'pt-BR' },
  { name: 'Milena', lang: 'ru-RU' }, { name: 'Yuri', lang: 'ru-RU' },
  { name: 'Google русский', lang: 'ru-RU' },
  { name: 'Microsoft Irina - Russian', lang: 'ru-RU' },
  { name: 'Xander', lang: 'nl-NL' }, { name: 'Ellen', lang: 'nl-BE' },
  { name: 'Google Nederlands', lang: 'nl-NL' },
  { name: 'Alva', lang: 'sv-SE' }, { name: 'Oskar', lang: 'sv-SE' },
  { name: 'Google svenska', lang: 'sv-SE' },
  { name: 'Satu', lang: 'fi-FI' }, { name: 'Google suomi', lang: 'fi-FI' },
  { name: 'Nora', lang: 'nb-NO' }, { name: 'Google norsk bokmål', lang: 'nb-NO' },
  { name: 'Zosia', lang: 'pl-PL' }, { name: 'Google polski', lang: 'pl-PL' },
  { name: 'Zuzana', lang: 'cs-CZ' }, { name: 'Google čeština', lang: 'cs-CZ' },
  { name: 'Lekha', lang: 'hi-IN' }, { name: 'Google हिन्दी', lang: 'hi-IN' },
  { name: 'Kanya', lang: 'th-TH' }, { name: 'Google ไทย', lang: 'th-TH' },
  { name: 'Damayanti', lang: 'id-ID' }, { name: 'Google Bahasa Indonesia', lang: 'id-ID' },
  { name: 'Melina', lang: 'el-GR' }, { name: 'Google ελληνικά', lang: 'el-GR' },
  { name: 'Carmit', lang: 'he-IL' }, { name: 'Google עברית', lang: 'he-IL' },
  { name: 'Maged', lang: 'ar-SA' }, { name: 'Google العربية', lang: 'ar-SA' },
  { name: 'Tarik', lang: 'ar-SA' },
];

const DEVICE_NAME_PREFIXES = [
  'DESKTOP', 'LAPTOP', 'PC', 'WIN', 'MAC', 'HOME', 'WORK', 'OFFICE', 'STUDIO', 'DEV',
];
const DEVICE_NAME_SUFFIXES = [
  'Alpha', 'Nova', 'Orbit', 'Pulse', 'Ridge', 'Summit', 'Vertex', 'Atlas', 'Cedar', 'Delta',
  'Echo', 'Flint', 'Grove', 'Harbor', 'Ivory', 'Jade', 'Kepler', 'Lumen', 'Maple', 'Nimbus',
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
  const fpIn = (privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : null) || (options.fingerprint && typeof options.fingerprint === 'object' ? options.fingerprint : {});
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
  for (let i = 0; i < raw.length; i += 1) acc += raw.charCodeAt(i);
  const tpl = MEDIA_DEVICE_TEMPLATES[acc % MEDIA_DEVICE_TEMPLATES.length] || MEDIA_DEVICE_TEMPLATES[0];
  // Chrome hands out 64-character lowercase hex identifiers, salted per origin, and never brands
  // them with a product prefix. Derive each identifier from the whole profile seed so two
  // profiles cannot share one: the previous running-sum derivation only depended on the first two
  // characters, so env-001/env-002/env-003 all published the same audio-input deviceId and could
  // be linked across environments.
  const digestHex = (salt) => crypto.createHash('sha256').update(raw + '|' + salt).digest('hex');
  const audioInputId = digestHex('audioinput');
  const videoInputId = digestHex('videoinput');
  const audioOutputId = digestHex('audiooutput');
  const groupId = digestHex('group');
  const usbTag = digestHex('usb').slice(0, 4) + ':' + digestHex('usb').slice(4, 8);
  const emptyLabels = options.emptyLabels === true;
  const labelOverride = options.labels && typeof options.labels === 'object' ? options.labels : null;
  const inputLabel = emptyLabels ? '' : String(labelOverride?.audioinput || labelOverride?.input || tpl.input);
  const videoLabel = emptyLabels ? '' : String(labelOverride?.videoinput || labelOverride?.video || `Integrated Camera (${usbTag})`);
  const outputLabel = emptyLabels ? '' : String(labelOverride?.audiooutput || labelOverride?.output || tpl.output);
  const devices = [
    { kind: 'audioinput', label: inputLabel, deviceId: audioInputId, groupId },
    { kind: 'videoinput', label: videoLabel, deviceId: videoInputId, groupId },
    { kind: 'audiooutput', label: outputLabel, deviceId: audioOutputId, groupId },
  ];
  if (Array.isArray(options.extra) && options.extra.length) {
    for (const item of options.extra.slice(0, 8)) {
      if (item && item.kind) devices.push({
        kind: String(item.kind),
        label: String(item.label || ''),
        deviceId: String(item.deviceId || digestHex('extra' + devices.length)),
        groupId: String(item.groupId || groupId),
      });
    }
  }
  return devices;
}

/** Pick a stable default speech voice matching the primary language. */
/**
 * Voices a given platform can actually ship. Apple voices are the bare given names
 * (Alex, Samantha, Otoya); Windows uses the "Microsoft X - Language" form; the Google
 * voices are bundled by Chrome itself and appear everywhere. Without an OS the full table
 * is returned, which keeps previously generated profiles byte-identical.
 */
function speechVoicePoolForOs(os) {
  const family = String(os || '').toLowerCase();
  if (!family) return SPEECH_VOICE_POOL;
  const isMac = family.startsWith('macos') || family === 'darwin';
  const isLinux = family === 'linux';
  return SPEECH_VOICE_POOL.filter((voice) => {
    const name = String(voice.name || '');
    if (/^Google\s/i.test(name)) return true;
    if (/^Microsoft\s/i.test(name)) return !isMac && !isLinux;
    return isMac;
  });
}

function createSpeechVoicesFromSeed(seedInput, languages = ['en-US'], mode = 'noise', options = {}) {
  if (mode === 'blocked') return [];
  if (mode === 'real') return null;
  // speechSynthesis.getVoices() is a strong OS signal: Samantha and Alex only exist on
  // macOS, the "Microsoft X - Language" voices only on Windows, and a stock Linux Chrome
  // reports just the bundled Google ones. Selecting purely by language mixes those
  // families, so a profile claiming Windows can answer with Apple voices. When an OS is
  // supplied the table is narrowed to what that platform can actually ship.
  const pool = speechVoicePoolForOs(options.os);
  const langs = (Array.isArray(languages) ? languages : [languages])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const primary = langs[0] || 'en-US';
  const primaryLang = primary.split('-')[0].toLowerCase();
  const langSet = new Set(langs.map((item) => item.toLowerCase()));
  const langPrefixSet = new Set(langs.map((item) => item.split('-')[0].toLowerCase()));
  const seed = hashSeed(String(seedInput || primary));
  // 18-32 voices, closer to full system tables — but never more than the platform has.
  const count = Math.min(pool.length, 18 + (u32(seed, 4) % 15));
  const scored = pool.map((base, index) => {
    let score = 0;
    const lang = String(base.lang || '').toLowerCase();
    const prefix = lang.split('-')[0];
    if (lang === primary.toLowerCase()) score += 100;
    else if (langSet.has(lang)) score += 80;
    else if (prefix === primaryLang) score += 60;
    else if (langPrefixSet.has(prefix)) score += 40;
    else if (prefix === 'en') score += 10;
    score += (u32(seed, 8 + (index % 24)) % 7);
    return { base, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = [];
  const used = new Set();
  for (const item of scored) {
    if (picked.length >= count) break;
    const base = item.base;
    const key = `${base.name}|${base.lang}`;
    if (used.has(key)) continue;
    used.add(key);
    picked.push({
      name: base.name,
      lang: base.lang,
      default: false,
      localService: !/^Google\s/i.test(base.name),
      // Chrome reports the voice name itself as the URI - verified against a real Chrome, where
      // every macOS voice exposes voiceURI === name. The previous scheme emitted a
      // product-branded URI for persona-less profiles, which any page could read straight out of
      // speechSynthesis.getVoices() and use to identify the browser, so the plain name is now
      // always used.
      voiceURI: base.name,
    });
  }
  let def = picked.find((v) => v.lang === primary)
    || picked.find((v) => v.lang.toLowerCase().startsWith(primaryLang))
    || picked[0];
  if (def) {
    def.default = true;
    if (def.localService == null) def.localService = true;
  }
  return picked;
}

/** Seeded host-style device name for machine / product surfaces. */
function createDeviceNameFromSeed(seedInput, options = {}) {
  const mode = String(options.mode || 'noise');
  const custom = String(options.custom || '').trim().slice(0, 120);
  if (mode === 'real') return null;
  if (mode === 'custom' && custom) return custom;
  const seed = hashSeed(String(seedInput || 'device'));
  const prefix = DEVICE_NAME_PREFIXES[u32(seed, 0) % DEVICE_NAME_PREFIXES.length];
  const suffix = DEVICE_NAME_SUFFIXES[u32(seed, 4) % DEVICE_NAME_SUFFIXES.length];
  const num = 1000 + (u32(seed, 8) % 9000);
  if ((u32(seed, 12) % 3) === 0) return `${suffix}-${num}`;
  return `${prefix}-${suffix}${String(num).slice(0, 3)}`;
}

/** Deterministic private IPv4 used as the local ICE candidate surface. */
function createLocalIpFromSeed(seedInput) {
  const seed = hashSeed(String(seedInput || 'local-ip'));
  const classPick = u32(seed, 0) % 3;
  if (classPick === 0) {
    return `10.${u32(seed, 4) % 256}.${u32(seed, 8) % 256}.${1 + (u32(seed, 12) % 254)}`;
  }
  if (classPick === 1) {
    return `192.168.${u32(seed, 4) % 256}.${1 + (u32(seed, 8) % 254)}`;
  }
  return `172.${16 + (u32(seed, 4) % 16)}.${u32(seed, 8) % 256}.${1 + (u32(seed, 12) % 254)}`;
}

function formatGeopositionValue(geo) {
  if (!geo || typeof geo !== 'object') return null;
  const lat = Number(geo.latitude);
  const lon = Number(geo.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const accuracy = Number.isFinite(Number(geo.accuracy)) ? Number(geo.accuracy) : 1000;
  return `${lat},${lon},${accuracy}`;
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

function webglPresetsForOs(os, options = {}) {
  let list = WEBGL_PRESETS.windows;
  if (os === 'macos' || os === 'macos_arm') list = WEBGL_PRESETS.macos;
  else if (os === 'linux') list = WEBGL_PRESETS.linux;
  if (options.legacy && (!os || os === 'windows')) return list.slice(0, 16);
  return list;
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
  const fpIn = (privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : null) || (profile.fingerprint && typeof profile.fingerprint === 'object' ? profile.fingerprint : {});

  const rawCoresOverride = fpIn.cores ?? privacy.cores;
  const rawMemoryOverride = fpIn.memory ?? privacy.memory;
  const coresOverride = rawCoresOverride === '' || rawCoresOverride === null || rawCoresOverride === undefined ? NaN : Number(rawCoresOverride);
  const memoryOverride = rawMemoryOverride === '' || rawMemoryOverride === null || rawMemoryOverride === undefined ? NaN : Number(rawMemoryOverride);
  const useRealCores = coresOverride === 0;
  const useRealMemory = memoryOverride === 0;
  // These are reassigned below when a coherent device persona is selected (opt-in), so the
  // hardware axes come from one real machine instead of being drawn independently.
  const hasCoresOverride = Number.isFinite(coresOverride) && coresOverride > 0;
  const hasMemoryOverride = Number.isFinite(memoryOverride) && memoryOverride > 0;
  let cores = hasCoresOverride
    ? Math.min(64, Math.max(1, Math.round(coresOverride)))
    : [4, 6, 8, 12, 16][u32(seed, 12) % 5];
  // navigator.deviceMemory is quantised by the spec to 0.25/0.5/1/2/4/8 and capped at 8, so the
  // former 16/32 draws were values no real Chrome can report — a single read identified the
  // browser as spoofed. Desktop Chrome effectively only ever reports 4 or 8. Correcting this
  // re-rolls the value on existing profiles; a profile that must keep its old reading can pin
  // it explicitly through privacy.fingerprint.memory.
  const DEVICE_MEMORY_STEPS = [0.25, 0.5, 1, 2, 4, 8];
  const memoryPool = [4, 8];
  let memory = hasMemoryOverride
    ? DEVICE_MEMORY_STEPS.reduce((best, step) => (
      Math.abs(step - memoryOverride) < Math.abs(best - memoryOverride) ? step : best
    ), 8)
    : memoryPool[u32(seed, 16) % memoryPool.length];
  const width = Number(profile.width) || 1280;
  const height = Number(profile.height) || 820;
  let colorDepth = [24, 24, 30][u32(seed, 20) % 3];
  let devicePixelRatio = [1, 1, 1.25, 1.5, 2][u32(seed, 24) % 5];

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

  let uaOs = desktopOs(uaProfile.os) || desktopOs(parseOsFromUa(uaProfile.userAgent)) || 'windows';
  const personaRequested = String(fpIn.deviceProfile ?? privacy.deviceProfile ?? '').toLowerCase() === 'persona';
  const webglOptions = webglPresetsForOs(uaOs, { legacy: !personaRequested });
  let webglPreset = webglOptions[u32(seed, 8) % webglOptions.length];

  // --- coherent device persona (opt-in) ---------------------------------------------
  // Drawing CPU, memory, colour depth, pixel ratio and GPU from separate pools can produce
  // machines that do not exist (4 cores with 32 GB, a 1x non-Retina Mac), and detectors score
  // the combination rather than each value. A persona bundles axes that co-occur on real
  // hardware. Off by default: switching an existing profile's hardware identity mid-life is
  // itself a risk, so this only applies where it was explicitly requested.
  let devicePersona = null;
  if (personaRequested) {
    devicePersona = pickPersona(uaOs, u32(seed, 36));
    if (!hasCoresOverride) cores = devicePersona.cores;
    if (!hasMemoryOverride) memory = Math.min(8, devicePersona.memory);
    colorDepth = devicePersona.colorDepth;
    devicePixelRatio = devicePersona.devicePixelRatio;
    webglPreset = {
      ...webglPreset,
      vendor: devicePersona.webgl.vendor,
      renderer: devicePersona.webgl.renderer,
      gpu: devicePersona.webgl.gpu || webglPreset.gpu,
    };
  }

  // --- mobile device persona ------------------------------------------------
  // A phone is one device, not five independent numbers: the UA model, viewport, pixel ratio,
  // core count and GPU all come out of the same pool record, and only that single record is
  // sampled. The operating system has to be asked for explicitly because a desktop kernel
  // cannot fall into a phone identity by accident.
  const mobileRequested = [fpIn.os, clientHintsIn.os, profile.os, uaProfile.os]
    .map((value) => String(value || '').toLowerCase())
    .find((value) => value === 'android' || value === 'ios');
  let mobileDevice = null;
  if (mobileRequested && supportsRuntimePersona(mobileRequested)) {
    mobileDevice = mobilePersona(u32(seed, 52), mobileRequested, { chromeMajor: kernelMajor || undefined });
    uaOs = mobileDevice.os;
    if (!hasCoresOverride) cores = mobileDevice.cores;
    if (!hasMemoryOverride) memory = mobileDevice.deviceMemory;
    colorDepth = mobileDevice.colorDepth;
    devicePixelRatio = mobileDevice.dpr;
    webglPreset = {
      ...webglPreset,
      vendor: mobileDevice.gpu.vendor,
      renderer: mobileDevice.gpu.renderer,
      gpu: mobileDevice.gpu.family ? { vendor: mobileDevice.gpu.family, architecture: '' } : webglPreset.gpu,
    };
    // A pinned UA still wins, but the rest of the phone identity follows the sampled device.
    if (!uaOverride) uaProfile = mobileDevice.uaProfile;
  }
  const inferGpuFromRenderer = (rendererStr) => {
    const s = String(rendererStr || '').toLowerCase();
    if (s.includes('nvidia') || s.includes('geforce') || s.includes('quadro') || s.includes('rtx') || s.includes('gtx')) {
      let arch = 'ampere';
      if (s.includes('40') || s.includes('ada')) arch = 'ada';
      else if (s.includes('30') || s.includes('ampere')) arch = 'ampere';
      else if (s.includes('20') || s.includes('16') || s.includes('turing')) arch = 'turing';
      else if (s.includes('10') || s.includes('pascal')) arch = 'pascal';
      return { vendor: 'nvidia', architecture: arch };
    }
    if (s.includes('intel') || s.includes('arc') || s.includes('iris') || s.includes('uhd') || s.includes('hd graphics')) {
      let arch = 'gen12';
      if (s.includes('arc') || s.includes('alchemist')) arch = 'alchemist';
      else if (s.includes('iris') || s.includes('770') || s.includes('gen12')) arch = 'gen12';
      else if (s.includes('630') || s.includes('620') || s.includes('gen9')) arch = 'gen9';
      return { vendor: 'intel', architecture: arch };
    }
    if (s.includes('amd') || s.includes('radeon')) {
      let arch = 'rdna-2';
      if (s.includes('7900') || s.includes('7800') || s.includes('7700') || s.includes('7600') || s.includes('780m') || s.includes('rdna-3') || s.includes('rdna3')) arch = 'rdna-3';
      else if (s.includes('6900') || s.includes('6800') || s.includes('6700') || s.includes('6600') || s.includes('680m') || s.includes('rdna-2') || s.includes('rdna2')) arch = 'rdna-2';
      else if (s.includes('580') || s.includes('570') || s.includes('590')) arch = 'gcn-4';
      return { vendor: 'amd', architecture: arch };
    }
    if (s.includes('apple') || s.includes('m1') || s.includes('m2') || s.includes('m3')) {
      return { vendor: 'apple', architecture: 'common-3' };
    }
    return null;
  };
  const effectiveRenderer = String(fpIn.webglRenderer || webglPreset.renderer || '');
  const inferredGpu = inferGpuFromRenderer(effectiveRenderer);
  const webglGpu = ((fpIn.webgpu && typeof fpIn.webgpu === 'object') || fpIn.gpuVendor || fpIn.gpuArchitecture)
    ? {
      vendor: String(fpIn.webgpu?.vendor || fpIn.gpuVendor || inferredGpu?.vendor || webglPreset.gpu?.vendor || ''),
      architecture: String(fpIn.webgpu?.architecture || fpIn.gpuArchitecture || inferredGpu?.architecture || webglPreset.gpu?.architecture || ''),
    }
    : (inferredGpu || webglPreset.gpu || null);

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

  // A persona carries its own panel size; without it the reported screen follows the window,
  // which is what makes "screen smaller than the viewport" style inconsistencies show up.
  // Phones report the full display, and their floor is far below the desktop minimum the window
  // sync assumes, so the panel comes from the persona without the desktop clamp.
  const mobileScreen = mobileDevice ? mobileDevice.screen : null;
  const screenWidth = mobileScreen
    ? Math.round(Number(fpIn.screenWidth) || mobileScreen.width)
    : Math.max(640, Math.round(Number(fpIn.screenWidth) || devicePersona?.screen?.width || width));
  const screenHeight = mobileScreen
    ? Math.round(Number(fpIn.screenHeight) || mobileScreen.height)
    : Math.max(480, Math.round(Number(fpIn.screenHeight) || devicePersona?.screen?.height || height));
  const taskbarHeight = mobileScreen
    ? 0
    : Math.max(0, Math.round(Number(fpIn.taskbarHeight) || (uaOs === 'macos' || uaOs === 'macos_arm' ? 25 : 40)));
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
    speechMode,
    // Narrow the table to the claimed OS for every profile, not just persona ones. Mixing
    // families is not a cosmetic difference: a macOS answer containing "Microsoft David - English
    // (United States)" is a combination no real machine can produce, and looking for exactly that
    // is a standard voice-based OS check. Older profiles used to report that mix, which is worth
    // the one-time correction for the same reason navigator.deviceMemory 16 was.
    { os: uaOs }
  );
  const deviceNameMode = mode('deviceNameMode', ['noise', 'custom', 'real'], privacy.deviceNameMode || 'noise');
  const deviceName = createDeviceNameFromSeed(
    stableIdentity + ':device:' + seed.toString('hex').slice(0, 8),
    {
      mode: deviceNameMode,
      custom: fpIn.deviceName || privacy.deviceName || '',
    }
  );
  const webrtcLocalIp = String(
    fpIn.webrtcLocalIp
    || privacy.webrtcLocalIp
    || ''
  ).trim() || createLocalIpFromSeed(stableIdentity + ':webrtc-local:' + seed.toString('hex').slice(0, 8));

  // Dynamic layer: may change with proxy/exit IP without rebuilding static seeds
  const webrtcAddress = String(
    fpIn.webrtcAddress
    || privacy.webrtcAddress
    || profile.exitIp
    || profile.exitIP
    || ''
  ).trim() || null;
  const timezoneDynamic = privacy.timezoneMode === 'real'
    ? null
    : (String(
        (privacy.timezoneMode === 'custom' ? privacy.timezone : '')
        || profile.exitTimezone
        || privacy.timezone
        || ''
      ).trim() || null);
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

  const webglRenderer = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : (fpIn.webglRenderer || webglPreset.renderer));
  const rLow = String(webglRenderer || '').toLowerCase();
  let resolvedVendor = fpIn.webglVendor || webglPreset.vendor;
  if (!fpIn.webglVendor && mobileDevice) {
    // Adreno / Mali / PowerVR renderers carry no desktop keyword, so the pool vendor is the only
    // truthful answer here.
    resolvedVendor = mobileDevice.gpu.vendor;
  } else if (!fpIn.webglVendor && webglRenderer) {
    if (rLow.includes('nvidia') || rLow.includes('geforce')) resolvedVendor = 'Google Inc. (NVIDIA)';
    else if (rLow.includes('intel') || rLow.includes('arc') || rLow.includes('iris') || rLow.includes('uhd')) resolvedVendor = 'Google Inc. (Intel)';
    else if (rLow.includes('amd') || rLow.includes('radeon')) resolvedVendor = 'Google Inc. (AMD)';
    else if (rLow.includes('apple')) resolvedVendor = 'Google Inc. (Apple)';
  }
  const webglVendor = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : resolvedVendor);
  if (webglGpu && webglMetaMode !== 'real') {
    const vLow = String(webglVendor || '').toLowerCase();
    if (rLow.includes('nvidia') || vLow.includes('nvidia')) {
      webglGpu.vendor = 'nvidia';
      if (!webglGpu.architecture) webglGpu.architecture = 'ampere';
    } else if (rLow.includes('intel') || vLow.includes('intel')) {
      webglGpu.vendor = 'intel';
      if (!webglGpu.architecture) webglGpu.architecture = 'gen12';
    } else if (rLow.includes('amd') || rLow.includes('radeon') || vLow.includes('amd') || vLow.includes('radeon')) {
      webglGpu.vendor = 'amd';
      if (!webglGpu.architecture) webglGpu.architecture = 'rdna-2';
    } else if (rLow.includes('apple') || vLow.includes('apple')) {
      webglGpu.vendor = 'apple';
      if (!webglGpu.architecture) webglGpu.architecture = 'common-3';
    }
  }
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
    timezone: timezoneDynamic,
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
    webrtcLocalIp,
    deviceName,
    deviceNameMode,
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
    // Font probing is a top-tier OS signal, and on a stock Chromium kernel the host's real
    // font list answers it. A persona carries the set its claimed platform ships, plus the
    // families exclusive to the other platforms so probes for those can be answered honestly
    // as absent. Null when no persona is selected: no persona means no claim to enforce.
    fonts: devicePersona
      ? {
        os: uaOs,
        list: fontsForOs(uaOs),
        foreign: exclusiveFontsForOtherOs(uaOs),
      }
      : null,
    maxTouchPoints: mobileDevice
      ? mobileDevice.maxTouchPoints
      : (Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0),
    mobile: Boolean(mobileDevice),
    touch: Boolean(mobileDevice),
    mobileDevice: mobileDevice
      ? {
        name: mobileDevice.name,
        model: mobileDevice.model,
        os: mobileDevice.os,
        osVersion: mobileDevice.osVersion,
        cores: mobileDevice.cores,
        viewport: { ...mobileDevice.viewport },
        screen: { ...mobileDevice.screen },
        panel: { ...mobileDevice.panel },
        dpr: mobileDevice.dpr,
        gpu: { vendor: mobileDevice.gpu.vendor, renderer: mobileDevice.gpu.renderer, family: mobileDevice.gpu.family },
      }
      : null,
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
      maxTouchPoints: mobileDevice
        ? mobileDevice.maxTouchPoints
        : (Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0),
      mediaDevices,
      mediaLabels: mediaLabelTemplates,
      battery,
      webrtcPolicy,
      webrtcLocalIp,
      deviceName,
      stability,
      userAgentMetadata: uaProfile.metadata,
      webglFp: webgl.fpPayload,
    },
    dynamicConfig: {
      timezone: timezoneDynamic,
      geoposition,
      geopositionText: formatGeopositionValue(geoposition),
      webrtcAddress,
      webrtcLocalIp,
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
  const parsedOs = parseOsFromUa(fp?.userAgent);
  const mobileOs = (parsedOs === 'android' || parsedOs === 'ios') ? parsedOs : null;
  const uaOs = mobileOs
    ? mobileOs
    : (desktopOs(fp?.uaProfile?.os) || desktopOs(parsedOs) || 'windows');
  const expectedPlatform = mobileOs
    ? (mobileOs === 'ios' ? 'iPhone' : 'Linux armv8l')
    : (OS_PRESETS[uaOs]?.platformNav || OS_PRESETS.windows.platformNav);
  const expectedChPlatform = mobileOs === 'android' ? 'Android' : (mobileOs === 'ios' ? 'iOS' : expectedClientHintPlatform(uaOs));
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
  if (mobileOs && /Direct3D|D3D11|Apple M[0-9]|Mesa|RADV/i.test(renderer)) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a mobile GPU.');
  }
  if (fp?.mobile && !(Number(fp?.maxTouchPoints) > 0)) {
    add('mobile-touch-missing', 'A mobile profile must expose touch points.', 'error');
  }
  if (fp?.mobile && fp?.mobileDevice && Number(fp.mobileDevice.screen?.width) !== Number(fp?.screen?.width)) {
    add('mobile-screen-mismatch', 'The reported screen must be the panel of the sampled device.');
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
  if (fp?.deviceMemory != null && !(Number(fp.deviceMemory) >= 1 && Number(fp.deviceMemory) <= 8)) {
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
    timezone: fp.timezone || fp.dynamicConfig?.timezone || null,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: Math.min(8, Math.max(1, Number(fp.deviceMemory) || 8)),
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
    fonts: fp.fonts || null,
    maxTouchPoints: fp.maxTouchPoints,
    mobile: Boolean(fp.mobile),
    mobileDevice: fp.mobileDevice || null,
    // The injected navigator.patches read this; without it the page reported empty brands / model.
    userAgentMetadata: fp.userAgentMetadata || fp.uaProfile?.metadata || null,
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
  // Phone identity flag, shared by the window metrics and the navigator patch below.
  const MOBILE = Boolean(CFG.mobile);

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
              if (data[px + 3] === 0) continue;
              const delta = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
              locked.push({ px: px, delta: delta });
            }
          }
          canvasNoiseLocks.set(key, locked);
        }
        for (let i = 0; i < locked.length; i += 1) {
          const item = locked[i];
          if (item.px + 3 >= data.length) continue;
          if (data[item.px + 3] === 0) continue;
          data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
        }
        return imageData;
      }
      for (let y = 0; y < (limitH || height); y += square) {
        for (let x = 0; x < (limitW || width); x += square) {
          const px = ((y * width) + x) * 4;
          if (px + 3 >= data.length) continue;
          if (data[px + 3] === 0) continue;
          const n = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
          data[px] = Math.max(0, Math.min(255, data[px] + n));
        }
      }
    } catch (_) {}
    return imageData;
  };
  const nativeSource = new WeakMap();
  const subWindowSyncHooks = [];
  const originalToString = Function.prototype.toString;
  const nativeLike = (wrapper, original, nameOverride, lengthOverride, isConstructor = false) => {
    if (typeof wrapper !== "function") return wrapper;
    const fnName = nameOverride !== undefined ? nameOverride : (original ? original.name : (wrapper.name || ""));
    const fnLength = lengthOverride !== undefined ? lengthOverride : (original ? original.length : wrapper.length);
    let clean;
    if (isConstructor) {
      clean = wrapper;
      try { Object.defineProperty(clean, "name", { configurable: true, value: fnName }); } catch (_) {}
      try { Object.defineProperty(clean, "length", { configurable: true, value: fnLength }); } catch (_) {}
    } else {
      const holder = {
        [fnName](...args) {
          return wrapper.apply(this, args);
        }
      };
      clean = holder[fnName];
      try { Object.defineProperty(clean, "length", { configurable: true, value: fnLength }); } catch (_) {}
    }
    let nativeStr;
    if (typeof original === "function") {
      const origStr = nativeSource.get(original) || originalToString.call(original);
      nativeStr = (origStr && origStr.includes("[native code]"))
        ? origStr
        : ("function " + fnName + "() { [native code] }");
    } else {
      nativeStr = "function " + fnName + "() { [native code] }";
    }
    try { nativeSource.set(clean, nativeStr); } catch (_) {}
    try { nativeSource.set(wrapper, nativeStr); } catch (_) {}
    return clean;
  };
  const makeNativeGetter = (key, getValue, targetType) => {
    const holder = {
      get [key]() {
        if (targetType === "navigator") {
          const isNav = this && (
            this === (typeof navigator !== "undefined" ? navigator : null) ||
            (typeof Navigator !== "undefined" && this instanceof Navigator) ||
            Object.prototype.toString.call(this) === "[object Navigator]"
          );
          if (!isNav) throw new TypeError("Illegal invocation");
        } else if (targetType === "screen") {
          const isScr = this && (
            this === (typeof screen !== "undefined" ? screen : null) ||
            (typeof Screen !== "undefined" && this instanceof Screen) ||
            Object.prototype.toString.call(this) === "[object Screen]"
          );
          if (!isScr) throw new TypeError("Illegal invocation");
        }
        return getValue.call(this);
      }
    };
    const getter = Object.getOwnPropertyDescriptor(holder, key).get;
    try { Object.defineProperty(getter, "name", { configurable: true, value: "get " + key }); } catch (_) {}
    try { Object.defineProperty(getter, "length", { configurable: true, value: 0 }); } catch (_) {}
    nativeSource.set(getter, "function get " + key + "() { [native code] }");
    return getter;
  };
  const nativeGetter = (key, fn) => {
    if (typeof fn !== "function") return fn;
    try { Object.defineProperty(fn, "name", { configurable: true, value: "get " + key }); } catch (_) {}
    try { Object.defineProperty(fn, "length", { configurable: true, value: 0 }); } catch (_) {}
    try { nativeSource.set(fn, "function get " + key + "() { [native code] }"); } catch (_) {}
    return fn;
  };
  const nativeAccessor = (key, desc) => {
    if (desc && typeof desc.get === "function") nativeGetter(key, desc.get);
    if (desc && typeof desc.set === "function") {
      try { Object.defineProperty(desc.set, "name", { configurable: true, value: "set " + key }); } catch (_) {}
      try { nativeSource.set(desc.set, "function set " + key + "() { [native code] }"); } catch (_) {}
    }
    return desc;
  };
  try {
    if (!nativeSource.has(Function.prototype.toString)) {
      const holder = {
        toString() {
          if (nativeSource.has(this)) return nativeSource.get(this);
          return originalToString.call(this);
        }
      };
      const patchedToString = holder.toString;
      nativeSource.set(patchedToString, "function toString() { [native code] }");
      Object.defineProperty(Function.prototype, "toString", {
        configurable: true,
        writable: true,
        value: patchedToString,
      });
    }
  } catch (_) {}
  const replaceMethod = (proto, key, factory) => {
    try {
      if (!proto || typeof proto[key] !== "function") return null;
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
  try {
    const hideWd = makeNativeGetter("webdriver", () => false, "navigator");
    if (typeof Navigator !== "undefined") {
      Object.defineProperty(Navigator.prototype, "webdriver", { configurable: true, enumerable: true, get: hideWd });
    }
    if (typeof navigator !== "undefined") {
      try { delete navigator.webdriver; } catch (_) {}
    }
  } catch (_) {}
  // cdc_ / $cdc_ selenium leftovers if present
  try {
    const cleanTargets = typeof document !== "undefined" ? [document, (typeof window !== "undefined" ? window : null)].filter(Boolean) : [];
    for (const tgt of cleanTargets) {
      for (const key of Object.getOwnPropertyNames(tgt)) {
        if (String(key).startsWith('$cdc_') || String(key).startsWith('cdc_') || String(key).startsWith('__selenium') || String(key).startsWith('__webdriver') || String(key).startsWith('__driver_')) {
          try { delete tgt[key]; } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // --- navigator (non-UA fields; UA handled by uaScript) ---
  const navPatch = {
    platform: { get: () => CFG.platform },
    maxTouchPoints: { get: () => CFG.maxTouchPoints },
    vendor: { get: () => CFG.vendor },
    languages: { get: () => Object.freeze([...CFG.languages]) },
    language: { get: () => CFG.languages[0] || "en-US" },
    webdriver: { get: () => false },
  };
  if (CFG.hardwareConcurrency != null) navPatch.hardwareConcurrency = { get: () => CFG.hardwareConcurrency };
  if (CFG.deviceMemory != null) navPatch.deviceMemory = { get: () => Math.min(8, CFG.deviceMemory) };
  if (CFG.doNotTrack != null) navPatch.doNotTrack = { get: () => CFG.doNotTrack };

  try {
    const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
    if (navProto) {
      for (const [key, desc] of Object.entries(navPatch)) {
        const fn = desc.get;
        const getter = makeNativeGetter(key, fn, "navigator");
        Object.defineProperty(navProto, key, {
          configurable: true,
          enumerable: true,
          get: getter,
        });
        if (typeof navigator !== "undefined") {
          try { delete navigator[key]; } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // --- permissions consistency (Notification.permission vs permissions.query) ---
  try {
    const permProto = typeof Permissions !== "undefined" ? Permissions.prototype : (typeof navigator !== "undefined" && navigator.permissions ? Object.getPrototypeOf(navigator.permissions) : null);
    if (permProto && typeof permProto.query === "function") {
      const notificationStatuses = new WeakSet();
      if (typeof PermissionStatus !== "undefined" && PermissionStatus.prototype) {
        const stateDesc = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, "state");
        if (stateDesc && typeof stateDesc.get === "function") {
          const origStateGet = stateDesc.get;
          const patchedStateGet = nativeLike(function state() {
            if (notificationStatuses.has(this) && typeof Notification !== "undefined") {
              return Notification.permission === "default" ? "prompt" : Notification.permission;
            }
            return origStateGet.call(this);
          }, origStateGet, "get state", 0);
          Object.defineProperty(PermissionStatus.prototype, "state", {
            configurable: true,
            enumerable: true,
            get: patchedStateGet,
          });
        }
      }
      replaceMethod(permProto, "query", (origQuery) => async function query(descriptor) {
        const status = await origQuery.call(this, descriptor);
        if (descriptor && descriptor.name === 'notifications') {
          if (status) notificationStatuses.add(status);
        }
        return status;
      });
    }
  } catch (_) {}

  // --- window.chrome presence ---
  try {
    if (typeof window !== "undefined") {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.app) {
        const noop = () => {};
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
          RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
          getDetails: nativeLike(noop, null, "getDetails", 0),
          getIsInstalled: nativeLike(() => false, null, "getIsInstalled", 0),
          installState: nativeLike((cb) => { if (typeof cb === 'function') cb('not_installed'); }, null, "installState", 1),
          runningState: nativeLike(() => "cannot_run", null, "runningState", 0),
        };
      }
      // Modern Chromium (v117+) has completely removed chrome.loadTimes and chrome.csi.
      // Retaining those obsolete mocks is an instant signature of legacy puppeteer-extra-plugin-stealth.
    }
  } catch (_) {}

  // --- timezone spoofing (Intl.DateTimeFormat & Date) ---
  if (CFG.timezone) {
    try {
      const targetTz = String(CFG.timezone).trim();
      new Intl.DateTimeFormat('en-US', { timeZone: targetTz }).format();

      const OrigDateTimeFormat = Intl.DateTimeFormat;
      const DateTimeFormatProto = OrigDateTimeFormat.prototype;

      const origSetTime = Date.prototype.setTime;
      const origGetTzOffset = Date.prototype.getTimezoneOffset;
      const getOffsetMinutes = (date) => {
        try {
          const ts = date.getTime();
          if (isNaN(ts)) return NaN;
          const partsTz = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          }).formatToParts(date);
          const getVal = (t) => parseInt(partsTz.find(p => p.type === t)?.value || '0', 10);
          const y = getVal('year');
          const m = getVal('month') - 1;
          const d = getVal('day');
          const h = getVal('hour') % 24;
          const min = getVal('minute');
          const s = getVal('second');
          const tzUtcTs = Date.UTC(y, m, d, h, min, s);
          return Math.round((Math.floor(ts / 1000) * 1000 - tzUtcTs) / 60000);
        } catch (_) {
          return 0;
        }
      };

      const getLocalComponents = (date) => {
        const off = getOffsetMinutes(date);
        return new Date(date.getTime() - off * 60000);
      };

      const PatchedDateTimeFormat = function DateTimeFormat(locales, options) {
        let opts = options;
        if (!opts) {
          opts = { timeZone: targetTz };
        } else if (opts.timeZone === undefined) {
          opts = Object.assign({}, opts, { timeZone: targetTz });
        }
        if (!(this instanceof PatchedDateTimeFormat)) {
          return Reflect.construct(OrigDateTimeFormat, [locales, opts]);
        }
        return Reflect.construct(OrigDateTimeFormat, [locales, opts], new.target);
      };
      PatchedDateTimeFormat.prototype = DateTimeFormatProto;
      // Without this the prototype's constructor still points at the original, so the one-line
      // check Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat returns false.
      try {
        Object.defineProperty(DateTimeFormatProto, 'constructor', {
          configurable: true, writable: true, enumerable: false, value: PatchedDateTimeFormat,
        });
      } catch (_) {}
      if (OrigDateTimeFormat.supportedLocalesOf) {
        PatchedDateTimeFormat.supportedLocalesOf = nativeLike(
          function supportedLocalesOf(...args) { return OrigDateTimeFormat.supportedLocalesOf.apply(OrigDateTimeFormat, args); },
          OrigDateTimeFormat.supportedLocalesOf,
          'supportedLocalesOf',
          1
        );
      }
      nativeLike(PatchedDateTimeFormat, OrigDateTimeFormat, 'DateTimeFormat', 0, true);
      Intl.DateTimeFormat = PatchedDateTimeFormat;

      replaceMethod(Date.prototype, 'getTimezoneOffset', () => function getTimezoneOffset() {
        return getOffsetMinutes(this);
      });

      const formatTzDate = (date) => {
        try {
          const parts = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            weekday: 'short',
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'long'
          }).formatToParts(date);
          const get = (type) => parts.find(p => p.type === type)?.value || '';
          const weekday = get('weekday');
          const month = get('month');
          const day = get('day');
          const year = get('year');
          const hour = (get('hour') === '24' ? '00' : get('hour')).padStart(2, '0');
          const minute = get('minute').padStart(2, '0');
          const second = get('second').padStart(2, '0');
          const tzName = get('timeZoneName');
          const diffMins = getOffsetMinutes(date);
          const sign = diffMins <= 0 ? '+' : '-';
          const absMins = Math.abs(diffMins);
          const offH = String(Math.floor(absMins / 60)).padStart(2, '0');
          const offM = String(absMins % 60).padStart(2, '0');
          const gmt = 'GMT' + sign + offH + offM;
          return weekday + ' ' + month + ' ' + day + ' ' + year + ' ' + hour + ':' + minute + ':' + second + ' ' + gmt + ' (' + tzName + ')';
        } catch (_) {
          return date.toISOString();
        }
      };

      replaceMethod(Date.prototype, 'toString', () => function toString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        return formatTzDate(this);
      });

      replaceMethod(Date.prototype, 'toTimeString', () => function toTimeString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        const match = full.match(/[0-9]{4}[ ]+(.*)/);
        return match ? match[1] : full;
      });

      replaceMethod(Date.prototype, 'toDateString', () => function toDateString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        return full.split(' ').slice(0, 4).join(' ');
      });

      replaceMethod(Date.prototype, 'toLocaleString', (orig) => function toLocaleString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'toLocaleDateString', (orig) => function toLocaleDateString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'toLocaleTimeString', (orig) => function toLocaleTimeString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'getHours', () => function getHours() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCHours();
      });

      replaceMethod(Date.prototype, 'getDate', () => function getDate() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCDate();
      });

      replaceMethod(Date.prototype, 'getDay', () => function getDay() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCDay();
      });

      replaceMethod(Date.prototype, 'getFullYear', () => function getFullYear() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear();
      });

      replaceMethod(Date.prototype, 'getMonth', () => function getMonth() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMonth();
      });

      replaceMethod(Date.prototype, 'getMinutes', () => function getMinutes() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMinutes();
      });

      replaceMethod(Date.prototype, 'getSeconds', () => function getSeconds() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCSeconds();
      });

      replaceMethod(Date.prototype, 'getMilliseconds', () => function getMilliseconds() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMilliseconds();
      });

      replaceMethod(Date.prototype, 'getYear', () => function getYear() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear() - 1900;
      });

      // Local-time setters must land in the spoofed zone too. Reading a component through the
      // patched getters while writing it through the host zone leaves the two disagreeing,
      // which is a stronger signal than not spoofing at all.
      const setLocal = (self, mutate) => {
        if (isNaN(self.getTime())) return NaN;
        const shifted = getLocalComponents(self);
        mutate(shifted);
        // Resolve the offset twice: the write may have crossed a DST boundary.
        let guess = shifted.getTime() + getOffsetMinutes(self) * 60000;
        guess = shifted.getTime() + getOffsetMinutes(new Date(guess)) * 60000;
        return origSetTime.call(self, guess);
      };
      replaceMethod(Date.prototype, 'setFullYear', () => function setFullYear(y, m, d) {
        return setLocal(this, (x) => {
          x.setUTCFullYear(y);
          if (m !== undefined) x.setUTCMonth(m);
          if (d !== undefined) x.setUTCDate(d);
        });
      });
      replaceMethod(Date.prototype, 'setMonth', () => function setMonth(m, d) {
        return setLocal(this, (x) => { x.setUTCMonth(m); if (d !== undefined) x.setUTCDate(d); });
      });
      replaceMethod(Date.prototype, 'setDate', () => function setDate(d) {
        return setLocal(this, (x) => x.setUTCDate(d));
      });
      replaceMethod(Date.prototype, 'setHours', () => function setHours(h, mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCHours(h);
          if (mi !== undefined) x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replaceMethod(Date.prototype, 'setMinutes', () => function setMinutes(mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replaceMethod(Date.prototype, 'setSeconds', () => function setSeconds(sec, ms) {
        return setLocal(this, (x) => { x.setUTCSeconds(sec); if (ms !== undefined) x.setUTCMilliseconds(ms); });
      });
      replaceMethod(Date.prototype, 'setMilliseconds', () => function setMilliseconds(ms) {
        return setLocal(this, (x) => x.setUTCMilliseconds(ms));
      });

      // new Date(y, m, d, ...) and Date.parse('2026-01-15 12:00:00') are defined against the
      // *local* zone. Left alone they resolve against the host zone while every getter above
      // reports the spoofed one, so a two-line script recovers the real timezone.
      try {
        const OrigDate = Date;
        const localToUtc = (ms) => {
          if (isNaN(ms)) return NaN;
          // getOffsetMinutes keeps the JS sign convention (UTC+05:30 reports -330), so shifting
          // a wall-clock reading in the spoofed zone back to a real instant means adding it.
          let out = ms + getOffsetMinutes(new OrigDate(ms)) * 60000;
          out = ms + getOffsetMinutes(new OrigDate(out)) * 60000;
          return out;
        };
        // Matches ES2015+ "date-time forms without a timezone offset", which parse as local.
        const NO_TZ = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?$');
        const parseLocal = (value) => {
          const raw = OrigDate.parse(value);
          if (isNaN(raw)) return raw;
          if (!NO_TZ.test(String(value).trim())) return raw;
          // OrigDate.parse resolved these fields against the host zone. Undo that with the
          // engine's own offset, then re-apply the spoofed zone's.
          const undo = raw - origGetTzOffset.call(new OrigDate(raw)) * 60000;
          return localToUtc(undo);
        };
        const PatchedDate = function Date(...args) {
          if (!new.target) return OrigDate();
          if (args.length === 0) return Reflect.construct(OrigDate, [], new.target);
          if (args.length === 1) {
            const only = args[0];
            if (typeof only === 'string') {
              return Reflect.construct(OrigDate, [parseLocal(only)], new.target);
            }
            return Reflect.construct(OrigDate, args, new.target);
          }
          // Interpret the fields as wall-clock time in the *spoofed* zone. Letting the engine
          // parse them first would apply the host zone's offset, which the correction below
          // would then apply a second time.
          const y = Number(args[0]);
          const wall = OrigDate.UTC(
            y >= 0 && y <= 99 ? y + 1900 : y,
            Number(args[1]) || 0,
            args[2] === undefined ? 1 : Number(args[2]),
            Number(args[3]) || 0,
            Number(args[4]) || 0,
            Number(args[5]) || 0,
            Number(args[6]) || 0
          );
          return Reflect.construct(OrigDate, [localToUtc(wall)], new.target);
        };
        PatchedDate.prototype = OrigDate.prototype;
        try {
          Object.defineProperty(OrigDate.prototype, 'constructor', {
            configurable: true, writable: true, enumerable: false, value: PatchedDate,
          });
        } catch (_) {}
        PatchedDate.UTC = OrigDate.UTC;
        PatchedDate.now = OrigDate.now;
        PatchedDate.parse = nativeLike(
          function parse(value) { return parseLocal(value); },
          OrigDate.parse, 'parse', 1
        );
        nativeLike(PatchedDate, OrigDate, 'Date', 7, true);
        globalThis.Date = PatchedDate;
      } catch (_) {}
    } catch (_) {}
  }


  // --- audio ---
  // A rendered OfflineAudioContext buffer is a stable per-machine value, so it needs the same
  // per-profile perturbation the canvas gets. Silent buffers are left untouched: a page that
  // renders nothing expects exact zeros, and dithering them is itself the tell.
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
              let silent = true;
              for (let i = 0; i < data.length; i += 1) {
                if (data[i] !== 0) { silent = false; break; }
              }
              if (!silent) {
                for (let i = 0; i < data.length; i += 1) {
                  data[i] = data[i] + (noise(i + channel * 4099 + mark) - 0.5) * 1e-7;
                }
              }
              channels.add(channel);
            }
          } catch (_) {}
          return data;
        });

        if (AudioBuffer.prototype.copyFromChannel) {
          replaceMethod(AudioBuffer.prototype, 'copyFromChannel', (original) => function(destination, channelNumber, startInChannel) {
            const chData = this.getChannelData(Number(channelNumber) || 0);
            const start = Number(startInChannel) || 0;
            const len = Math.min(destination.length, Math.max(0, chData.length - start));
            for (let i = 0; i < len; i += 1) {
              destination[i] = chData[start + i];
            }
          });
        }
      }
      if (globalThis.AnalyserNode) {
        const patchFreq = (name) => {
          if (!AnalyserNode.prototype || !AnalyserNode.prototype[name]) return;
          replaceMethod(AnalyserNode.prototype, name, (original) => function(...args) {
            const res = original.apply(this, args);
            try {
              const array = args[0];
              if (array && array.length) {
                const step = Math.max(1, Math.floor(array.length / 32));
                if (name.includes('Byte')) {
                  for (let i = 0; i < array.length; i += step) {
                    if (array[i] > 0 && array[i] < 255) {
                      const delta = noise(i + mark) > 0.5 ? 1 : -1;
                      array[i] = Math.max(0, Math.min(255, array[i] + delta));
                    }
                  }
                } else {
                  const amp = 1e-5;
                  for (let i = 0; i < array.length; i += step) {
                    if (array[i] !== 0 && !isNaN(array[i]) && isFinite(array[i])) {
                      array[i] += (noise(i + mark) - 0.5) * amp;
                    }
                  }
                }
              }
            } catch (_) {}
            return res;
          });
        };
        patchFreq('getFloatFrequencyData');
        patchFreq('getByteFrequencyData');
        patchFreq('getFloatTimeDomainData');
        patchFreq('getByteTimeDomainData');
      }
    } catch (_) {}
  }

  // --- fonts ---
  // Only the APIs that report font presence directly are answered here. Measurement-based
  // probing (rendering text and comparing widths) is NOT intercepted: doing so means hooking
  // the same geometry the page uses for layout, which risks visibly breaking sites. Closing
  // that path properly belongs in the kernel's font stack, so on a stock Chromium kernel the
  // host's real fonts can still be measured — see the notes in the development guide.
  if (CFG.fonts && Array.isArray(CFG.fonts.list) && CFG.fonts.list.length) {
    const personaFonts = CFG.fonts.list.slice();
    const personaSet = new Set(personaFonts.map((name) => String(name).toLowerCase()));
    const foreignSet = new Set((CFG.fonts.foreign || []).map((name) => String(name).toLowerCase()));
    // Local Font Access: enumerate the persona's set rather than the host's.
    try {
      if (typeof globalThis.queryLocalFonts === 'function') {
        const original = globalThis.queryLocalFonts;
        const patched = nativeLike(async function queryLocalFonts(options) {
          const wanted = options && Array.isArray(options.postscriptNames)
            ? new Set(options.postscriptNames.map((name) => String(name)))
            : null;
          return personaFonts
            .filter((family) => !wanted || wanted.has(family.replace(/\\s+/g, '')))
            .map((family) => Object.freeze({
              family,
              fullName: family,
              postscriptName: family.replace(/\\s+/g, ''),
              style: 'Regular',
            }));
        }, original);
        Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, writable: true, value: patched });
      }
    } catch (_) {}
    // document.fonts.check(): answer for the platform font families we model, and only when
    // the page has not loaded a web font under that name — otherwise defer to the browser so
    // real font-loading logic keeps working.
    try {
      const fontSet = document.fonts;
      if (fontSet && typeof fontSet.check === 'function') {
        const originalCheck = fontSet.check.bind(fontSet);
        const rawCheck = fontSet.check;
        const familyOf = (spec) => {
          // The CSS 'font' shorthand always ends with the family list, preceded by the
          // (required) font-size. Anchor on a UNIT-bearing size so a numeric font-weight
          // (e.g. "700") is not mistaken for it, take everything after it as the family
          // list, then return the primary family, unquoted. Handling only quoted families
          // here leaked: every check() carries a size, so an unquoted family such as
          // "12px Menlo" kept the size token and matched nothing, falling through to the
          // host's real fonts — the exact contradiction this hook exists to prevent.
          // NOTE: template literal — backslashes are doubled so \\s / \\d survive to the page.
          const s = String(spec || '').trim();
          const m = s.match(/(?:^|\\s)\\d*\\.?\\d+(?:px|pt|pc|em|rem|ex|ch|%|vh|vw|vmin|vmax|cm|mm|in|q)(?:\\s*\\/\\s*\\S+)?\\s+(.+)$/i);
          const first = String(m ? m[1] : s).split(',')[0].trim();
          return first.replace(/^["']|["']$/g, '').trim();
        };
        const isWebFont = (family) => {
          try {
            for (const face of fontSet) if (String(face.family).replace(/^["']|["']$/g, '').toLowerCase() === family) return true;
          } catch (_) {}
          return false;
        };
        const patched = nativeLike(function check(spec, text) {
          try {
            const family = familyOf(spec).toLowerCase();
            if (family && !isWebFont(family)) {
              if (foreignSet.has(family)) return false;
              if (personaSet.has(family)) return true;
            }
          } catch (_) {}
          return originalCheck(spec, text);
        }, rawCheck);
        Object.defineProperty(fontSet, 'check', { configurable: true, writable: true, value: patched });
      }
    } catch (_) {}
  }

  // --- screen ---
  try {
    const s = CFG.screen || {};
    const baseScreenWidth = Number(s.width) || 0;
    const baseScreenHeight = Number(s.height) || 0;
    const baseAvailWidth = Number(s.availWidth) || baseScreenWidth;
    const baseAvailHeight = Number(s.availHeight) || (baseScreenHeight ? Math.max(0, baseScreenHeight - 40) : 0);

    const rawWinWidthDesc = Object.getOwnPropertyDescriptor(window, 'innerWidth') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerWidth');
    const rawInnerWidthGet = rawWinWidthDesc?.get ? () => rawWinWidthDesc.get.call(window) : null;
    const rawWinHeightDesc = Object.getOwnPropertyDescriptor(window, 'innerHeight') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerHeight');
    const rawInnerHeightGet = rawWinHeightDesc?.get ? () => rawWinHeightDesc.get.call(window) : null;

    const rawVisualViewport = window.visualViewport;
    const rawVisualWidthDesc = rawVisualViewport ? (Object.getOwnPropertyDescriptor(rawVisualViewport, 'width') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rawVisualViewport), 'width')) : null;
    const rawVisualWidthGet = rawVisualWidthDesc?.get ? () => rawVisualWidthDesc.get.call(rawVisualViewport) : null;
    const rawVisualHeightDesc = rawVisualViewport ? (Object.getOwnPropertyDescriptor(rawVisualViewport, 'height') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rawVisualViewport), 'height')) : null;
    const rawVisualHeightGet = rawVisualHeightDesc?.get ? () => rawVisualHeightDesc.get.call(rawVisualViewport) : null;

    const liveViewportSize = (axis, fallback) => {
      try {
        if (axis === 'width') {
          if (typeof rawVisualWidthGet === 'function') {
            const vw = Number(rawVisualWidthGet());
            if (Number.isFinite(vw) && vw > 0) return Math.round(vw);
          }
          if (typeof rawInnerWidthGet === 'function') {
            const rawW = Number(rawInnerWidthGet());
            if (Number.isFinite(rawW) && rawW > 0) return Math.round(rawW);
          }
        } else {
          if (typeof rawVisualHeightGet === 'function') {
            const vh = Number(rawVisualHeightGet());
            if (Number.isFinite(vh) && vh > 0) return Math.round(vh);
          }
          if (typeof rawInnerHeightGet === 'function') {
            const rawH = Number(rawInnerHeightGet());
            if (Number.isFinite(rawH) && rawH > 0) return Math.round(rawH);
          }
        }
        const root = document && document.documentElement;
        const rootVal = axis === 'width' ? Number(root?.clientWidth) : Number(root?.clientHeight);
        if (Number.isFinite(rootVal) && rootVal > 0) return Math.round(rootVal);
        const body = document && document.body;
        const bodyVal = axis === 'width' ? Number(body?.clientWidth) : Number(body?.clientHeight);
        if (Number.isFinite(bodyVal) && bodyVal > 0) return Math.round(bodyVal);
      } catch (_) {}
      return fallback;
    };

    // A phone has no desktop title bar or window chrome: outerWidth/outerHeight track the layout
    // viewport, the touch surface has to exist as own properties rather than only through
    // navigator.maxTouchPoints, and screen.* stays the panel instead of growing with the window.
    const dynamicScreen = {
      width: () => (MOBILE && baseScreenWidth ? baseScreenWidth : (baseScreenWidth ? Math.max(baseScreenWidth, liveViewportSize('width', baseScreenWidth)) : liveViewportSize('width', 1920))),
      height: () => (MOBILE && baseScreenHeight ? baseScreenHeight : (baseScreenHeight ? Math.max(baseScreenHeight, liveViewportSize('height', baseScreenHeight)) : liveViewportSize('height', 1080))),
      availWidth: () => (MOBILE && baseAvailWidth ? baseAvailWidth : (baseAvailWidth ? Math.max(baseAvailWidth, liveViewportSize('width', baseAvailWidth)) : liveViewportSize('width', 1920))),
      availHeight: () => (MOBILE && baseAvailHeight ? baseAvailHeight : (baseAvailHeight ? Math.max(baseAvailHeight, liveViewportSize('height', baseAvailHeight)) : liveViewportSize('height', 1040))),
      availLeft: () => s.availLeft ?? 0,
      availTop: () => s.availTop ?? 0,
      colorDepth: () => s.colorDepth ?? 24,
      pixelDepth: () => s.pixelDepth ?? 24,
    };

    for (const [key, getter] of Object.entries(dynamicScreen)) {
      try {
        const nativeG = makeNativeGetter(key, getter, "screen");
        Object.defineProperty(Screen.prototype, key, { configurable: true, enumerable: true, get: nativeG });
        if (typeof screen !== "undefined") {
          try { delete screen[key]; } catch (_) {}
        }
      } catch (_) {}
    }
    try { Object.defineProperty(window, 'devicePixelRatio', nativeAccessor('devicePixelRatio', { configurable: true, get: () => s.devicePixelRatio || 1 })); } catch (_) {}
    for (const [key, value] of Object.entries({ screenX: s.screenX, screenY: s.screenY, screenLeft: s.screenX, screenTop: s.screenY })) {
      try { Object.defineProperty(window, key, nativeAccessor(key, { configurable: true, get: () => value || 0 })); } catch (_) {}
    }

    const initialInnerWidth = Number(window.innerWidth) || Number(s.availWidth) || Number(s.width) || 1;
    const initialInnerHeight = Number(window.innerHeight) || Number(s.availHeight) || Number(s.height) || 1;
    try { Object.defineProperty(window, 'innerWidth', nativeAccessor('innerWidth', { configurable: true, get: () => liveViewportSize('width', initialInnerWidth) })); } catch (_) {}
    try { Object.defineProperty(window, 'innerHeight', nativeAccessor('innerHeight', { configurable: true, get: () => liveViewportSize('height', initialInnerHeight) })); } catch (_) {}
    const isFullscreen = () => {
      try { return Boolean(document && (document.fullscreenElement || document.webkitFullscreenElement)); }
      catch (_) { return false; }
    };
    const getOuterHeight = () => {
      const h = liveViewportSize('height', initialInnerHeight);
      return (MOBILE || isFullscreen()) ? h : (h + 88);
    };
    const getOuterWidth = () => {
      const w = liveViewportSize('width', initialInnerWidth);
      return (MOBILE || isFullscreen()) ? w : (w + 16);
    };
    try { Object.defineProperty(window, 'outerWidth', nativeAccessor('outerWidth', { configurable: true, get: getOuterWidth })); } catch (_) {}
    try { Object.defineProperty(window, 'outerHeight', nativeAccessor('outerHeight', { configurable: true, get: getOuterHeight })); } catch (_) {}
    if (MOBILE) {
      try { Object.defineProperty(window, 'ontouchstart', nativeAccessor('ontouchstart', { configurable: true, enumerable: true, get: () => null })); } catch (_) {}
      try { Object.defineProperty(window, 'orientation', nativeAccessor('orientation', { configurable: true, get: () => 0 })); } catch (_) {}
      try {
        const meta = CFG.userAgentMetadata || {};
        const brandList = Object.freeze((meta.brands || []).map((item) => Object.freeze({
          brand: String(item.brand),
          version: String(item.version),
        })));
        const fullList = Object.freeze((meta.fullVersionList || meta.brands || []).map((item) => Object.freeze({
          brand: String(item.brand),
          version: String(item.version),
        })));
        const chPlatform = String(meta.platform || "Android");
        const chPlatformVersion = String(meta.platformVersion || "");
        const chModel = String(meta.model || "");
        const chFullVersion = String(meta.uaFullVersion || meta.fullVersion || "");
        const chMobile = Object.freeze({
          brands: brandList,
          mobile: true,
          platform: chPlatform,
          getHighEntropyValues(hints) {
            const all = {
              brands: brandList,
              fullVersionList: fullList,
              fullVersion: chFullVersion,
              uaFullVersion: chFullVersion,
              platform: chPlatform,
              platformVersion: chPlatformVersion,
              architecture: String(meta.architecture || ""),
              model: chModel,
              mobile: true,
              bitness: String(meta.bitness || ""),
              wow64: false,
            };
            const out = { brands: brandList, mobile: true, platform: chPlatform };
            for (const hint of Array.isArray(hints) ? hints : []) if (hint in all) out[hint] = all[hint];
            return Promise.resolve(out);
          },
          toJSON() { return { brands: brandList, mobile: true, platform: chPlatform }; },
        });
        if (globalThis.Navigator?.prototype) {
          Object.defineProperty(globalThis.Navigator.prototype, 'userAgentData', nativeAccessor('userAgentData', { configurable: true, enumerable: true, get: () => chMobile }));
        }
      } catch (_) {}
    }

    try {
      if (typeof window.matchMedia === "function") {
        const origMatchMedia = window.matchMedia.bind(window);
        // A plain object literal is not a MediaQueryList: Object.getPrototypeOf(mql) and
        // an instanceof MediaQueryList check both give the patch away, and the listener methods
        // silently do nothing. Take a real MediaQueryList from the engine and override only the
        // two values we need, so the prototype chain, brand checks and change events stay real.
        const spoofMql = (query, matches) => {
          const real = origMatchMedia(String(query));
          if (real.matches === matches) return real;
          try {
            // Re-query with a expression the engine itself resolves to the value we need, so the
            // object keeps live change notifications instead of a frozen boolean.
            const forced = origMatchMedia(matches ? 'all' : 'not all');
            Object.defineProperty(forced, 'media', {
              configurable: true, enumerable: true, get: nativeLike(function media() { return String(query); }, null, 'media', 0),
            });
            return forced;
          } catch (_) {}
          try {
            Object.defineProperty(real, 'matches', {
              configurable: true, enumerable: true, get: nativeLike(function matches() { return matches; }, null, 'matches', 0),
            });
          } catch (_) {}
          return real;
        };
        const patchedMatchMedia = {
          matchMedia(query) {
            const q = String(query || "").toLowerCase();
            const sw = dynamicScreen.width();
            const sh = dynamicScreen.height();
            const mDevW = q.match(/\((min-|max-)?device-width:\s*([\d.]+)px\)/);
            if (mDevW) {
              const type = mDevW[1] || "";
              const val = parseFloat(mDevW[2]);
              let matches = false;
              if (type === "min-") matches = sw >= val;
              else if (type === "max-") matches = sw <= val;
              else matches = Math.abs(sw - val) < 1;
              return spoofMql(query, matches);
            }
            const mDevH = q.match(/\((min-|max-)?device-height:\s*([\d.]+)px\)/);
            if (mDevH) {
              const type = mDevH[1] || "";
              const val = parseFloat(mDevH[2]);
              let matches = false;
              if (type === "min-") matches = sh >= val;
              else if (type === "max-") matches = sh <= val;
              else matches = Math.abs(sh - val) < 1;
              return spoofMql(query, matches);
            }
            const mDpr = q.match(/\(-webkit-(min-|max-)?device-pixel-ratio:\s*([\d.]+)\)/);
            if (mDpr) {
              const type = mDpr[1] || "";
              const val = parseFloat(mDpr[2]);
              const curDpr = Number(s.devicePixelRatio) || 1;
              let matches = false;
              if (type === "min-") matches = curDpr >= val;
              else if (type === "max-") matches = curDpr <= val;
              else matches = Math.abs(curDpr - val) < 0.01;
              return spoofMql(query, matches);
            }
            const mRes = q.match(/\((min-|max-)?resolution:\s*([\d.]+)(dppx|dpi)\)/);
            if (mRes) {
              const type = mRes[1] || "";
              const val = parseFloat(mRes[2]);
              const unit = mRes[3];
              const curDpr = Number(s.devicePixelRatio) || 1;
              const curVal = unit === "dpi" ? curDpr * 96 : curDpr;
              let matches = false;
              if (type === "min-") matches = curVal >= val;
              else if (type === "max-") matches = curVal <= val;
              else matches = Math.abs(curVal - val) < (unit === "dpi" ? 1 : 0.01);
              return spoofMql(query, matches);
            }
            return origMatchMedia(query);
          }
        }.matchMedia;
        nativeSource.set(patchedMatchMedia, "function matchMedia() { [native code] }");
        Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: patchedMatchMedia });
      }
    } catch (_) {}

    const patchSubWindow = (subWin) => {
      if (!subWin || subWin === window) return;
      try {
        const subNav = subWin.Navigator && subWin.Navigator.prototype;
        if (subNav) {
          for (const [key, desc] of Object.entries(navPatch)) {
            const g = makeNativeGetter(key, desc.get, "navigator");
            Object.defineProperty(subNav, key, { configurable: true, enumerable: true, get: g });
            if (subWin.navigator) {
              try { delete subWin.navigator[key]; } catch (_) {}
            }
          }
          if (typeof Navigator !== "undefined" && Navigator.prototype) {
            for (const k of ['userAgent', 'appVersion', 'userAgentData', 'plugins', 'mimeTypes']) {
              const d = Object.getOwnPropertyDescriptor(Navigator.prototype, k);
              if (d) {
                try { Object.defineProperty(subNav, k, d); } catch (_) {}
                if (subWin.navigator) { try { delete subWin.navigator[k]; } catch (_) {} }
              }
            }
          }
        }
        const subScreen = subWin.Screen && subWin.Screen.prototype;
        if (subScreen) {
          for (const [key, getter] of Object.entries(dynamicScreen)) {
            const g = makeNativeGetter(key, getter, "screen");
            Object.defineProperty(subScreen, key, { configurable: true, enumerable: true, get: g });
            if (subWin.screen) {
              try { delete subWin.screen[key]; } catch (_) {}
            }
          }
        }
        if (CFG.timezone && subWin.Date && subWin.Date !== Date) {
          try {
            subWin.Date = Date;
            if (subWin.Intl && subWin.Intl.DateTimeFormat) {
              subWin.Intl.DateTimeFormat = Intl.DateTimeFormat;
            }
          } catch (_) {}
        }
        if (!subWin.chrome && typeof window !== "undefined" && window.chrome) {
          try { subWin.chrome = window.chrome; } catch (_) {}
        }
        for (const hook of subWindowSyncHooks) {
          try { hook(subWin); } catch (_) {}
        }
      } catch (_) {}
    };

    try {
      if (typeof HTMLIFrameElement !== "undefined") {
        const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
        if (desc && typeof desc.get === "function") {
          const origCW = desc.get;
          const patchedCW = nativeGetter("contentWindow", function() {
            const subWin = origCW.call(this);
            if (subWin) patchSubWindow(subWin);
            return subWin;
          });
          Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
            configurable: true,
            enumerable: true,
            get: patchedCW,
          });
        }
        const docDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument");
        if (docDesc && typeof docDesc.get === "function") {
          const origCD = docDesc.get;
          const patchedCD = nativeGetter("contentDocument", function() {
            const subDoc = origCD.call(this);
            if (subDoc && subDoc.defaultView) patchSubWindow(subDoc.defaultView);
            return subDoc;
          });
          Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
            configurable: true,
            enumerable: true,
            get: patchedCD,
          });
        }
      }
    } catch (_) {}
    try {
      const viewport = window.visualViewport;
      if (viewport) {
        const initialVisualWidth = Number(viewport.width) || initialInnerWidth;
        const initialVisualHeight = Number(viewport.height) || initialInnerHeight;
        Object.defineProperty(viewport, 'width', nativeAccessor('width', { configurable: true, get: () => liveViewportSize('width', initialVisualWidth) }));
        Object.defineProperty(viewport, 'height', nativeAccessor('height', { configurable: true, get: () => liveViewportSize('height', initialVisualHeight) }));
      }
    } catch (_) {}
    try {
      Object.defineProperty(document, 'fullscreenEnabled', nativeAccessor('fullscreenEnabled', { configurable: true, get: () => true }));
      Object.defineProperty(document, 'webkitFullscreenEnabled', nativeAccessor('webkitFullscreenEnabled', { configurable: true, get: () => true }));
    } catch (_) {}
    try {
      const origReqFs = Element.prototype.requestFullscreen || Element.prototype.webkitRequestFullscreen;
      if (typeof origReqFs === 'function') {
        const patchedReqFs = nativeLike(function requestFullscreen(options) {
          try {
            const res = origReqFs.call(this, options);
            if (res && typeof res.catch === 'function') {
              return res.catch(() => {
                if (typeof this.webkitRequestFullscreen === 'function' && this.webkitRequestFullscreen !== requestFullscreen) {
                  try { this.webkitRequestFullscreen(options); } catch (_) {}
                }
                return Promise.resolve();
              });
            }
            return res || Promise.resolve();
          } catch (_) {
            if (typeof this.webkitRequestFullscreen === 'function' && this.webkitRequestFullscreen !== requestFullscreen) {
              try { this.webkitRequestFullscreen(options); } catch (_) {}
            }
            return Promise.resolve();
          }
        }, origReqFs);
        try { Element.prototype.requestFullscreen = patchedReqFs; } catch (_) {}
        try { Element.prototype.webkitRequestFullscreen = patchedReqFs; } catch (_) {}
      }
    } catch (_) {}
    try {
      const ensureIframeFullscreen = (node) => {
        if (!node || node.nodeType !== 1 || node.tagName !== 'IFRAME') return;
        try {
          if (!node.hasAttribute('allowfullscreen')) node.setAttribute('allowfullscreen', 'true');
          if (!node.hasAttribute('webkitallowfullscreen')) node.setAttribute('webkitallowfullscreen', 'true');
          const curAllow = node.getAttribute('allow') || '';
          if (!curAllow.includes('fullscreen')) {
            node.setAttribute('allow', (curAllow ? curAllow + '; ' : '') + 'fullscreen *; autoplay *');
          }
        } catch (_) {}
      };
      try {
        if (typeof document.querySelectorAll === 'function') {
          document.querySelectorAll('iframe').forEach(ensureIframeFullscreen);
        }
      } catch (_) {}
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          try {
            document.querySelectorAll('iframe').forEach(ensureIframeFullscreen);
          } catch (_) {}
        }, { once: true });
      }
      if (typeof MutationObserver === 'function' && document.documentElement) {
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) {
              ensureIframeFullscreen(n);
              if (n.querySelectorAll) {
                try { n.querySelectorAll('iframe').forEach(ensureIframeFullscreen); } catch (_) {}
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (_) {}
  } catch (_) {}

  // --- canvas ---
  const webglCanvases = new WeakSet();
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
      // Only for 2D canvases! WebGL canvases must not be drawn via 2D drawImage (destroys WebGL rendering/readback)
      const noiseCanvas = (source) => {
        const w = source.width | 0;
        const h = source.height | 0;
        if (!w || !h || !originalGet) return null;
        if (webglCanvases.has(source)) return null;
        const copy = document.createElement('canvas');
        copy.width = w;
        copy.height = h;
        const c2 = copy.getContext('2d');
        if (!c2) return null;
        try {
          c2.drawImage(source, 0, 0);
          const image = applyCanvasNoise(originalGet.call(c2, 0, 0, w, h), mark);
          c2.putImageData(image, 0, 0);
          return copy;
        } catch (_) { return null; }
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
      const blockContext = (proto) => replaceMethod(proto, 'getContext', (target) => function(...argArray) {
          const type = String(argArray[0] || '');
          if (type.includes('webgl') || type === 'experimental-webgl') return null;
          return Reflect.apply(target, this, argArray);
      });
      blockContext(globalThis.HTMLCanvasElement?.prototype);
      blockContext(globalThis.OffscreenCanvas?.prototype);
    } catch (_) {}
  } else if (CFG.webgl && (CFG.webgl.mode === 'noise' || (CFG.webgl.metaMode && CFG.webgl.metaMode !== 'real'))) {
    try {
      const mark = Number(CFG.webgl.mark) || 1;
      const metaMode = String(CFG.webgl.metaMode || 'noise');
      const pixelNoise = CFG.webgl.mode === 'noise';
      const enabledDebugExts = new WeakSet();

      const patchGetExtension = (proto) => {
        if (!proto || !proto.getExtension) return;
        replaceMethod(proto, 'getExtension', (original) => function(name) {
          const extName = String(name || '').toLowerCase();
          if (metaMode === 'blocked' && extName === 'webgl_debug_renderer_info') return null;
          let ext = original.apply(this, arguments);
          if (extName === 'webgl_debug_renderer_info') {
            if (!ext && metaMode !== 'blocked' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
              const debugProto = typeof WebGLDebugRendererInfo !== "undefined" ? WebGLDebugRendererInfo.prototype : Object.prototype;
              ext = Object.create(debugProto);
              Object.defineProperty(ext, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, enumerable: true, writable: false, configurable: false });
              Object.defineProperty(ext, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, enumerable: true, writable: false, configurable: false });
            }
            if (ext) enabledDebugExts.add(this);
          }
          return ext;
        });
      };

      const patchGetParameter = (proto) => {
        if (!proto || !proto.getParameter) return;
        if (metaMode === 'real') return;
        replaceMethod(proto, 'getParameter', (original) => function(param) {
          const UNMASKED_VENDOR_WEBGL = 0x9245;
          const UNMASKED_RENDERER_WEBGL = 0x9246;
          if (param === UNMASKED_VENDOR_WEBGL || param === UNMASKED_RENDERER_WEBGL) {
            if (!enabledDebugExts.has(this)) {
              // Conforms to real Chrome: without WEBGL_debug_renderer_info, native returns null and sets INVALID_ENUM
              return original.apply(this, arguments);
            }
            if (param === UNMASKED_VENDOR_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
            if (param === UNMASKED_RENDERER_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
          }
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
            if (pixels && pixels.length && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
              // Skip empty/black buffer
              let hasNonZero = false;
              for (let i = 0; i < pixels.length; i += 32) {
                if (pixels[i] !== 0) { hasNonZero = true; break; }
              }
              if (!hasNonZero) return result;

              const amp = noiseAmplitudeNow();
              const step = Math.max(4, Math.floor(pixels.length / sampleStepDivisorNow()));
              for (let i = 0; i < pixels.length; i += step) {
                const alphaIdx = i - (i % 4) + 3;
                if (alphaIdx < pixels.length && pixels[alphaIdx] === 0) continue;
                const n = Math.floor(noise(i + mark) * amp) - Math.floor(amp / 2);
                pixels[i] = Math.max(0, Math.min(255, (pixels[i] || 0) + n));
              }
            }
          } catch (_) {}
          return result;
        });
      };

      const patchGetSupportedExtensions = (proto) => {
        if (!proto || !proto.getSupportedExtensions) return;
        replaceMethod(proto, 'getSupportedExtensions', (original) => function() {
          const list = original.apply(this, arguments);
          if (metaMode === 'blocked' && Array.isArray(list)) {
            return list.filter((ext) => String(ext).toLowerCase() !== 'webgl_debug_renderer_info');
          }
          if (Array.isArray(list) && metaMode !== 'blocked' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
            if (!list.some((ext) => String(ext).toLowerCase() === 'webgl_debug_renderer_info')) {
              return [...list, 'WEBGL_debug_renderer_info'];
            }
          }
          return list;
        });
      };

      if (globalThis.WebGLRenderingContext) {
        patchGetParameter(WebGLRenderingContext.prototype);
        patchReadPixels(WebGLRenderingContext.prototype);
        patchGetExtension(WebGLRenderingContext.prototype);
        patchGetSupportedExtensions(WebGLRenderingContext.prototype);
      }
      if (globalThis.WebGL2RenderingContext) {
        patchGetParameter(WebGL2RenderingContext.prototype);
        patchReadPixels(WebGL2RenderingContext.prototype);
        patchGetExtension(WebGL2RenderingContext.prototype);
        patchGetSupportedExtensions(WebGL2RenderingContext.prototype);
      }
      subWindowSyncHooks.push((subWin) => {
        if (subWin.WebGLRenderingContext) {
          patchGetParameter(subWin.WebGLRenderingContext.prototype);
          patchReadPixels(subWin.WebGLRenderingContext.prototype);
          patchGetExtension(subWin.WebGLRenderingContext.prototype);
          patchGetSupportedExtensions(subWin.WebGLRenderingContext.prototype);
        }
        if (subWin.WebGL2RenderingContext) {
          patchGetParameter(subWin.WebGL2RenderingContext.prototype);
          patchReadPixels(subWin.WebGL2RenderingContext.prototype);
          patchGetExtension(subWin.WebGL2RenderingContext.prototype);
          patchGetSupportedExtensions(subWin.WebGL2RenderingContext.prototype);
        }
      });

      // Track WebGL canvases so 2D toDataURL does not attempt to draw them
      try {
        const wrapCtx = (proto) => {
          if (!proto || !proto.getContext) return;
          replaceMethod(proto, 'getContext', (original) => function(...args) {
            const ctx = original.apply(this, args);
            try {
              const type = String(args[0] || '').toLowerCase();
              if (type.includes('webgl') || type.includes('experimental-webgl')) {
                webglCanvases.add(this);
              }
            } catch (_) {}
            return ctx;
          });
        };
        wrapCtx(globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype);
        wrapCtx(globalThis.OffscreenCanvas && OffscreenCanvas.prototype);
      } catch (_) {}
    } catch (_) {}
  }

  // --- client rects ---
  if (CFG.clientRects && CFG.clientRects.mode === 'noise') {
    try {
      const mark = Number(CFG.clientRects.mark) || 1;
      // A zero offset would silently disable this whole surface for that profile (the host value
      // would pass through untouched), so the derived step is never allowed to collapse to 0.
      const rawStep = (mark % 7) - 3;
      const noisePx = (rawStep === 0 ? 1 : rawStep) * 0.0001;
      // Font-metric fingerprinting reads width/height, so those carry their own deterministic
      // sub-pixel delta instead of being handed back untouched.
      const sizeStep = (mark % 5) - 2;
      const noiseSize = (sizeStep === 0 ? 1 : sizeStep) * 0.0001;
      const patch = (proto, method) => {
        if (!proto || !proto[method]) return;
        replaceMethod(proto, method, (original) => function() {
          const rect = original.apply(this, arguments);
          if (!rect) return rect;
          try {
            const x = rect.x + noisePx, y = rect.y + noisePx;
            const width = rect.width + noiseSize, height = rect.height + noiseSize;
            return DOMRect.fromRect ? DOMRect.fromRect({ x, y, width, height }) : rect;
          } catch (_) { return rect; }
        });
      };
      // A DOMRectList facade must shadow every native accessor/iterator: inheriting the real
      // prototype gives instanceof parity, but the native length getter, item() and iterator
      // throw "Illegal invocation" on a synthetic object. Own/proto-level shims keep
      // Array.from(), spread, for..of and item() working exactly like a real list.
      const rectsFacadeProto = (() => {
        const proto = typeof DOMRectList !== "undefined" ? Object.create(DOMRectList.prototype) : {};
        Object.defineProperty(proto, "item", {
          value: function item(index) { return this[index] || null; },
          writable: true, configurable: true, enumerable: false,
        });
        if (typeof Symbol !== "undefined" && Symbol.iterator) {
          Object.defineProperty(proto, Symbol.iterator, {
            value: function iterator() {
              let i = 0;
              const self = this;
              return {
                next() {
                  return i < self.length ? { value: self[i++], done: false } : { value: undefined, done: true };
                },
                [Symbol.iterator]() { return this; },
              };
            },
            writable: true, configurable: true, enumerable: false,
          });
        }
        return proto;
      })();
      const patchList = (proto, method) => {
        if (!proto || !proto[method]) return;
        replaceMethod(proto, method, (original) => function() {
          const list = original.apply(this, arguments);
          if (!list) return list;
          try {
            const rects = Object.create(rectsFacadeProto);
            for (let i = 0; i < list.length; i += 1) {
              const rect = list[i];
              rects[i] = DOMRect.fromRect
                ? DOMRect.fromRect({ x: rect.x + noisePx, y: rect.y + noisePx, width: rect.width + noiseSize, height: rect.height + noiseSize })
                : rect;
            }
            Object.defineProperty(rects, "length", { value: list.length, writable: false, configurable: true, enumerable: false });
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
      const blocked = nativeLike(function RTCPeerConnection() {
        throw new DOMException('WebRTC is disabled by this profile', 'NotAllowedError');
      }, globalThis.RTCPeerConnection, 'RTCPeerConnection', 0, true);
      if (globalThis.RTCPeerConnection) window.RTCPeerConnection = blocked;
      if (globalThis.webkitRTCPeerConnection) window.webkitRTCPeerConnection = blocked;
    } catch (_) {}
  } else if (CFG.webrtc === 'proxy' && CFG.webrtcAddress) {
    // NOTE: the bundled 148 kernel refuses to construct a peer connection at all ("detached
    // documents"), for every webrtc_policy value. This layer therefore only ever runs on a stock
    // Chromium kernel, which is exactly why it has to be correct there.
    try {
      const targetIp = String(CFG.webrtcAddress || '');
      const IPV4 = /^\\d{1,3}(\\.\\d{1,3}){3}$/;
      const isPrivateIpv4 = (value) => (
        /^10\\./.test(value)
        || /^192\\.168\\./.test(value)
        || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(value)
        || /^169\\.254\\./.test(value)
        || /^127\\./.test(value)
      );
      // Only the machine's own addresses may be replaced: private IPv4, any IPv6 literal
      // (link-local, ULA or global) and the mDNS .local name Chrome uses for host candidates all
      // identify the host. A public candidate already carries the exit address and must survive.
      // The previous version rewrote every "typ host" line with a regex that only understood
      // IPv4, so IPv6 and .local candidates went out untouched.
      const isOwnAddress = (value) => {
        const addr = String(value || '');
        if (!addr) return false;
        if (/\\.local$/i.test(addr)) return true;
        if (IPV4.test(addr)) return isPrivateIpv4(addr);
        if (addr.includes(':')) return true;
        return false;
      };
      const rewriteCandidateLine = (line) => {
        if (typeof line !== 'string' || !targetIp) return line;
        // The ICE event hands out "candidate:..." while the SDP line carries "a=candidate:...",
        // so the prefix is optional and has to be preserved on the way out.
        const m = line.match(/^(a=)?candidate:(\\S+) (\\d+) (\\S+) (\\d+) (\\S+) (\\d+) typ (\\S+)([\\s\\S]*)$/);
        if (!m) return line;
        let changed = false;
        let addr = m[6];
        if (isOwnAddress(addr)) { addr = targetIp; changed = true; }
        // raddr on a reflexive candidate names the base address it was observed from, which is
        // the same local address in a different field.
        const tail = m[9].replace(/ raddr (\\S+)/, (whole, base) => {
          if (!isOwnAddress(base)) return whole;
          changed = true;
          return ' raddr 0.0.0.0';
        });
        if (!changed) return line;
        return (m[1] || '') + 'candidate:' + m[2] + ' ' + m[3] + ' ' + m[4] + ' ' + m[5] + ' ' + addr
          + ' ' + m[7] + ' typ ' + m[8] + tail;
      };
      const rewriteSdp = (desc) => {
        if (!desc || typeof desc.sdp !== 'string' || !targetIp) return desc;
        try {
          const nl = String.fromCharCode(10);
          let changed = false;
          const mapped = desc.sdp.split(nl).map((line) => {
            const next = rewriteCandidateLine(line);
            if (next !== line) changed = true;
            return next;
          });
          if (!changed) return desc;
          return Object.assign({}, desc, { sdp: mapped.join(nl) });
        } catch (_) { return desc; }
      };
      // Descriptions the page reads have to stay brand-checkable, or instanceof becomes a tell.
      const rewriteDescription = (desc) => {
        const next = rewriteSdp(desc);
        if (next === desc) return desc;
        try { return new RTCSessionDescription({ type: next.type, sdp: next.sdp }); } catch (_) { return next; }
      };
      const rewriteCandidate = (candidate) => {
        if (!candidate || typeof candidate.candidate !== 'string') return candidate;
        const line = rewriteCandidateLine(candidate.candidate);
        if (line === candidate.candidate) return candidate;
        try {
          return new RTCIceCandidate({
            candidate: line,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          });
        } catch (_) { return candidate; }
      };
      const rewriteIceEvent = (event) => {
        try {
          if (!event || !event.candidate) return event;
          const candidate = rewriteCandidate(event.candidate);
          if (candidate === event.candidate) return event;
          if (typeof RTCPeerConnectionIceEvent === 'function') {
            const rebuilt = new RTCPeerConnectionIceEvent('icecandidate', { candidate: candidate, url: event.url || '' });
            if (rebuilt && rebuilt.candidate) return rebuilt;
          }
          const shim = Object.create(Object.getPrototypeOf(event));
          const own = { candidate: candidate, type: event.type, target: event.target, currentTarget: event.currentTarget };
          for (const key of Object.keys(own)) {
            try { Object.defineProperty(shim, key, { value: own[key], enumerable: true, configurable: true }); } catch (_) {}
          }
          return shim;
        } catch (_) { return event; }
      };
      const pcProto = globalThis.RTCPeerConnection && RTCPeerConnection.prototype;
      if (pcProto) {
        if (pcProto.createOffer) {
          replaceMethod(pcProto, 'createOffer', (orig) => async function createOffer(...args) {
            return rewriteSdp(await orig.apply(this, args));
          });
        }
        if (pcProto.createAnswer) {
          replaceMethod(pcProto, 'createAnswer', (orig) => async function createAnswer(...args) {
            return rewriteSdp(await orig.apply(this, args));
          });
        }
        if (pcProto.setLocalDescription) {
          replaceMethod(pcProto, 'setLocalDescription', (orig) => async function setLocalDescription(desc, ...args) {
            // setLocalDescription() with no argument is the documented modern form: the engine
            // builds and applies the offer itself, so there is no argument to rewrite and the
            // stored description is covered by the getters below instead.
            return orig.call(this, desc === undefined ? desc : rewriteSdp(desc), ...args);
          });
        }
        // Every path funnels through the description getters: the rewritten argument form, the
        // no-argument form and a page that built its own SDP. Reading is the only place that
        // covers all three, so the raw stored SDP never reaches the page.
        const descriptionCache = new WeakMap();
        for (const key of ['localDescription', 'currentLocalDescription', 'pendingLocalDescription',
          'remoteDescription', 'currentRemoteDescription', 'pendingRemoteDescription']) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(pcProto, key);
            if (!descriptor || typeof descriptor.get !== 'function' || descriptor.configurable === false) continue;
            Object.defineProperty(pcProto, key, {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                const raw = descriptor.get.call(this);
                if (!raw) return raw;
                let cache = descriptionCache.get(this);
                if (!cache) { cache = new Map(); descriptionCache.set(this, cache); }
                const hit = cache.get(key);
                if (hit && hit.raw === raw) return hit.wrapped;
                const wrapped = rewriteDescription(raw);
                cache.set(key, { raw: raw, wrapped: wrapped });
                return wrapped;
              },
            });
          } catch (_) {}
        }
        // Gathered candidates also reach the page one by one through the handler or a listener.
        try {
          const handlerState = new WeakMap();
          const descriptor = Object.getOwnPropertyDescriptor(pcProto, 'onicecandidate');
          if (descriptor && typeof descriptor.set === 'function') {
            Object.defineProperty(pcProto, 'onicecandidate', {
              configurable: true,
              enumerable: descriptor.enumerable,
              get() {
                const state = handlerState.get(this);
                return state ? state.user || null : null;
              },
              set(fn) {
                const state = handlerState.get(this) || {};
                state.user = typeof fn === 'function' ? fn : null;
                handlerState.set(this, state);
                if (typeof fn !== 'function') { descriptor.set.call(this, null); return; }
                descriptor.set.call(this, function onicecandidate(event) {
                  return fn.call(this, rewriteIceEvent(event));
                });
              },
            });
          }
        } catch (_) {}
        try {
          const listenerWrappers = new WeakMap();
          const captureOf = (options) => (options === true
            || (options && typeof options === 'object' && options.capture) ? 'capture' : 'bubble');
          if (pcProto.addEventListener) {
            replaceMethod(pcProto, 'addEventListener', (orig) => function addEventListener(type, listener, options) {
              if (String(type) !== 'icecandidate' || typeof listener !== 'function') {
                return orig.call(this, type, listener, options);
              }
              let perTarget = listenerWrappers.get(this);
              if (!perTarget) { perTarget = new WeakMap(); listenerWrappers.set(this, perTarget); }
              let perListener = perTarget.get(listener);
              if (!perListener) { perListener = new Map(); perTarget.set(listener, perListener); }
              const key = captureOf(options);
              let wrapper = perListener.get(key);
              if (!wrapper) {
                wrapper = function wrapped(event) { return listener.call(this, rewriteIceEvent(event)); };
                perListener.set(key, wrapper);
              }
              return orig.call(this, type, wrapper, options);
            });
          }
          if (pcProto.removeEventListener) {
            replaceMethod(pcProto, 'removeEventListener', (orig) => function removeEventListener(type, listener, options) {
              if (String(type) === 'icecandidate' && typeof listener === 'function') {
                const perTarget = listenerWrappers.get(this);
                const perListener = perTarget && perTarget.get(listener);
                const wrapper = perListener && perListener.get(captureOf(options));
                if (wrapper) return orig.call(this, type, wrapper, options);
              }
              return orig.call(this, type, listener, options);
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // --- mediaDevices ---
  if (CFG.mediaDevices && CFG.mediaDevices.mode && CFG.mediaDevices.mode !== 'real' && Array.isArray(CFG.mediaDevices.devices)) {
    try {
      const devProto = typeof MediaDeviceInfo !== "undefined" ? MediaDeviceInfo.prototype : Object.prototype;
      const makeDevice = (kind, label, deviceId, groupId) => {
        const item = Object.create(devProto);
        const props = {
          deviceId: String(deviceId || ""),
          kind: String(kind || ""),
          label: String(label || ""),
          groupId: String(groupId || ""),
        };
        for (const [k, v] of Object.entries(props)) {
          Object.defineProperty(item, k, { value: v, enumerable: false, writable: false, configurable: true });
        }
        item.toJSON = function toJSON() {
          return { deviceId: item.deviceId, kind: item.kind, label: item.label, groupId: item.groupId };
        };
        Object.defineProperty(item, 'toJSON', { enumerable: false, writable: true, configurable: true });
        return item;
      };
      const devices = CFG.mediaDevices.devices.map((d) => makeDevice(d.kind, d.label, d.deviceId, d.groupId));
      // Chrome only publishes identifiers and labels once the user has granted a capture
      // permission; before that the same three entries come back with every field empty. Handing
      // out ids up front both diverged from the real surface and made the synthetic identifiers
      // readable without any permission prompt.
      const withheldDevices = CFG.mediaDevices.devices.map((d) => makeDevice(d.kind, "", "", ""));
      const enumerateForPermission = async () => {
        let granted = false;
        try {
          const perms = navigator.permissions;
          if (perms && typeof perms.query === 'function') {
            const [cam, mic] = await Promise.all([
              Promise.resolve().then(() => perms.query({ name: 'camera' })).catch(() => null),
              Promise.resolve().then(() => perms.query({ name: 'microphone' })).catch(() => null),
            ]);
            granted = Boolean((cam && cam.state === 'granted') || (mic && mic.state === 'granted'));
          }
        } catch (_) {}
        return (granted ? devices : withheldDevices).slice();
      };
      const mdProto = typeof MediaDevices !== 'undefined' ? MediaDevices.prototype : null;
      if (mdProto && mdProto.enumerateDevices) {
        replaceMethod(mdProto, 'enumerateDevices', () => async function enumerateDevices() {
          return enumerateForPermission();
        });
      } else if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        replaceMethod(navigator.mediaDevices, 'enumerateDevices', () => async function enumerateDevices() {
          return enumerateForPermission();
        });
      }
    } catch (_) {}
  }

  // --- speech voices ---
  if (CFG.speech && CFG.speech.mode === 'blocked') {
    try {
      const spProto = typeof SpeechSynthesis !== 'undefined' ? SpeechSynthesis.prototype : null;
      if (spProto && spProto.getVoices) {
        replaceMethod(spProto, 'getVoices', () => function getVoices() { return []; });
      } else if (globalThis.speechSynthesis) {
        replaceMethod(speechSynthesis, 'getVoices', () => function getVoices() { return []; });
      }
    } catch (_) {}
  } else if (CFG.speech && CFG.speech.mode === 'noise' && Array.isArray(CFG.speech.voices)) {
    try {
      const voiceProto = typeof SpeechSynthesisVoice !== "undefined" ? SpeechSynthesisVoice.prototype : Object.prototype;
      const voices = CFG.speech.voices.map((v) => {
        const voice = Object.create(voiceProto);
        const props = {
          name: String(v.name || ""),
          lang: String(v.lang || "en-US"),
          default: Boolean(v.default),
          localService: v.localService !== false,
          voiceURI: String(v.voiceURI || v.name || ""),
        };
        for (const [k, val] of Object.entries(props)) {
          Object.defineProperty(voice, k, { value: val, enumerable: false, writable: false, configurable: true });
        }
        return voice;
      });
      const spProto = typeof SpeechSynthesis !== 'undefined' ? SpeechSynthesis.prototype : null;
      if (spProto && spProto.getVoices) {
        replaceMethod(spProto, 'getVoices', () => function getVoices() { return voices.slice(); });
      } else if (globalThis.speechSynthesis) {
        replaceMethod(speechSynthesis, 'getVoices', () => function getVoices() { return voices.slice(); });
      }
    } catch (_) {}
  }

  // --- battery ---
  if (CFG.battery && CFG.battery.mode === 'blocked') {
    try {
      const blocked = function getBattery() {
        return Promise.reject(new DOMException('Battery status is disabled by this profile', 'NotAllowedError'));
      };
      const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
      if (navProto && navProto.getBattery) {
        replaceMethod(navProto, 'getBattery', () => blocked);
      } else if (navigator.getBattery) {
        replaceMethod(navigator, 'getBattery', () => blocked);
      }
    } catch (_) {}
  } else if (CFG.battery && CFG.battery.mode === 'noise' && CFG.battery.value && !CFG.battery.value.blocked) {
    try {
      const snap = CFG.battery.value;
      const battProto = typeof BatteryManager !== "undefined" ? BatteryManager.prototype : (typeof EventTarget !== "undefined" ? EventTarget.prototype : Object.prototype);
      const makeManager = () => {
        const manager = Object.create(battProto);
        const props = {
          charging: Boolean(snap.charging),
          chargingTime: snap.chargingTime == null ? Infinity : Number(snap.chargingTime),
          dischargingTime: snap.dischargingTime == null ? Infinity : Number(snap.dischargingTime),
          level: Math.min(1, Math.max(0, Number(snap.level) || 0)),
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null,
        };
        for (const [k, val] of Object.entries(props)) {
          Object.defineProperty(manager, k, { value: val, enumerable: false, writable: false, configurable: true });
        }
        return manager;
      };
      const spoofed = function getBattery() { return Promise.resolve(makeManager()); };
      const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
      if (navProto && navProto.getBattery) {
        replaceMethod(navProto, 'getBattery', () => spoofed);
      } else if (navigator.getBattery) {
        replaceMethod(navigator, 'getBattery', () => spoofed);
      }
    } catch (_) {}
  }

  // --- WebGPU adapter info ---
  // Modes mirror the profile contract:
  //   real    : do not touch the kernel's adapter or its info
  //   blocked : keep navigator.gpu present but make requestAdapter resolve to no adapter
  //   webgl   : expose an adapter whose info matches the configured WebGL/GPU identity
  if (CFG.webgpu && typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const gpuMode = String(CFG.webgpu.mode || 'real');
      const gpuProto = typeof GPU !== 'undefined' ? GPU.prototype : null;
      const requestTarget = (gpuProto && typeof gpuProto.requestAdapter === 'function')
        ? gpuProto
        : navigator.gpu;
      const gpuInfo = CFG.webgpu.gpu && (CFG.webgpu.gpu.vendor || CFG.webgpu.gpu.architecture)
        ? {
          vendor: String(CFG.webgpu.gpu.vendor || ''),
          architecture: String(CFG.webgpu.gpu.architecture || ''),
          device: String(CFG.webgpu.gpu.device || ''),
          description: String(CFG.webgpu.gpu.description || CFG.webgpu.gpu.architecture || ''),
        }
        : null;

      if (gpuMode === 'blocked' && requestTarget) {
        replaceMethod(requestTarget, 'requestAdapter', () => async function requestAdapter() {
          return null;
        });
      } else if (gpuMode === 'webgl' && gpuInfo && requestTarget) {
        const adapterInfo = new WeakMap();

        const makeAdapterInfo = () => {
          const proto = typeof GPUAdapterInfo !== 'undefined' ? GPUAdapterInfo.prototype : Object.prototype;
          const info = Object.create(proto);
          for (const [key, value] of Object.entries(gpuInfo)) {
            try {
              Object.defineProperty(info, key, {
                configurable: true,
                enumerable: true,
                writable: false,
                value: value,
              });
            } catch (_) {}
          }
          try {
            Object.defineProperty(info, 'toJSON', {
              configurable: true,
              enumerable: false,
              writable: true,
              value: function toJSON() {
                const out = {};
                for (const key of ['vendor', 'architecture', 'device', 'description']) {
                  try { if (key in info) out[key] = info[key]; } catch (_) {}
                }
                return out;
              },
            });
          } catch (_) {}
          return info;
        };

        replaceMethod(requestTarget, 'requestAdapter', (originalRequestAdapter) => async function requestAdapter(...args) {
          const adapter = await originalRequestAdapter.apply(this, args);
          if (!adapter) return adapter;
          const info = makeAdapterInfo();
          adapterInfo.set(adapter, info);
          // Prefer an own accessor so a single adapter can carry a stable object even when the
          // platform marks the prototype accessor non-configurable.
          try {
            Object.defineProperty(adapter, 'info', {
              configurable: true,
              enumerable: true,
              get: () => info,
            });
          } catch (_) {}
          return adapter;
        });

        const adapterProto = typeof GPUAdapter !== 'undefined' ? GPUAdapter.prototype : null;
        if (adapterProto) {
          const infoDescriptor = Object.getOwnPropertyDescriptor(adapterProto, 'info');
          if (infoDescriptor && typeof infoDescriptor.get === 'function') {
            try {
              Object.defineProperty(adapterProto, 'info', {
                configurable: true,
                enumerable: infoDescriptor.enumerable === true,
                get: function info() {
                  const spoofed = adapterInfo.get(this);
                  return spoofed || infoDescriptor.get.call(this);
                },
              });
            } catch (_) {}
          }
          if (typeof adapterProto.requestAdapterInfo === 'function') {
            replaceMethod(adapterProto, 'requestAdapterInfo', (originalRequestAdapterInfo) => async function requestAdapterInfo(...args) {
              const spoofed = adapterInfo.get(this);
              return spoofed || originalRequestAdapterInfo.apply(this, args);
            });
          }
        }
      }
    } catch (_) {}
  }

} catch (_) {}
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
    timezone: fp.timezone || fp.dynamicConfig?.timezone || null,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: Math.min(8, Math.max(1, Number(fp.deviceMemory) || 8)),
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
                if (data[px + 3] === 0) continue;
                locked.push({ px: px, delta: Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2) });
              }
            }
            workerLocks.set(key, locked);
          }
          for (let i = 0; i < locked.length; i += 1) {
            const item = locked[i];
            if (item.px + 3 >= data.length) continue;
            if (data[item.px + 3] === 0) continue;
            data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
          }
          return imageData;
        }
        for (let y = 0; y < limitH; y += square) {
          for (let x = 0; x < limitW; x += square) {
            const px = ((y * width) + x) * 4;
            if (px + 3 >= data.length) continue;
            if (data[px + 3] === 0) continue;
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
  const nativeLike = (wrapper, original, nameOverride, lengthOverride, isConstructor = false) => {
    if (typeof wrapper !== 'function') return wrapper;
    const fnName = nameOverride !== undefined ? nameOverride : (original ? original.name : (wrapper.name || ''));
    const fnLength = lengthOverride !== undefined ? lengthOverride : (original ? original.length : wrapper.length);
    let clean;
    if (isConstructor) {
      clean = wrapper;
      try { Object.defineProperty(clean, 'name', { configurable: true, value: fnName }); } catch (_) {}
      try { Object.defineProperty(clean, 'length', { configurable: true, value: fnLength }); } catch (_) {}
    } else {
      const holder = {
        [fnName](...args) {
          return wrapper.apply(this, args);
        }
      };
      clean = holder[fnName];
      try { Object.defineProperty(clean, 'length', { configurable: true, value: fnLength }); } catch (_) {}
    }
    const nativeStr = (typeof original === 'function')
      ? (sources.get(original) || originalToString.call(original))
      : ('function ' + fnName + '() { [native code] }');
    try { sources.set(clean, nativeStr); } catch (_) {}
    try { sources.set(wrapper, nativeStr); } catch (_) {}
    return clean;
  };
  // Workers are probed independently of the page, so the accessors installed here need the
  // same native disguise: real WorkerNavigator getters stringify as [native code].
  const nativeAccessor = (key, desc) => {
    if (desc && typeof desc.get === 'function') {
      try { Object.defineProperty(desc.get, 'name', { configurable: true, value: 'get ' + key }); } catch (_) {}
      try { Object.defineProperty(desc.get, 'length', { configurable: true, value: 0 }); } catch (_) {}
      try { sources.set(desc.get, 'function get ' + key + '() { [native code] }'); } catch (_) {}
    }
    return desc;
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
        try { Object.defineProperty(navProto, key, nativeAccessor(key, { configurable: true, enumerable: true, get: () => value })); } catch (_) {}
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
            bitness: String(metadata.bitness ?? '64'),
            wow64: Boolean(metadata.wow64),
          };
          const out = { brands, mobile: values.mobile, platform: values.platform };
          for (const hint of Array.isArray(hints) ? hints : []) if (hint in values) out[hint] = values[hint];
          return Promise.resolve(out);
        },
        toJSON() { return { brands, mobile: Boolean(metadata.mobile), platform: String(metadata.platform || '') }; },
      });
      try { Object.defineProperty(navProto, 'userAgentData', nativeAccessor('userAgentData', { configurable: true, enumerable: true, get: () => uaData })); } catch (_) {}
      // Only a phone profile replaces the page-side object: a desktop browser reports the real
      // architecture through the same API, and Chromium fills in the host value whenever the
      // override leaves the field empty, which is exactly the leak a phone identity cannot have.
      try {
        const pageNavProto = MOBILE ? globalThis.Navigator?.prototype : null;
        if (pageNavProto) {
          Object.defineProperty(pageNavProto, 'userAgentData', nativeAccessor('userAgentData', { configurable: true, enumerable: true, get: () => uaData }));
        }
      } catch (_) {}
    }
  } catch (_) {}

  // --- worker timezone spoofing ---
  if (CFG.timezone) {
    try {
      const targetTz = String(CFG.timezone).trim();
      new Intl.DateTimeFormat('en-US', { timeZone: targetTz }).format();

      const OrigDateTimeFormat = Intl.DateTimeFormat;
      const DateTimeFormatProto = OrigDateTimeFormat.prototype;

      const origSetTime = Date.prototype.setTime;
      const origGetTzOffset = Date.prototype.getTimezoneOffset;
      const getOffsetMinutes = (date) => {
        try {
          const ts = date.getTime();
          if (isNaN(ts)) return NaN;
          const partsTz = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          }).formatToParts(date);
          const getVal = (t) => parseInt(partsTz.find(p => p.type === t)?.value || '0', 10);
          const y = getVal('year');
          const m = getVal('month') - 1;
          const d = getVal('day');
          const h = getVal('hour') % 24;
          const min = getVal('minute');
          const s = getVal('second');
          const tzUtcTs = Date.UTC(y, m, d, h, min, s);
          return Math.round((Math.floor(ts / 1000) * 1000 - tzUtcTs) / 60000);
        } catch (_) {
          return 0;
        }
      };

      const getLocalComponents = (date) => {
        const off = getOffsetMinutes(date);
        return new Date(date.getTime() - off * 60000);
      };

      const PatchedDateTimeFormat = function DateTimeFormat(locales, options) {
        let opts = options;
        if (!opts) {
          opts = { timeZone: targetTz };
        } else if (opts.timeZone === undefined) {
          opts = Object.assign({}, opts, { timeZone: targetTz });
        }
        if (!(this instanceof PatchedDateTimeFormat)) {
          return Reflect.construct(OrigDateTimeFormat, [locales, opts]);
        }
        return Reflect.construct(OrigDateTimeFormat, [locales, opts], new.target);
      };
      PatchedDateTimeFormat.prototype = DateTimeFormatProto;
      // Without this the prototype's constructor still points at the original, so the one-line
      // check Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat returns false.
      try {
        Object.defineProperty(DateTimeFormatProto, 'constructor', {
          configurable: true, writable: true, enumerable: false, value: PatchedDateTimeFormat,
        });
      } catch (_) {}
      if (OrigDateTimeFormat.supportedLocalesOf) {
        PatchedDateTimeFormat.supportedLocalesOf = nativeLike(
          function supportedLocalesOf(...args) { return OrigDateTimeFormat.supportedLocalesOf.apply(OrigDateTimeFormat, args); },
          OrigDateTimeFormat.supportedLocalesOf,
          'supportedLocalesOf',
          1
        );
      }
      nativeLike(PatchedDateTimeFormat, OrigDateTimeFormat, 'DateTimeFormat', 0, true);
      Intl.DateTimeFormat = PatchedDateTimeFormat;

      replace(Date.prototype, 'getTimezoneOffset', () => function getTimezoneOffset() {
        return getOffsetMinutes(this);
      });

      const formatTzDate = (date) => {
        try {
          const parts = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            weekday: 'short',
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'long'
          }).formatToParts(date);
          const get = (type) => parts.find(p => p.type === type)?.value || '';
          const weekday = get('weekday');
          const month = get('month');
          const day = get('day');
          const year = get('year');
          const hour = (get('hour') === '24' ? '00' : get('hour')).padStart(2, '0');
          const minute = get('minute').padStart(2, '0');
          const second = get('second').padStart(2, '0');
          const tzName = get('timeZoneName');
          const diffMins = getOffsetMinutes(date);
          const sign = diffMins <= 0 ? '+' : '-';
          const absMins = Math.abs(diffMins);
          const offH = String(Math.floor(absMins / 60)).padStart(2, '0');
          const offM = String(absMins % 60).padStart(2, '0');
          const gmt = 'GMT' + sign + offH + offM;
          return weekday + ' ' + month + ' ' + day + ' ' + year + ' ' + hour + ':' + minute + ':' + second + ' ' + gmt + ' (' + tzName + ')';
        } catch (_) {
          return date.toISOString();
        }
      };

      replace(Date.prototype, 'toString', () => function toString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        return formatTzDate(this);
      });

      replace(Date.prototype, 'toTimeString', () => function toTimeString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        const match = full.match(/[0-9]{4}[ ]+(.*)/);
        return match ? match[1] : full;
      });

      replace(Date.prototype, 'toDateString', () => function toDateString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        return full.split(' ').slice(0, 4).join(' ');
      });

      replace(Date.prototype, 'toLocaleString', (orig) => function toLocaleString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'toLocaleDateString', (orig) => function toLocaleDateString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'toLocaleTimeString', (orig) => function toLocaleTimeString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'getHours', () => function getHours() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCHours();
      });

      replace(Date.prototype, 'getDate', () => function getDate() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCDate();
      });

      replace(Date.prototype, 'getDay', () => function getDay() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCDay();
      });

      replace(Date.prototype, 'getFullYear', () => function getFullYear() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear();
      });

      replace(Date.prototype, 'getMonth', () => function getMonth() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMonth();
      });

      replace(Date.prototype, 'getMinutes', () => function getMinutes() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMinutes();
      });

      replace(Date.prototype, 'getSeconds', () => function getSeconds() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCSeconds();
      });

      replace(Date.prototype, 'getMilliseconds', () => function getMilliseconds() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCMilliseconds();
      });

      replace(Date.prototype, 'getYear', () => function getYear() {
        if (isNaN(this.getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear() - 1900;
      });

      // Local-time setters must land in the spoofed zone too. Reading a component through the
      // patched getters while writing it through the host zone leaves the two disagreeing,
      // which is a stronger signal than not spoofing at all.
      const setLocal = (self, mutate) => {
        if (isNaN(self.getTime())) return NaN;
        const shifted = getLocalComponents(self);
        mutate(shifted);
        // Resolve the offset twice: the write may have crossed a DST boundary.
        let guess = shifted.getTime() + getOffsetMinutes(self) * 60000;
        guess = shifted.getTime() + getOffsetMinutes(new Date(guess)) * 60000;
        return origSetTime.call(self, guess);
      };
      replace(Date.prototype, 'setFullYear', () => function setFullYear(y, m, d) {
        return setLocal(this, (x) => {
          x.setUTCFullYear(y);
          if (m !== undefined) x.setUTCMonth(m);
          if (d !== undefined) x.setUTCDate(d);
        });
      });
      replace(Date.prototype, 'setMonth', () => function setMonth(m, d) {
        return setLocal(this, (x) => { x.setUTCMonth(m); if (d !== undefined) x.setUTCDate(d); });
      });
      replace(Date.prototype, 'setDate', () => function setDate(d) {
        return setLocal(this, (x) => x.setUTCDate(d));
      });
      replace(Date.prototype, 'setHours', () => function setHours(h, mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCHours(h);
          if (mi !== undefined) x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replace(Date.prototype, 'setMinutes', () => function setMinutes(mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replace(Date.prototype, 'setSeconds', () => function setSeconds(sec, ms) {
        return setLocal(this, (x) => { x.setUTCSeconds(sec); if (ms !== undefined) x.setUTCMilliseconds(ms); });
      });
      replace(Date.prototype, 'setMilliseconds', () => function setMilliseconds(ms) {
        return setLocal(this, (x) => x.setUTCMilliseconds(ms));
      });

      // new Date(y, m, d, ...) and Date.parse('2026-01-15 12:00:00') are defined against the
      // *local* zone. Left alone they resolve against the host zone while every getter above
      // reports the spoofed one, so a two-line script recovers the real timezone.
      try {
        const OrigDate = Date;
        const localToUtc = (ms) => {
          if (isNaN(ms)) return NaN;
          // getOffsetMinutes keeps the JS sign convention (UTC+05:30 reports -330), so shifting
          // a wall-clock reading in the spoofed zone back to a real instant means adding it.
          let out = ms + getOffsetMinutes(new OrigDate(ms)) * 60000;
          out = ms + getOffsetMinutes(new OrigDate(out)) * 60000;
          return out;
        };
        // Matches ES2015+ "date-time forms without a timezone offset", which parse as local.
        const NO_TZ = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?$');
        const parseLocal = (value) => {
          const raw = OrigDate.parse(value);
          if (isNaN(raw)) return raw;
          if (!NO_TZ.test(String(value).trim())) return raw;
          // OrigDate.parse resolved these fields against the host zone. Undo that with the
          // engine's own offset, then re-apply the spoofed zone's.
          const undo = raw - origGetTzOffset.call(new OrigDate(raw)) * 60000;
          return localToUtc(undo);
        };
        const PatchedDate = function Date(...args) {
          if (!new.target) return OrigDate();
          if (args.length === 0) return Reflect.construct(OrigDate, [], new.target);
          if (args.length === 1) {
            const only = args[0];
            if (typeof only === 'string') {
              return Reflect.construct(OrigDate, [parseLocal(only)], new.target);
            }
            return Reflect.construct(OrigDate, args, new.target);
          }
          // Interpret the fields as wall-clock time in the *spoofed* zone. Letting the engine
          // parse them first would apply the host zone's offset, which the correction below
          // would then apply a second time.
          const y = Number(args[0]);
          const wall = OrigDate.UTC(
            y >= 0 && y <= 99 ? y + 1900 : y,
            Number(args[1]) || 0,
            args[2] === undefined ? 1 : Number(args[2]),
            Number(args[3]) || 0,
            Number(args[4]) || 0,
            Number(args[5]) || 0,
            Number(args[6]) || 0
          );
          return Reflect.construct(OrigDate, [localToUtc(wall)], new.target);
        };
        PatchedDate.prototype = OrigDate.prototype;
        try {
          Object.defineProperty(OrigDate.prototype, 'constructor', {
            configurable: true, writable: true, enumerable: false, value: PatchedDate,
          });
        } catch (_) {}
        PatchedDate.UTC = OrigDate.UTC;
        PatchedDate.now = OrigDate.now;
        PatchedDate.parse = nativeLike(
          function parse(value) { return parseLocal(value); },
          OrigDate.parse, 'parse', 1
        );
        nativeLike(PatchedDate, OrigDate, 'Date', 7, true);
        globalThis.Date = PatchedDate;
      } catch (_) {}
    } catch (_) {}
  }
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
  let args = [];
  // Critical: without this, Chromium/CDP sets navigator.webdriver = true
  args.push('--disable-blink-features=AutomationControlled');
  // Never enable automation switch (some launchers add it by default)
  if (fp.userAgent) args.push(`--user-agent=${fp.userAgent}`);
  // TLS extension permutation by Chrome major from UA
  if (fp.uaProfile) {
    // Feature flags are list-valued: merging has to append and de-duplicate
    // rather than let one occurrence replace the other.
    args = mergeFlags(args, chromeArgsForUa(fp.uaProfile), { listFlags: LIST_VALUE_FLAGS });
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
  if (fp.webgl?.mode === 'blocked') {
    args.push('--disable-webgl', '--disable-webgl2', '--disable-3d-apis');
  } else {
    // Ensure WebGL is available even on VMs/older GPUs that Chrome would normally blocklist
    args.push('--ignore-gpu-blocklist', '--enable-webgl');
    // Issue #19: SwiftShader software rendering when requested or when no GPU available
    if (profile.privacy?.softwareWebgl || profile.advanced?.softwareWebgl || fp.webgl?.software) {
      args.push(
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-compositing'
      );
    }
  }
  if (fp.audio?.mode === 'muted' || profile.privacy?.audio === 'muted') args.push('--mute-audio');
  if (fp.doNotTrack === '1' || profile.privacy?.dnt || profile.privacy?.dntMode === 'on') args.push('--do-not-track');
  // Use full BCP47 when present (ja-JP / zh-CN); Chrome accepts --lang=ja-JP
  const lang = (fp.languages && fp.languages[0]) || profile.language;
  if (lang) {
    const tag = String(lang).trim();
    const primary = tag.split(',')[0].trim();
    if (primary) args.push(`--lang=${primary}`);
  }
  if (process.platform === 'win32') {
    // Keep consistent UI scale across all multi-environment windows on Windows
    // to prevent some windows having 1.25x enlarged toolbars/tabbars.
    const scaleFactor = profile.privacy?.forceDeviceScaleFactor || profile.deviceScaleFactor || 1;
    args.push(`--force-device-scale-factor=${scaleFactor}`);
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

// Bookkeeping for the per-target inject. The runtime drives the same document-start script from
// several places (pre-start, post-start, watch sweeps, reload recovery, worker attach). Registering
// one identical source twice makes Chromium run it twice on every later navigation, and evaluating
// it twice on a live document stacks a second layer of noise on the readers, which shifts canvas /
// clientRects while the profile is already in use. Tracking what each target already carries keeps
// the later passes true no-ops without leaving anything the page itself could detect.
const TARGET_INJECT_STATE = new Map();
const MAX_TRACKED_TARGETS = 256;
const injectSourceKey = (source) => crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);

async function applyFingerprintToTab(cdpCall, webSocketDebuggerUrl, fp, profile = {}, options = {}) {
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

  const source = buildInjectionScript(fp);
  const fpKey = injectSourceKey(source);
  const injectTargetKey = typeof options.applyKey === 'string' && options.applyKey
    ? options.applyKey
    : (typeof webSocketDebuggerUrl === 'string' && webSocketDebuggerUrl ? webSocketDebuggerUrl : '');
  const forceInject = options.force === true;
  const injectState = injectTargetKey ? TARGET_INJECT_STATE.get(injectTargetKey) : null;
  const sameConfig = Boolean(injectState && injectState.fpKey === fpKey);
  const alreadyPatched = Boolean(sameConfig && injectState.documentStartOk && injectState.evaluated);
  // Nothing left to do for this target: the live document already carries this exact config and the
  // document-start registration covers every later navigation.
  if (alreadyPatched && !forceInject) return;

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
  // Desktop windows must retain Chromium's live viewport. A fixed device-metrics
  // override leaves the renderer at the fingerprint's initial size after resize,
  // producing a large blank region. screen.* remains spoofed by the document script.
  // A phone profile is the exception: there the layout viewport IS the device panel, and pinning
  // it is what makes innerWidth, screen.*, the pixel ratio and pointer type agree inside a
  // desktop window. Emulated touch goes with it, or a phone that cannot answer touch probes is
  // immediately suspicious.
  if (fp.mobile && fp.screen) {
    const viewport = fp.mobileDevice?.viewport || {};
    const mobileWidth = Math.round(Number(viewport.width) || Number(fp.screen.width) || 360);
    const mobileHeight = Math.round(Number(viewport.height) || Number(fp.screen.height) || 640);
    await softOverride('Emulation.setDeviceMetricsOverride', {
      width: mobileWidth,
      height: mobileHeight,
      deviceScaleFactor: Number(fp.screen.devicePixelRatio) || 3,
      mobile: true,
      screenWidth: Math.round(Number(fp.screen.width) || mobileWidth),
      screenHeight: Math.round(Number(fp.screen.height) || mobileHeight),
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
      positionX: 0,
      positionY: 0,
    });
    await softOverride('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: Number(fp.maxTouchPoints) || 5,
    });
  } else if (fp.screen) {
    await softOverride('Emulation.clearDeviceMetricsOverride', {});
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

  // Register for future documents first (start page navigation depends on this).
  // Must not silently drop registration failures — otherwise navigation paints host FP.
  let documentStartOk = Boolean(sameConfig && injectState.documentStartOk);
  let scriptIdentifier = injectState && injectState.identifier ? injectState.identifier : null;
  if (!documentStartOk) {
    if (scriptIdentifier) {
      // The config changed under a live registration: drop the stale script so the next navigation
      // cannot run both the previous and the current inject back to back.
      await invoke('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptIdentifier }).catch(() => {});
      scriptIdentifier = null;
    }
    try {
      const added = await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
      scriptIdentifier = added?.identifier || added?.result?.identifier || scriptIdentifier;
      documentStartOk = true;
    } catch (error) {
      const msg = String(error && error.message || error || '');
      if (!/already|duplicate|exists/i.test(msg)) {
        // Retry once after re-enabling Page domain.
        await invoke('Page.enable', {}).catch(() => {});
        try {
          const added = await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
          scriptIdentifier = added?.identifier || added?.result?.identifier || scriptIdentifier;
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
  }
  // Already-open documents: best-effort patch. Never abort startup if evaluate throws
  // (Chromium often reports "Uncaught" for redefine races; document-start still applies on next nav).
  let evaluatedOk = false;
  try {
    const evaluated = await invoke('Runtime.evaluate', {
      expression: source,
      returnByValue: false,
      awaitPromise: false,
    });
    const exceptionDetails = evaluated && (evaluated.exceptionDetails || evaluated.result?.exceptionDetails);
    if (exceptionDetails) {
      // leave a soft signal for callers that inspect return value; do not throw
      const text = exceptionDetails.text
        || exceptionDetails.exception?.description
        || 'Uncaught';
      const err = new Error(text);
      err.softInject = true;
      err.exceptionDetails = exceptionDetails;
      err.documentStartOk = documentStartOk;
      // Soft path: swallow so keepDefaultTab can still open the welcome page.
    } else {
      evaluatedOk = true;
    }
  } catch (error) {
    const msg = String(error && error.message || error || '');
    if (!/Uncaught|already in effect|cannot be overridden/i.test(msg)) {
      // unexpected CDP transport errors still surface
      throw error;
    }
  }
  if (injectTargetKey) {
    TARGET_INJECT_STATE.set(injectTargetKey, { fpKey, identifier: scriptIdentifier, documentStartOk, evaluated: evaluatedOk });
    if (TARGET_INJECT_STATE.size > MAX_TRACKED_TARGETS) {
      // Bounded: keep the most recent targets so a long-running host cannot grow this forever.
      const oldest = TARGET_INJECT_STATE.keys().next().value;
      TARGET_INJECT_STATE.delete(oldest);
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
  createDeviceNameFromSeed,
  createLocalIpFromSeed,
  formatGeopositionValue,
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
