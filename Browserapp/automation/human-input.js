'use strict';

/**
 * Human-like keyboard input over the Chrome DevTools Protocol.
 *
 * `Input.insertText` writes a value straight into the focused element. The
 * page observes an `input` event, but no keydown/keypress/keyup sequence, no
 * modifier transitions and no inter-key timing. That combination is one of
 * the cheapest automation signals a page can look for.
 *
 * This module turns each character into the key event sequence a physical
 * keyboard produces — optional Shift press, keyDown carrying the text, keyUp,
 * Shift release — and drives it through the typing engine so longer strings
 * carry per-key timing and plausible corrections.
 *
 * Characters with no physical key on a US layout (CJK, emoji, anything outside
 * printable ASCII) are committed the way an input method commits them, through
 * `Input.insertText`, because no key sequence can produce them.
 *
 * The transport is injected: `call` is any object exposing
 * `call(socketUrl, method, params)`.
 */

const { createTypingEngine, DEFAULT_DELAY_RANGE } = require('./human-typing');

const MODIFIER_SHIFT = 8;

const VK_SHIFT = 16;
const VK_ENTER = 13;
const VK_TAB = 9;
const VK_BACKSPACE = 8;
const VK_ESCAPE = 27;
const VK_DELETE = 46;
const VK_ARROW_LEFT = 37;
const VK_ARROW_UP = 38;
const VK_ARROW_RIGHT = 39;
const VK_ARROW_DOWN = 40;
const VK_HOME = 36;
const VK_END = 35;
const VK_PAGE_UP = 33;
const VK_PAGE_DOWN = 34;

/**
 * Printable ASCII key table for a US layout.
 * `base` is the unshifted character the key prints; `shift` marks the keys
 * that need Shift held down to produce the entry's character.
 */
const PRINTABLE = Object.create(null);

for (let i = 0; i < 26; i += 1) {
  const lower = String.fromCharCode(97 + i);
  const upper = String.fromCharCode(65 + i);
  const vk = 65 + i;
  const code = 'Key' + upper;
  PRINTABLE[lower] = { vk, code, base: lower, shift: false };
  PRINTABLE[upper] = { vk, code, base: lower, shift: true };
}

for (let i = 0; i <= 9; i += 1) {
  const digit = String(i);
  PRINTABLE[digit] = { vk: 48 + i, code: 'Digit' + i, base: digit, shift: false };
}

const SYMBOLS = {
  ' ': { vk: 32, code: 'Space', base: ' ', shift: false },
  '!': { vk: 49, code: 'Digit1', base: '1', shift: true },
  '"': { vk: 222, code: 'Quote', base: "'", shift: true },
  '#': { vk: 51, code: 'Digit3', base: '3', shift: true },
  '$': { vk: 52, code: 'Digit4', base: '4', shift: true },
  '%': { vk: 53, code: 'Digit5', base: '5', shift: true },
  '&': { vk: 55, code: 'Digit7', base: '7', shift: true },
  "'": { vk: 222, code: 'Quote', base: "'", shift: false },
  '(': { vk: 57, code: 'Digit9', base: '9', shift: true },
  ')': { vk: 48, code: 'Digit0', base: '0', shift: true },
  '*': { vk: 56, code: 'Digit8', base: '8', shift: true },
  '+': { vk: 187, code: 'Equal', base: '=', shift: true },
  ',': { vk: 188, code: 'Comma', base: ',', shift: false },
  '-': { vk: 189, code: 'Minus', base: '-', shift: false },
  '.': { vk: 190, code: 'Period', base: '.', shift: false },
  '/': { vk: 191, code: 'Slash', base: '/', shift: false },
  ':': { vk: 186, code: 'Semicolon', base: ';', shift: true },
  ';': { vk: 186, code: 'Semicolon', base: ';', shift: false },
  '<': { vk: 188, code: 'Comma', base: ',', shift: true },
  '=': { vk: 187, code: 'Equal', base: '=', shift: false },
  '>': { vk: 190, code: 'Period', base: '.', shift: true },
  '?': { vk: 191, code: 'Slash', base: '/', shift: true },
  '@': { vk: 50, code: 'Digit2', base: '2', shift: true },
  '[': { vk: 219, code: 'BracketLeft', base: '[', shift: false },
  '\\': { vk: 220, code: 'Backslash', base: '\\', shift: false },
  ']': { vk: 221, code: 'BracketRight', base: ']', shift: false },
  '^': { vk: 54, code: 'Digit6', base: '6', shift: true },
  '_': { vk: 189, code: 'Minus', base: '-', shift: true },
  '`': { vk: 192, code: 'Backquote', base: '`', shift: false },
  '{': { vk: 219, code: 'BracketLeft', base: '[', shift: true },
  '|': { vk: 220, code: 'Backslash', base: '\\', shift: true },
  '}': { vk: 221, code: 'BracketRight', base: ']', shift: true },
  '~': { vk: 192, code: 'Backquote', base: '`', shift: true },
};

for (const [ch, entry] of Object.entries(SYMBOLS)) PRINTABLE[ch] = entry;

const CONTROL_KEYS = { '\n': 'Enter', '\r': 'Enter', '\t': 'Tab' };

/** Keys with no printable character; sent as raw key events. */
const NAMED_KEYS = {
  Enter: { vk: VK_ENTER, code: 'Enter', key: 'Enter' },
  Tab: { vk: VK_TAB, code: 'Tab', key: 'Tab' },
  Backspace: { vk: VK_BACKSPACE, code: 'Backspace', key: 'Backspace' },
  Delete: { vk: VK_DELETE, code: 'Delete', key: 'Delete' },
  Escape: { vk: VK_ESCAPE, code: 'Escape', key: 'Escape' },
  ArrowLeft: { vk: VK_ARROW_LEFT, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowUp: { vk: VK_ARROW_UP, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowRight: { vk: VK_ARROW_RIGHT, code: 'ArrowRight', key: 'ArrowRight' },
  ArrowDown: { vk: VK_ARROW_DOWN, code: 'ArrowDown', key: 'ArrowDown' },
  Home: { vk: VK_HOME, code: 'Home', key: 'Home' },
  End: { vk: VK_END, code: 'End', key: 'End' },
  PageUp: { vk: VK_PAGE_UP, code: 'PageUp', key: 'PageUp' },
  PageDown: { vk: VK_PAGE_DOWN, code: 'PageDown', key: 'PageDown' },
};

/**
 * Resolve a printable character to its key description, or null when the
 * character has no key on a US layout.
 *
 * @param {string} ch single character
 * @returns {{vk:number, code:string, base:string, shift:boolean}|null}
 */
function keyDescriptor(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return null;
  return PRINTABLE[ch] || null;
}

/** True when a named key (Enter, Backspace, ArrowLeft, ...) is supported. */
function isNamedKey(name) {
  return Object.prototype.hasOwnProperty.call(NAMED_KEYS, name);
}

/**
 * Build a typing driver backed by CDP key events.
 *
 * @param {{call:Function}} call transport exposing `call(socketUrl, method, params)`
 * @param {string} ws websocket debugger URL of the target page
 * @param {{onEvent?:Function, sleep?:Function, randomInt?:Function}} [options]
 * @returns {{typeChar:Function, pressKey:Function, flush:Function}}
 */
function createCdpTypingDriver(call, ws, options = {}) {
  if (!call || typeof call.call !== 'function') {
    throw new TypeError('transport with call(socketUrl, method, params) is required');
  }
  if (!ws) throw new TypeError('websocket url is required');

  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomInt = typeof options.randomInt === 'function' ? options.randomInt : null;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  function emit(event) {
    if (onEvent) {
      try { onEvent(event); } catch (_) { /* observers must not break typing */ }
    }
  }

  /** Shift press/release bracket, so `shiftKey` state matches a real hand. */
  async function withShift(enabled, fn) {
    if (!enabled) return fn();
    await call.call(ws, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: MODIFIER_SHIFT,
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: VK_SHIFT,
      nativeVirtualKeyCode: VK_SHIFT,
    });
    emit({ type: 'modifier', key: 'Shift', down: true });
    try {
      return await fn();
    } finally {
      await call.call(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: 0,
        key: 'Shift',
        code: 'ShiftLeft',
        windowsVirtualKeyCode: VK_SHIFT,
        nativeVirtualKeyCode: VK_SHIFT,
      });
      emit({ type: 'modifier', key: 'Shift', down: false });
    }
  }

  async function typeChar(ch) {
    const named = CONTROL_KEYS[ch];
    if (named) {
      // A line break or tab is a key press, not a text commitment: pages that
      // watch for Enter or Tab would otherwise never see one.
      await pressKey(named);
      return;
    }

    const descriptor = keyDescriptor(ch);
    if (!descriptor) {
      // No physical key produces this character: commit it the way an input
      // method commits a composed syllable.
      await call.call(ws, 'Input.insertText', { text: ch });
      emit({ type: 'commit', text: ch });
      return;
    }

    const modifiers = descriptor.shift ? MODIFIER_SHIFT : 0;
    await withShift(descriptor.shift, async () => {
      await call.call(ws, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers,
        text: ch,
        unmodifiedText: descriptor.base,
        key: ch,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.vk,
        nativeVirtualKeyCode: descriptor.vk,
      });
      await call.call(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers,
        key: ch,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.vk,
        nativeVirtualKeyCode: descriptor.vk,
      });
    });
    emit({ type: 'char', text: ch });
  }

  async function pressKey(name, opts = {}) {
    const descriptor = NAMED_KEYS[name];
    if (!descriptor) throw new Error('unsupported key: ' + name);

    await call.call(ws, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: 0,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.vk,
      nativeVirtualKeyCode: descriptor.vk,
    });

    // A physical key is held for a few tens of milliseconds before release;
    // the caller can pin it, otherwise a plausible hold time is drawn.
    const hold = Number.isFinite(opts.delay) && opts.delay > 0
      ? opts.delay
      : (randomInt ? randomInt(30, 90) : 30 + Math.floor(Math.random() * 61));
    await sleep(hold);

    await call.call(ws, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 0,
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.vk,
      nativeVirtualKeyCode: descriptor.vk,
    });
    emit({ type: 'key', key: name });
  }

  async function flush() {
    // Events are already awaited in order; give the renderer a chance to
    // process the queue before the next character is measured.
    await sleep(0);
  }

  return { typeChar, pressKey, flush };
}

/**
 * Type `text` into the focused element using real key event sequences.
 *
 * @param {{call:Function}} call transport
 * @param {string} ws websocket debugger URL
 * @param {string} text
 * @param {{human?:boolean, delayRange?:number[], typoConfig?:object,
 *          clear?:boolean, onEvent?:Function, randomInt?:Function,
 *          sleep?:Function}} [options]
 *   `human` adds the slip-and-correct behaviour on top of the timing jitter.
 * @returns {Promise<{chars:number, slips:number, correctedChars:number}>}
 */
async function typeText(call, ws, text, options = {}) {
  const value = text == null ? '' : String(text);
  const driver = createCdpTypingDriver(call, ws, options);
  const engine = createTypingEngine(driver, options);
  const range = options.delayRange || DEFAULT_DELAY_RANGE;

  if (options.clear) {
    const length = Array.from(value).length;
    for (let i = 0; i < length + 8; i += 1) {
      await driver.pressKey('Backspace', { delay: 25 });
    }
  }

  if (options.human) {
    return engine.simulateType(value, range, options.typoConfig);
  }

  const typed = await engine.typeText(value, range);
  return { chars: typed, slips: 0, correctedChars: 0 };
}

module.exports = {
  createCdpTypingDriver,
  typeText,
  keyDescriptor,
  isNamedKey,
  PRINTABLE_CHARACTERS: Object.keys(PRINTABLE),
  NAMED_KEY_NAMES: Object.keys(NAMED_KEYS),
  MODIFIER_SHIFT,
};
