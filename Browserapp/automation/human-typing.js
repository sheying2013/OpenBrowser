'use strict';

/**
 * Human-like text entry.
 *
 * Types text with per-character delays, and occasionally introduces a
 * plausible typo that is then corrected — the way a real person types.
 * Three correction styles are modelled:
 *
 *   1. adjacent-key slip      -> pause, Backspace, retype
 *   2. run of 2-3 mistakes    -> backspace the whole run (or ArrowLeft+Delete)
 *   3. double-strike          -> Backspace the duplicate
 *
 * Line breaks, tabs and surrogate-pair characters never receive a slip, so
 * the produced text always matches the intended text exactly.
 *
 * The module is transport-agnostic: callers supply a driver exposing
 * `typeChar`, `pressKey` and `flush`, so it works with any automation
 * backend.
 */

/** Adjacent-key neighbourhood on a standard QWERTY layout. */
const ADJACENT_KEYS = {
  '`': ['1', '~'],
  '~': ['`', '1'],
  1: ['`', '2', 'q'],
  2: ['1', '3', 'q', 'w'],
  3: ['2', '4', 'w', 'e'],
  4: ['3', '5', 'e', 'r'],
  5: ['4', '6', 'r', 't'],
  6: ['5', '7', 't', 'y'],
  7: ['6', '8', 'y', 'u'],
  8: ['7', '9', 'u', 'i'],
  9: ['8', '0', 'i', 'o'],
  0: ['9', '-', 'o', 'p'],
  '-': ['0', '=', 'p', '['],
  '=': ['-', '[', ']'],
  q: ['1', '2', 'w', 'a'],
  w: ['2', '3', 'q', 'e', 'a', 's'],
  e: ['3', '4', 'w', 'r', 's', 'd'],
  r: ['4', '5', 'e', 't', 'd', 'f'],
  t: ['5', '6', 'r', 'y', 'f', 'g'],
  y: ['6', '7', 't', 'u', 'g', 'h'],
  u: ['7', '8', 'y', 'i', 'h', 'j'],
  i: ['8', '9', 'u', 'o', 'j', 'k'],
  o: ['9', '0', 'i', 'p', 'k', 'l'],
  p: ['0', '-', 'o', '[', 'l', ';'],
  a: ['q', 'w', 's', 'z'],
  s: ['w', 'e', 'a', 'd', 'z', 'x'],
  d: ['e', 'r', 's', 'f', 'x', 'c'],
  f: ['r', 't', 'd', 'g', 'c', 'v'],
  g: ['t', 'y', 'f', 'h', 'v', 'b'],
  h: ['y', 'u', 'g', 'j', 'b', 'n'],
  j: ['u', 'i', 'h', 'k', 'n', 'm'],
  k: ['i', 'o', 'j', 'l', 'm', ','],
  l: ['o', 'p', 'k', ';', '.', 'm'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k', ','],
  ',': ['m', 'k', 'l', '.'],
  '.': [',', 'l', ';', '/'],
  '/': ['.', ';'],
  ';': ['l', 'p', '[', "'"],
  "'": [';', '[', ']'],
  '[': ['p', '-', ']', ';', "'"],
  ']': ['[', '=', "'"],
  ' ': ['c', 'v', 'b', 'n', 'm'],
};

const FALLBACK_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const DELAY_BOUND_MIN = 10;
const DELAY_BOUND_MAX = 10000;
const DEFAULT_DELAY_RANGE = [100, 500];

/** All values are integer percentages (0-100). */
const DEFAULT_TYPO_CONFIG = {
  typoRate: 5,
  scenario1Threshold: 60,
  scenario2Threshold: 25,
  scenario2BackspaceRate: 80,
};

const BACKSPACE = 'Backspace';
const ARROW_LEFT = 'ArrowLeft';
const DELETE = 'Delete';

function clampDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DELAY_RANGE[0];
  return Math.min(DELAY_BOUND_MAX, Math.max(DELAY_BOUND_MIN, n));
}

/** Coerce any accepted delay input into a [min, max] tuple. */
function normalizeDelayRange(range) {
  if (typeof range === 'number') {
    const v = clampDelay(range);
    return [v, v];
  }
  if (!Array.isArray(range) || range.length < 2) {
    return DEFAULT_DELAY_RANGE.slice();
  }
  let min = clampDelay(range[0]);
  let max = clampDelay(range[1]);
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  return [min, max];
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return fallback;
  return n;
}

/** Tolerant parser for remotely supplied typo configuration. */
function parseTypoConfig(raw) {
  const defaults = DEFAULT_TYPO_CONFIG;
  if (!raw || typeof raw !== 'object') return Object.assign({}, defaults);
  return {
    typoRate: clampPercent(raw.typoRate, defaults.typoRate),
    scenario1Threshold: clampPercent(raw.scenario1Threshold, defaults.scenario1Threshold),
    scenario2Threshold: clampPercent(raw.scenario2Threshold, defaults.scenario2Threshold),
    scenario2BackspaceRate: clampPercent(raw.scenario2BackspaceRate, defaults.scenario2BackspaceRate),
  };
}

/** Resolve the delay range from a settings object. */
function delayRangeFromSettings(settings = {}) {
  const min = Number(settings.simulateInputDelay);
  if (!Number.isFinite(min)) return DEFAULT_DELAY_RANGE.slice();
  let maxRaw = Number(settings.simulateInputDelayMax);
  if (Number.isFinite(maxRaw) && maxRaw > 0 && min > maxRaw) maxRaw = min;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : min;
  return normalizeDelayRange([min, max]);
}

/** Normalize newlines so CRLF is not typed as two separate line breaks. */
function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isLineBreak(ch) {
  return ch === '\n' || ch === '\r';
}

/** Characters that may receive a simulated slip. */
function isTypoEligible(ch) {
  if (!ch) return false;
  if (isLineBreak(ch) || ch === '\t') return false;
  if (ch.length > 1) return false; // surrogate pairs (emoji, rare CJK ext)
  return true;
}

function countConsecutiveEligible(chars, start) {
  let count = 0;
  for (let i = start; i < chars.length && isTypoEligible(chars[i]); i += 1) count += 1;
  return count;
}

/**
 * Create an engine bound to a driver.
 *
 * @param {object} driver
 * @param {(char:string)=>Promise<void>} driver.typeChar  Type one character.
 * @param {(key:string, opts:{delay:number})=>Promise<void>} driver.pressKey  Press a named key.
 * @param {()=>Promise<void>} [driver.flush]  Await a round-trip so pending input is processed.
 * @param {object} [options]
 * @param {(min:number,max:number)=>number} [options.randomInt]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 * @param {(ch:string)=>string} [options.pickWrongChar]  Override slip generation (testing).
 * @param {(event:object)=>void} [options.onEvent]  Observation hook for slips/corrections.
 */
function createTypingEngine(driver, options = {}) {
  if (!driver || typeof driver.typeChar !== 'function' || typeof driver.pressKey !== 'function') {
    throw new TypeError('driver with typeChar and pressKey is required');
  }

  const randInt = typeof options.randomInt === 'function'
    ? options.randomInt
    : (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  const flush = typeof driver.flush === 'function'
    ? () => driver.flush()
    : async () => {};

  function emit(event) {
    if (onEvent) {
      try { onEvent(event); } catch (_) { /* observers must not break typing */ }
    }
  }

  function pickDelay(range) {
    const [min, max] = normalizeDelayRange(range);
    return randInt(min, max);
  }

  function wrongCharFor(ch) {
    if (typeof options.pickWrongChar === 'function') return options.pickWrongChar(ch);
    const lower = ch.toLowerCase();
    const neighbours = ADJACENT_KEYS[lower];
    const wrong = Array.isArray(neighbours) && neighbours.length
      ? neighbours[randInt(0, neighbours.length - 1)]
      : FALLBACK_KEY_CHARS[randInt(0, FALLBACK_KEY_CHARS.length - 1)];
    return ch !== lower ? wrong.toUpperCase() : wrong;
  }

  async function typeChar(ch, range, extraDelay = 0) {
    await sleep(pickDelay(range) + extraDelay);
    await driver.typeChar(ch);
    await flush();
  }

  async function pressKey(key, preDelay, keyHold = 0) {
    await sleep(preDelay);
    await driver.pressKey(key, { delay: keyHold });
    await flush();
  }

  function pickScenario(config) {
    const roll = Math.random() * 100;
    if (roll < config.scenario1Threshold) return 1;
    if (roll < config.scenario1Threshold + config.scenario2Threshold) return 2;
    return 3;
  }

  function pickScenario2Mode(config) {
    return Math.random() * 100 < config.scenario2BackspaceRate ? 'backspace' : 'cursor';
  }

  async function scenario1(ch, range) {
    await typeChar(wrongCharFor(ch), range);
    await pressKey(BACKSPACE, randInt(80, 150), randInt(50, 100));
    await typeChar(ch, range, randInt(100, 200));
    emit({ type: 'typo', scenario: 1, span: 1 });
  }

  async function scenario2Backspace(chars, start, span, range) {
    for (let k = 0; k < span; k += 1) {
      await typeChar(wrongCharFor(chars[start + k]), range);
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(BACKSPACE, k === 0 ? randInt(100, 200) : randInt(30, 60), randInt(50, 100));
    }
    for (let k = 0; k < span; k += 1) {
      await typeChar(chars[start + k], range, k === 0 ? randInt(100, 200) : 0);
    }
    emit({ type: 'typo', scenario: 2, mode: 'backspace', span });
  }

  async function scenario2Cursor(chars, start, span, range) {
    for (let k = 0; k < span; k += 1) {
      await typeChar(wrongCharFor(chars[start + k]), range);
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(ARROW_LEFT, k === 0 ? randInt(100, 200) : randInt(30, 60), randInt(50, 100));
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(DELETE, randInt(30, 60), randInt(50, 100));
    }
    for (let k = 0; k < span; k += 1) {
      await typeChar(chars[start + k], range, k === 0 ? randInt(100, 200) : 0);
    }
    emit({ type: 'typo', scenario: 2, mode: 'cursor', span });
  }

  async function scenario3(ch, range) {
    await typeChar(ch, range);
    await typeChar(ch, range);
    await pressKey(BACKSPACE, randInt(80, 150), randInt(50, 100));
    emit({ type: 'typo', scenario: 3, span: 1 });
  }

  /** Returns how many source characters were consumed by the correction. */
  async function runScenario(chars, index, range, config) {
    const scenario = pickScenario(config);

    if (scenario === 1) {
      await scenario1(chars[index], range);
      return 1;
    }
    if (scenario === 3) {
      await scenario3(chars[index], range);
      return 1;
    }

    const maxSpan = countConsecutiveEligible(chars, index);
    const span = Math.min(randInt(2, 3), maxSpan);
    if (span < 2) {
      await scenario1(chars[index], range);
      return 1;
    }
    if (pickScenario2Mode(config) === 'backspace') {
      await scenario2Backspace(chars, index, span, range);
    } else {
      await scenario2Cursor(chars, index, span, range);
    }
    return span;
  }

  function shouldSlip(ch, config) {
    return isTypoEligible(ch) && Math.random() * 100 < config.typoRate;
  }

  /** Type text with per-character delays, no slips. */
  async function typeText(text, delayRange) {
    const range = normalizeDelayRange(delayRange);
    const chars = Array.from(normalizeText(text));
    for (let i = 0; i < chars.length; i += 1) {
      await typeChar(chars[i], i === 0 ? [0, 0] : range);
    }
    return chars.length;
  }

  /** Type text with per-character delays plus occasional corrected slips. */
  async function simulateType(text, delayRange, typoConfig) {
    const range = normalizeDelayRange(delayRange);
    const config = parseTypoConfig(typoConfig);
    const chars = Array.from(normalizeText(text));
    const stats = { chars: chars.length, slips: 0, correctedChars: 0 };
    let index = 0;

    while (index < chars.length) {
      const ch = chars[index];
      if (!shouldSlip(ch, config)) {
        await typeChar(ch, index === 0 ? [0, 0] : range);
        index += 1;
        continue;
      }
      const consumed = await runScenario(chars, index, range, config);
      stats.slips += 1;
      stats.correctedChars += consumed;
      index += consumed;
    }
    return stats;
  }

  return {
    typeText,
    simulateType,
    simulateTyping: simulateType,
    pickWrongChar: wrongCharFor,
    ADJACENT_KEYS,
    config: Object.assign({}, DEFAULT_TYPO_CONFIG),
  };
}

module.exports = {
  createTypingEngine,
  simulateType: (driver, text, delayRange, typoConfig, options) =>
    createTypingEngine(driver, options).simulateType(text, delayRange, typoConfig),
  typeText: (driver, text, delayRange, options) =>
    createTypingEngine(driver, options).typeText(text, delayRange),
  ADJACENT_KEYS,
  DEFAULT_TYPO_CONFIG,
  DEFAULT_DELAY_RANGE,
  DELAY_BOUND_MIN,
  DELAY_BOUND_MAX,
  normalizeDelayRange,
  delayRangeFromSettings,
  parseTypoConfig,
  normalizeText,
  isTypoEligible,
};
