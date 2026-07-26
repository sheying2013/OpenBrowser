'use strict';

/**
 * Coherent device personas.
 *
 * Sampling each hardware axis independently produces machines that do not exist — 4 cores
 * with 32 GB, a Mac reporting 24-bit colour at 1x, a laptop persona carrying a workstation
 * GPU. Detectors score the *combination*, so an impossible pairing is a stronger signal than
 * any single spoofed value. A persona keeps the axes that co-occur on real hardware bundled
 * together: CPU, memory, GPU, screen geometry, colour depth and pixel ratio ship as one unit.
 *
 * Selection is seeded per profile, so a profile keeps the same persona across launches.
 *
 * GPU strings must match what the OS actually reports: ANGLE/D3D11 on Windows, Metal on
 * macOS, and Mesa/OpenGL on Linux. `webglPresetsForOs` in fingerprint.js holds the same
 * families; these entries pair them with plausible CPU/RAM/display combinations.
 */

/** @typedef {{os:string, cores:number, memory:number, colorDepth:number, devicePixelRatio:number, screen:{width:number,height:number}, webgl:{vendor:string,renderer:string,gpu?:{vendor:string,architecture:string}}}} DevicePersona */

/** @type {DevicePersona[]} */
const WINDOWS_PERSONAS = [
  {
    os: 'windows', cores: 8, memory: 16, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'windows', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1366, height: 768 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'windows', cores: 12, memory: 16, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'nvidia', architecture: 'ampere' },
    },
  },
  {
    os: 'windows', cores: 16, memory: 32, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'nvidia', architecture: 'ada' },
    },
  },
  {
    os: 'windows', cores: 8, memory: 16, colorDepth: 24, devicePixelRatio: 1.25,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'amd', architecture: 'rdna-2' },
    },
  },
  {
    os: 'windows', cores: 6, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-12lp' },
    },
  },
];

/** Apple hardware: Retina (2x) and 30-bit colour are the norm, not the exception. */
const MACOS_PERSONAS = [
  {
    os: 'macos', cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1440, height: 900 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m1' },
    },
  },
  {
    os: 'macos', cores: 10, memory: 16, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1512, height: 982 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m2' },
    },
  },
  {
    os: 'macos', cores: 12, memory: 32, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1728, height: 1117 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m3' },
    },
  },
  {
    os: 'macos', cores: 8, memory: 16, colorDepth: 24, devicePixelRatio: 2,
    screen: { width: 1680, height: 1050 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
];

const LINUX_PERSONAS = [
  {
    os: 'linux', cores: 8, memory: 16, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'linux', cores: 12, memory: 32, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)',
      gpu: { vendor: 'nvidia', architecture: 'ampere' },
    },
  },
  {
    os: 'linux', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)',
      gpu: { vendor: 'amd', architecture: 'rdna-2' },
    },
  },
];

/**
 * Fonts shipped with a stock install of each platform. Font probing is one of the strongest
 * OS signals there is — Segoe UI and Calibri only exist on Windows, Helvetica Neue and the
 * SF faces only on macOS — so a profile presenting as one platform while the host is another
 * is contradicted the moment a page enumerates fonts.
 *
 * These lists are deliberately the common baseline rather than an exhaustive dump: claiming
 * an unusually large or exotic font set is itself distinguishing.
 */
const OS_FONTS = Object.freeze({
  windows: Object.freeze([
    'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
    'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
    'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free',
    'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
    'Malgun Gothic', 'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
    'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
    'Microsoft YaHei', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli',
    'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ]),
  macos: Object.freeze([
    'American Typewriter', 'Andale Mono', 'Arial', 'Arial Black', 'Arial Narrow',
    'Arial Rounded MT Bold', 'Arial Unicode MS', 'Avenir', 'Avenir Next', 'Avenir Next Condensed',
    'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard',
    'Chalkboard SE', 'Chalkduster', 'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate',
    'Courier', 'Courier New', 'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva',
    'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text',
    'Impact', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Microsoft Sans Serif',
    'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell',
    'Savoye LET', 'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman',
    'Trattatello', 'Trebuchet MS', 'Verdana', 'Zapfino', 'PingFang SC', 'Hiragino Sans',
  ]),
  linux: Object.freeze([
    'Abyssinica SIL', 'Bitstream Charter', 'Cantarell', 'Century Schoolbook L', 'Courier 10 Pitch',
    'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Dingbats', 'FreeMono', 'FreeSans',
    'FreeSerif', 'Liberation Mono', 'Liberation Sans', 'Liberation Sans Narrow',
    'Liberation Serif', 'Nimbus Mono PS', 'Nimbus Roman', 'Nimbus Sans', 'Noto Color Emoji',
    'Noto Mono', 'Noto Sans', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Serif',
    'P052', 'Standard Symbols PS', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono', 'URW Bookman',
    'URW Gothic', 'Z003',
  ]),
});

function fontsForOs(os) {
  const family = String(os || '').toLowerCase();
  if (family.startsWith('macos') || family === 'darwin') return OS_FONTS.macos;
  if (family === 'linux') return OS_FONTS.linux;
  return OS_FONTS.windows;
}

/**
 * Families that exist on exactly one platform. Used to answer font probes for a persona:
 * claiming Windows while the host answers "yes" to Helvetica Neue is a direct contradiction.
 */
function exclusiveFontsForOtherOs(os) {
  const family = String(os || '').toLowerCase();
  const isMac = family.startsWith('macos') || family === 'darwin';
  const isLinux = family === 'linux';
  const mine = new Set(fontsForOs(os).map((name) => name.toLowerCase()));
  const others = [];
  for (const [key, list] of Object.entries(OS_FONTS)) {
    const keyIsMac = key === 'macos';
    const keyIsLinux = key === 'linux';
    if ((isMac && keyIsMac) || (isLinux && keyIsLinux) || (!isMac && !isLinux && key === 'windows')) continue;
    for (const name of list) if (!mine.has(name.toLowerCase())) others.push(name);
  }
  return others;
}

const PERSONAS_BY_OS = Object.freeze({
  windows: Object.freeze(WINDOWS_PERSONAS),
  macos: Object.freeze(MACOS_PERSONAS),
  macos_arm: Object.freeze(MACOS_PERSONAS),
  linux: Object.freeze(LINUX_PERSONAS),
});

function personasForOs(os) {
  return PERSONAS_BY_OS[String(os || '').toLowerCase()] || WINDOWS_PERSONAS;
}

/**
 * Deterministically pick one persona for an OS. `index` should come from the profile seed so
 * the same profile keeps the same hardware identity on every launch.
 * @returns {DevicePersona}
 */
function pickPersona(os, index) {
  const pool = personasForOs(os);
  const n = Number.isFinite(Number(index)) ? Math.abs(Math.trunc(Number(index))) : 0;
  return pool[n % pool.length];
}

/** True when the axes form a combination that real hardware actually ships. */
function isCoherent(persona) {
  if (!persona) return false;
  const { cores, memory, colorDepth, devicePixelRatio, os, webgl } = persona;
  if (!Number.isInteger(cores) || cores < 2 || cores > 64) return false;
  if (!Number.isInteger(memory) || memory < 4 || memory > 128) return false;
  // Memory tracks core count on real machines: no 4-core/32 GB or 16-core/4 GB laptops.
  if (cores <= 4 && memory > 16) return false;
  if (cores >= 12 && memory < 8) return false;
  if (![24, 30].includes(colorDepth)) return false;
  if (!(devicePixelRatio >= 1 && devicePixelRatio <= 3)) return false;
  // Apple ships Retina panels; a 1x Mac persona would stand out.
  if (String(os).startsWith('macos') && devicePixelRatio < 2) return false;
  // GPU strings must match the platform's graphics backend.
  const renderer = String(webgl?.renderer || '');
  if (os === 'windows' && !/D3D11/.test(renderer)) return false;
  if (String(os).startsWith('macos') && !/Metal/.test(renderer)) return false;
  if (os === 'linux' && !/OpenGL/.test(renderer)) return false;
  return true;
}

module.exports = {
  PERSONAS_BY_OS,
  OS_FONTS,
  personasForOs,
  pickPersona,
  isCoherent,
  fontsForOs,
  exclusiveFontsForOtherOs,
};
