'use strict';

/** Self-test for the named window command bus. */

const assert = require('assert');
const {
  WindowCommandBus,
  handlersFromAdapter,
  commandTopic,
  parseTopic,
  COMMANDS,
} = require('./window-command-bus');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Recording adapter covering every command. */
function recordingAdapter(log) {
  return {
    close: (force) => log.push(`close:${force}`),
    minimize: () => log.push('minimize'),
    maximize: () => log.push('maximize'),
    unmaximize: () => log.push('unmaximize'),
    focus: () => log.push('focus'),
    hide: () => log.push('hide'),
    show: () => log.push('show'),
    setResizable: (value) => log.push(`setResizable:${value}`),
  };
}

// ---- topics ----

check('commandTopic joins command and window name', () => {
  assert.strictEqual(commandTopic('close', 'sync-main'), 'close:sync-main');
});

check('parseTopic splits on the first colon so names may contain colons', () => {
  assert.deepStrictEqual(parseTopic('close:sync:main'), { command: 'close', windowName: 'sync:main' });
});

check('parseTopic handles a topic without a separator', () => {
  assert.deepStrictEqual(parseTopic('close'), { command: 'close', windowName: '' });
});

check('every documented command is registered by the full adapter', () => {
  const log = [];
  const handlers = handlersFromAdapter(recordingAdapter(log));
  for (const command of COMMANDS) {
    assert.ok(typeof handlers[command] === 'function', `missing handler for ${command}`);
  }
});

// ---- registration ----

check('register routes commands to the matching window', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  bus.register('console', handlersFromAdapter(recordingAdapter(log)));

  assert.strictEqual(bus.send('main', 'show'), true);
  assert.deepStrictEqual(log, ['show'], 'only the addressed window reacted');
});

check('register replaces an existing registration for the same window', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  assert.strictEqual(bus.size, COMMANDS.length, 'no duplicate handlers accumulated');
  bus.send('main', 'show');
  assert.deepStrictEqual(log, ['show'], 'handler ran exactly once');
});

check('register rejects an empty window name', () => {
  const bus = new WindowCommandBus();
  assert.throws(() => bus.register('', {}), /window name is required/);
});

check('register ignores non-function handler entries', () => {
  const bus = new WindowCommandBus();
  bus.register('main', { show: 'not a function', hide: () => {} });
  assert.strictEqual(bus.size, 1);
  assert.strictEqual(bus.has('main', 'hide'), true);
  assert.strictEqual(bus.has('main', 'show'), false);
});

check('the detach function removes only that window', () => {
  const log = [];
  const bus = new WindowCommandBus();
  const detach = bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  bus.register('other', handlersFromAdapter(recordingAdapter(log)));
  detach();
  assert.strictEqual(bus.send('main', 'show'), false);
  assert.strictEqual(bus.send('other', 'show'), true, 'sibling window unaffected');
});

check('unregister reports how many handlers were removed', () => {
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter([])));
  assert.strictEqual(bus.unregister('main'), COMMANDS.length);
  assert.strictEqual(bus.unregister('main'), 0, 'second call is a no-op');
});

// ---- single handlers ----

check('on attaches one command without disturbing the others', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  let extra = 0;
  bus.on('main', 'focus', () => { extra += 1; });

  bus.send('main', 'focus');
  assert.strictEqual(extra, 1, 'replacement handler ran');
  assert.deepStrictEqual(log, [], 'the original focus handler was replaced, not stacked');
});

check('on can target a window that has no handlers yet', () => {
  const bus = new WindowCommandBus();
  let called = 0;
  bus.on('fresh', 'show', () => { called += 1; });
  assert.strictEqual(bus.send('fresh', 'show'), true);
  assert.strictEqual(called, 1);
});

check('the handler from on can be detached individually', () => {
  const bus = new WindowCommandBus();
  let called = 0;
  const off = bus.on('main', 'show', () => { called += 1; });
  bus.on('main', 'hide', () => { called += 1; });
  off();
  assert.strictEqual(bus.send('main', 'show'), false);
  assert.strictEqual(bus.send('main', 'hide'), true, 'sibling command still attached');
  assert.strictEqual(called, 1);
  assert.strictEqual(bus.names().length, 1, 'window entry retained while other commands remain');
});

check('on rejects a non-function handler', () => {
  const bus = new WindowCommandBus();
  assert.throws(() => bus.on('main', 'show', null), /handler must be a function/);
});

// ---- dispatch ----

check('send returns false for an unknown window or command', () => {
  const bus = new WindowCommandBus();
  bus.register('main', { show: () => {} });
  assert.strictEqual(bus.send('ghost', 'show'), false);
  assert.strictEqual(bus.send('main', 'maximize'), false);
});

check('dispatch routes by topic', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('sync:main', handlersFromAdapter(recordingAdapter(log)));
  assert.strictEqual(bus.dispatch('close:sync:main', { force: true }), true);
  assert.deepStrictEqual(log, ['close:true']);
});

check('close forwards the force flag', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  bus.send('main', 'close');
  bus.send('main', 'close', { force: true });
  assert.deepStrictEqual(log, ['close:false', 'close:true']);
});

check('setResizable coerces its payload to a boolean', () => {
  const log = [];
  const bus = new WindowCommandBus();
  bus.register('main', handlersFromAdapter(recordingAdapter(log)));
  bus.send('main', 'setResizable', 1);
  bus.send('main', 'setResizable', 0);
  bus.send('main', 'setResizable');
  assert.deepStrictEqual(log, ['setResizable:true', 'setResizable:false', 'setResizable:false']);
});

// ---- introspection ----

check('names lists registered windows', () => {
  const bus = new WindowCommandBus();
  bus.register('a', { show: () => {} });
  bus.register('b', { show: () => {} });
  assert.deepStrictEqual(bus.names().sort(), ['a', 'b']);
});

check('size counts all attached handlers', () => {
  const bus = new WindowCommandBus();
  bus.register('a', { show: () => {}, hide: () => {} });
  bus.register('b', { show: () => {} });
  assert.strictEqual(bus.size, 3);
});

check('clear detaches everything and reports the count', () => {
  const bus = new WindowCommandBus();
  bus.register('a', { show: () => {} });
  bus.register('b', { show: () => {} });
  assert.strictEqual(bus.clear(), 2);
  assert.strictEqual(bus.size, 0);
  assert.deepStrictEqual(bus.names(), []);
});

// ---- adapter mapping ----

check('handlersFromAdapter omits capabilities the window lacks', () => {
  const handlers = handlersFromAdapter({ show: () => {}, hide: () => {} });
  assert.deepStrictEqual(Object.keys(handlers).sort(), ['hide', 'show']);
});

check('handlersFromAdapter on an empty adapter yields nothing', () => {
  assert.deepStrictEqual(handlersFromAdapter({}), {});
  assert.deepStrictEqual(handlersFromAdapter(), {});
});

check('handlersFromAdapter ignores non-function properties', () => {
  const handlers = handlersFromAdapter({ show: () => {}, minimize: 'nope' });
  assert.deepStrictEqual(Object.keys(handlers), ['show']);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nWINDOW_COMMAND_BUS_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
