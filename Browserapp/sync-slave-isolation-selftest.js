'use strict';

// One dead slave must not desync the whole session.
//
// refreshMasterTabs fetches every slave's targets in parallel. When that batch was a bare
// Promise.all, a single closed environment (ECONNREFUSED) rejected the whole pass; the tick
// wrapper hands that to handleWatchError, which treats a refused connection as a dead debug
// port and stops the ENTIRE sync session. Closing one of ten synced windows therefore killed
// sync for the other nine. These checks pin the isolation down.

const assert = require('assert');
const cdp = require('./cdp');
const { LiveSyncController } = require('./live-sync-v5.js');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

const MASTER_PORT = 9001;
const GOOD_SLAVE_PORT = 9002;
const DEAD_SLAVE_PORT = 9003;

function makeController() {
  const controller = Object.create(LiveSyncController.prototype);
  controller.events = [];
  controller.emit = (value) => controller.events.push(value);
  controller.engine = { running: new Map(), on: () => () => {} };
  controller.master = { id: 'master', item: { port: MASTER_PORT } };
  controller.slaves = [
    { id: 'good', port: GOOD_SLAVE_PORT },
    { id: 'dead', port: DEAD_SLAVE_PORT },
  ];
  controller.connections = new Map();
  controller.extensionConnections = new Map();
  controller.tabMap = new Map();
  controller.extensionMap = new Map();
  controller.masterTabs = [];
  controller.tickCount = 1; // not a heavy tick: skip extension/geometry work
  controller.mappingReady = false;
  // Neutralize the downstream steps; this test is about surviving the slave fetch.
  controller.ensureMapping = async () => {};
  controller.reconcileSlaveTabs = async () => {};
  controller.attach = async () => {};
  controller.closeMappedTabs = async () => {};
  return controller;
}

const page = (id, url) => ({ id, type: 'page', url, title: id, webSocketDebuggerUrl: `ws://127.0.0.1/${id}` });

(async () => {
  const originalTargets = cdp.targets;
  cdp.targets = async (port) => {
    if (port === DEAD_SLAVE_PORT) {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:' + port);
      error.code = 'ECONNREFUSED';
      throw error;
    }
    return [page('t1', 'https://example.com/')];
  };

  try {
    // --- a dead slave does not abort the pass ---
    {
      const controller = makeController();
      let threw = null;
      try { await controller.refreshMasterTabs(); } catch (error) { threw = error; }
      ok('pass completes despite an unreachable slave', threw === null);
      ok('reachable slave still processed (mapping stage reached)', controller.mappingReady === true);
      ok('master tabs still refreshed', controller.masterTabs.length === 1);
      const reported = controller.events.filter((e) => e.type === 'sync-slave-unreachable');
      ok('unreachable slave is reported once', reported.length === 1 && reported[0].id === 'dead');
    }

    // --- repeated ticks do not spam the same slave ---
    {
      const controller = makeController();
      await controller.refreshMasterTabs();
      await controller.refreshMasterTabs();
      await controller.refreshMasterTabs();
      const reported = controller.events.filter((e) => e.type === 'sync-slave-unreachable');
      ok('a permanently dead slave is throttled, not spammed', reported.length === 1);
    }

    // --- master failure still propagates (must keep stopping the session) ---
    {
      const controller = makeController();
      controller.master = { id: 'master', item: { port: 9999 } };
      cdp.targets = async (port) => {
        if (port === 9999) throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
        return [page('t1', 'https://example.com/')];
      };
      let threw = null;
      try { await controller.refreshMasterTabs(); } catch (error) { threw = error; }
      ok('an unreachable master still throws (session stop path intact)', threw !== null && /ECONNREFUSED/.test(threw.message));
    }
  } finally {
    cdp.targets = originalTargets;
  }

  console.log(`\nsync-slave-isolation-selftest: ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('sync-slave-isolation-selftest FAILED:', e); process.exit(1); });
