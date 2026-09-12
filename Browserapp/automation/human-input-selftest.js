'use strict';

/**
 * Self-test for the CDP human-like typing adapter.
 * A recording transport stands in for the devtools connection so the exact
 * event sequence can be asserted without a browser.
 */

const assert = require('assert');
const {
  createCdpTypingDriver,
  typeText,
  keyDescriptor,
  isNamedKey,
  PRINTABLE_CHARACTERS,
  NAMED_KEY_NAMES,
} = require('./human-input');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/**
 * Recording transport plus a minimal editable-field model, so assertions can
 * reason about the text the page would actually end up holding rather than the
 * raw stream of key events.
 */
function recorder() {
  const events = [];
  const buf = [];
  let pos = 0;

  function applyKey(params) {
    if (params.type === 'keyDown') {
      if (typeof params.text === 'string' && params.text) {
        for (const ch of params.text) { buf.splice(pos, 0, ch); pos += 1; }
      }
      return;
    }
    if (params.type !== 'rawKeyDown') return;
    switch (params.key) {
      case 'Backspace': if (pos > 0) { buf.splice(pos - 1, 1); pos -= 1; } break;
      case 'Delete': if (pos < buf.length) buf.splice(pos, 1); break;
      case 'ArrowLeft': pos = Math.max(0, pos - 1); break;
      case 'ArrowRight': pos = Math.min(buf.length, pos + 1); break;
      case 'Home': pos = 0; break;
      case 'End': pos = buf.length; break;
      case 'Enter': buf.splice(pos, 0, '\n'); pos += 1; break;
      case 'Tab': buf.splice(pos, 0, '\t'); pos += 1; break;
      default: break;
    }
  }

  return {
    events,
    call: (ws, method, params) => {
      events.push({ method, params });
      if (method === 'Input.insertText') {
        for (const ch of String(params.text || '')) { buf.splice(pos, 0, ch); pos += 1; }
      } else if (method === 'Input.dispatchKeyEvent') {
        applyKey(params);
      }
      return Promise.resolve({});
    },
    value: () => buf.join(''),
    cursor: () => pos,
    names: () => events.map((e) => e.method + ':' + (e.params && e.params.type ? e.params.type : '')),
  };
}

const fast = { sleep: () => Promise.resolve(), randomInt: (min) => min };
const WS = 'ws://test/1';

(async () => {
  // ---- key table ----

  check('every printable ASCII character has a key descriptor', () => {
    for (let code = 32; code <= 126; code += 1) {
      const ch = String.fromCharCode(code);
      assert.ok(keyDescriptor(ch), `missing descriptor for ${JSON.stringify(ch)}`);
    }
    assert.strictEqual(PRINTABLE_CHARACTERS.length, 95);
  });

  check('lowercase letters need no shift and map to their own key code', () => {
    const k = keyDescriptor('a');
    assert.strictEqual(k.vk, 65);
    assert.strictEqual(k.code, 'KeyA');
    assert.strictEqual(k.shift, false);
  });

  check('uppercase letters reuse the letter key with shift held', () => {
    const k = keyDescriptor('Z');
    assert.strictEqual(k.vk, 90);
    assert.strictEqual(k.code, 'KeyZ');
    assert.strictEqual(k.shift, true);
    assert.strictEqual(k.base, 'z');
  });

  check('shifted symbols point at the unshifted physical key', () => {
    assert.deepStrictEqual(
      { vk: keyDescriptor('!').vk, code: keyDescriptor('!').code, base: keyDescriptor('!').base },
      { vk: 49, code: 'Digit1', base: '1' },
    );
    assert.strictEqual(keyDescriptor('!').shift, true);
    assert.strictEqual(keyDescriptor(';').shift, false);
    assert.strictEqual(keyDescriptor(':').shift, true);
  });

  check('digits map to their digit keys without shift', () => {
    const k = keyDescriptor('7');
    assert.strictEqual(k.vk, 55);
    assert.strictEqual(k.code, 'Digit7');
    assert.strictEqual(k.shift, false);
  });

  check('non-ASCII characters have no physical key', () => {
    assert.strictEqual(keyDescriptor('中'), null);
    assert.strictEqual(keyDescriptor('😀'), null);
    assert.strictEqual(keyDescriptor(''), null);
    assert.strictEqual(keyDescriptor(null), null);
  });

  check('named keys cover the editing and navigation set', () => {
    for (const name of ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape',
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      assert.ok(isNamedKey(name), `missing named key ${name}`);
    }
    assert.strictEqual(isNamedKey('F13'), false);
    assert.strictEqual(NAMED_KEY_NAMES.length, 13);
  });

  // ---- driver construction ----

  check('driver rejects a transport without call()', () => {
    assert.throws(() => createCdpTypingDriver(null, WS), /transport/);
    assert.throws(() => createCdpTypingDriver({}, WS), /transport/);
  });

  check('driver rejects a missing socket url', () => {
    assert.throws(() => createCdpTypingDriver({ call: () => {} }, ''), /websocket/);
  });

  // ---- event sequences ----

  await checkAsync('a lowercase character emits keyDown then keyUp', async () => {
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, fast);
    await driver.typeChar('a');
    assert.deepStrictEqual(r.names(), [
      'Input.dispatchKeyEvent:keyDown',
      'Input.dispatchKeyEvent:keyUp',
    ]);
    const down = r.events[0].params;
    assert.strictEqual(down.text, 'a');
    assert.strictEqual(down.unmodifiedText, 'a');
    assert.strictEqual(down.code, 'KeyA');
    assert.strictEqual(down.modifiers, 0);
  });

  await checkAsync('an uppercase character brackets the key with Shift', async () => {
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, fast);
    await driver.typeChar('A');
    assert.deepStrictEqual(r.names(), [
      'Input.dispatchKeyEvent:rawKeyDown',
      'Input.dispatchKeyEvent:keyDown',
      'Input.dispatchKeyEvent:keyUp',
      'Input.dispatchKeyEvent:keyUp',
    ]);
    assert.strictEqual(r.events[0].params.key, 'Shift');
    assert.strictEqual(r.events[0].params.windowsVirtualKeyCode, 16);
    assert.strictEqual(r.events[1].params.modifiers, 8, 'character carries the shift modifier');
    assert.strictEqual(r.events[3].params.key, 'Shift');
    assert.strictEqual(r.events[3].params.modifiers, 0);
  });

  await checkAsync('Shift is released even when the inner dispatch fails', async () => {
    const events = [];
    const call = (ws, method, params) => {
      events.push({ method, params, params2: params.type });
      if (params.type === 'keyDown') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    };
    const driver = createCdpTypingDriver({ call }, WS, fast);
    await assert.rejects(() => driver.typeChar('A'), /boom/);
    const last = events[events.length - 1];
    assert.strictEqual(last.params.key, 'Shift', 'shift keyUp still sent');
    assert.strictEqual(last.params.type, 'keyUp');
  });

  await checkAsync('characters outside ASCII are committed instead of typed', async () => {
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, fast);
    await driver.typeChar('中');
    assert.deepStrictEqual(r.names(), ['Input.insertText:']);
    assert.strictEqual(r.events[0].params.text, '中');
  });

  await checkAsync('named keys are sent as raw key events with a hold time', async () => {
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, fast);
    await driver.pressKey('Backspace', { delay: 40 });
    assert.deepStrictEqual(r.names(), [
      'Input.dispatchKeyEvent:rawKeyDown',
      'Input.dispatchKeyEvent:keyUp',
    ]);
    assert.strictEqual(r.events[0].params.windowsVirtualKeyCode, 8);
    assert.strictEqual(r.events[0].params.text, undefined, 'raw events must not insert text');
  });

  await checkAsync('an unknown named key is rejected', async () => {
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, fast);
    await assert.rejects(() => driver.pressKey('Meta'), /unsupported key/);
  });

  await checkAsync('a physical key is held for a plausible time by default', async () => {
    const waits = [];
    const r = recorder();
    const driver = createCdpTypingDriver(r, WS, {
      sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    });
    await driver.pressKey('Enter');
    const hold = waits.find((ms) => ms > 0);
    assert.ok(hold >= 30 && hold <= 90, `hold time out of range: ${hold}`);
  });

  // ---- text-level entry ----

  await checkAsync('plain typing produces one keyDown and keyUp per character', async () => {
    const r = recorder();
    const stat = await typeText(r, WS, 'ab', Object.assign({ delayRange: [0, 0] }, fast));
    assert.strictEqual(stat.chars, 2);
    assert.strictEqual(stat.slips, 0);
    assert.strictEqual(r.names().filter((n) => n.endsWith('keyDown')).length, 2);
    assert.strictEqual(r.names().filter((n) => n.endsWith('keyUp')).length, 2);
    assert.strictEqual(r.value(), 'ab');
  });

  await checkAsync('delays are drawn per character and stay inside the range', async () => {
    const waits = [];
    const r = recorder();
    await typeText(r, WS, 'abcd', {
      delayRange: [20, 40],
      sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
      randomInt: (min, max) => (min + max) >> 1,
    });
    const interKey = waits.filter((ms) => ms === 30);
    assert.strictEqual(interKey.length, 3, 'the first character is not delayed');
  });

  await checkAsync('the human mode introduces and corrects slips', async () => {
    const r = recorder();
    const stat = await typeText(r, WS, 'thequickbrownfox', {
      human: true,
      delayRange: [0, 0],
      typoConfig: { typoRate: 100, scenario1Threshold: 100, scenario2Threshold: 0 },
      sleep: () => Promise.resolve(),
      randomInt: (min) => min,
    });
    assert.ok(stat.slips > 0, 'a 100% slip rate must produce corrections');
    assert.ok(r.names().includes('Input.dispatchKeyEvent:rawKeyDown'), 'corrections use Backspace');
    assert.strictEqual(r.value(), 'thequickbrownfox', 'the final text still matches the input');
  });

  await checkAsync('the human mode never slips on line breaks', async () => {
    const r = recorder();
    await typeText(r, WS, 'a\nb', {
      human: true,
      delayRange: [0, 0],
      typoConfig: { typoRate: 100, scenario1Threshold: 100, scenario2Threshold: 0 },
      sleep: () => Promise.resolve(),
      randomInt: (min) => min,
    });
    assert.ok(r.names().includes('Input.dispatchKeyEvent:rawKeyDown'), 'Enter stays a raw key');
  });

  await checkAsync('non-ASCII text round-trips through the commit path', async () => {
    const r = recorder();
    await typeText(r, WS, 'a中b', Object.assign({ delayRange: [0, 0] }, fast));
    assert.strictEqual(r.value(), 'a中b');
    assert.ok(r.names().some((n) => n.startsWith('Input.insertText')));
  });

  await checkAsync('empty text dispatches nothing', async () => {
    const r = recorder();
    const stat = await typeText(r, WS, '', fast);
    assert.strictEqual(stat.chars, 0);
    assert.strictEqual(r.events.length, 0);
  });

  await checkAsync('null text is treated as empty rather than crashing', async () => {
    const r = recorder();
    const stat = await typeText(r, WS, null, fast);
    assert.strictEqual(stat.chars, 0);
    assert.strictEqual(r.events.length, 0);
  });

  await checkAsync('clear sends a backspace run before typing', async () => {
    const r = recorder();
    await typeText(r, WS, 'hi', Object.assign({ delayRange: [0, 0], clear: true }, fast));
    const firstTyped = r.events.findIndex((e) => e.params && e.params.text === 'h');
    const cleared = r.events.slice(0, firstTyped).filter((e) => e.params.windowsVirtualKeyCode === 8);
    assert.ok(cleared.length >= 10, `expected a backspace run, saw ${cleared.length}`);
  });

  await checkAsync('observers receive a compact event stream', async () => {
    const seen = [];
    const r = recorder();
    await typeText(r, WS, 'a', Object.assign({ delayRange: [0, 0], onEvent: (e) => seen.push(e) }, fast));
    assert.deepStrictEqual(seen.map((e) => e.type), ['char']);
  });

  await checkAsync('a throwing observer cannot break typing', async () => {
    const r = recorder();
    const stat = await typeText(r, WS, 'ab', Object.assign({
      delayRange: [0, 0],
      onEvent: () => { throw new Error('observer'); },
    }, fast));
    assert.strictEqual(stat.chars, 2);
  });

  await checkAsync('surrogate pairs are never split across events', async () => {
    const r = recorder();
    await typeText(r, WS, '😀', Object.assign({ delayRange: [0, 0] }, fast));
    assert.strictEqual(r.events.length, 1);
    assert.strictEqual(r.events[0].params.text, '😀');
  });

  // ---- report ----
  const passed = results.filter((x) => x.ok).length;
  const failed = results.filter((x) => !x.ok);
  for (const x of results) {
    console.log(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.name}${x.ok ? '' : `  -> ${x.err}`}`);
  }
  console.log(`\nHUMAN_INPUT_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
