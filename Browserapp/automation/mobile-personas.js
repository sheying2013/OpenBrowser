"use strict";

/**
 * Mobile device personas.
 *
 * A phone profile only holds up when every phone-shaped surface agrees: the UA names a model that
 * exists, Client Hints report mobile, the CSS viewport matches that model's panel, the pixel ratio
 * corresponds to a panel width that actually ships, the core count comes from the same device and
 * the GPU string is one the chip vendor really exposes. Drawing those axes independently produces
 * phones that never existed, so a device is picked as one unit and every derived axis falls out of
 * that single record.
 *
 * The pool carries Android and iOS models. Both platforms are supported in the runtime:
 * - Android: Client Hints, Linux armv8l platform, real vendor GPUs (Qualcomm Adreno, ARM Mali, etc.).
 * - iOS: iPhone platform, Apple GPU, Retina/Super Retina physical DPR and panel dimensions.
 */

const pool = require("./data/mobile-devices.json");
const { buildUaProfile } = require("./user-agent");

/** Operating systems whose personas the injector can currently back with a consistent surface. */
const RUNTIME_OS = Object.freeze(["android", "ios"]);

/** Pixel ratios Android panels actually use, and the panel widths they ship at. */
const ANDROID_DPR_STEPS = Object.freeze([1.5, 1.75, 2, 2.25, 2.5, 2.625, 2.75, 2.875, 3, 3.5, 4]);
// Most phones in the pool are 1080p panels; 720p and 1440p are the next real widths, so the
// search walks them in that order and keeps the first exact match.
const ANDROID_PANELS = Object.freeze([1080, 720, 1440]);
/** Chrome for Android keeps the address bar outside the layout viewport. */
const URL_BAR_HEIGHT = 56;
const DEFAULT_CHROME_MAJOR = 148;

const normalizeOs = (os) => (String(os || "").toLowerCase() === "ios" ? "ios" : "android");

function devicesForOs(os) {
  const key = normalizeOs(os);
  return pool.devices.filter((device) => device.os === key);
}

function supportsRuntimePersona(os) {
  return RUNTIME_OS.includes(String(os || "").toLowerCase());
}

/** Highest Android release a device advertises support for, e.g. "12-15" -> 15. */
function androidVersionFromRange(range, fallback = 13) {
  const versions = String(range || "")
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 8 && n <= 99);
  if (!versions.length) return fallback;
  return Math.max(...versions);
}

/**
 * Pick the density bucket whose panel best matches a CSS viewport. Android derives the layout
 * viewport from a physical panel divided by a density bucket, so these two have to agree; the
 * remaining slack is the rounding the platform itself performs when it reports the CSS width.
 */
function resolveAndroidPanel(cssWidth) {
  const width = Number(cssWidth);
  const fallback = { dpr: 3, panel: 1080, error: Number.isFinite(width) ? Math.abs(width * 3 - 1080) : Infinity };
  if (!Number.isFinite(width) || width <= 0) return fallback;
  let best = null;
  // Walk the panels in market order and take the first one the viewport can belong to. Without
  // this a 412pt phone would match a 720p panel at 1.75x just because the rounding is tighter,
  // even though that viewport only ever ships on a 1080p panel.
  for (const panel of ANDROID_PANELS) {
    for (const ratio of ANDROID_DPR_STEPS) {
      const error = Math.abs(width * ratio - panel);
      if (!best || error < best.error - 1e-9) best = { dpr: ratio, panel, error };
    }
    // Only a near-exact match claims the panel; anything looser keeps searching so a 720p
    // viewport is not pushed onto a 1080p panel just because that panel came first.
    if (best && best.panel === panel && best.error <= panel * 0.01) return best;
  }
  return best || fallback;
}

function deriveAndroidDpr(cssWidth) {
  return resolveAndroidPanel(cssWidth).dpr;
}

/**
 * Apple devices ship physical panels with strict density buckets:
 * - 2x (Retina / Liquid Retina): iPhone 6/7/8/SE (375x667), iPhone XR / 11 (414x896).
 * - 3x (Retina HD Plus / Super Retina OLED / Super Retina XDR):
 *   iPhone 6+/7+/8+ (414x736), iPhone X/XS/11 Pro (375x812), iPhone 12/13 mini (360x780),
 *   modern OLED iPhone 12/13/14/15/16 (390..440pt).
 */
function deriveIosDpr(cssWidth, deviceName = "") {
  const name = String(deviceName || "").trim();
  const w = Number(cssWidth);
  if (name) {
    if (/iPhone\s+(6|7|8|SE)/i.test(name) && !/Plus/i.test(name)) return 2;
    if (/iPhone\s+(XR|11\b)/i.test(name) && !/Pro/i.test(name)) return 2;
    if (/iPhone\s+(X|XS|11\s+Pro|12|13|14|15|16)/i.test(name)) return 3;
    if (/Plus/i.test(name)) return 3;
  }
  return Number.isFinite(w) && w >= 390 ? 3 : 2;
}

/** UA model tokens are plain ASCII: keep what real firmware reports, drop the rest. */
function sanitizeModelToken(value, fallback = "") {
  const cleaned = String(value || "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/[^A-Za-z0-9 ._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function buildAndroidUserAgent({ model, version, chromeMajor } = {}) {
  const major = Number(chromeMajor) || DEFAULT_CHROME_MAJOR;
  const token = sanitizeModelToken(model, "Android");
  const release = Number(version) || 13;
  return `Mozilla/5.0 (Linux; Android ${release}; ${token}) AppleWebKit/537.36 `
    + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

function buildIosUserAgent({ version, chromeMajor } = {}) {
  const major = Number(chromeMajor) || DEFAULT_CHROME_MAJOR;
  const relStr = String(version || 18).trim();
  const release = relStr.includes("_") ? relStr : (relStr.includes(".") ? relStr.replace(/\./g, "_") : `${relStr}_0`);
  return `Mozilla/5.0 (iPhone; CPU iPhone OS ${release} like Mac OS X) AppleWebKit/605.1.15 `
    + `(KHTML, like Gecko) CriOS/${major}.0.0.0 Mobile/15E148 Safari/604.1`;
}

/** GPU family key used by the WebGL payload, derived from the vendor string the pool reports. */
function gpuFamily(vendor) {
  const v = String(vendor || "").toLowerCase();
  if (v.includes("qualcomm")) return "qualcomm";
  if (v.includes("imagination")) return "imagination";
  if (v.includes("arm")) return "arm";
  if (v.includes("samsung")) return "samsung";
  if (v.includes("apple")) return "apple";
  return "";
}

/**
 * Draw one device and derive every axis from it.
 * @param {number} seedU32 unsigned 32-bit profile seed
 * @param {"android"|"ios"} [os]
 * @param {{ chromeMajor?: number }} [options]
 */
function mobilePersona(seedU32, os = "android", options = {}) {
  const key = normalizeOs(os);
  const devices = devicesForOs(key);
  if (!devices.length) throw new Error(`mobile device pool has no ${key} entries`);
  const seed = Number.isFinite(Number(seedU32)) ? Math.abs(Math.trunc(Number(seedU32))) : 1;
  const device = devices[seed % devices.length];
  const isIos = key === "ios";
  const chromeMajor = Number(options.chromeMajor) || DEFAULT_CHROME_MAJOR;
  const osVersion = androidVersionFromRange(device.osRange, isIos ? 18 : 13);
  const resolvedPanel = isIos ? null : resolveAndroidPanel(device.width);
  const dpr = isIos ? deriveIosDpr(device.width, device.name) : resolvedPanel.dpr;
  // The pool records the display in CSS pixels, so the layout viewport is that panel minus the
  // browser chrome. screen.* keeps the full panel, which is what a phone reports.
  const screenWidth = device.width;
  const screenHeight = device.height;
  const viewportHeight = Math.max(320, Math.round(screenHeight - URL_BAR_HEIGHT));
  // Memory follows device hardware capabilities quantized to Chrome spec
  const deviceMemory = isIos
    ? (device.cores <= 2 ? 2 : (device.cores <= 4 ? 4 : 8))
    : (device.cores <= 4 ? 4 : 8);
  const model = isIos ? "iPhone" : sanitizeModelToken(device.model, sanitizeModelToken(device.name, "Android"));
  const deviceModel = sanitizeModelToken(device.model, sanitizeModelToken(device.name, isIos ? "iPhone" : "Android"));
  const userAgent = isIos
    ? buildIosUserAgent({ version: osVersion, chromeMajor })
    : buildAndroidUserAgent({ model, version: osVersion, chromeMajor });
  const vendor = isIos ? "Apple Computer, Inc." : "Google Inc.";
  const uaProfile = buildUaProfile({
    userAgent,
    os: key,
    chromeMajor,
    platformNav: isIos ? "iPhone" : "Linux armv8l",
    platform: isIos ? "iOS" : "Android",
    platformVersion: `${osVersion}.0.0`,
    model,
    mobile: true,
    architecture: "",
    bitness: "",
    wow64: false,
    vendor,
  });

  // Mobile Client Hints omit architecture/bitness; ensure they remain empty
  uaProfile.metadata.architecture = "";
  uaProfile.metadata.bitness = "";
  uaProfile.clientHints.architecture = "";
  uaProfile.clientHints.bitness = "";
  uaProfile.vendor = vendor;

  const panelWidth = isIos ? Math.round(screenWidth * dpr) : resolvedPanel.panel;
  const panelHeight = Math.round(screenHeight * dpr);
  const panelError = isIos ? 0 : Number(resolvedPanel.error.toFixed(2));

  return {
    os: key,
    runtimeSupported: supportsRuntimePersona(key),
    name: device.name,
    model,
    deviceModel,
    osVersion,
    osRange: device.osRange,
    cores: device.cores,
    deviceMemory,
    colorDepth: 24,
    dpr,
    // Physical panel the layout viewport renders on.
    panel: {
      width: panelWidth,
      height: panelHeight,
      error: panelError,
    },
    screen: { width: screenWidth, height: screenHeight },
    viewport: { width: screenWidth, height: viewportHeight },
    touch: true,
    maxTouchPoints: 5,
    vendor,
    gpu: {
      vendor: device.gpuVendor,
      renderer: device.gpuRenderer,
      family: gpuFamily(device.gpuVendor),
    },
    userAgent,
    uaProfile,
  };
}

module.exports = {
  POOL_SIZE: pool.count || pool.devices.length,
  RUNTIME_OS,
  ANDROID_DPR_STEPS,
  ANDROID_PANELS,
  devicesForOs,
  supportsRuntimePersona,
  androidVersionFromRange,
  resolveAndroidPanel,
  deriveAndroidDpr,
  deriveIosDpr,
  sanitizeModelToken,
  buildAndroidUserAgent,
  buildIosUserAgent,
  gpuFamily,
  mobilePersona,
};
