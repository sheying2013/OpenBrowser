#!/usr/bin/env node
const assert = require('assert');
const { LiveSyncController } = require('./live-sync-v5');
const { LiveSyncController: LiveSyncV4, injection } = require('./live-sync-v4');
const cdp = require('./cdp');

async function testPickerAndMenuProtection() {
  const events = [];
  const engine = { running: new Map(), profiles: new Map(), on: () => () => {}, stop: async () => {} };
  const controller = new LiveSyncController(engine, (event) => events.push(event));

  // 1. Check injection includes change event listener
  assert.ok(injection.includes("document.addEventListener('change'"), 'injection must listen for change events');

  // 2. Test surface blur gives 4000ms grace period for browser menus
  controller.geometryPausedUntil = 0;
  controller.browserOwnedUntil = 0;
  controller.enqueueForward('master-tab', { type: 'surface', focused: false, visible: true });
  assert.ok(controller.browserOwnedUntil >= Date.now() + 3800, 'surface blur must grant ~4000ms protection for external menus');
  assert.ok(controller.geometryPausedUntil >= Date.now() + 3800, 'surface blur must pause geometry sync for ~4000ms');

  // 3. Test picker interactions (select, date, etc.) pause geometry even when click sync is disabled
  controller.syncSettings.click = false;
  controller.geometryPausedUntil = 0;
  controller.browserOwnedUntil = 0;
  controller.enqueueForward('master-tab', { type: 'mouse', phase: 'down', tag: 'select' });
  assert.ok(controller.browserOwnedUntil >= Date.now() + 3800, 'select mousedown must grant 4000ms protection');
  assert.ok(controller.geometryPausedUntil >= Date.now() + 3800, 'select mousedown must pause geometry sync');

  controller.geometryPausedUntil = 0;
  controller.browserOwnedUntil = 0;
  controller.enqueueForward('master-tab', { type: 'click', tag: 'input', elementType: 'date' });
  assert.ok(controller.browserOwnedUntil >= Date.now() + 3800, 'date picker click must grant 4000ms protection');
  controller.syncSettings.click = true;

  // 4. Test hasBrowserOwnedInteraction returns true for unfocused surface
  controller.connections.set('master-tab', {
    tab: { id: 'master-tab' },
    connection: {
      command: async () => ({ result: { value: { focused: false, picker: false } } }),
      close() {},
    },
  });
  controller.activeMasterTab = 'master-tab';
  controller.browserOwnedUntil = 0;
  const unfocusedResult = await controller.hasBrowserOwnedInteraction();
  assert.strictEqual(unfocusedResult, true, 'unfocused surface must report browser owned interaction');
  assert.ok(controller.browserOwnedUntil >= Date.now() + 3300, 'unfocused surface must refresh browserOwnedUntil');

  // 5. Test hasBrowserOwnedInteraction returns true when pickerOpen is true
  controller.connections.get('master-tab').connection.command = async () => ({
    result: { value: { focused: true, picker: true, pickerOpen: true } },
  });
  controller.browserOwnedUntil = 0;
  const pickerOpenResult = await controller.hasBrowserOwnedInteraction();
  assert.strictEqual(pickerOpenResult, true, 'open picker must report browser owned interaction');
  assert.ok(controller.browserOwnedUntil >= Date.now() + 3800, 'open picker must refresh browserOwnedUntil to 4000ms');

  // 6. Test hasBrowserOwnedInteraction returns false when picker is closed and grace period expired
  controller.connections.get('master-tab').connection.command = async () => ({
    result: { value: { focused: true, picker: true, pickerOpen: false } },
  });
  controller.browserOwnedUntil = Date.now() - 1;
  const closedPickerResult = await controller.hasBrowserOwnedInteraction();
  assert.strictEqual(closedPickerResult, false, 'closed picker after grace period must return false');

  // 7. Test v4 forward handles 'change' event
  const v4Calls = [];
  const originalCall = cdp.call;
  const originalTabs = cdp.tabs;
  try {
    cdp.call = async (wsUrl, method, params) => {
      v4Calls.push({ wsUrl, method, params });
      return {};
    };
    cdp.tabs = async (port) => [
      { id: 's-tab', url: 'about:blank', webSocketDebuggerUrl: 'ws://s1/s-tab' }
    ];
    const v4 = new LiveSyncV4(engine, () => {});
    v4.master = { port: 100 };
    v4.slaves = [{ id: 's1', port: 101 }];
    v4.tabMap = new Map([['m-tab', new Map([['s1', 's-tab']]) ]]);
    v4.connections = new Map([
      ['m-tab', { tab: { id: 'm-tab' } }],
      ['s-tab', { tab: { id: 's-tab', webSocketDebuggerUrl: 'ws://s1/s-tab' } }],
    ]);
    await v4.forward('m-tab', {
      type: 'change',
      selector: '#test-select',
      value: 'option2',
      selectedIndex: 1,
    });
    assert.strictEqual(v4Calls.length, 1, 'v4 forward must execute evaluate for change event');
    assert.strictEqual(v4Calls[0].method, 'Runtime.evaluate');
    assert.ok(v4Calls[0].params.expression.includes('selectedIndex'), 'expression must update selectedIndex');
    assert.ok(v4Calls[0].params.expression.includes('dispatchEvent'), 'expression must dispatch change event');
  } finally {
    cdp.call = originalCall;
    cdp.tabs = originalTabs;
  }

  controller.stop();
  console.log('POPUP_PICKER_SELFTEST_OK');
}

testPickerAndMenuProtection().catch((err) => {
  console.error('POPUP_PICKER_SELFTEST_FAIL:', err);
  process.exit(1);
});
