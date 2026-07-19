const http = require('http');
const path = require('path');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');

const root = path.resolve(__dirname, '..', 'functional-v2-selftest-data');
const fakeApp = { getPath(name) { if (name === 'userData') return root; throw new Error(`Unsupported path: ${name}`); } };
const engine = new BrowserEngine(fakeApp);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>OpenBrowser V2 Selftest</title><input id="text" autofocus><h1>CDP Selftest</h1>');
});

function listen() {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

async function evaluate(port, expression) {
  const tab = await cdp.firstTab(port);
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value;
}

async function main() {
  let results = {};
  try {
    await engine.init(path.join(__dirname, 'bundled-extension'));
    const profiles = [
      { id: 'selftest-chrome', name: 'Selftest Chrome', browser: 'Google Chrome', language: 'en-US', proxy: 'Direct' },
      { id: 'selftest-edge', name: 'Selftest Edge', browser: 'Microsoft Edge', language: 'en-US', proxy: 'Direct' }
    ];
    engine.syncProfiles(profiles);
    const extension = engine.listExtensions()[0];
    await engine.assignExtension(extension.id, profiles.map((item) => item.id), true);
    const started = [];
    for (const profile of profiles) started.push(await engine.start(profile));
    const port = await listen();
    const url = `http://127.0.0.1:${port}/`;
    await Promise.all(started.map((item) => cdp.navigate(item.port, url)));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const extensionMarkers = {};
    const textValues = {};
    for (const item of started) {
      extensionMarkers[item.id] = await evaluate(item.port, "Boolean(document.getElementById('openbrowser-profile-marker'))");
      await evaluate(item.port, "document.getElementById('text').focus(); true");
      await cdp.insertText(item.port, 'SYNC_TEST');
      textValues[item.id] = await evaluate(item.port, "document.getElementById('text').value");
    }
    await cdp.setWindowBounds(started[0].port, { left: 20, top: 20, width: 800, height: 650 });
    await cdp.setWindowBounds(started[1].port, { left: 840, top: 20, width: 800, height: 650 });
    const beforeTabs = (await cdp.tabs(started[1].port)).length;
    await cdp.newTab(started[1].port, url);
    const afterTabs = (await cdp.tabs(started[1].port)).length;
    results = { started, extensionMarkers, textValues, tabManagement: { before: beforeTabs, after: afterTabs }, windowManagement: true, success: Object.values(textValues).every((value) => value === 'SYNC_TEST') && afterTabs === beforeTabs + 1 };
    process.stdout.write(JSON.stringify(results, null, 2));
  } finally {
    await engine.stopAll().catch(() => {});
    server.close();
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
