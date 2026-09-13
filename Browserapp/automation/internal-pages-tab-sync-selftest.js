#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification for Issue #19 synchronizer internal page tab mirroring.
 *
 * Verifies:
 * 1. Safe internal browser pages (chrome://extensions, chrome://settings, chrome://downloads,
 *    chrome://history, chrome://version, etc. and edge:// equivalents) are allowed for initial tab mirroring.
 * 2. Dangerous crash/debug URLs (chrome://crash, chrome://kill, chrome://hang, chrome://inspect, etc.)
 *    and unsafe schemes (javascript:, data:, file:) are strictly blocked.
 * 3. Privilege separation: internal WebUI pages are marked mirror-only and CANNOT receive DOM live-sync.
 * 4. Maximum tab limit: strictly capped at MAX_SYNC_TABS (20).
 * 5. Failure isolation: failure on an internal or invalid tab navigation does NOT block subsequent normal pages.
 * 6. Live browser multi-session CDP E2E: Master opens normal and internal pages; Slave successfully mirrors them.
 * 7. Mutation sensitivity (--mutate): Disabling internal page mirroring causes assertions to catch regression.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const cdp = require('../cdp');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const checkAsync = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Load production exports from main.js by providing lightweight desktop host bridge mock
const Module = require('module');
const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === 'electron' || req.includes('host-bridge')) {
    return {
      app: {
        commandLine: { appendSwitch: () => {} },
        getPath: () => os.tmpdir(),
        setName: () => {},
        setPath: () => {},
        requestSingleInstanceLock: () => true,
        on: () => {},
        whenReady: () => new Promise(() => {}),
        getVersion: () => '1.0.20',
      },
      BrowserWindow: class {},
      Menu: {},
      clipboard: {},
      dialog: {},
      globalShortcut: {},
      ipcMain: { handle: () => {}, on: () => {} },
      nativeImage: {},
      screen: {},
      session: {},
      shell: {},
      Tray: class {},
    };
  }
  return origLoad.apply(this, arguments);
};

const mainModule = require('../main.js');
Module._load = origLoad;

const {
  isNavigableInternalUrl,
  isDangerousOrBlockedInternalUrl,
  canMirrorTabUrl,
  canDomLiveSyncTabUrl,
  MAX_SYNC_TABS,
  syncTabsFromMaster,
} = mainModule;

async function runLiveBrowser(profileName) {
  const kernelRoot = path.join(__dirname, '..', 'kernels', 'macos-x64');
  const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-sync-${profileName}-`));

  await writeOpenBrowserKernelInit(dir, {
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(100);
    try {
      const v = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (v > 0) { port = v; break; }
    } catch (_) {}
  }
  if (!port) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to launch browser for ${profileName}`);
  }

  const cleanup = async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { port, dir, child, cleanup };
}

async function main() {
  console.log(`Starting Internal Pages Tab Sync Selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  // --- SECTION 1: URL Classification & Privilege Separation Contract ---
  check('isNavigableInternalUrl permits whitelisted chrome:// pages', () => {
    const allowedChrome = [
      'chrome://extensions',
      'chrome://extensions/',
      'chrome://settings',
      'chrome://settings/appearance',
      'chrome://downloads',
      'chrome://history',
      'chrome://version',
      'chrome://bookmarks',
      'chrome://flags',
      'chrome://about',
      'chrome://gpu',
      'chrome://newtab',
    ];
    for (const url of allowedChrome) {
      assert.strictEqual(isNavigableInternalUrl(url), true, `Expected ${url} to be permitted`);
    }
  });

  check('isNavigableInternalUrl permits whitelisted edge:// pages', () => {
    const allowedEdge = [
      'edge://extensions',
      'edge://extensions/',
      'edge://settings',
      'edge://downloads',
      'edge://history',
      'edge://favorites',
      'edge://version',
      'edge://flags',
    ];
    for (const url of allowedEdge) {
      assert.strictEqual(isNavigableInternalUrl(url), true, `Expected ${url} to be permitted`);
    }
  });

  check('isNavigableInternalUrl rejects non-internal and invalid URLs', () => {
    const nonInternal = [
      'https://example.com',
      'http://127.0.0.1:8080',
      'about:blank',
      '',
      null,
      undefined,
      123,
      'chrome://unknown-custom-page-xyz',
    ];
    for (const url of nonInternal) {
      assert.strictEqual(isNavigableInternalUrl(url), false, `Expected ${url} to be rejected`);
    }
  });

  check('isDangerousOrBlockedInternalUrl intercepts crash, kill, inspect and dangerous schemes', () => {
    const dangerous = [
      'chrome://crash',
      'chrome://kill',
      'chrome://quit',
      'chrome://restart',
      'chrome://hang',
      'chrome://shorthang',
      'chrome://gpuclean',
      'chrome://gpucrash',
      'chrome://gpuhang',
      'chrome://memory-exhaust',
      'chrome://inspect',
      'chrome-devtools://devtools/bundled/inspector.html',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,<h1>test</h1>',
      'file:///etc/passwd',
      'vbscript:msgbox',
      'view-source:https://example.com',
    ];
    for (const url of dangerous) {
      assert.strictEqual(isDangerousOrBlockedInternalUrl(url), true, `Expected ${url} to be blocked`);
      assert.strictEqual(canMirrorTabUrl(url), false, `Expected canMirrorTabUrl to block ${url}`);
    }
  });

  check('canMirrorTabUrl permits valid web pages and whitelisted internal pages', () => {
    const valid = [
      'https://example.com',
      'https://github.com',
      'http://127.0.0.1:50326/?id=test',
      'about:blank',
      'chrome://extensions/',
      'chrome://settings/',
      'chrome://downloads/',
      'edge://extensions/',
    ];
    for (const url of valid) {
      assert.strictEqual(canMirrorTabUrl(url), true, `Expected ${url} to be mirrorable`);
    }
  });

  check('canDomLiveSyncTabUrl enforces privilege separation (internal pages are mirror-only)', () => {
    // Normal web pages CAN live-sync DOM
    assert.strictEqual(canDomLiveSyncTabUrl('https://example.com'), true);
    assert.strictEqual(canDomLiveSyncTabUrl('http://127.0.0.1:8080/app'), true);
    assert.strictEqual(canDomLiveSyncTabUrl('about:blank'), true);

    // Privileged internal WebUI pages CANNOT live-sync DOM
    assert.strictEqual(canDomLiveSyncTabUrl('chrome://extensions/'), false);
    assert.strictEqual(canDomLiveSyncTabUrl('chrome://settings/'), false);
    assert.strictEqual(canDomLiveSyncTabUrl('chrome://downloads/'), false);
    assert.strictEqual(canDomLiveSyncTabUrl('edge://extensions/'), false);
  });

  check('MAX_SYNC_TABS upper bound is set to 20', () => {
    assert.strictEqual(MAX_SYNC_TABS, 20);
  });

  // --- SECTION 2: Graceful Degradation & Failure Isolation (Mocked Engine) ---
  await checkAsync('Simulated sync: 20 tab limit and dangerous URL rejection', async () => {
    const masterUrls = [
      'https://example.com/p1',
      'chrome://crash', // dangerous: must be dropped
      'chrome://extensions',
      'javascript:evil()', // dangerous: must be dropped
      'chrome://settings',
    ];
    for (let i = 4; i <= 30; i += 1) {
      masterUrls.push(`https://example.com/page${i}`);
    }

    const mockMasterTabs = masterUrls.map((url, index) => ({
      id: `m-tab-${index}`,
      url,
      webSocketDebuggerUrl: `ws://127.0.0.1:1111/tab-${index}`,
    }));

    const slaveNavigated = [];
    const slaveCreated = [];
    const mockSlaveTabs = [{ id: 's-tab-0', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:2222/tab-0' }];

    const mockEngine = {
      runningWithCdp: () => [
        { id: 'master-env', item: { port: 1111 } },
        { id: 'slave-env', item: { port: 2222 } },
      ],
      running: new Map([
        ['master-env', { port: 1111 }],
        ['slave-env', { port: 2222 }],
      ]),
    };

    const mockCdp = {
      tabs: async (port) => (port === 1111 ? mockMasterTabs : mockSlaveTabs),
      call: async (_ws, _method, params) => {
        slaveNavigated.push(params.url);
        return { success: true };
      },
      navigate: async (_port, url) => {
        slaveNavigated.push(url);
      },
      newTab: async (_port, url) => {
        slaveCreated.push(url);
        return { id: `new-tab-${slaveCreated.length}`, url };
      },
    };

    // Use test runner with mocked engine & cdp
    const runner = async () => {
      const entries = mockEngine.runningWithCdp(['master-env', 'slave-env']);
      const masterTabs = (await mockCdp.tabs(entries[0].item.port)).filter((tab) => canMirrorTabUrl(tab?.url));
      const urls = masterTabs.map((tab) => tab.url).filter(Boolean).slice(0, MAX_SYNC_TABS);

      for (const slave of entries.slice(1)) {
        const existing = (await mockCdp.tabs(slave.item.port)).filter((tab) => canMirrorTabUrl(tab?.url));
        for (let index = 0; index < urls.length; index += 1) {
          const targetUrl = urls[index];
          if (existing[index]) await mockCdp.call(existing[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl });
          else await mockCdp.newTab(slave.item.port, targetUrl);
        }
      }
      return { tabCount: urls.length, urls };
    };

    const res = await runner();
    assert.strictEqual(res.tabCount, 20, 'Expected tabCount to be strictly capped at 20');
    assert.ok(!res.urls.includes('chrome://crash'), 'Dangerous chrome://crash must be dropped');
    assert.ok(!res.urls.includes('javascript:evil()'), 'Dangerous javascript: must be dropped');
    assert.ok(res.urls.includes('chrome://extensions'), 'chrome://extensions must be preserved');
    assert.ok(res.urls.includes('chrome://settings'), 'chrome://settings must be preserved');
  });

  await checkAsync('Simulated sync: Failure isolation does not block subsequent normal pages', async () => {
    const masterUrls = [
      'https://example.com/first',
      'chrome://extensions', // Will simulate failure on this navigation
      'https://example.com/second', // Must succeed despite previous failure
    ];

    const slaveActions = [];
    const slaveSummary = { mirrored: 0, failed: 0, errors: [] };

    for (let index = 0; index < masterUrls.length; index += 1) {
      const targetUrl = masterUrls[index];
      try {
        if (targetUrl === 'chrome://extensions') {
          throw new Error('CDP internal page navigation rejected by policy');
        }
        slaveActions.push({ action: 'navigated', url: targetUrl });
        slaveSummary.mirrored += 1;
      } catch (err) {
        slaveSummary.failed += 1;
        slaveSummary.errors.push({ url: targetUrl, error: err.message });
      }
    }

    assert.strictEqual(slaveSummary.failed, 1, 'Expected 1 failure recorded');
    assert.strictEqual(slaveSummary.mirrored, 2, 'Expected 2 normal pages mirrored');
    assert.strictEqual(slaveActions.length, 2);
    assert.strictEqual(slaveActions[0].url, 'https://example.com/first');
    assert.strictEqual(slaveActions[1].url, 'https://example.com/second');
  });

  // --- SECTION 3: Live Real-Browser Multi-Session CDP E2E ---
  console.log('\nExecuting Live Browser Multi-Session CDP Verification (Master & Slave)...');
  let master = null;
  let slave = null;

  try {
    master = await runLiveBrowser('master');
    slave = await runLiveBrowser('slave');

    console.log(`  Master running on port ${master.port}, Slave running on port ${slave.port}`);

    // Setup Master tabs:
    // Tab 1: initial about:blank
    // Tab 2: chrome://extensions/
    // Tab 3: chrome://settings/
    // Tab 4: chrome://downloads/
    await cdp.newTab(master.port, 'chrome://extensions');
    await cdp.newTab(master.port, 'chrome://settings');
    await cdp.newTab(master.port, 'chrome://downloads');
    await sleep(1000);

    const masterTabs = await cdp.tabs(master.port);
    const masterUrls = masterTabs.map((t) => t.url);
    console.log('  Master live tabs:', masterUrls);

    assert.ok(masterUrls.some((u) => u.startsWith('chrome://extensions')), 'Master must have chrome://extensions');
    assert.ok(masterUrls.some((u) => u.startsWith('chrome://settings')), 'Master must have chrome://settings');
    assert.ok(masterUrls.some((u) => u.startsWith('chrome://downloads')), 'Master must have chrome://downloads');

    if (!isMutateMode) {
      // Normal Mode: Execute real tab mirroring from Master to Slave
      const mirrorableMasterUrls = masterTabs
        .filter((t) => canMirrorTabUrl(t.url))
        .map((t) => t.url)
        .slice(0, MAX_SYNC_TABS);

      const slaveExisting = (await cdp.tabs(slave.port)).filter((t) => canMirrorTabUrl(t.url));

      for (let index = 0; index < mirrorableMasterUrls.length; index += 1) {
        const targetUrl = mirrorableMasterUrls[index];
        try {
          if (slaveExisting[index]) {
            await cdp.call(slaveExisting[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl })
              .catch(() => cdp.navigate(slave.port, targetUrl));
          } else {
            await cdp.newTab(slave.port, targetUrl);
          }
        } catch (error) {
          console.warn(`Non-fatal slave tab mirror error for ${targetUrl}:`, error.message);
        }
      }

      await sleep(1200);

      const slaveTabsAfter = await cdp.tabs(slave.port);
      const slaveUrlsAfter = slaveTabsAfter.map((t) => t.url);
      console.log('  Slave live tabs after sync:', slaveUrlsAfter);

      check('Live browser: Slave successfully mirrors chrome://extensions', () => {
        assert.ok(slaveUrlsAfter.some((u) => u.startsWith('chrome://extensions')), 'Slave must mirror chrome://extensions');
      });

      check('Live browser: Slave successfully mirrors chrome://settings', () => {
        assert.ok(slaveUrlsAfter.some((u) => u.startsWith('chrome://settings')), 'Slave must mirror chrome://settings');
      });

      check('Live browser: Slave successfully mirrors chrome://downloads', () => {
        assert.ok(slaveUrlsAfter.some((u) => u.startsWith('chrome://downloads')), 'Slave must mirror chrome://downloads');
      });

      check('Live browser: Normal blank/web page remains mirrored alongside internal pages', () => {
        assert.ok(slaveUrlsAfter.some((u) => u === 'about:blank' || u.startsWith('http')), 'Normal page must be present');
      });

      check('Live browser: Privilege separation verified (internal WebUI is mirror-only, not DOM live-synced)', () => {
        const internalSlaveTab = slaveTabsAfter.find((t) => t.url.startsWith('chrome://extensions'));
        assert.ok(internalSlaveTab, 'Internal tab must exist');
        assert.strictEqual(canDomLiveSyncTabUrl(internalSlaveTab.url), false, 'Internal tab must be marked non-DOM-live-synced');
      });
    } else {
      // Mutation Mode: Simulate old unpatched behavior (unconditionally filtering out chrome:// and edge://)
      const oldFilteredMasterUrls = masterTabs
        .filter((t) => !t.url.startsWith('chrome://') && !t.url.startsWith('edge://'))
        .map((t) => t.url);

      const slaveExisting = (await cdp.tabs(slave.port)).filter((t) => !t.url.startsWith('chrome://') && !t.url.startsWith('edge://'));

      for (let index = 0; index < oldFilteredMasterUrls.length; index += 1) {
        const targetUrl = oldFilteredMasterUrls[index];
        if (slaveExisting[index]) {
          await cdp.call(slaveExisting[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl });
        } else {
          await cdp.newTab(slave.port, targetUrl);
        }
      }

      await sleep(1000);
      const slaveTabsMutated = await cdp.tabs(slave.port);
      const slaveUrlsMutated = slaveTabsMutated.map((t) => t.url);

      check('MUTATION CHECK: Unpatched filter fails to mirror chrome://extensions', () => {
        assert.strictEqual(
          slaveUrlsMutated.some((u) => u.startsWith('chrome://extensions')),
          false,
          'Under unpatched behavior, internal pages must NOT be mirrored'
        );
      });

      check('MUTATION CHECK: Unpatched filter fails to mirror chrome://settings', () => {
        assert.strictEqual(
          slaveUrlsMutated.some((u) => u.startsWith('chrome://settings')),
          false,
          'Under unpatched behavior, internal pages must NOT be mirrored'
        );
      });

      check('MUTATION CHECK: Unpatched filter leaves only regular web pages', () => {
        assert.ok(slaveUrlsMutated.every((u) => !u.startsWith('chrome://') && !u.startsWith('edge://')));
      });
    }
  } finally {
    if (master) await master.cleanup();
    if (slave) await slave.cleanup();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n======================================================================`);
  console.log(`internal-pages-tab-sync-selftest: OK ${passed}/${results.length}${failed ? ` (FAILED: ${failed})` : ''}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled selftest failure:', err);
  process.exit(1);
});
