"use strict";

/**
 * Coherent device personas.
 *
 * Sampling each hardware axis independently produces machines that do not exist — 4 cores
 * with 32 GB, a Mac reporting 24-bit colour at 1x, a laptop persona carrying a workstation
 * GPU, or an Android phone claiming Direct3D11 graphics and Win32 platform. Detectors score
 * the combination, so an impossible pairing is a stronger signal than any single spoofed
 * value. A persona keeps the axes that co-occur on real hardware bundled together: CPU,
 * memory, GPU, screen geometry, colour depth and pixel ratio ship as one unit.
 *
 * Selection is seeded per profile, so a profile keeps the same persona across launches.
 *
 * GPU strings must match what the OS actually reports: ANGLE/D3D11 on Windows, Metal on
 * macOS, Mesa/OpenGL on Linux, and OpenGL ES / Vulkan on Android.
 */

/** @typedef {{os:string, cores:number, memory:number, colorDepth:number, devicePixelRatio:number, screen:{width:number,height:number}, webgl:{vendor:string,renderer:string,gpu?:{vendor:string,architecture:string}}}} DevicePersona */

/** @type {DevicePersona[]} */
const WINDOWS_PERSONAS = [
  {
    os: "windows", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "intel", architecture: "gen-9" },
    },
  },
  {
    os: "windows", cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1366, height: 768 },
    webgl: {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "intel", architecture: "gen-9" },
    },
  },
  {
    os: "windows", cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "nvidia", architecture: "ampere" },
    },
  },
  {
    os: "windows", cores: 16, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "nvidia", architecture: "ada" },
    },
  },
  {
    os: "windows", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "amd", architecture: "rdna-2" },
    },
  },
  {
    os: "windows", cores: 6, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      gpu: { vendor: "intel", architecture: "gen-12lp" },
    },
  },
];

/** Apple Silicon hardware: Retina (2x) and 30-bit colour are the norm, not the exception. */
const MACOS_APPLE_PERSONAS = [
  {
    os: "macos", cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1440, height: 900 },
    webgl: {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
      gpu: { vendor: "apple", architecture: "apple-m1" },
    },
  },
  {
    os: "macos", cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1512, height: 982 },
    webgl: {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
      gpu: { vendor: "apple", architecture: "apple-m2" },
    },
  },
  {
    os: "macos", cores: 12, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1728, height: 1117 },
    webgl: {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)",
      gpu: { vendor: "apple", architecture: "apple-m3" },
    },
  },
];

/**
 * Intel Mac hardware: x86 Chrome builds only. An x86 UA whose Client Hints say architecture=x86
 * can never legitimately report an Apple M-series GPU - that cross-check is exactly what
 * detectors run, so Intel and Apple Silicon personas live in separate pools.
 */
const MACOS_INTEL_PERSONAS = [
  {
    os: "macos", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2,
    screen: { width: 1680, height: 1050 },
    webgl: {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)",
      gpu: { vendor: "intel", architecture: "gen-9" },
    },
  },
  {
    // MacBook Pro 16" (2019): 8-core Intel + Radeon Pro 5500M (RDNA1).
    os: "macos", cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1728, height: 1117 },
    webgl: {
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)",
      gpu: { vendor: "amd", architecture: "rdna-1" },
    },
  },
  {
    // iMac Pro (2017): 10-core Xeon + Radeon Pro Vega 56.
    os: "macos", cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro Vega 56, Unspecified Version)",
      gpu: { vendor: "amd", architecture: "vega" },
    },
  },
];

/** Legacy merged pool kept for external consumers; new code should pick by architecture. */
const MACOS_PERSONAS = [...MACOS_APPLE_PERSONAS, ...MACOS_INTEL_PERSONAS];

const LINUX_PERSONAS = [
  {
    os: "linux", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
      gpu: { vendor: "intel", architecture: "gen-9" },
    },
  },
  {
    os: "linux", cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)",
      gpu: { vendor: "nvidia", architecture: "ampere" },
    },
  },
  {
    os: "linux", cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)",
      gpu: { vendor: "amd", architecture: "rdna-2" },
    },
  },
];

/** Modern Android mobile device personas: high DPR (2.625 - 3.5), mobile viewports, Adreno / Mali / Xclipse GPUs. */
const ANDROID_PERSONAS = [
  {
    os: "android", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 3,
    screen: { width: 412, height: 915 },
    webgl: {
      vendor: "Google Inc. (Qualcomm)",
      renderer: "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
      gpu: { vendor: "qualcomm", architecture: "adreno-700" },
    },
  },
  {
    os: "android", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2.625,
    screen: { width: 412, height: 892 },
    webgl: {
      vendor: "Google Inc. (Qualcomm)",
      renderer: "ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)",
      gpu: { vendor: "qualcomm", architecture: "adreno-700" },
    },
  },
  {
    os: "android", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2.75,
    screen: { width: 393, height: 873 },
    webgl: {
      vendor: "Google Inc. (ARM)",
      renderer: "ANGLE (ARM, Mali-G710, OpenGL ES 3.2)",
      gpu: { vendor: "arm", architecture: "valhall" },
    },
  },
  {
    os: "android", cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 3,
    screen: { width: 360, height: 800 },
    webgl: {
      vendor: "Google Inc. (Samsung Electronics)",
      renderer: "ANGLE (Samsung Electronics, Samsung Xclipse 920, OpenGL ES 3.2)",
      gpu: { vendor: "samsung", architecture: "rdna-2" },
    },
  },
];

/**
 * Fonts shipped with a stock install of each platform. Font probing is one of the strongest
 * OS signals there is — Segoe UI and Calibri only exist on Windows, Helvetica Neue and the
 * SF faces only on macOS — so a profile presenting as one platform while the host is another
 * is contradicted the moment a page enumerates fonts.
 */
const OS_FONTS = Object.freeze({
  windows: Object.freeze([
    "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Cambria Math", "Candara",
    "Comic Sans MS", "Consolas", "Constantia", "Corbel", "Courier New", "Ebrima",
    "Franklin Gothic Medium", "Gabriola", "Gadugi", "Georgia", "Impact", "Ink Free",
    "Javanese Text", "Leelawadee UI", "Lucida Console", "Lucida Sans Unicode",
    "Malgun Gothic", "Marlett", "Microsoft Himalaya", "Microsoft JhengHei",
    "Microsoft New Tai Lue", "Microsoft PhagsPa", "Microsoft Sans Serif", "Microsoft Tai Le",
    "Microsoft YaHei", "MingLiU-ExtB", "Mongolian Baiti", "MS Gothic", "MV Boli",
    "Myanmar Text", "Nirmala UI", "Palatino Linotype", "Segoe MDL2 Assets", "Segoe Print",
    "Segoe Script", "Segoe UI", "Segoe UI Emoji", "Segoe UI Historic", "Segoe UI Symbol",
    "SimSun", "Sitka", "Sylfaen", "Symbol", "Tahoma", "Times New Roman", "Trebuchet MS",
    "Verdana", "Webdings", "Wingdings", "Yu Gothic",
    "Aldhabi", "HoloLens MDL2 Assets", "Segoe Fluent Icons",
  ]),
  macos: Object.freeze([
    "American Typewriter", "Andale Mono", "Arial", "Arial Black", "Arial Narrow",
    "Arial Rounded MT Bold", "Arial Unicode MS", "Avenir", "Avenir Next", "Avenir Next Condensed",
    "Baskerville", "Big Caslon", "Bodoni 72", "Bradley Hand", "Brush Script MT", "Chalkboard",
    "Chalkboard SE", "Chalkduster", "Charter", "Cochin", "Comic Sans MS", "Copperplate",
    "Courier", "Courier New", "Didot", "DIN Alternate", "DIN Condensed", "Futura", "Geneva",
    "Georgia", "Gill Sans", "Helvetica", "Helvetica Neue", "Herculanum", "Hoefler Text",
    "Impact", "Lucida Grande", "Luminari", "Marker Felt", "Menlo", "Microsoft Sans Serif",
    "Monaco", "Noteworthy", "Optima", "Palatino", "Papyrus", "Phosphate", "Rockwell",
    "Savoye LET", "SignPainter", "Skia", "Snell Roundhand", "Tahoma", "Times", "Times New Roman",
    "Trattatello", "Trebuchet MS", "Verdana", "Zapfino", "PingFang SC", "Hiragino Sans",
    "PingFang HK Light", "Kohinoor Devanagari Medium", "InaiMathi Bold", "Galvji",
    "MuktaMahee Regular", "American Typewriter Semibold", "Futura Bold",
    "SignPainter-HouseScript Semibold", "Apple SD Gothic Neo ExtraBold",
    "STIX Two Math Regular", "STIX Two Text Regular", "Noto Sans Canadian Aboriginal Regular",
    "Noto Sans Gunjala Gondi Regular", "Noto Sans Masaram Gondi Regular",
    "Noto Serif Yezidi Regular",
  ]),
  linux: Object.freeze([
    "Abyssinica SIL", "Bitstream Charter", "Cantarell", "Century Schoolbook L", "Courier 10 Pitch",
    "DejaVu Sans", "DejaVu Sans Mono", "DejaVu Serif", "Dingbats", "FreeMono", "FreeSans",
    "FreeSerif", "Liberation Mono", "Liberation Sans", "Liberation Sans Narrow",
    "Liberation Serif", "Nimbus Mono PS", "Nimbus Roman", "Nimbus Sans", "Noto Color Emoji",
    "Noto Mono", "Noto Sans", "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Serif",
    "P052", "Standard Symbols PS", "Ubuntu", "Ubuntu Condensed", "Ubuntu Mono", "URW Bookman",
    "URW Gothic", "Z003",
  ]),
  ios: Object.freeze([
    "American Typewriter", "Arial", "Arial Black", "Arial Rounded MT Bold",
    "Avenir", "Avenir Next", "Avenir Next Condensed", "Baskerville",
    "Bodoni 72", "Bradley Hand", "Chalkboard SE", "Chalkduster", "Charter",
    "Cochin", "Copperplate", "Courier", "Courier New", "Didot",
    "DIN Alternate", "DIN Condensed", "Futura", "Galvji", "Georgia",
    "Gill Sans", "Helvetica", "Helvetica Neue", "Hiragino Sans", "Hoefler Text",
    "Impact", "InaiMathi Bold", "Kohinoor Devanagari Medium", "Marker Felt",
    "MuktaMahee Regular", "Noteworthy", "Optima", "Palatino", "Papyrus",
    "PingFang SC", "PingFang HK Light", "Rockwell", "Savoye LET",
    "Snell Roundhand", "Times New Roman", "Trebuchet MS", "Verdana", "Zapfino",
    "Apple SD Gothic Neo ExtraBold", "Noto Sans Canadian Aboriginal Regular",
    "Noto Sans Gunjala Gondi Regular", "Noto Sans Masaram Gondi Regular",
    "Noto Serif Yezidi Regular",
  ]),
  android: Object.freeze([
    "Roboto", "Noto Sans", "Noto Serif", "Noto Color Emoji",
    "Droid Sans", "Droid Sans Mono", "Carrois Gothic", "Coming Soon",
    "Cutive Mono", "Dancing Script",
  ]),
});

// Real macOS/Apple host-exclusive families that have no bundled subset asset.
// They must NOT enter fontsForOs() (that would mismatch the blob name table);
// they only belong in the foreign/deny list so non-Apple personas block them.
const APPLE_HOST_ONLY_FONTS = Object.freeze([
  "Apple Color Emoji", "Apple Symbols",
]);

function fontsForOs(os) {
  const family = String(os || "").toLowerCase();
  if (family.includes("ios") || family.includes("iphone") || family.includes("ipad")) return OS_FONTS.ios;
  if (family.startsWith("macos") || family === "darwin" || family.includes("mac")) return OS_FONTS.macos;
  if (family.includes("linux")) return OS_FONTS.linux;
  if (family.includes("android")) return OS_FONTS.android;
  return OS_FONTS.windows;
}

/**
 * Families that exist on exactly one platform. Used to answer font probes for a persona:
 * claiming Windows while the host answers "yes" to Helvetica Neue is a direct contradiction.
 */
function exclusiveFontsForOtherOs(os) {
  const family = String(os || "").toLowerCase();
  const isIos = family.includes("ios") || family.includes("iphone") || family.includes("ipad");
  const isMac = (family.startsWith("macos") || family === "darwin" || family.includes("mac")) && !isIos;
  const isLinux = family.includes("linux") && !family.includes("android");
  const isAndroid = family.includes("android");
  const mine = new Set(fontsForOs(os).map((name) => name.toLowerCase()));
  const others = [];
  const seenOthers = new Set();
  for (const [key, list] of Object.entries(OS_FONTS)) {
    const keyIsIos = key === "ios";
    const keyIsMac = key === "macos";
    const keyIsLinux = key === "linux";
    const keyIsAndroid = key === "android";
    if (
      (isIos && (keyIsIos || keyIsMac)) ||
      (isMac && (keyIsMac || keyIsIos)) ||
      (isLinux && keyIsLinux) ||
      (isAndroid && keyIsAndroid) ||
      (!isMac && !isIos && !isLinux && !isAndroid && key === "windows")
    ) {
      continue;
    }
    for (const name of list) {
      const lower = name.toLowerCase();
      if (!mine.has(lower) && !seenOthers.has(lower)) {
        seenOthers.add(lower);
        others.push(name);
      }
    }
  }
  if (!isMac && !isIos) {
    for (const name of APPLE_HOST_ONLY_FONTS) {
      const lower = name.toLowerCase();
      if (!mine.has(lower) && !seenOthers.has(lower)) {
        seenOthers.add(lower);
        others.push(name);
      }
    }
  }
  return others;
}

const PERSONAS_BY_OS = Object.freeze({
  windows: Object.freeze(WINDOWS_PERSONAS),
  // "macos" is the x86 Chrome build (Intel Mac): only Intel/AMD GPUs are plausible there.
  macos: Object.freeze(MACOS_INTEL_PERSONAS),
  // "macos_arm" is the Apple Silicon Chrome build: only Apple M-series GPUs.
  macos_arm: Object.freeze(MACOS_APPLE_PERSONAS),
  linux: Object.freeze(LINUX_PERSONAS),
  android: Object.freeze(ANDROID_PERSONAS),
});

function personasForOs(os) {
  const k = String(os || "").toLowerCase();
  if (k.includes("ios") || k.includes("iphone") || k.includes("ipad")) {
    // iPhone/iPad share the Apple GPU family with Apple Silicon Macs, never with Intel Macs.
    return PERSONAS_BY_OS.macos_arm;
  }
  return PERSONAS_BY_OS[k] || WINDOWS_PERSONAS;
}

/**
 * Physical execution limits by host platform.
 */
const HOST_WEBGL_LIMITS = Object.freeze({
  macos: Object.freeze({
    maxTextureSize: 16384,
    maxCubeMapTextureSize: 16384,
    maxRenderbufferSize: 16384,
    maxViewportDims: Object.freeze([16384, 16384]),
    aliasedPointSizeRange: Object.freeze([1, 511]),
    aliasedLineWidthRange: Object.freeze([1, 1]),
  }),
  darwin: Object.freeze({
    maxTextureSize: 16384,
    maxCubeMapTextureSize: 16384,
    maxRenderbufferSize: 16384,
    maxViewportDims: Object.freeze([16384, 16384]),
    aliasedPointSizeRange: Object.freeze([1, 511]),
    aliasedLineWidthRange: Object.freeze([1, 1]),
  }),
  linux: Object.freeze({
    maxTextureSize: 16384,
    maxCubeMapTextureSize: 16384,
    maxRenderbufferSize: 16384,
    maxViewportDims: Object.freeze([16384, 16384]),
    aliasedPointSizeRange: Object.freeze([1, 1024]),
    aliasedLineWidthRange: Object.freeze([1, 1]),
  }),
  windows: Object.freeze({
    maxTextureSize: 32768,
    maxCubeMapTextureSize: 32768,
    maxRenderbufferSize: 32768,
    maxViewportDims: Object.freeze([32768, 32768]),
    aliasedPointSizeRange: Object.freeze([1, 2048]),
    aliasedLineWidthRange: Object.freeze([1, 1]),
  }),
});

function getHostWebglLimits(hostPlatform = process.platform) {
  const p = String(hostPlatform || "").toLowerCase().trim();
  if (p === "darwin" || p === "macos" || p === "ios") return HOST_WEBGL_LIMITS.macos;
  if (p === "linux") return HOST_WEBGL_LIMITS.linux;
  return HOST_WEBGL_LIMITS.windows;
}

function isPersonaWebglCompatible(persona, hostPlatform = process.platform) {
  if (!persona || !persona.webgl) return true;
  const hostLimits = typeof hostPlatform === "object" && hostPlatform !== null
    ? hostPlatform
    : getHostWebglLimits(hostPlatform);
  const gpu = persona.webgl.gpu;
  if (!gpu) return true;

  const vendor = String(gpu.vendor || "").toLowerCase().trim();
  const arch = String(gpu.architecture || "").toLowerCase().trim();

  if (vendor === "nvidia") {
    const is32kArch = arch.includes("ada") || arch.includes("ampere") || arch.includes("turing")
      || arch.includes("40") || arch.includes("30") || arch.includes("20");
    if (is32kArch && hostLimits.maxTextureSize < 32768) {
      return false;
    }
  }
  return true;
}

function compatiblePersonasForOs(os, hostPlatform = process.platform) {
  const pool = personasForOs(os);
  const hostLimits = typeof hostPlatform === "object" && hostPlatform !== null
    ? hostPlatform
    : getHostWebglLimits(hostPlatform);
  const compatible = pool.filter((p) => isPersonaWebglCompatible(p, hostLimits));
  return Object.freeze(compatible.length > 0 ? compatible : pool);
}

function resolveCompatiblePersona(persona, hostPlatform = process.platform) {
  if (!persona) return persona;
  if (isPersonaWebglCompatible(persona, hostPlatform)) return persona;
  const pool = compatiblePersonasForOs(persona.os, hostPlatform);
  return pool[0] || persona;
}

function pickPersona(os, index, options) {
  let pool;
  if (options && (options.hostCompatible || options.host || options.hostLimits)) {
    pool = compatiblePersonasForOs(os, options.hostLimits || options.host || process.platform);
  } else {
    pool = personasForOs(os);
  }
  const n = Number.isFinite(Number(index)) ? Math.abs(Math.trunc(Number(index))) : 0;
  return pool[n % pool.length];
}

/** True when the axes form a combination that real hardware actually ships. */
function isCoherent(persona) {
  if (!persona) return false;
  const { cores, memory, colorDepth, devicePixelRatio, os, webgl } = persona;
  if (!Number.isInteger(cores) || cores < 2 || cores > 64) return false;
  if (!Number.isInteger(memory) || memory < 4 || memory > 8) return false;
  if (cores <= 2 && memory > 8) return false;
  if (cores >= 12 && memory < 8) return false;
  if (![24, 30].includes(colorDepth)) return false;

  const maxDpr = (os === "android" || os === "ios") ? 4 : 3;
  if (!(devicePixelRatio >= 1 && devicePixelRatio <= maxDpr)) return false;

  if (String(os).startsWith("macos") && devicePixelRatio < 2) return false;
  if (os === "ios" && devicePixelRatio < 2) return false;

  const renderer = String(webgl?.renderer || "");
  if (os === "windows" && !/D3D11/.test(renderer)) return false;
  if (String(os).startsWith("macos") && !/Metal/.test(renderer)) return false;
  if (os === "linux" && !/OpenGL/.test(renderer)) return false;
  if (os === "android") {
    if (!/OpenGL ES|Vulkan|Mali|Adreno|Xclipse/i.test(renderer)) return false;
    if (devicePixelRatio < 1.5 || devicePixelRatio > 4) return false;
  }
  if (os === "ios") {
    if (!/Apple/i.test(renderer)) return false;
    if (devicePixelRatio < 2 || devicePixelRatio > 3) return false;
  }
  return true;
}

module.exports = {
  WINDOWS_PERSONAS,
  MACOS_PERSONAS,
  MACOS_APPLE_PERSONAS,
  MACOS_INTEL_PERSONAS,
  PERSONAS_BY_OS,
  DEVICE_PERSONAS: PERSONAS_BY_OS,
  OS_FONTS,
  HOST_WEBGL_LIMITS,
  getHostWebglLimits,
  isPersonaWebglCompatible,
  compatiblePersonasForOs,
  resolveCompatiblePersona,
  personasForOs,
  pickPersona,
  isCoherent,
  fontsForOs,
  exclusiveFontsForOtherOs,
  APPLE_HOST_ONLY_FONTS,
};
