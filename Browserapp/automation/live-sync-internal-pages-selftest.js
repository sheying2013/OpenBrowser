#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  LiveSyncController,
  isNavigableInternalUrl,
  isDangerousOrBlockedInternalUrl,
  canMirrorTabUrl,
  canDomLiveSyncTabUrl,
  ALLOWED_INTERNAL_PAGES,
  ALLOWED_INTERNAL_HOSTS,
  BLOCKED_INTERNAL_HOSTS,
  BLOCKED_INTERNAL_SCHEMES,
} = require('../live-sync-v5');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log('Starting Live-Sync Internal Pages Degradation Selftest...\n');

  // 1. 白名单完整性验证（19 项）
  check('ALLOWED_INTERNAL_HOSTS contains exactly 19 hosts matching main.js', () => {
    const expected = [
      'extensions', 'settings', 'downloads', 'history', 'version',
      'bookmarks', 'flags', 'about', 'chrome-urls', 'gpu',
      'newtab', 'new-tab-page', 'management', 'system', 'components',
      'policy', 'credits', 'terms', 'favorites'
    ];
    assert.strictEqual(ALLOWED_INTERNAL_HOSTS.size, 19, `Expected 19 hosts, got ${ALLOWED_INTERNAL_HOSTS.size}`);
    for (const host of expected) {
      assert.ok(ALLOWED_INTERNAL_HOSTS.has(host), `Missing host in ALLOWED_INTERNAL_HOSTS: ${host}`);
      assert.ok(ALLOWED_INTERNAL_PAGES.test(`chrome://${host}`), `ALLOWED_INTERNAL_PAGES failed to match chrome://${host}`);
      assert.ok(ALLOWED_INTERNAL_PAGES.test(`edge://${host}`), `ALLOWED_INTERNAL_PAGES failed to match edge://${host}`);
      assert.ok(isNavigableInternalUrl(`chrome://${host}`), `isNavigableInternalUrl rejected chrome://${host}`);
      assert.ok(isNavigableInternalUrl(`edge://${host}/`), `isNavigableInternalUrl rejected edge://${host}/`);
    }
  });

  // 2. 危险 URL 拦截验证
  check('Blocked and dangerous URLs are rejected from mirroring', () => {
    const dangerous = [
      'chrome://crash',
      'chrome://kill',
      'chrome://hang',
      'chrome://inspect',
      'javascript:alert(1)',
      'data:text/html,<h1>bad</h1>',
      'file:///etc/passwd',
      'chrome-devtools://devtools/bundled/inspector.html',
    ];
    for (const url of dangerous) {
      assert.ok(isDangerousOrBlockedInternalUrl(url), `Should be blocked: ${url}`);
      assert.strictEqual(canMirrorTabUrl(url), false, `canMirrorTabUrl should reject: ${url}`);
      assert.strictEqual(canDomLiveSyncTabUrl(url), false, `canDomLiveSyncTabUrl should reject: ${url}`);
    }
  });

  // 3. 特权分离规则验证：内部页只允许镜像 URL，严格禁止 DOM live-sync
  check('Privilege separation: internal pages are mirror-only (canMirrorTabUrl true, canDomLiveSyncTabUrl false)', () => {
    const internalUrls = [
      'chrome://settings',
      'chrome://extensions',
      'chrome://downloads',
      'chrome://gpu',
      'chrome://flags',
      'chrome://management',
      'edge://settings',
      'edge://system',
      'edge://components',
    ];
    for (const url of internalUrls) {
      assert.strictEqual(canMirrorTabUrl(url), true, `Internal url should be mirrorable: ${url}`);
      assert.strictEqual(canDomLiveSyncTabUrl(url), false, `Internal url must NOT be DOM-sync eligible: ${url}`);
    }

    // 普通网页既允许镜像，也允许 DOM live-sync
    const normalUrls = [
      'https://example.com',
      'http://127.0.0.1:8080/app',
      'about:blank',
    ];
    for (const url of normalUrls) {
      assert.strictEqual(canMirrorTabUrl(url), true, `Normal url should be mirrorable: ${url}`);
      assert.strictEqual(canDomLiveSyncTabUrl(url), true, `Normal url must be DOM-sync eligible: ${url}`);
    }
  });

  // 4. LiveSyncController.attach 对特权内部页不得注入任何脚本、不得调用 Runtime.addBinding
  await checkAsync('LiveSyncController.attach strictly skips privileged internal pages', async () => {
    const mockEngine = {
      running: new Map([
        ['m1', { port: 9222, profile: { number: 1 } }],
        ['s1', { port: 9223, profile: { number: 2 } }],
      ]),
      on: () => () => {},
    };
    const controller = new LiveSyncController(mockEngine, () => {});
    controller.master = { id: 'm1', item: { port: 9222 } };
    controller.slaves = [{ id: 's1', port: 9223 }];

    let connectionCreated = false;
    const privilegedTab = {
      id: 'tab-settings',
      url: 'chrome://settings',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-settings',
    };

    await controller.attach(privilegedTab);
    assert.strictEqual(controller.connections.has('tab-settings'), false, 'Privileged tab must not be added to connections');
  });

  // 5. markSlave 对特权内部页不得注入 environmentMarker 脚本
  await checkAsync('LiveSyncController.markSlave strictly skips privileged internal pages', async () => {
    const mockEngine = {
      running: new Map([
        ['s1', { port: 9223, profile: { number: 2 } }],
      ]),
    };
    const controller = new LiveSyncController(mockEngine, () => {});
    let cdpCallCount = 0;
    const origCdpCall = require('../cdp').call;
    require('../cdp').call = async () => {
      cdpCallCount += 1;
      return {};
    };

    try {
      const slaveInternalTab = {
        id: 'slave-ext',
        url: 'chrome://extensions',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/slave-ext',
      };
      await controller.markSlave(slaveInternalTab, 's1');
      assert.strictEqual(cdpCallCount, 0, 'cdp.call must not be invoked for internal pages in markSlave');
    } finally {
      require('../cdp').call = origCdpCall;
    }
  });

  // 6. refreshMasterTabs 在 tab 变成内部页时断开连接与清理
  await checkAsync('refreshMasterTabs cleans up connections when tab navigates to internal page', async () => {
    const mockEngine = {
      running: new Map([
        ['m1', { port: 9222, profile: { number: 1 }, item: { port: 9222 } }],
        ['s1', { port: 9223, profile: { number: 2 }, port: 9223 }],
      ]),
      on: () => () => {},
    };
    const controller = new LiveSyncController(mockEngine, () => {});
    controller.master = { id: 'm1', item: { port: 9222 } };
    controller.slaves = [{ id: 's1', port: 9223 }];

    let closed = false;
    controller.connections.set('tab-1', {
      tab: { id: 'tab-1', url: 'https://example.com' },
      connection: {
        socket: { readyState: 1 },
        close: () => { closed = true; },
      },
      scroll: { x: 0, y: 0 },
    });

    const origTargets = require('../cdp').targets;
    require('../cdp').targets = async (port) => {
      if (port === 9222) {
        return [{ id: 'tab-1', type: 'page', url: 'chrome://gpu' }];
      }
      return [{ id: 'slave-tab-1', type: 'page', url: 'chrome://gpu' }];
    };

    try {
      await controller.refreshMasterTabs();
      assert.strictEqual(closed, true, 'Existing connection must be closed when navigating to chrome://gpu');
      assert.strictEqual(controller.connections.has('tab-1'), false, 'Connection must be removed from connections map');
    } finally {
      require('../cdp').targets = origTargets;
    }
  });

  // 7. forward 与 enqueueForward 阻断内部页事件
  await checkAsync('forward and enqueueForward block DOM events on internal pages', async () => {
    const mockEngine = { running: new Map(), on: () => () => {} };
    const controller = new LiveSyncController(mockEngine, () => {});
    controller.syncGeneration = 1;
    controller.syncSession = { generation: 1 };
    controller.masterTabs = [{ id: 'tab-settings', url: 'chrome://settings' }];

    let superForwardCalled = false;
    controller.planProtocolFanout = () => ({ skip: false, delayMs: 0 });
    // Spy on parent forward
    const originalForward = Object.getPrototypeOf(LiveSyncController.prototype).forward;
    Object.getPrototypeOf(LiveSyncController.prototype).forward = async () => {
      superForwardCalled = true;
    };

    try {
      await controller.forward('tab-settings', { type: 'click', x: 10, y: 10 });
      assert.strictEqual(superForwardCalled, false, 'super.forward must NOT be called for internal page');

      controller.enqueueForward('tab-settings', { type: 'click', x: 10, y: 10 });
      assert.strictEqual(controller.forwardQueue.length, 0, 'enqueueForward must not push events for internal page');
    } finally {
      Object.getPrototypeOf(LiveSyncController.prototype).forward = originalForward;
    }
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n======================================================================`);
  console.log(`live-sync-internal-pages-selftest: OK ${passed}/${results.length}${failed ? ` (FAILED: ${failed})` : ''}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
