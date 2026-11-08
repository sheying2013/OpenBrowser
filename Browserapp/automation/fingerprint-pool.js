'use strict';

/**
 * OpenBrowser Fingerprint Pool Module (跨环境指纹池)
 *
 * Pooled fingerprint allocation and reuse architecture (avoid regenerating a
 * fresh fingerprint on every profile read).
 *
 * Replaces pure single-environment randomization with a pool of coherent, verified
 * device personas that are deterministically assigned and reused when exhausted.
 *
 * Invariant Constraints:
 * 1. Default disabled: enabled === false by default. Zero side effects on require.
 * 2. Deterministic & Reproducible: Same seed produces identical pool and assignments.
 * 3. Stable: Same envId always maps to the same persona regardless of call count.
 * 4. Collision-minimized: Unexhausted pools assign unique personas to different envIds.
 * 5. Bounded reuse: When pool capacity is exceeded, personas are reused gracefully (reused: true).
 * 6. Internal consistency: Every persona must pass verifyPersonaConsistency across all hardware/OS axes.
 * 7. Pure functional design: No global mutable state, no file I/O (upper layers handle persistence).
 */

const crypto = require('crypto');
const {
  PERSONAS_BY_OS,
  fontsForOs,
  exclusiveFontsForOtherOs,
} = require('./device-personas');
const {
  MEDIA_DEVICE_POOLS_BY_OS,
  OS_PRESETS,
} = require('./fingerprint');

const DEFAULT_OS_MIX = Object.freeze({
  windows: 0.70,
  macos: 0.20,
  linux: 0.05,
  android: 0.05,
});

/**
 * Standard realistic locale/timezone presets by OS
 */
const OS_LOCALE_PRESETS = Object.freeze({
  windows: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'America/Chicago', languages: ['en-US', 'en'] },
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'] },
    { timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
  ],
  macos: [
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Paris', languages: ['fr-FR', 'fr', 'en'] },
    { timezone: 'Asia/Tokyo', languages: ['ja-JP', 'ja', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
  ],
  linux: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
    { timezone: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'] },
  ],
  android: [
    { timezone: 'America/New_York', languages: ['en-US', 'en'] },
    { timezone: 'America/Los_Angeles', languages: ['en-US', 'en'] },
    { timezone: 'Asia/Shanghai', languages: ['zh-CN', 'zh'] },
    { timezone: 'Europe/London', languages: ['en-GB', 'en'] },
  ],
});

/**
 * Mulberry32 deterministic 32-bit PRNG
 * @param {number} a Seed integer
 */
function mulberry32(a) {
  return function next() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute deterministic 32-bit integer from seed and suffix
 * @param {string|number} seed
 * @param {string|number} suffix
 * @returns {number}
 */
function hashSeedToInt(seed, suffix = '') {
  const h = crypto.createHash('sha256')
    .update(String(seed != null ? seed : ''))
    .update(':')
    .update(String(suffix != null ? suffix : ''))
    .digest();
  return h.readUInt32BE(0);
}

/**
 * Verify internal consistency of a single persona across all hardware and platform axes.
 *
 * Rules:
 * 1. Platform ↔ GPU 品牌/渲染器 (Windows != Apple/Metal/Mesa, macOS != Direct3D/Mesa, Linux != Direct3D/Metal, Android != D3D/Metal)
 * 2. 字体集 ↔ OS (Windows 不能含 PingFang/Menlo/Monaco/Ubuntu, macOS 不能含 Segoe UI/Bahnschrift/Calibri/Ubuntu)
 * 3. 媒体标签 ↔ OS (Windows 不能含 FaceTime/MacBook/PulseAudio, macOS 不能含 Realtek/Conexant/Synaptics)
 * 4. CPU 核数与内存 (核数 1-64, 内存 1-128, 单核配超大内存或 64 核配 1G 内存判定不自洽)
 * 5. Screen 与 DPR (尺寸正数, macOS Retina 要求 DPR >= 2, Android DPR 1.5-4)
 * 6. 时区/语言族 (时区符合 IANA 规范)
 *
 * @param {object} persona
 * @returns {{ valid: boolean, ok: boolean, issues: Array<{ code: string, severity: string, field: string, message: string }>, violations: Array<{ code: string, severity: string, field: string, message: string }> }}
 */
function verifyPersonaConsistency(persona) {
  const issues = [];

  if (!persona || typeof persona !== 'object') {
    const issue = { code: 'persona-null', severity: 'error', field: 'persona', message: 'Persona must be a non-null object' };
    return { valid: false, ok: false, issues: [issue], violations: [issue] };
  }

  // 1. OS & Platform
  const rawOs = String(persona.os || persona.uaProfile?.os || '').trim().toLowerCase();
  let os = rawOs;
  if (os.startsWith('mac') || os === 'darwin') os = 'macos';
  else if (os.includes('win')) os = 'windows';
  else if (os.includes('linux')) os = 'linux';
  else if (os.includes('android')) os = 'android';
  else if (os.includes('ios') || os.includes('iphone')) os = 'ios';

  const VALID_OSES = ['windows', 'macos', 'linux', 'android', 'ios'];
  if (!os || !VALID_OSES.includes(os)) {
    issues.push({ code: 'os-invalid', severity: 'error', field: 'os', message: `Unsupported or missing OS: '${rawOs}'` });
  }

  const platform = String(persona.platform || persona.uaProfile?.platform || '').trim();
  if (platform) {
    if (os === 'windows' && !/^Win(32|64)$/i.test(platform)) {
      issues.push({ code: 'platform-os-mismatch', severity: 'error', field: 'platform', message: `Windows persona platform must be Win32/Win64, got '${platform}'` });
    } else if (os === 'macos' && platform !== 'MacIntel') {
      issues.push({ code: 'platform-os-mismatch', severity: 'error', field: 'platform', message: `macOS persona platform must be MacIntel, got '${platform}'` });
    } else if (os === 'linux' && !/^Linux (x86_64|i686)$/i.test(platform)) {
      issues.push({ code: 'platform-os-mismatch', severity: 'error', field: 'platform', message: `Linux persona platform must be Linux x86_64/i686, got '${platform}'` });
    } else if (os === 'android' && !/^Linux (armv8l|aarch64)$/i.test(platform)) {
      issues.push({ code: 'platform-os-mismatch', severity: 'error', field: 'platform', message: `Android persona platform must be Linux armv8l/aarch64, got '${platform}'` });
    }
  }

  // 2. GPU / WebGL
  const renderer = String(persona.webgl?.renderer || persona.gpu_renderer || persona.renderer || '').trim();
  if (renderer) {
    if (os === 'windows') {
      if (/Apple|Metal|Mesa|RADV|llvmpipe|Adreno|Mali|Xclipse/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Windows persona has incompatible non-Windows GPU renderer: '${renderer}'` });
      } else if (!/Direct3D|D3D11|D3D9|Intel|NVIDIA|AMD|GeForce|Radeon|ANGLE/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Windows persona requires Direct3D11/ANGLE renderer, got: '${renderer}'` });
      }
    } else if (os === 'macos') {
      if (/Direct3D|D3D11|D3D9|Mesa|RADV|llvmpipe|Adreno|Mali|Xclipse/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `macOS persona has incompatible non-macOS GPU renderer: '${renderer}'` });
      } else if (!/Metal/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `macOS persona requires Metal renderer, got: '${renderer}'` });
      }
    } else if (os === 'linux') {
      if (/Direct3D|D3D11|Apple|Metal|Adreno|Mali|Xclipse/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Linux persona has incompatible GPU renderer: '${renderer}'` });
      } else if (!/OpenGL|Mesa|RADV|NVIDIA/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Linux persona requires OpenGL/Mesa/NVIDIA renderer, got: '${renderer}'` });
      }
    } else if (os === 'android') {
      if (/Direct3D|D3D11|Apple M[0-9]|Metal/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Android persona has incompatible desktop GPU renderer: '${renderer}'` });
      } else if (!/Adreno|Mali|Xclipse|Qualcomm|ARM|Samsung|OpenGL ES|Vulkan/i.test(renderer)) {
        issues.push({ code: 'gpu-platform-mismatch', severity: 'error', field: 'webgl.renderer', message: `Android persona requires mobile GPU renderer, got: '${renderer}'` });
      }
    }
  }

  // 3. Fonts
  const fonts = Array.isArray(persona.fonts?.list)
    ? persona.fonts.list
    : Array.isArray(persona.fontList)
      ? persona.fontList
      : Array.isArray(persona.font_list)
        ? persona.font_list
        : [];

  if (fonts.length > 0) {
    const fontLowerSet = new Set(fonts.map((f) => String(f).trim().toLowerCase()));

    const MACOS_EXCLUSIVE_FONTS = [
      'pingfang sc', 'pingfang hk', 'pingfang tc', 'hiragino sans', 'hiragino kaku gothic pro',
      'menlo', 'monaco', 'apple sd gothic neo', 'sf pro', 'sf pro text', 'sf pro display',
      'helvetica neue', 'lucida grande', 'avenir next', 'baskerville', 'chalkboard',
      'cochin', 'didot', 'geneva', 'hoefler text', 'noteworthy', 'optima', 'papyrus',
      'snell roundhand', 'zapfino',
    ];

    const WINDOWS_EXCLUSIVE_FONTS = [
      'segoe ui', 'segoe mdl2 assets', 'segoe print', 'segoe script', 'bahnschrift',
      'calibri', 'cambria', 'cambria math', 'candara', 'consolas', 'constantia',
      'corbel', 'ebrima', 'gadugi', 'ink free', 'leelawadee ui', 'malgun gothic',
      'microsoft jhenghei', 'microsoft yahei', 'nirmala ui', 'simsun', 'sitka',
      'ms gothic', 'yu gothic',
    ];

    const LINUX_EXCLUSIVE_FONTS = [
      'ubuntu', 'ubuntu condensed', 'ubuntu mono', 'cantarell', 'liberation mono',
      'liberation sans', 'liberation serif', 'dejavu sans', 'dejavu serif',
    ];

    if (os === 'windows') {
      for (const f of MACOS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Windows persona contains exclusive macOS font: '${f}'` });
        }
      }
      for (const f of LINUX_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Windows persona contains exclusive Linux font: '${f}'` });
        }
      }
    } else if (os === 'macos') {
      for (const f of WINDOWS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `macOS persona contains exclusive Windows font: '${f}'` });
        }
      }
      for (const f of LINUX_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `macOS persona contains exclusive Linux font: '${f}'` });
        }
      }
    } else if (os === 'linux') {
      for (const f of MACOS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Linux persona contains exclusive macOS font: '${f}'` });
        }
      }
      for (const f of WINDOWS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Linux persona contains exclusive Windows font: '${f}'` });
        }
      }
    } else if (os === 'android') {
      for (const f of MACOS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Android persona contains exclusive macOS font: '${f}'` });
        }
      }
      for (const f of WINDOWS_EXCLUSIVE_FONTS) {
        if (fontLowerSet.has(f)) {
          issues.push({ code: 'font-os-mismatch', severity: 'error', field: 'fonts', message: `Android persona contains exclusive Windows font: '${f}'` });
        }
      }
    }
  }

  // 4. Media Device Labels
  const mediaLabels = [];
  if (persona.mediaDevices) {
    if (Array.isArray(persona.mediaDevices.devices)) {
      for (const d of persona.mediaDevices.devices) {
        if (d && d.label) mediaLabels.push(String(d.label));
      }
    }
    if (persona.mediaDevices.input) mediaLabels.push(String(persona.mediaDevices.input));
    if (persona.mediaDevices.output) mediaLabels.push(String(persona.mediaDevices.output));
    if (persona.mediaDevices.video) mediaLabels.push(String(persona.mediaDevices.video));
    if (Array.isArray(persona.mediaDevices.labels)) {
      for (const l of persona.mediaDevices.labels) {
        if (l) mediaLabels.push(String(l));
      }
    }
  }
  if (persona.webrtc_media_labels) {
    const w = persona.webrtc_media_labels;
    if (Array.isArray(w.audio_input_labels)) mediaLabels.push(...w.audio_input_labels);
    if (Array.isArray(w.audio_output_labels)) mediaLabels.push(...w.audio_output_labels);
    if (Array.isArray(w.video_input_labels)) mediaLabels.push(...w.video_input_labels);
  }

  if (mediaLabels.length > 0) {
    const MACOS_LABEL_PATTERN = /MacBook|Mac mini|FaceTime/i;
    const WINDOWS_LABEL_PATTERN = /Realtek|Conexant|Synaptics/i;
    const LINUX_LABEL_PATTERN = /PulseAudio/i;
    const ANDROID_LABEL_PATTERN = /Back Camera|Front Camera|Rear Camera|Phone Microphone|Phone Speaker/i;

    for (const label of mediaLabels) {
      if (os === 'windows') {
        if (MACOS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Windows persona contains foreign macOS media label: '${label}'` });
        } else if (LINUX_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Windows persona contains foreign Linux media label: '${label}'` });
        } else if (ANDROID_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Windows persona contains foreign Android media label: '${label}'` });
        }
      } else if (os === 'macos') {
        if (WINDOWS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `macOS persona contains foreign Windows media label: '${label}'` });
        } else if (LINUX_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `macOS persona contains foreign Linux media label: '${label}'` });
        } else if (ANDROID_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `macOS persona contains foreign Android media label: '${label}'` });
        }
      } else if (os === 'linux') {
        if (MACOS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Linux persona contains foreign macOS media label: '${label}'` });
        } else if (WINDOWS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Linux persona contains foreign Windows media label: '${label}'` });
        }
      } else if (os === 'android') {
        if (MACOS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Android persona contains foreign macOS media label: '${label}'` });
        } else if (WINDOWS_LABEL_PATTERN.test(label)) {
          issues.push({ code: 'media-label-os-mismatch', severity: 'error', field: 'mediaDevices', message: `Android persona contains foreign Windows media label: '${label}'` });
        }
      }
    }
  }

  // 5. CPU Cores & Memory Coherence
  const cores = Number(persona.hardwareConcurrency || persona.cores);
  if (Number.isFinite(cores)) {
    if (!Number.isInteger(cores) || cores < 1 || cores > 64) {
      issues.push({ code: 'cpu-cores-invalid', severity: 'error', field: 'cores', message: `Hardware concurrency must be integer 1-64, got ${cores}` });
    }
  }
  const memory = Number(persona.deviceMemory || persona.memory);
  if (Number.isFinite(memory)) {
    if (!Number.isInteger(memory) || memory < 1 || memory > 128) {
      issues.push({ code: 'device-memory-invalid', severity: 'error', field: 'memory', message: `Device memory must be integer 1-128, got ${memory}` });
    }
  }
  if (Number.isFinite(cores) && Number.isFinite(memory)) {
    if (cores <= 1 && memory > 8) {
      issues.push({ code: 'cpu-memory-incoherent', severity: 'error', field: 'cores_memory', message: `Single-core CPU paired with >8GB RAM (${memory}GB) is physically incoherent` });
    }
    if (cores >= 32 && memory < 8) {
      issues.push({ code: 'cpu-memory-incoherent', severity: 'error', field: 'cores_memory', message: `Workstation CPU (${cores} cores) paired with <8GB RAM (${memory}GB) is physically incoherent` });
    }
    if ((os === 'android' || os === 'ios') && (cores > 16 || memory > 24)) {
      issues.push({ code: 'cpu-memory-incoherent', severity: 'error', field: 'cores_memory', message: `Mobile device hardware exceeds realistic bounds (cores: ${cores}, memory: ${memory}GB)` });
    }
  }

  // 6. Screen & DPR
  const screen = persona.screen;
  if (screen && typeof screen === 'object') {
    const width = Number(screen.width);
    const height = Number(screen.height);
    if (Number.isFinite(width) && Number.isFinite(height)) {
      if (width <= 0 || height <= 0) {
        issues.push({ code: 'screen-geometry-invalid', severity: 'error', field: 'screen', message: `Screen dimensions must be positive, got ${width}x${height}` });
      }
    }
    const dpr = Number(screen.devicePixelRatio || persona.devicePixelRatio);
    if (Number.isFinite(dpr)) {
      if (os === 'macos' && dpr < 2) {
        issues.push({ code: 'screen-dpr-mismatch', severity: 'error', field: 'devicePixelRatio', message: `macOS Retina personas require devicePixelRatio >= 2, got ${dpr}` });
      }
      if (os === 'android' && (dpr < 1.5 || dpr > 4)) {
        issues.push({ code: 'screen-dpr-mismatch', severity: 'error', field: 'devicePixelRatio', message: `Android personas require devicePixelRatio between 1.5 and 4, got ${dpr}` });
      }
    }
  }

  // 7. Timezone
  const tz = persona.timezone ? String(persona.timezone).trim() : '';
  if (tz) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      issues.push({ code: 'timezone-invalid', severity: 'error', field: 'timezone', message: `Invalid IANA timezone: '${tz}'` });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    violations: issues.filter((i) => i.severity === 'error'),
  };
}

/**
 * Deterministically generate coherent personas for a pool
 * @param {object} params
 * @returns {Array<object>}
 */
function generatePoolPersonas({ seed = 'openbrowser-pool', size = 20, osMix = DEFAULT_OS_MIX }) {
  const personas = [];
  const rng = mulberry32(hashSeedToInt(seed, 'pool-generation'));

  // Normalize osMix
  const mix = { ...DEFAULT_OS_MIX, ...osMix };
  const osKeys = Object.keys(mix);
  const totalWeight = osKeys.reduce((acc, k) => acc + (mix[k] > 0 ? mix[k] : 0), 0) || 1;
  const normalizedMix = {};
  for (const k of osKeys) {
    normalizedMix[k] = (mix[k] > 0 ? mix[k] : 0) / totalWeight;
  }

  for (let i = 0; i < size; i++) {
    // 1. Pick OS by distribution
    const r = rng();
    let cumulative = 0;
    let chosenOs = 'windows';
    for (const k of osKeys) {
      cumulative += normalizedMix[k];
      if (r <= cumulative) {
        chosenOs = k;
        break;
      }
    }

    // Fallback if missing presets
    const osTemplates = PERSONAS_BY_OS[chosenOs] || PERSONAS_BY_OS.windows;
    const tplIdx = Math.floor(rng() * osTemplates.length);
    const tpl = osTemplates[tplIdx];

    // Media pool
    const mediaPool = MEDIA_DEVICE_POOLS_BY_OS[chosenOs] || MEDIA_DEVICE_POOLS_BY_OS.windows;
    const mediaIdx = Math.floor(rng() * mediaPool.length);
    const media = mediaPool[mediaIdx];

    // Fonts
    const fontList = fontsForOs(chosenOs);

    // Locale
    const localePool = OS_LOCALE_PRESETS[chosenOs] || OS_LOCALE_PRESETS.windows;
    const localeIdx = Math.floor(rng() * localePool.length);
    const loc = localePool[localeIdx];

    // Seeds for canvas / audio / clientRects
    const canvasNoiseSeed = hashSeedToInt(seed, `canvas:${i}`);
    const audioNoiseSeed = hashSeedToInt(seed, `audio:${i}`);
    const clientRectsNoiseSeed = hashSeedToInt(seed, `clientrects:${i}`);

    // Platform & UA
    const platform = chosenOs === 'windows'
      ? 'Win32'
      : (chosenOs === 'macos' ? 'MacIntel' : (chosenOs === 'linux' ? 'Linux x86_64' : 'Linux armv8l'));

    const chromeMajor = 128;
    let uaString = '';
    if (chosenOs === 'windows') {
      uaString = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
    } else if (chosenOs === 'macos') {
      uaString = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
    } else if (chosenOs === 'linux') {
      uaString = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
    } else if (chosenOs === 'android') {
      uaString = `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;
    }

    const personaId = `fpp-${chosenOs}-${i}-${hashSeedToInt(seed, `id:${i}`).toString(16).slice(0, 8)}`;

    const persona = {
      id: personaId,
      os: chosenOs,
      platform,
      cores: tpl.cores,
      hardwareConcurrency: tpl.cores,
      memory: tpl.memory,
      deviceMemory: tpl.memory,
      colorDepth: tpl.colorDepth || 24,
      devicePixelRatio: tpl.devicePixelRatio,
      screen: {
        width: tpl.screen.width,
        height: tpl.screen.height,
        availWidth: tpl.screen.width,
        availHeight: tpl.screen.height - (chosenOs === 'windows' ? 40 : (chosenOs === 'macos' ? 25 : 0)),
        availLeft: 0,
        availTop: 0,
        screenX: 0,
        screenY: 0,
        colorDepth: tpl.colorDepth || 24,
        pixelDepth: tpl.colorDepth || 24,
        devicePixelRatio: tpl.devicePixelRatio,
      },
      webgl: {
        vendor: tpl.webgl.vendor,
        renderer: tpl.webgl.renderer,
        gpu: tpl.webgl.gpu ? { ...tpl.webgl.gpu } : undefined,
      },
      webgpu: {
        vendor: tpl.webgl.gpu?.vendor || (chosenOs === 'macos' ? 'apple' : 'intel'),
        renderer: tpl.webgl.renderer,
        architecture: tpl.webgl.gpu?.architecture || 'common-3',
      },
      fonts: {
        list: [...fontList],
      },
      fontList: [...fontList],
      mediaDevices: {
        input: media.input,
        output: media.output,
        video: media.video,
        devices: [
          { kind: 'audioinput', label: media.input, deviceId: `fpp-aid-${i}`, groupId: `fpp-gid-${i}` },
          { kind: 'audiooutput', label: media.output, deviceId: `fpp-aod-${i}`, groupId: `fpp-gid-${i}` },
          { kind: 'videoinput', label: media.video, deviceId: `fpp-vid-${i}`, groupId: `fpp-gid-${i}` },
        ],
      },
      webrtc_media_labels: {
        default_text: 'Default',
        communications_text: 'Communications',
        audio_input_labels: [media.input],
        audio_output_labels: [media.output],
        video_input_labels: [media.video],
      },
      canvas: {
        noiseSeed: canvasNoiseSeed,
        stability: { mode: 'noise', seed: canvasNoiseSeed },
      },
      audio: {
        noiseSeed: audioNoiseSeed,
      },
      clientRects: {
        noiseSeed: clientRectsNoiseSeed,
      },
      timezone: loc.timezone,
      languages: [...loc.languages],
      userAgent: uaString,
      provenance: {
        source: 'authentic_preset',
        status: 'verified',
        verifiedAxes: [
          'os', 'platform', 'webgl', 'cores', 'hardwareConcurrency',
          'memory', 'deviceMemory', 'screen', 'devicePixelRatio',
          'colorDepth', 'fonts', 'mediaDevices', 'webrtc_media_labels',
          'timezone', 'languages', 'userAgent',
        ],
        structuralPlaceholders: [
          'webgpu_adapter_limits',
          'cputype_mach_header',
          'webgl_unmasked_extension_order',
        ],
        notes: 'Hardware profiles and OS pools verified from device-personas.js; WebGPU limits and low-level mach-headers remain structural placeholders awaiting physical device sampling.',
      },
    };

    const audit = verifyPersonaConsistency(persona);
    if (!audit.valid) {
      throw new Error(`Internal generator produced inconsistent persona: ${audit.violations[0].message}`);
    }

    personas.push(persona);
  }

  return personas;
}

/**
 * FingerprintPool: Stateful pool coordinator instance (without global mutable state or file I/O).
 */
class FingerprintPool {
  /**
   * @param {object} options
   * @param {string|number} [options.seed='openbrowser-pool-seed']
   * @param {boolean} [options.enabled=false]
   * @param {number} [options.size=20]
   * @param {object} [options.osMix]
   * @param {Array<object>} [options.personas]
   * @param {boolean} [options.strict=false]
   * @param {object} [options.initialAssignments]
   */
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.seed = String(options.seed != null ? options.seed : 'openbrowser-pool-seed');
    this.strict = Boolean(options.strict);

    // Assignments map: envId -> { assigned, envId, personaId, persona, reused, reuseCount, assignedAt }
    this.assignedEnvs = new Map();
    // Slot usage tracking: personaId -> Set of envIds
    this.personaUsage = new Map();

    if (!this.enabled && !options.personas) {
      // Default disabled with no explicit personas: keep memory/alloc footprint zero
      this.personas = [];
    } else if (Array.isArray(options.personas)) {
      this.personas = [];
      for (const p of options.personas) {
        const audit = verifyPersonaConsistency(p);
        if (audit.valid) {
          this.personas.push(p);
        } else if (this.strict) {
          throw new Error(`Inconsistent persona rejected from pool: ${audit.violations[0].message}`);
        }
      }
      if (this.personas.length === 0) {
        throw new Error('No valid personas provided to pool');
      }
    } else {
      const poolSize = Number.isInteger(options.size) && options.size > 0 ? options.size : 20;
      this.personas = generatePoolPersonas({
        seed: this.seed,
        size: poolSize,
        osMix: options.osMix || DEFAULT_OS_MIX,
      });
    }

    // Initialize slot usage
    for (const p of this.personas) {
      this.personaUsage.set(p.id, new Set());
    }

    // Import initial assignments if provided
    if (options.initialAssignments) {
      this.importAssignments(options.initialAssignments);
    }
  }

  /**
   * Assign a persona to an environment.
   * - If disabled: returns null, mutates nothing.
   * - If previously assigned: returns existing assignment record.
   * - If unexhausted: finds deterministic unassigned persona (reused: false).
   * - If exhausted: reuses least-used persona (reused: true, reuseCount >= 1).
   *
   * @param {string} envId Environment identifier
   * @returns {object|null} Assignment record
   */
  assignPersona(envId) {
    if (!this.enabled) return null;
    if (!envId || typeof envId !== 'string') {
      throw new Error('assignPersona requires a non-empty string envId');
    }

    // Return cached assignment if already allocated
    if (this.assignedEnvs.has(envId)) {
      return this.assignedEnvs.get(envId);
    }

    const M = this.personas.length;
    if (M === 0) {
      return null;
    }

    const h = hashSeedToInt(this.seed, envId);
    const preferredIdx = h % M;

    // Check for unassigned slots (pool unexhausted)
    let chosen = null;
    let reused = false;
    let reuseCount = 0;

    const unassignedCount = Array.from(this.personaUsage.values()).filter((s) => s.size === 0).length;

    if (unassignedCount > 0) {
      // Pool is NOT exhausted: find an unoccupied slot
      const prefPersona = this.personas[preferredIdx];
      if (this.personaUsage.get(prefPersona.id).size === 0) {
        chosen = prefPersona;
      } else {
        // Probe for the next free slot
        for (let step = 1; step < M; step++) {
          const candidate = this.personas[(preferredIdx + step) % M];
          if (this.personaUsage.get(candidate.id).size === 0) {
            chosen = candidate;
            break;
          }
        }
      }
      reused = false;
      reuseCount = 0;
    } else {
      // Pool IS exhausted: find least-used persona starting from preferredIdx
      let minUsage = Infinity;
      for (const p of this.personas) {
        const u = this.personaUsage.get(p.id).size;
        if (u < minUsage) minUsage = u;
      }

      for (let step = 0; step < M; step++) {
        const candidate = this.personas[(preferredIdx + step) % M];
        if (this.personaUsage.get(candidate.id).size === minUsage) {
          chosen = candidate;
          break;
        }
      }

      reused = true;
      reuseCount = this.personaUsage.get(chosen.id).size;
    }

    // Register assignment
    this.personaUsage.get(chosen.id).add(envId);

    const record = {
      assigned: true,
      envId,
      personaId: chosen.id,
      persona: chosen,
      reused,
      reuseCount,
      assignedAt: Date.now(),
      // Direct convenience properties
      id: chosen.id,
      os: chosen.os,
      platform: chosen.platform,
    };

    this.assignedEnvs.set(envId, record);
    return record;
  }

  /**
   * Get assigned persona for an environment.
   * Auto-assigns if not previously assigned.
   * @param {string} envId
   * @returns {object|null} Persona object
   */
  getPersona(envId) {
    if (!this.enabled) return null;
    if (!envId) return null;
    if (this.assignedEnvs.has(envId)) {
      return this.assignedEnvs.get(envId).persona;
    }
    const rec = this.assignPersona(envId);
    return rec ? rec.persona : null;
  }

  /**
   * Get assignment record for an environment
   * @param {string} envId
   * @returns {object|null}
   */
  getAssignment(envId) {
    if (!this.enabled) return null;
    return this.assignedEnvs.get(envId) || null;
  }

  /**
   * Check if envId has an active persona assignment
   * @param {string} envId
   * @returns {boolean}
   */
  hasPersona(envId) {
    if (!this.enabled) return false;
    return this.assignedEnvs.has(envId);
  }

  /**
   * Release assignment for an environment
   * @param {string} envId
   * @returns {boolean}
   */
  releasePersona(envId) {
    if (!this.enabled) return false;
    if (!this.assignedEnvs.has(envId)) return false;
    const rec = this.assignedEnvs.get(envId);
    this.personaUsage.get(rec.personaId)?.delete(envId);
    this.assignedEnvs.delete(envId);
    return true;
  }

  /**
   * Get comprehensive pool statistics
   */
  getPoolStats() {
    const osDistribution = { windows: 0, macos: 0, linux: 0, android: 0, ios: 0 };
    for (const p of this.personas) {
      if (osDistribution[p.os] != null) osDistribution[p.os]++;
      else osDistribution[p.os] = 1;
    }
    const total = this.personas.length;
    const osPercentages = {};
    for (const [os, count] of Object.entries(osDistribution)) {
      osPercentages[os] = total > 0 ? `${((count / total) * 100).toFixed(1)}%` : '0.0%';
    }

    let verifiedCount = 0;
    let placeholderCount = 0;
    for (const p of this.personas) {
      if (p.provenance?.status === 'verified') verifiedCount++;
      else placeholderCount++;
    }

    return {
      enabled: this.enabled,
      poolSize: total,
      assignedCount: this.assignedEnvs.size,
      reusedCount: Array.from(this.assignedEnvs.values()).filter((a) => a.reused).length,
      availableCount: Array.from(this.personaUsage.values()).filter((s) => s.size === 0).length,
      osDistribution,
      osPercentages,
      statusCounts: {
        verified: verifiedCount,
        structural_placeholder: placeholderCount,
      },
    };
  }

  /**
   * Export assignments state for external persistence (pure JSON)
   */
  exportAssignments() {
    return {
      seed: this.seed,
      enabled: this.enabled,
      assignments: Array.from(this.assignedEnvs.entries()).map(([envId, rec]) => ({
        envId,
        personaId: rec.personaId,
        reused: rec.reused,
        reuseCount: rec.reuseCount,
        assignedAt: rec.assignedAt,
      })),
    };
  }

  /**
   * Import assignments from external persistence
   * @param {object} state
   */
  importAssignments(state) {
    if (!state) return;
    const list = Array.isArray(state)
      ? state
      : Array.isArray(state.assignments)
        ? state.assignments
        : typeof state === 'object'
          ? Object.entries(state).map(([envId, val]) => (typeof val === 'string' ? { envId, personaId: val } : { envId, ...val }))
          : [];

    const personaMap = new Map(this.personas.map((p) => [p.id, p]));

    for (const item of list) {
      if (!item || !item.envId || !item.personaId) continue;
      const persona = personaMap.get(item.personaId);
      if (!persona) continue;

      this.personaUsage.get(persona.id)?.add(item.envId);

      const record = {
        assigned: true,
        envId: item.envId,
        personaId: persona.id,
        persona,
        reused: Boolean(item.reused),
        reuseCount: Number(item.reuseCount) || 0,
        assignedAt: item.assignedAt || Date.now(),
        id: persona.id,
        os: persona.os,
        platform: persona.platform,
      };

      this.assignedEnvs.set(item.envId, record);
    }
  }
}

/**
 * Factory function to create a fingerprint pool.
 * Default enabled: false. Zero side effects.
 *
 * @param {object} [options]
 * @param {string|number} [options.seed]
 * @param {boolean} [options.enabled=false]
 * @param {number} [options.size=20]
 * @param {object} [options.osMix]
 * @param {Array<object>} [options.personas]
 * @param {boolean} [options.strict=false]
 * @param {object} [options.initialAssignments]
 * @returns {FingerprintPool}
 */
function createFingerprintPool(options = {}) {
  return new FingerprintPool(options);
}

module.exports = {
  createFingerprintPool,
  verifyPersonaConsistency,
  FingerprintPool,
  DEFAULT_OS_MIX,
  hashSeedToInt,
};
