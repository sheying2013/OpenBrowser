const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function factor(tab) {
  const metrics = await cdp.call(tab.webSocketDebuggerUrl, 'Page.getLayoutMetrics');
  const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  return (Number(viewport.scale) || 1) * (Number(viewport.zoom) || 1);
}

async function factors(tabs) {
  return Promise.all(tabs.map(factor));
}

function assertNear(values, expected, label) {
  if (values.some((value) => Math.abs(value - expected) > 0.015)) {
    throw new Error(`${label}: expected ${expected}, got ${JSON.stringify(values)}`);
  }
}

async function main() {
  const root = path.join(__dirname, '..', 'zoom-reconcile-4-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const app = { getPath: (name) => (name === 'userData' ? root : '') };
  const engine = new BrowserEngine(app);
  let sync;
  const profiles = Array.from({ length: 4 }, (_, index) => ({
    id: `zoom-env-${index + 1}`,
    name: index === 0 ? 'Zoom Master' : `Zoom Slave ${index}`,
    browser: 'Google Chrome',
    proxy: 'Direct',
  }));

  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const sessions = [];
    const tabs = [];
    for (const profile of profiles) {
      const session = await engine.start(profile);
      sessions.push(session);
      tabs.push(await cdp.newTab(session.port, 'chrome://newtab'));
    }

    sync = new LiveSyncController(engine, () => {});
    await sync.start(profiles.map((profile) => profile.id));
    await cdp.activateTab(sessions[0].port, tabs[0].id);
    await sleep(2200);

    // Simulate three independently/randomly zoomed controlled environments.
    const random = [2, 0.5, 1.6];
    await Promise.all(tabs.slice(1).map((tab, index) => cdp.call(
      tab.webSocketDebuggerUrl,
      'Emulation.setPageScaleFactor',
      { pageScaleFactor: random[index] },
    )));
    const disturbed = await factors(tabs);
    await sleep(2200);
    const continuouslyCorrected = await factors(tabs);
    assertNear(continuouslyCorrected, 1, 'continuous correction while master stays at 100% failed');

    await cdp.call(tabs[0].webSocketDebuggerUrl, 'Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
    await sleep(2200);
    const zoom125 = await factors(tabs);
    assertNear(zoom125, 1.25, 'master 125% propagation failed');

    await cdp.call(tabs[2].webSocketDebuggerUrl, 'Emulation.setPageScaleFactor', { pageScaleFactor: 2.4 });
    await sleep(2200);
    const correctedWhile125 = await factors(tabs);
    assertNear(correctedWhile125, 1.25, 'slave drift correction at unchanged 125% failed');

    // Ctrl+0 equivalent: master returns to 100%, every slave must follow.
    await cdp.call(tabs[0].webSocketDebuggerUrl, 'Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await sleep(2200);
    const ctrl0 = await factors(tabs);
    assertNear(ctrl0, 1, 'Ctrl+0 reset propagation failed');

    process.stdout.write(JSON.stringify({
      success: true,
      windows: 4,
      disturbed,
      continuouslyCorrected,
      zoom125,
      correctedWhile125,
      ctrl0,
    }, null, 2));
  } finally {
    sync?.stop();
    await engine.stopAll().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
