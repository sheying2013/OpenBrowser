'use strict';

/** Self-test for per-window generation and stale-event rejection. */

const assert = require('assert');
const {
  WindowGenerationRegistry,
  acceptWindowEvent,
  extractWindowGeneration,
  extractWindowIdentity,
  normalizeWindowKey,
} = require('./protocol/window-generation');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, err: error.message || String(error) }); }
}

check('normalizeWindowKey trims and rejects empty values', () => {
  assert.strictEqual(normalizeWindowKey('  window:7  '), 'window:7');
  assert.strictEqual(normalizeWindowKey(''), '');
  assert.strictEqual(normalizeWindowKey(null), '');
  assert.strictEqual(normalizeWindowKey(undefined), '');
});

check('extractWindowGeneration ignores zero, negative and non-numeric values', () => {
  assert.strictEqual(extractWindowGeneration({ generation: 4 }), 4);
  assert.strictEqual(extractWindowGeneration({ nativeWindowGeneration: '5' }), 5);
  assert.strictEqual(extractWindowGeneration({ windowGeneration: 0 }), 0);
  assert.strictEqual(extractWindowGeneration({ windowGeneration: -2 }), 0);
  assert.strictEqual(extractWindowGeneration({ windowGeneration: 'x' }), 0);
});

check('extractWindowIdentity prefers explicit native window fields', () => {
  assert.strictEqual(extractWindowIdentity({ windowNumber: 42, tabId: 't1' }, 'fallback'), 'window-number:42');
  assert.strictEqual(extractWindowIdentity({ nativeWindowId: 'n7' }, 'fallback'), 'window-id:n7');
  assert.strictEqual(extractWindowIdentity({ tabId: 'ignored' }, 'fallback'), 'fallback');
  assert.strictEqual(extractWindowIdentity({}, 'fallback'), 'fallback');
});

check('generationFor is stable until the key is retired', () => {
  const registry = new WindowGenerationRegistry();
  const first = registry.generationFor('window:1');
  assert.strictEqual(first, 1);
  assert.strictEqual(registry.generationFor('window:1'), first);
  assert.strictEqual(registry.generationFor('window:2'), first + 1);
});

check('forget refuses a mismatched generation and keeps the window live', () => {
  const registry = new WindowGenerationRegistry();
  const generation = registry.generationFor('window:3');
  assert.strictEqual(registry.forget('window:3', generation + 1), false);
  assert.strictEqual(registry.isCurrent('window:3', generation), true);
});

check('forget matching generation retires the key', () => {
  const registry = new WindowGenerationRegistry();
  const generation = registry.generationFor('window:4');
  assert.strictEqual(registry.forget('window:4', generation), true);
  assert.strictEqual(registry.currentGeneration('window:4'), 0);
  assert.strictEqual(registry.retiredGeneration('window:4'), generation);
});

check('reopened window receives a higher generation', () => {
  const registry = new WindowGenerationRegistry();
  const first = registry.generationFor('window:5');
  registry.forget('window:5', first);
  const second = registry.generationFor('window:5');
  assert.ok(second > first, `${second} must be greater than ${first}`);
});

check('stale generation after close is rejected without resurrection', () => {
  const registry = new WindowGenerationRegistry();
  const first = registry.generationFor('window-number:6');
  registry.forget('window-number:6', first);
  const gate = acceptWindowEvent(registry, 'window-number:6', { windowNumber: 6, windowGeneration: first });
  assert.strictEqual(gate.accept, false);
  assert.strictEqual(gate.reason, 'retired-generation');
  assert.strictEqual(registry.currentGeneration('window-number:6'), 0);
});

check('newer generation after close is adopted', () => {
  const registry = new WindowGenerationRegistry();
  const first = registry.generationFor('window-number:7');
  registry.forget('window-number:7', first);
  const next = first + 10;
  const gate = acceptWindowEvent(registry, 'window-number:7', { windowNumber: 7, windowGeneration: next });
  assert.strictEqual(gate.accept, true);
  assert.strictEqual(gate.reason, 'adopted');
  assert.strictEqual(registry.isCurrent('window-number:7', next), true);
});

check('unversioned payload keeps backwards compatibility and allocates once', () => {
  const registry = new WindowGenerationRegistry();
  const first = acceptWindowEvent(registry, 'tab:t1', { type: 'click' });
  const second = acceptWindowEvent(registry, 'tab:t1', { type: 'key' });
  assert.strictEqual(first.accept, true);
  assert.strictEqual(first.reason, 'unversioned');
  assert.strictEqual(second.generation, first.generation);
});

check('live generation mismatch is rejected with the current generation', () => {
  const registry = new WindowGenerationRegistry();
  const current = registry.generationFor('window-number:8');
  const gate = acceptWindowEvent(registry, 'window-number:8', { windowNumber: 8, generation: current + 1 });
  assert.strictEqual(gate.accept, false);
  assert.strictEqual(gate.reason, 'stale-generation');
  assert.strictEqual(gate.generation, current);
});

check('unknown generation can be rejected explicitly', () => {
  const registry = new WindowGenerationRegistry();
  const gate = acceptWindowEvent(registry, 'window-number:9', { windowNumber: 9, windowGeneration: 1 }, { adoptUnknown: false });
  assert.strictEqual(gate.accept, false);
  assert.strictEqual(gate.reason, 'unknown-window');
  assert.strictEqual(registry.currentGeneration('window-number:9'), 0);
});

check('missing identity is rejected', () => {
  const registry = new WindowGenerationRegistry();
  const gate = acceptWindowEvent(registry, '', { type: 'click' });
  assert.strictEqual(gate.accept, false);
  assert.strictEqual(gate.reason, 'missing-window-key');
});

check('snapshot and clear expose deterministic state', () => {
  const registry = new WindowGenerationRegistry();
  const first = registry.generationFor('a');
  registry.forget('a', first);
  const snapshot = registry.snapshot();
  assert.strictEqual(snapshot.current.a, undefined);
  assert.strictEqual(snapshot.retired.a, first);
  assert.strictEqual(snapshot.nextGeneration, first);
  registry.clear();
  assert.deepStrictEqual(registry.snapshot(), { current: {}, retired: {}, nextGeneration: 0 });
});

check('live-sync v5 drops a stale event before synchronization side effects', () => {
  const { LiveSyncController } = require('../live-sync-v5');
  const fake = {
    windowGenerations: new WindowGenerationRegistry(),
    windowKeyGenerations: new Map(),
    tabWindowKeys: new Map(),
    forwardStats: { dropped: 0 },
    events: [],
    emit(event) { this.events.push(event); },
    pauseGeometrySync() { throw new Error('stale event reached side effects'); },
  };
  fake.bindWindowKey = LiveSyncController.prototype.bindWindowKey;
  fake.acceptWindowEvent = LiveSyncController.prototype.acceptWindowEvent;
  fake.enqueueForward = LiveSyncController.prototype.enqueueForward;
  const generation = fake.bindWindowKey('tab-2', 'tab:tab-2');
  assert.strictEqual(fake.acceptWindowEvent('tab-2', { windowNumber: 9, windowGeneration: generation }).accept, true);
  fake.enqueueForward('tab-2', { type: 'click', windowNumber: 9, windowGeneration: generation + 1 });
  assert.strictEqual(fake.forwardStats.dropped, 1);
  assert.strictEqual(fake.events[0].type, 'sync-window-event-dropped');
  assert.strictEqual(fake.events[0].reason, 'stale-generation');
});

check('live-sync v5 scopes native window keys to the tab and retires all of them', () => {
  const { LiveSyncController } = require('../live-sync-v5');
  const fake = {
    windowGenerations: new WindowGenerationRegistry(),
    windowKeyGenerations: new Map(),
    tabWindowKeys: new Map(),
  };
  fake.bindWindowKey = LiveSyncController.prototype.bindWindowKey;
  fake.acceptWindowEvent = LiveSyncController.prototype.acceptWindowEvent;
  fake.forgetWindow = LiveSyncController.prototype.forgetWindow;

  const tabGeneration = fake.bindWindowKey('tab-1', 'tab:tab-1');
  const native = fake.acceptWindowEvent('tab-1', { windowNumber: 42, windowGeneration: tabGeneration });
  assert.strictEqual(native.accept, true);
  assert.strictEqual(native.key, 'tab:tab-1/window-number:42');
  assert.strictEqual(fake.forgetWindow('tab-1'), true);
  assert.strictEqual(fake.acceptWindowEvent('tab-1', { windowNumber: 42, windowGeneration: tabGeneration }).accept, false);
  const replacement = fake.acceptWindowEvent('tab-1', { windowNumber: 42, windowGeneration: tabGeneration + 20 });
  assert.strictEqual(replacement.accept, true);
});

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  if (item.ok) console.log('  PASS  ' + item.name);
  else console.error('  FAIL  ' + item.name + ': ' + item.err);
}
if (failed.length) {
  console.error(`window-generation-selftest: FAIL ${results.length - failed.length}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`window-generation-selftest: OK ${results.length}/${results.length}`);
}
