'use strict';

/**
 * Self-test for human-like typing.
 *
 * Runs fully offline. A small text-buffer driver replays every keystroke so
 * the final text can be compared against the intended input — this proves
 * that each correction style leaves the field in the right state.
 */

const assert = require('assert');
const {
  createTypingEngine,
  ADJACENT_KEYS,
  DEFAULT_TYPO_CONFIG,
  normalizeDelayRange,
  delayRangeFromSettings,
  parseTypoConfig,
  normalizeText,
  isTypoEligible,
} = require('./human-typing');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Text field simulator: tracks content plus a caret index. */
function createBufferDriver() {
  let text = '';
  let caret = 0;
  const log = [];
  return {
    async typeChar(ch) {
      text = text.slice(0, caret) + ch + text.slice(caret);
      caret += ch.length;
      log.push({ op: 'type', ch });
    },
    async pressKey(key) {
      log.push({ op: 'key', key });
      if (key === 'Backspace') {
        if (caret > 0) {
          text = text.slice(0, caret - 1) + text.slice(caret);
          caret -= 1;
        }
      } else if (key === 'Delete') {
        if (caret < text.length) {
          text = text.slice(0, caret) + text.slice(caret + 1);
        }
      } else if (key === 'ArrowLeft') {
        if (caret > 0) caret -= 1;
      } else if (key === 'ArrowRight') {
        if (caret < text.length) caret += 1;
      }
    },
    async flush() {},
    get text() { return text; },
    get caret() { return caret; },
    get log() { return log.slice(); },
  };
}

/** Deterministic engine options: fixed randomness, instant sleeps. */
function deterministic(seq) {
  let i = 0;
  return {
    randomInt: () => {
      const v = seq[i % seq.length];
      i += 1;
      return v;
    },
    sleep: async () => {},
  };
}

(async () => {
  // ---- tables & constants ----
  check('adjacent-key table is complete', () => {
    const keys = Object.keys(ADJACENT_KEYS);
    assert.strictEqual(keys.length, 48, `expected 48 entries, got ${keys.length}`);
    for (const ch of ['a', 'z', 'q', 'm', '1', '0', ' ', ';', "'", '[', ']', ',', '.', '/', '-', '=', '`']) {
      assert.ok(ADJACENT_KEYS[ch], `missing neighbours for ${JSON.stringify(ch)}`);
      assert.ok(ADJACENT_KEYS[ch].length > 0, `empty neighbours for ${JSON.stringify(ch)}`);
    }
  });

  check('space neighbours model thumb slips', () => {
    assert.deepStrictEqual(ADJACENT_KEYS[' '], ['c', 'v', 'b', 'n', 'm']);
  });

  check('default typo config is percentage based', () => {
    assert.deepStrictEqual(DEFAULT_TYPO_CONFIG, {
      typoRate: 5, scenario1Threshold: 60, scenario2Threshold: 25, scenario2BackspaceRate: 80,
    });
  });

  // ---- delay handling ----
  check('normalizeDelayRange clamps and orders bounds', () => {
    assert.deepStrictEqual(normalizeDelayRange([100, 500]), [100, 500]);
    assert.deepStrictEqual(normalizeDelayRange([500, 100]), [100, 500]);
    assert.deepStrictEqual(normalizeDelayRange(250), [250, 250]);
    assert.deepStrictEqual(normalizeDelayRange([1, 99999]), [10, 10000]);
    assert.deepStrictEqual(normalizeDelayRange(null), [100, 500]);
  });

  check('delayRangeFromSettings handles a single value and a range', () => {
    assert.deepStrictEqual(delayRangeFromSettings({}), [100, 500]);
    assert.deepStrictEqual(delayRangeFromSettings({ simulateInputDelay: 300 }), [300, 300]);
    assert.deepStrictEqual(
      delayRangeFromSettings({ simulateInputDelay: 200, simulateInputDelayMax: 800 }),
      [200, 800]
    );
    assert.deepStrictEqual(
      delayRangeFromSettings({ simulateInputDelay: 900, simulateInputDelayMax: 100 }),
      [900, 900]
    );
  });

  check('parseTypoConfig falls back on invalid values', () => {
    assert.deepStrictEqual(parseTypoConfig(null), DEFAULT_TYPO_CONFIG);
    assert.strictEqual(parseTypoConfig({ typoRate: 200 }).typoRate, 5);
    assert.strictEqual(parseTypoConfig({ typoRate: -1 }).typoRate, 5);
    assert.strictEqual(parseTypoConfig({ typoRate: 33 }).typoRate, 33);
    assert.strictEqual(parseTypoConfig({ scenario1Threshold: 'nope' }).scenario1Threshold, 60);
  });

  // ---- text normalization ----
  check('normalizeText collapses CRLF and lone CR', () => {
    assert.strictEqual(normalizeText('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  });

  check('isTypoEligible excludes line breaks, tabs and surrogate pairs', () => {
    assert.strictEqual(isTypoEligible('a'), true);
    assert.strictEqual(isTypoEligible('\n'), false);
    assert.strictEqual(isTypoEligible('\t'), false);
    assert.strictEqual(isTypoEligible('😀'), false);
  });

  // ---- plain typing ----
  await checkAsync('typeText types every character in order', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, deterministic([100]));
    const count = await engine.typeText('hello world', [100, 200]);
    assert.strictEqual(count, 11);
    assert.strictEqual(driver.text, 'hello world');
  });

  await checkAsync('typeText handles unicode code points', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, deterministic([50]));
    await engine.typeText('a😀b', [50, 50]);
    assert.strictEqual(driver.text, 'a😀b');
  });

  // ---- no-slip / all-slip boundaries ----
  await checkAsync('typoRate 0 never slips and reproduces the input', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, deterministic([1]));
    const stats = await engine.simulateType('the quick brown fox', [50, 80], {
      typoRate: 0, scenario1Threshold: 60, scenario2Threshold: 25, scenario2BackspaceRate: 80,
    });
    assert.strictEqual(stats.slips, 0);
    assert.strictEqual(driver.text, 'the quick brown fox');
  });

  await checkAsync('typoRate 100 always slips and still reproduces the input', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min, max) => min,
      sleep: async () => {},
      pickWrongChar: () => 'z',
    });
    const stats = await engine.simulateType('abcdefgh', [50, 50], {
      typoRate: 100, scenario1Threshold: 100, scenario2Threshold: 0, scenario2BackspaceRate: 100,
    });
    assert.strictEqual(stats.slips, 8, 'one slip per character');
    assert.strictEqual(driver.text, 'abcdefgh', 'corrections restore the exact text');
  });

  // ---- each correction style, verified by replay ----
  await checkAsync('scenario 1 corrects a single adjacent slip', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      pickWrongChar: (ch) => (ch === 'a' ? 's' : ch),
    });
    const events = [];
    const engine2 = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      pickWrongChar: (ch) => (ch === 'a' ? 's' : ch),
      onEvent: (e) => events.push(e),
    });
    void engine;
    await engine2.simulateType('abc', [50, 50], {
      typoRate: 100, scenario1Threshold: 100, scenario2Threshold: 0, scenario2BackspaceRate: 100,
    });
    assert.strictEqual(driver.text, 'abc');
    assert.ok(events.every((e) => e.scenario === 1), 'all events report scenario 1');
    assert.ok(driver.log.some((l) => l.op === 'key' && l.key === 'Backspace'), 'used Backspace');
  });

  await checkAsync('scenario 2 backspace corrects a run of slips', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      pickWrongChar: () => 'q',
    });
    const events = [];
    const engine2 = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      pickWrongChar: () => 'q',
      onEvent: (e) => events.push(e),
    });
    void engine;
    await engine2.simulateType('abcdef', [50, 50], {
      typoRate: 100, scenario1Threshold: 0, scenario2Threshold: 100, scenario2BackspaceRate: 100,
    });
    assert.strictEqual(driver.text, 'abcdef');
    assert.ok(events.some((e) => e.scenario === 2 && e.mode === 'backspace'), 'backspace mode used');
    assert.ok(events.every((e) => e.span >= 2), 'each run covers 2+ characters');
  });

  await checkAsync('scenario 2 cursor path uses ArrowLeft + Delete', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      pickWrongChar: () => 'q',
    });
    await engine.simulateType('abcdef', [50, 50], {
      typoRate: 100, scenario1Threshold: 0, scenario2Threshold: 100, scenario2BackspaceRate: 0,
    });
    assert.strictEqual(driver.text, 'abcdef', 'text restored via caret navigation');
    assert.ok(driver.log.some((l) => l.op === 'key' && l.key === 'ArrowLeft'), 'used ArrowLeft');
    assert.ok(driver.log.some((l) => l.op === 'key' && l.key === 'Delete'), 'used Delete');
  });

  await checkAsync('scenario 3 corrects a double strike', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
    });
    const events = [];
    const engine2 = createTypingEngine(driver, {
      randomInt: (min) => min,
      sleep: async () => {},
      onEvent: (e) => events.push(e),
    });
    void engine;
    await engine2.simulateType('xyz', [50, 50], {
      typoRate: 100, scenario1Threshold: 0, scenario2Threshold: 0, scenario2BackspaceRate: 100,
    });
    assert.strictEqual(driver.text, 'xyz');
    assert.ok(events.every((e) => e.scenario === 3), 'scenario 3 used throughout');
  });

  // ---- stress: random configurations must never corrupt text ----
  await checkAsync('randomised runs always reproduce the intended text', async () => {
    const samples = [
      'Hello World',
      'user@example.com',
      'P@ssw0rd!2026',
      'The quick brown fox jumps over the lazy dog.',
      '订单编号：AB-12345',
      'line one\nline two',
      'a[1] + b{2} - c(3)',
      "don't stop; keep going",
    ];
    for (let run = 0; run < 40; run += 1) {
      const driver = createBufferDriver();
      const engine = createTypingEngine(driver, {
        randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
        sleep: async () => {},
      });
      const text = samples[run % samples.length];
      const stats = await engine.simulateType(text, [10, 40], {
        typoRate: 40, scenario1Threshold: 40, scenario2Threshold: 35, scenario2BackspaceRate: 50,
      });
      assert.strictEqual(driver.text, normalizeText(text), `run ${run} corrupted output`);
      assert.ok(stats.slips >= 0);
    }
  });

  await checkAsync('stats report character and slip counts', async () => {
    const driver = createBufferDriver();
    const engine = createTypingEngine(driver, {
      randomInt: (min) => min, sleep: async () => {},
    });
    const stats = await engine.simulateType('abcdef', [20, 20], {
      typoRate: 100, scenario1Threshold: 100, scenario2Threshold: 0, scenario2BackspaceRate: 100,
    });
    assert.strictEqual(stats.chars, 6);
    assert.strictEqual(stats.slips, 6);
    assert.strictEqual(stats.correctedChars, 6);
  });

  await checkAsync('rejects an invalid driver', async () => {
    assert.throws(() => createTypingEngine(null), /driver with typeChar/);
    assert.throws(() => createTypingEngine({ typeChar: async () => {} }), /driver with typeChar/);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nHUMAN_TYPING_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
