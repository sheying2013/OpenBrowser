'use strict';

/**
 * Human-like text entry and typing cadence simulation.
 *
 * Implements a natural human typing cadence model:
 *   - Per-keystroke 50-180ms Gaussian random delay (Box-Muller)
 *   - Inter-word pauses (80-240ms) after spaces / delimiters
 *   - Sentence-ending pauses (180-600ms) after terminal punctuation
 *   - Plausible corrected typo slips (typo rate <= 3%)
 *   - Dynamic WPM cadence curve (micro-bursts and fatigue variations)
 *   - Differentiated speed profiles (fast / medium / slow)
 *   - Chunking and immediate AbortSignal cancellation
 *   - Sensitive / password field log suppression
 *
 * Dispatches trusted events natively through CDP Input.dispatchKeyEvent
 * so event.isTrusted is naturally true.
 */

/** Adjacent-key neighbourhood on a standard QWERTY layout. */
const ADJACENT_KEYS = Object.freeze({
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
});

const FALLBACK_KEY_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const DELAY_BOUND_MIN = 10;
const DELAY_BOUND_MAX = 10000;

/** Default typing cadence profiles: fast / medium / slow. */
const SPEED_PROFILES = Object.freeze({
  fast: {
    name: 'fast',
    delayRange: [50, 100],
    meanDelay: 75,
    stdDev: 12,
    wordPause: [80, 150],
    sentencePause: [180, 320],
    typoRate: 1.5,
  },
  medium: {
    name: 'medium',
    delayRange: [80, 140],
    meanDelay: 110,
    stdDev: 18,
    wordPause: [120, 240],
    sentencePause: [280, 480],
    typoRate: 2.5,
  },
  slow: {
    name: 'slow',
    delayRange: [120, 180],
    meanDelay: 150,
    stdDev: 20,
    wordPause: [180, 350],
    sentencePause: [400, 700],
    typoRate: 3.0,
  },
});

const DEFAULT_DELAY_RANGE = SPEED_PROFILES.medium.delayRange.slice();

/** All percentages are integers or floats <= 100. Default typoRate <= 3%. */
const DEFAULT_TYPO_CONFIG = Object.freeze({
  typoRate: 2.5,
  scenario1Threshold: 60,
  scenario2Threshold: 25,
  scenario2BackspaceRate: 80,
});

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

/** Tolerant parser for typo configuration. */
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

/** Resolve speed profile configuration from a name or settings object. */
function resolveSpeedProfile(speedOrSettings) {
  if (typeof speedOrSettings === 'string') {
    const key = speedOrSettings.toLowerCase().trim();
    if (SPEED_PROFILES[key]) return SPEED_PROFILES[key];
  }
  if (speedOrSettings && typeof speedOrSettings === 'object') {
    const named = speedOrSettings.speed || speedOrSettings.simulateInputSpeed || speedOrSettings.typingSpeed;
    if (typeof named === 'string' && SPEED_PROFILES[named.toLowerCase().trim()]) {
      return SPEED_PROFILES[named.toLowerCase().trim()];
    }
  }
  return SPEED_PROFILES.medium;
}

/** Resolve delay range from settings object. */
function delayRangeFromSettings(settings = {}) {
  if (!settings || typeof settings !== 'object') return DEFAULT_DELAY_RANGE.slice();
  if (settings.speed && SPEED_PROFILES[String(settings.speed).toLowerCase()]) {
    return SPEED_PROFILES[String(settings.speed).toLowerCase()].delayRange.slice();
  }
  const min = Number(settings.simulateInputDelay);
  if (!Number.isFinite(min)) return DEFAULT_DELAY_RANGE.slice();
  let maxRaw = Number(settings.simulateInputDelayMax);
  if (Number.isFinite(maxRaw) && maxRaw > 0 && min > maxRaw) maxRaw = min;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : min;
  return normalizeDelayRange([min, max]);
}

/** Box-Muller Gaussian random sampling clamped to [min, max]. */
function sampleGaussian(min, max, mean, stdDev, randomSource) {
  let u1 = 0, u2 = 0;
  const rand = typeof randomSource === 'function' ? randomSource : Math.random;
  while (u1 === 0) u1 = rand();
  while (u2 === 0) u2 = rand();
  const z = Math.sqrt(-2.0 * Math.log(u1 || 1e-9)) * Math.cos(2.0 * Math.PI * u2);
  const targetMean = Number.isFinite(mean) ? mean : (min + max) / 2;
  const targetStd = Number.isFinite(stdDev) && stdDev > 0 ? stdDev : Math.max(1, (max - min) / 6);
  const val = Math.round(targetMean + z * targetStd);
  return Math.max(min, Math.min(max, val));
}

/**
 * Natural WPM rhythm multiplier.
 * Models: initial warm-up ramp, micro-burst cadence oscillations (+/-8%),
 * and natural minor drift across longer texts.
 */
function wpmCurveFactor(index, total) {
  if (total <= 1) return 1.0;
  const ramp = total <= 4 ? 1.0 : Math.min(1.0, 0.78 + 0.22 * (index / 4));
  const burst = 1.0 + Math.sin(index * 0.45) * 0.08;
  const fatigue = index > 80 ? 1.0 + Math.min(0.12, ((index - 80) / 200) * 0.12) : 1.0;
  return Math.max(0.7, Math.min(1.35, (burst * fatigue) / ramp));
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
  if (ch.length > 1) return false; // surrogate pairs
  const code = ch.charCodeAt(0);
  return code >= 32 && code <= 126;
}

function countConsecutiveEligible(chars, start) {
  let count = 0;
  for (let i = start; i < chars.length && isTypoEligible(chars[i]); i += 1) count += 1;
  return count;
}

const WORD_SEPARATORS = new Set([' ', ',', ';', ':', '-', '/', '(', ')', '[', ']']);
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '\n', '。', '！', '？', '…']);

function isWordBoundary(prevChar, currentChar) {
  if (!prevChar) return false;
  return WORD_SEPARATORS.has(prevChar) && currentChar !== ' ';
}

function isSentenceBoundary(prevChar, currentChar) {
  if (!prevChar) return false;
  return SENTENCE_TERMINATORS.has(prevChar) && currentChar !== ' ' && currentChar !== '\n';
}

/**
 * Abortable sleep supporting AbortSignal cancellation.
 */
function abortableSleep(ms, signal) {
  if (ms <= 0) {
    if (signal?.aborted) {
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      return reject(err);
    }
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      reject(err);
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create a typing engine bound to a driver.
 *
 * @param {object} driver
 * @param {(char:string)=>Promise<void>} driver.typeChar  Type one character.
 * @param {(key:string, opts:{delay:number})=>Promise<void>} driver.pressKey  Press a named key.
 * @param {()=>Promise<void>} [driver.flush]  Await round-trip input processing.
 * @param {object} [options]
 * @param {string} [options.speed='medium']  Speed profile: 'fast' | 'medium' | 'slow'
 * @param {AbortSignal} [options.signal]  Cancellation signal
 * @param {boolean} [options.sensitive=false]  Mask logged values for password fields
 * @param {(min:number,max:number)=>number} [options.randomInt]
 * @param {(ms:number)=>Promise<void>} [options.sleep]
 * @param {(ch:string)=>string} [options.pickWrongChar]  Override slip generation (testing)
 * @param {(event:object)=>void} [options.onEvent]  Observation hook
 */
function createTypingEngine(driver, options = {}) {
  if (!driver || typeof driver.typeChar !== 'function' || typeof driver.pressKey !== 'function') {
    throw new TypeError('driver with typeChar and pressKey is required');
  }

  const speedProfile = resolveSpeedProfile(options.speed);
  const signal = options.signal || null;
  const sensitive = Boolean(options.sensitive);

  const customSleep = typeof options.sleep === 'function' ? options.sleep : null;
  const sleep = async (ms) => {
    if (signal?.aborted) {
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      throw err;
    }
    if (customSleep) {
      await customSleep(ms);
      if (signal?.aborted) {
        const err = new Error('Typing cancelled');
        err.name = 'AbortError';
        throw err;
      }
      return;
    }
    await abortableSleep(ms, signal);
  };

  const randInt = typeof options.randomInt === 'function'
    ? options.randomInt
    : (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const flush = typeof driver.flush === 'function' ? () => driver.flush() : async () => {};

  function emit(event) {
    if (!onEvent) return;
    try {
      if (sensitive && event) {
        // Redact typed text in logs / observers for password / credential security
        const sanitized = { ...event };
        if (sanitized.text) sanitized.text = '•';
        if (sanitized.ch) sanitized.ch = '•';
        onEvent(sanitized);
        return;
      }
      onEvent(event);
    } catch (_) {
      // Observers must not break typing
    }
  }

  function pickDelay(range, index = 0, total = 1) {
    const [min, max] = normalizeDelayRange(range);
    if (typeof options.randomInt === 'function') {
      return randInt(min, max);
    }
    const factor = wpmCurveFactor(index, total);
    const mean = (min + max) / 2;
    const stdDev = Math.max(2, (max - min) / 6);
    const sampled = sampleGaussian(min, max, mean, stdDev);
    const scaled = Math.round(sampled * factor);
    return Math.max(min, Math.min(max, scaled));
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

  async function typeChar(ch, range, extraDelay = 0, index = 0, total = 1) {
    if (signal?.aborted) {
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      throw err;
    }
    const delay = pickDelay(range, index, total) + extraDelay;
    if (delay > 0) await sleep(delay);
    await driver.typeChar(ch);
    await flush();
  }

  async function pressKey(key, preDelay, keyHold = 0) {
    if (signal?.aborted) {
      const err = new Error('Typing cancelled');
      err.name = 'AbortError';
      throw err;
    }
    if (preDelay > 0) await sleep(preDelay);
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

  async function scenario1(ch, range, index, total) {
    await typeChar(wrongCharFor(ch), range, 0, index, total);
    await pressKey(BACKSPACE, randInt(80, 150), randInt(40, 80));
    await typeChar(ch, range, randInt(90, 180), index, total);
    emit({ type: 'typo', scenario: 1, span: 1 });
  }

  async function scenario2Backspace(chars, start, span, range, total) {
    for (let k = 0; k < span; k += 1) {
      await typeChar(wrongCharFor(chars[start + k]), range, 0, start + k, total);
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(BACKSPACE, k === 0 ? randInt(100, 180) : randInt(30, 60), randInt(40, 80));
    }
    for (let k = 0; k < span; k += 1) {
      await typeChar(chars[start + k], range, k === 0 ? randInt(90, 180) : 0, start + k, total);
    }
    emit({ type: 'typo', scenario: 2, mode: 'backspace', span });
  }

  async function scenario2Cursor(chars, start, span, range, total) {
    for (let k = 0; k < span; k += 1) {
      await typeChar(wrongCharFor(chars[start + k]), range, 0, start + k, total);
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(ARROW_LEFT, k === 0 ? randInt(100, 180) : randInt(30, 60), randInt(40, 80));
    }
    for (let k = 0; k < span; k += 1) {
      await pressKey(DELETE, randInt(30, 60), randInt(40, 80));
    }
    for (let k = 0; k < span; k += 1) {
      await typeChar(chars[start + k], range, k === 0 ? randInt(90, 180) : 0, start + k, total);
    }
    emit({ type: 'typo', scenario: 2, mode: 'cursor', span });
  }

  async function scenario3(ch, range, index, total) {
    await typeChar(ch, range, 0, index, total);
    await typeChar(ch, range, 0, index, total);
    await pressKey(BACKSPACE, randInt(80, 150), randInt(40, 80));
    emit({ type: 'typo', scenario: 3, span: 1 });
  }

  async function runScenario(chars, index, range, config) {
    const scenario = pickScenario(config);
    const total = chars.length;

    if (scenario === 1) {
      await scenario1(chars[index], range, index, total);
      return 1;
    }
    if (scenario === 3) {
      await scenario3(chars[index], range, index, total);
      return 1;
    }

    const maxSpan = countConsecutiveEligible(chars, index);
    const span = Math.min(randInt(2, 3), maxSpan);
    if (span < 2) {
      await scenario1(chars[index], range, index, total);
      return 1;
    }
    if (pickScenario2Mode(config) === 'backspace') {
      await scenario2Backspace(chars, index, span, range, total);
    } else {
      await scenario2Cursor(chars, index, span, range, total);
    }
    return span;
  }

  function shouldSlip(ch, config) {
    return isTypoEligible(ch) && Math.random() * 100 < config.typoRate;
  }

  /** Type text with per-character delays and human cadence pauses, without slips. */
  async function typeText(text, delayRange) {
    const range = normalizeDelayRange(delayRange || speedProfile.delayRange);
    const chars = Array.from(normalizeText(text));
    for (let i = 0; i < chars.length; i += 1) {
      if (signal?.aborted) {
        const err = new Error('Typing cancelled');
        err.name = 'AbortError';
        throw err;
      }
      let extra = 0;
      if (i > 0) {
        const prev = chars[i - 1];
        const cur = chars[i];
        if (isSentenceBoundary(prev, cur)) {
          extra = typeof options.randomInt === 'function'
            ? randInt(speedProfile.sentencePause[0], speedProfile.sentencePause[1])
            : sampleGaussian(speedProfile.sentencePause[0], speedProfile.sentencePause[1], null, null);
        } else if (isWordBoundary(prev, cur)) {
          extra = typeof options.randomInt === 'function'
            ? randInt(speedProfile.wordPause[0], speedProfile.wordPause[1])
            : sampleGaussian(speedProfile.wordPause[0], speedProfile.wordPause[1], null, null);
        }
      }
      await typeChar(chars[i], i === 0 ? [0, 0] : range, extra, i, chars.length);
    }
    return chars.length;
  }

  /** Type text with per-character delays, human cadence, and plausible corrected slips. */
  async function simulateType(text, delayRange, typoConfig) {
    const range = normalizeDelayRange(delayRange || speedProfile.delayRange);
    const config = parseTypoConfig(typoConfig || { typoRate: speedProfile.typoRate });
    const chars = Array.from(normalizeText(text));
    const stats = { chars: chars.length, slips: 0, correctedChars: 0 };
    let index = 0;

    while (index < chars.length) {
      if (signal?.aborted) {
        const err = new Error('Typing cancelled');
        err.name = 'AbortError';
        throw err;
      }
      const ch = chars[index];
      if (!shouldSlip(ch, config)) {
        let extra = 0;
        if (index > 0) {
          const prev = chars[index - 1];
          if (isSentenceBoundary(prev, ch)) {
            extra = typeof options.randomInt === 'function'
              ? randInt(speedProfile.sentencePause[0], speedProfile.sentencePause[1])
              : sampleGaussian(speedProfile.sentencePause[0], speedProfile.sentencePause[1], null, null);
          } else if (isWordBoundary(prev, ch)) {
            extra = typeof options.randomInt === 'function'
              ? randInt(speedProfile.wordPause[0], speedProfile.wordPause[1])
              : sampleGaussian(speedProfile.wordPause[0], speedProfile.wordPause[1], null, null);
          }
        }
        await typeChar(ch, index === 0 ? [0, 0] : range, extra, index, chars.length);
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
    speedProfile,
  };
}

/**
 * High-level human-like typing dispatch directly to a CDP session.
 *
 * @param {object} cdp Transport module exposing .call(ws, method, params)
 * @param {string} wsUrl Target page debugger WebSocket URL
 * @param {string} text Text string to type
 * @param {object} [options]
 * @param {string} [options.speed='medium'] 'fast' | 'medium' | 'slow'
 * @param {number[]} [options.delayRange] Explicit [min, max] ms bounds (50-180ms)
 * @param {object} [options.typoConfig] Custom typo config
 * @param {number} [options.typoRate] Typo slip rate percentage (<= 3.0%)
 * @param {boolean} [options.clear=false] Clear focused field prior to typing
 * @param {boolean} [options.sensitive=false] Redact cleartext in debug/event logging
 * @param {AbortSignal} [options.signal] AbortSignal for immediate cancellation
 * @param {number} [options.chunkSize=160] Max characters per cadence chunk
 * @returns {Promise<{chars:number, slips:number, correctedChars:number, elapsedMs:number, wpm:number, chunks:number}>}
 */
async function dispatchHumanTyping(cdp, wsUrl, text, options = {}) {
  if (!cdp || typeof cdp.call !== 'function') {
    throw new TypeError('cdp transport with call() is required');
  }
  if (!wsUrl || typeof wsUrl !== 'string') {
    throw new TypeError('wsUrl is required');
  }

  const humanInput = require('./human-input');
  const normalized = normalizeText(text);
  const speed = resolveSpeedProfile(options.speed || options.profileSpeed);
  const range = options.delayRange ? normalizeDelayRange(options.delayRange) : speed.delayRange.slice();
  let typoRate;
  if (Number.isFinite(options.typoRate)) {
    typoRate = Math.min(100, Math.max(0, Number(options.typoRate)));
  } else if (options.typoConfig && Number.isFinite(options.typoConfig.typoRate)) {
    typoRate = Math.min(100, Math.max(0, Number(options.typoConfig.typoRate)));
  } else {
    typoRate = speed.typoRate;
  }
  const typoConfig = parseTypoConfig({
    ...(options.typoConfig || {}),
    typoRate,
  });

  const driver = humanInput.createCdpTypingDriver(cdp, wsUrl, options);
  const engine = createTypingEngine(driver, {
    ...options,
    speed: speed.name,
  });

  if (options.clear) {
    try {
      await cdp.call(wsUrl, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 65, modifiers: 2 });
      await cdp.call(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, modifiers: 2 });
      await driver.pressKey('Backspace', { delay: 35 });
    } catch (_) {
      for (let i = 0; i < 20; i += 1) {
        if (options.signal?.aborted) throw Object.assign(new Error('Typing cancelled'), { name: 'AbortError' });
        await driver.pressKey('Backspace', { delay: 20 });
      }
    }
  }

  const startTime = Date.now();
  const chunkSize = options.chunkSize || 160;
  const chars = Array.from(normalized);
  const stats = { chars: chars.length, slips: 0, correctedChars: 0, chunks: 0 };

  if (chars.length <= chunkSize) {
    const res = await engine.simulateType(normalized, range, typoConfig);
    stats.slips += res.slips;
    stats.correctedChars += res.correctedChars;
    stats.chunks = 1;
  } else {
    for (let c = 0; c < chars.length; c += chunkSize) {
      if (options.signal?.aborted) {
        const err = new Error('Typing cancelled');
        err.name = 'AbortError';
        throw err;
      }
      const chunkText = chars.slice(c, c + chunkSize).join('');
      const res = await engine.simulateType(chunkText, range, typoConfig);
      stats.slips += res.slips;
      stats.correctedChars += res.correctedChars;
      stats.chunks += 1;
      if (c + chunkSize < chars.length) {
        await abortableSleep(sampleGaussian(120, 280, 180, 25), options.signal);
      }
    }
  }

  const elapsedMs = Math.max(1, Date.now() - startTime);
  const words = Math.max(1, stats.chars / 5);
  const minutes = elapsedMs / 60000;
  stats.elapsedMs = elapsedMs;
  stats.wpm = Math.round(words / minutes);
  return stats;
}

module.exports = {
  createTypingEngine,
  dispatchHumanTyping,
  simulateType: (driver, text, delayRange, typoConfig, options) =>
    createTypingEngine(driver, options).simulateType(text, delayRange, typoConfig),
  typeText: (driver, text, delayRange, options) =>
    createTypingEngine(driver, options).typeText(text, delayRange),
  ADJACENT_KEYS,
  SPEED_PROFILES,
  DEFAULT_TYPO_CONFIG,
  DEFAULT_DELAY_RANGE,
  DELAY_BOUND_MIN,
  DELAY_BOUND_MAX,
  sampleGaussian,
  wpmCurveFactor,
  normalizeDelayRange,
  resolveSpeedProfile,
  delayRangeFromSettings,
  parseTypoConfig,
  normalizeText,
  isTypoEligible,
  abortableSleep,
};
