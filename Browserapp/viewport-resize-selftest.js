'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserEngine } = require('./engine');
const { getStartPageServer } = require('./automation/start-page-server');
const cdp = require('./cdp');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function viewport(tab) {
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: '({innerWidth,innerHeight,visualWidth:visualViewport.width,visualHeight:visualViewport.height,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight})',
    returnByValue: true,
  });
  return result.result?.value || {};
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-viewport-resize-'));
  const app = { getPath: (name) => (name === 'userData' ? root : '') };
  const engine = new BrowserEngine(app);
  const profile = {
    id: 'viewport-env',
    number: 1,
    name: '1',
    browser: 'Google Chrome',
    networkMode: 'direct',
    proxy: 'Direct',
    privacy: { languageMode: 'real', timezoneMode: 'real', geoMode: 'disabled' },
    advanced: { showInfoPage: false },
    platform: { type: 'blank', startUrl: '' },
  };
  try {
    await engine.init(null);
    engine.syncProfiles([profile]);
    const session = await engine.start(profile);
    const tab = await cdp.firstTab(session.port);
    assert.ok(tab?.webSocketDebuggerUrl, 'browser tab with CDP socket required');

    // Keep the baseline below the smallest Windows logical work area used by
    // the test machine (1280px at 150% scaling reports roughly 836px to
    // Chromium). The second request still exercises the real enlargement path
    // without mistaking OS work-area clamping for a resize regression.
    await cdp.setWindowBounds(session.port, { left: 20, top: 20, width: 640, height: 480 });
    await wait(700);
    const smallBounds = (await cdp.windowForPort(session.port)).bounds;
    const small = await viewport(tab);

    await cdp.setWindowBounds(session.port, { left: 20, top: 20, width: 1320, height: 900 });
    await wait(900);
    const largeBounds = (await cdp.windowForPort(session.port)).bounds;
    const large = await viewport(tab);

    const requestedLarge = { width: 1320, height: 900 };
    const widthDelta = (largeBounds.width || 0) - (smallBounds.width || 0);
    const heightDelta = (largeBounds.height || 0) - (smallBounds.height || 0);
    const viewportWidthDelta = large.innerWidth - small.innerWidth;
    const viewportHeightDelta = large.innerHeight - small.innerHeight;
    const clampedByWorkArea = process.platform === 'win32'
      && ((largeBounds.width || 0) < requestedLarge.width - 100 || (largeBounds.height || 0) < requestedLarge.height - 100);
    if (clampedByWorkArea) {
      // A small Windows/RDP work area can clamp the requested size. The test
      // still requires a real enlargement and a matching page viewport.
      assert.ok(widthDelta > 0 && heightDelta > 0, `browser window did not enlarge before work-area clamp: ${JSON.stringify({ smallBounds, largeBounds })}`);
      assert.ok(viewportWidthDelta > 0 && viewportHeightDelta > 0, `page viewport did not follow clamped resize: ${JSON.stringify({ small, large })}`);
    } else {
      assert.ok(widthDelta > 150, `browser window did not resize: ${JSON.stringify({ smallBounds, largeBounds })}`);
      assert.ok(viewportWidthDelta > 150, `innerWidth did not follow resize: ${JSON.stringify({ small, large })}`);
      assert.ok(viewportHeightDelta > 100, `innerHeight did not follow resize: ${JSON.stringify({ small, large })}`);
    }
    assert.ok(Math.abs(large.innerWidth - large.visualWidth) < 3, `visual viewport is fixed/cropped: ${JSON.stringify(large)}`);
    assert.ok(Math.abs(large.innerWidth - large.clientWidth) < 3, `document viewport does not fill window: ${JSON.stringify(large)}`);

    process.stdout.write(JSON.stringify({ success: true, clampedByWorkArea, smallBounds, largeBounds, small, large }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {});
    await getStartPageServer()?.stop?.().catch(() => {});
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
