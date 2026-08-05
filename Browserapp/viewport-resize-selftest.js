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

    await cdp.setWindowBounds(session.port, { left: 20, top: 20, width: 820, height: 640 });
    await wait(700);
    const smallBounds = (await cdp.windowForPort(session.port)).bounds;
    const small = await viewport(tab);

    await cdp.setWindowBounds(session.port, { left: 20, top: 20, width: 1320, height: 900 });
    await wait(900);
    const largeBounds = (await cdp.windowForPort(session.port)).bounds;
    const large = await viewport(tab);

    assert.ok((largeBounds.width || 0) - (smallBounds.width || 0) > 150, `browser window did not resize: ${JSON.stringify({ smallBounds, largeBounds })}`);
    assert.ok(large.innerWidth - small.innerWidth > 150, `innerWidth did not follow resize: ${JSON.stringify({ small, large })}`);
    assert.ok(large.innerHeight - small.innerHeight > 100, `innerHeight did not follow resize: ${JSON.stringify({ small, large })}`);
    assert.ok(Math.abs(large.innerWidth - large.visualWidth) < 3, `visual viewport is fixed/cropped: ${JSON.stringify(large)}`);
    assert.ok(Math.abs(large.innerWidth - large.clientWidth) < 3, `document viewport does not fill window: ${JSON.stringify(large)}`);

    process.stdout.write(JSON.stringify({ success: true, smallBounds, largeBounds, small, large }, null, 2));
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
