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
  const devices = [
    { kind: 'audioinput', label: emptyLabels ? '' : tpl.input, deviceId: `ob-ai-${head}`, groupId: `ob-g-${tail}` },
    { kind: 'videoinput', label: emptyLabels ? '' : `Integrated Camera (${head}:${tail})`, deviceId: `ob-vi-${tail}`, groupId: `ob-g-${tail}` },
    { kind: 'audiooutput', label: emptyLabels ? '' : tpl.output, deviceId: `ob-ao-${head}${tail.slice(0, 2)}`, groupId: `ob-g-${tail}` },
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
  const audioMode = mode('audio', ['real', 'noise', 'muted'], privacy.audio === 'muted' ? 'muted' : 'noise');
  const clientRectsMode = mode('clientRects', ['real', 'noise'], 'noise');
  const webrtcMode = mode('webrtc', ['real', 'proxy', 'disabled'], privacy.webrtc || 'proxy');
  const mediaDevicesMode = mode('mediaDevices', ['real', 'noise', 'empty'], privacy.mediaDevices === 'real' ? 'real' : (privacy.mediaDevices === 'empty' ? 'empty' : 'noise'));
  const speechMode = mode('speech', ['real', 'noise', 'blocked'], privacy.speech === 'blocked' ? 'blocked' : (privacy.speech === 'noise' ? 'noise' : 'real'));

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

  const mediaDevices = mediaDevicesMode === 'real'
    ? null
    : createMediaDevicesFromSeed(stableIdentity + ':' + seed.toString('hex').slice(0, 12), {
      emptyLabels: mediaDevicesMode === 'empty',
      extra: Array.isArray(fpIn.mediaDevices) ? fpIn.mediaDevices : null,
    });
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

  const webgl = {
    mode: webglMode,
    vendor: fpIn.webglVendor || webglPreset.vendor,
    renderer: fpIn.webglRenderer || webglPreset.renderer,
    mark: Number.isFinite(Number(fpIn.webglId)) ? Number(fpIn.webglId) : webglId,
    gpu: webglGpu,
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
    webrtcAddress,
    mediaDevices: {
      mode: mediaDevicesMode,
      devices: mediaDevices,
    },
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
  const json = JSON.stringify({
    platform: fp.platform,
    userAgent: fp.userAgent,
    languages: fp.languages,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: fp.deviceMemory,
    screen: fp.screen,
    webgl: {
      mode: fp.webgl?.mode,
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
    },
    canvas: fp.canvas,
    audio: fp.audio,
    clientRects: fp.clientRects,
    webrtc: fp.webrtc,
    webrtcAddress: fp.webrtcAddress || null,
    mediaDevices: fp.mediaDevices || null,
    speech: fp.speech || null,
    maxTouchPoints: fp.maxTouchPoints,
    vendor: fp.vendor || fp.uaProfile?.vendor || 'Google Inc.',
    doNotTrack: fp.doNotTrack,
    seed: fp.seed,
  });

  // UA + Client Hints (userAgentData) injected first
  const uaScript = fp.uaProfile
    ? buildUaInjectionScript(fp.uaProfile)
    : (fp.userAgent ? buildUaInjectionScript(buildUaProfile({ userAgent: fp.userAgent, platform: fp.platform })) : '');

  return `${uaScript}
(() => {
  const CFG = ${json};
  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => {
    let x = Math.sin((n + 1) * seedNum) * 10000;
    return x - Math.floor(x);
  };
  const applyCanvasNoise = (imageData, mark) => {
    try {
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const n = Math.floor(noise(i + mark) * 3) - 1;
        data[i] = Math.max(0, Math.min(255, data[i] + n));
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
  try {
    for (const [key, desc] of Object.entries(navPatch)) {
      try { Object.defineProperty(Navigator.prototype, key, { configurable: true, enumerable: true, ...desc }); } catch (_) {
        try { Object.defineProperty(navigator, key, { configurable: true, ...desc }); } catch (__) {}
      }
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
  } else if (CFG.webgl && CFG.webgl.mode === 'noise') {
    try {
      const mark = Number(CFG.webgl.mark) || 1;
      const patchGetParameter = (proto) => {
        if (!proto || !proto.getParameter) return;
        replaceMethod(proto, 'getParameter', (original) => function(param) {
          const UNMASKED_VENDOR_WEBGL = 0x9245;
          const UNMASKED_RENDERER_WEBGL = 0x9246;
          if (param === UNMASKED_VENDOR_WEBGL) return CFG.webgl.vendor;
          if (param === UNMASKED_RENDERER_WEBGL) return CFG.webgl.renderer;
          return original.apply(this, arguments);
        });
      };
      // Subtle deterministic readPixels noise so WebGL hashers diverge per env
      const patchReadPixels = (proto) => {
        if (!proto || !proto.readPixels) return;
        replaceMethod(proto, 'readPixels', (original) => function(...args) {
          const result = original.apply(this, args);
          try {
            const pixels = args[6];
            if (pixels && pixels.length) {
              const step = Math.max(4, Math.floor(pixels.length / 64));
              for (let i = 0; i < pixels.length; i += step) {
                const n = Math.floor(noise(i + mark) * 3) - 1;
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
            const originalSetLocal = pc.setLocalDescription?.bind(pc);
            if (originalSetLocal) {
              pc.setLocalDescription = async function(desc) {
                const result = await originalSetLocal(desc);
                return result;
              };
            }
            const originalCreateOffer = pc.createOffer?.bind(pc);
            if (originalCreateOffer) {
              pc.createOffer = async function(...oArgs) {
                const offer = await originalCreateOffer(...oArgs);
                if (offer && typeof offer.sdp === 'string' && targetIp) {
                  // Soft rewrite host candidates if present (best-effort; kernel path is stronger)
                  offer.sdp = offer.sdp.replace(/(\n)a=candidate:.* typ host .*/g, (line) => {
                    return line.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/, targetIp);
                  });
                }
                return offer;
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
})();`;
}

/** Worker-safe subset injected before attached workers are resumed. */
function buildWorkerInjectionScript(fp) {
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
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
    },
    canvas: fp.canvas,
    seed: fp.seed,
  });
  return `(() => {
  const CFG = ${json};
  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => { const x = Math.sin((n + 1) * seedNum) * 10000; return x - Math.floor(x); };
  const applyNoise = (imageData, mark) => {
    try {
      for (let i = 0; i < imageData.data.length; i += 4) {
        const n = Math.floor(noise(i + mark) * 3) - 1;
        imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + n));
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
  } else if (CFG.webgl?.mode === 'noise') {
    const mark = Number(CFG.webgl?.mark) || 1;
    const patch = (proto) => {
      replace(proto, 'getParameter', (original) => function(param) {
        if (param === 0x9245) return CFG.webgl.vendor;
        if (param === 0x9246) return CFG.webgl.renderer;
        return original.apply(this, arguments);
      });
      replace(proto, 'readPixels', (original) => function(...args) {
        const result = original.apply(this, args);
        try {
          const pixels = args[6];
          const step = Math.max(4, Math.floor((pixels?.length || 0) / 64));
          for (let i = 0; pixels && i < pixels.length; i += step) {
            const n = Math.floor(noise(i + mark) * 3) - 1;
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

  // Network/Emulation.setUserAgentOverride + UserAgentMetadata (Client Hints)
  if (fp.userAgent || fp.uaProfile) {
    const uaProfile = fp.uaProfile || buildUaProfile({
      userAgent: fp.userAgent,
      platform: fp.platform,
    });
    const acceptLanguage = (fp.languages || []).join(',');
    const override = cdpUserAgentOverride(uaProfile, acceptLanguage);
    // Emulation affects navigator + most page JS
    await cdpCall(webSocketDebuggerUrl, 'Emulation.setUserAgentOverride', override);
    // Network affects HTTP headers (User-Agent + sec-ch-ua*)
    await cdpCall(webSocketDebuggerUrl, 'Network.enable', {});
    await cdpCall(webSocketDebuggerUrl, 'Network.setUserAgentOverride', {
      userAgent: override.userAgent,
      acceptLanguage: override.acceptLanguage,
      platform: override.platform,
      userAgentMetadata: override.userAgentMetadata,
    });
  }
  if (fp.screen) {
    await cdpCall(webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', {
      width: fp.screen.width,
      height: fp.screen.height,
      deviceScaleFactor: fp.screen.devicePixelRatio || 1,
      mobile: false,
    });
  }
  if (timezone) {
    await cdpCall(webSocketDebuggerUrl, 'Emulation.setTimezoneOverride', { timezoneId: timezone });
  }
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    await cdpCall(webSocketDebuggerUrl, 'Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy: privacy.accuracy || 100,
    });
  }
  if (fp.languages?.[0]) {
    await cdpCall(webSocketDebuggerUrl, 'Emulation.setLocaleOverride', { locale: fp.languages[0] });
  }

  const source = buildInjectionScript(fp);
  await cdpCall(webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source });
  await cdpCall(webSocketDebuggerUrl, 'Runtime.evaluate', { expression: source });
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
  buildWebglFpPayload,
  audioMarkFromSeed,
  clientRectMarkFromSeed,
  WEBGL_PRESETS,
  // re-export UA helpers for UI / selftest
  buildUaProfile,
  randomUaForSeed,
  OS_PRESETS,
};
