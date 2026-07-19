const assert = require('assert');
const { LiveSyncController } = require('./live-sync-v5');

const events = [];
const controller = new LiveSyncController({}, (event) => events.push(event));
controller.drainForwardQueue = () => {};

function queued(payload) {
  const before = controller.forwardQueue.length;
  controller.enqueueForward('master-tab', payload);
  return controller.forwardQueue.length > before;
}

controller.updateSettings({ keyboard: false, click: true, scroll: true, track: true });
assert.equal(queued({ type: 'key', phase: 'down' }), false);
assert.equal(queued({ type: 'input', value: '1' }), false);
assert.equal(queued({ type: 'click', x: 1, y: 1 }), true);

controller.forwardQueue.length = 0;
controller.updateSettings({ keyboard: true, click: false, scroll: false, track: false });
assert.equal(queued({ type: 'focus' }), false);
assert.equal(queued({ type: 'mouse', phase: 'move' }), false);
assert.equal(queued({ type: 'wheel', deltaY: 1 }), false);
assert.equal(queued({ type: 'key', phase: 'down' }), true);

const settings = controller.updateSettings({ inputMinMs: 420, inputMaxMs: 120, clickMinMs: -1, clickMaxMs: 99999 });
assert.equal(settings.inputMinMs, 420);
assert.equal(settings.inputMaxMs, 420);
assert.equal(settings.clickMinMs, 0);
assert.equal(settings.clickMaxMs, 5000);
assert(events.some((event) => event.type === 'sync-settings'));

process.stdout.write(JSON.stringify({ success: true, settings, checks: 10 }, null, 2));
