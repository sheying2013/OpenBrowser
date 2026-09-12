'use strict';

/**
 * Validation and normalisation for window arrangement configuration.
 *
 * Arrangement configs drive automatic tiling of profile windows. Values must
 * stay within sane bounds or the requested grid can push windows off-screen
 * (or produce an absurd column count). Platform differences are limited to the
 * minimum window height, which is larger on macOS due to the title bar.
 */

const MIN_POSITION = 0;
const MAX_POSITION = 9999;
const MIN_WIDTH = 500;
const MAX_WIDTH = 9999;
const MIN_HEIGHT = 200;
const MAC_MIN_HEIGHT = 400;
const MAX_HEIGHT = 9999;
const MIN_GAP = -9999;
const MAX_GAP = 9999;
const MIN_COL_NUM = 1;
const MAX_COL_NUM = 99;

const DEFAULTS = {
  x: 10,
  y: 10,
  width: 600,
  height: 500,
  gapX: 20,
  gapY: 20,
  colNum: 3,
  screenId: 0,
};

/** Keys that must be whole numbers. */
const INTEGER_KEYS = ['x', 'y', 'width', 'height', 'gapX', 'gapY', 'colNum', 'screenId'];

function minHeightForPlatform(platform) {
  return platform === 'darwin' ? MAC_MIN_HEIGHT : MIN_HEIGHT;
}

function isInteger(value) {
  return Number.isInteger(value);
}

/**
 * Strictly validate an arrangement config.
 * @param {object} config
 * @param {string} [platform] Defaults to `process.platform`.
 * @returns {boolean}
 */
function checkArrangeConfig(config, platform = process.platform) {
  if (!config || typeof config !== 'object') return false;
  if (!INTEGER_KEYS.every((key) => isInteger(config[key]))) return false;

  const minHeight = minHeightForPlatform(platform);
  const { x, y, width, height, gapX, gapY, colNum } = config;

  if (x < MIN_POSITION || x > MAX_POSITION) return false;
  if (y < MIN_POSITION || y > MAX_POSITION) return false;
  if (width < MIN_WIDTH || width > MAX_WIDTH) return false;
  if (height < minHeight || height > MAX_HEIGHT) return false;
  if (gapX < MIN_GAP || gapX > MAX_GAP) return false;
  if (gapY < MIN_GAP || gapY > MAX_GAP) return false;
  if (colNum < MIN_COL_NUM || colNum > MAX_COL_NUM) return false;
  return true;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Coerce arbitrary input into a valid config by clamping out-of-range values
 * and filling absent ones with defaults.
 *
 * @param {object} [input]
 * @param {string} [platform]
 * @returns {object} A config for which `checkArrangeConfig` returns true.
 */
function normalizeArrangeConfig(input, platform = process.platform) {
  const source = input && typeof input === 'object' ? input : {};
  const minHeight = minHeightForPlatform(platform);

  return {
    x: clampNumber(source.x, MIN_POSITION, MAX_POSITION, DEFAULTS.x),
    y: clampNumber(source.y, MIN_POSITION, MAX_POSITION, DEFAULTS.y),
    width: clampNumber(source.width, MIN_WIDTH, MAX_WIDTH, DEFAULTS.width),
    height: clampNumber(source.height, minHeight, MAX_HEIGHT, Math.max(DEFAULTS.height, minHeight)),
    gapX: clampNumber(source.gapX, MIN_GAP, MAX_GAP, DEFAULTS.gapX),
    gapY: clampNumber(source.gapY, MIN_GAP, MAX_GAP, DEFAULTS.gapY),
    colNum: clampNumber(source.colNum, MIN_COL_NUM, MAX_COL_NUM, DEFAULTS.colNum),
    screenId: clampNumber(source.screenId, 0, MAX_POSITION, DEFAULTS.screenId),
  };
}

/**
 * Describe every field that fails validation, for actionable error messages.
 * @returns {Array<{key:string, reason:string}>}
 */
function describeArrangeConfigProblems(config, platform = process.platform) {
  if (!config || typeof config !== 'object') {
    return [{ key: '*', reason: 'config must be an object' }];
  }
  const minHeight = minHeightForPlatform(platform);
  const problems = [];

  for (const key of INTEGER_KEYS) {
    if (!isInteger(config[key])) problems.push({ key, reason: 'must be an integer' });
  }

  const ranges = {
    x: [MIN_POSITION, MAX_POSITION],
    y: [MIN_POSITION, MAX_POSITION],
    width: [MIN_WIDTH, MAX_WIDTH],
    height: [minHeight, MAX_HEIGHT],
    gapX: [MIN_GAP, MAX_GAP],
    gapY: [MIN_GAP, MAX_GAP],
    colNum: [MIN_COL_NUM, MAX_COL_NUM],
  };

  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = config[key];
    if (!isInteger(value)) continue;
    if (value < min || value > max) {
      problems.push({ key, reason: `must be between ${min} and ${max}` });
    }
  }
  return problems;
}

/**
 * Compute grid positions for `count` windows and a validated config.
 * Rows grow downward until every window is placed.
 *
 * @returns {Array<{x:number, y:number, width:number, height:number}>}
 */
function computeGrid(config, count, platform = process.platform) {
  const cfg = normalizeArrangeConfig(config, platform);
  const positions = [];
  const cols = cfg.colNum;
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({
      x: cfg.x + col * (cfg.width + cfg.gapX),
      y: cfg.y + row * (cfg.height + cfg.gapY),
      width: cfg.width,
      height: cfg.height,
    });
  }
  return positions;
}

module.exports = {
  checkArrangeConfig,
  normalizeArrangeConfig,
  describeArrangeConfigProblems,
  computeGrid,
  minHeightForPlatform,
  INTEGER_KEYS,
  DEFAULTS,
  LIMITS: {
    MIN_POSITION, MAX_POSITION, MIN_WIDTH, MAX_WIDTH,
    MIN_HEIGHT, MAC_MIN_HEIGHT, MAX_HEIGHT,
    MIN_GAP, MAX_GAP, MIN_COL_NUM, MAX_COL_NUM,
  },
};
