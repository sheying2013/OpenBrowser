const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v4');
const cdp = require('./cdp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evalTab(tab, expression) { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return result.result?.value; }
async function current(port) { const tabs = (await cdp.tabs(port)).filter((tab) => /^http:/.test(tab.url)); return tabs[0]; }

async function main() {
  const dataRoot = path.join(__dirname, '..', 'live-sync-v4-selftest-data'); await fs.rm(dataRoot, { recursive: true, force: true }); await fs.mkdir(dataRoot, { recursive: true });
  const page = `<!doctype html><meta charset="utf-8"><style>body{height:2200px;margin:0;padding:30px;font:18px sans-serif}button,input{font:inherit;margin:10px;padding:12px}</style><input id="message"><button id="counter" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);this.textContent='count:'+this.dataset.count">count:0</button><input id="special"><div style="margin-top:1500px">bottom</div>`;
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  const app = { getPath(name) { if (name === 'userData') return dataRoot; throw new Error(name); } }; const engine = new BrowserEngine(app); let sync;
  const profiles = [{ id: 'v4-master', name: 'V4 Master', browser: 'Microsoft Edge', proxy: 'Direct' }, { id: 'v4-slave', name: 'V4 Slave', browser: 'Microsoft Edge', proxy: 'Direct' }];
  try {
    await engine.init(null); engine.syncProfiles(profiles); const master = await engine.start(profiles[0]); const slave = await engine.start(profiles[1]);
    await Promise.all([cdp.navigate(master.port, url), cdp.navigate(slave.port, url)]); await sleep(900); sync = new LiveSyncController(engine, () => {}); const originalForward = sync.forward.bind(sync); sync.forward = async (tabId, payload) => { process.stderr.write('PAYLOAD ' + JSON.stringify(payload) + '\n'); return originalForward(tabId, payload); }; await sync.start(profiles.map((item) => item.id));
    let masterTab = await current(master.port); let slaveTab = await current(slave.port);
    await evalTab(masterTab, `(() => { const e=document.querySelector('#message'); e.value='KEYBOARD_SYNC'; e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'KEYBOARD_SYNC'})); return true; })()`);
    await evalTab(masterTab, `document.querySelector('#counter').click(); true`);
    await evalTab(masterTab, `scrollTo(0,800); true`); await sleep(750);
    const masterResult = await evalTab(masterTab, `({count:counter.dataset.count||'0',scrollY:Math.round(scrollY)})`); process.stderr.write('MASTER ' + JSON.stringify(masterResult) + '\n');
    const first = await evalTab(slaveTab, `({value:message.value,count:counter.dataset.count||'0',scrollY:Math.round(scrollY)})`);
    if (first.value !== 'KEYBOARD_SYNC' || first.count !== '1' || Math.abs(first.scrollY - 800) > 5) throw new Error('First-tab sync failed: ' + JSON.stringify(first));

    await Promise.all([cdp.newTab(master.port, url), cdp.newTab(slave.port, url)]); await sleep(1300);
    const masterTabs = (await cdp.tabs(master.port)).filter((tab) => tab.url === url); const slaveTabs = (await cdp.tabs(slave.port)).filter((tab) => tab.url === url); masterTab = masterTabs[0]; slaveTab = slaveTabs[0];
    await evalTab(masterTab, `(() => { const e=document.querySelector('#message'); e.value='SECOND_TAB_OK'; e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'SECOND_TAB_OK'})); return true; })()`); await sleep(500);
    const secondValues = await Promise.all(slaveTabs.map((tab) => evalTab(tab, `message.value`)));
    if (!secondValues.includes('SECOND_TAB_OK')) throw new Error('Second-tab sync failed: ' + JSON.stringify(secondValues));
    process.stdout.write(JSON.stringify({ success: true, mouse: first.count, input: first.value, scroll: first.scrollY, multiTab: secondValues }, null, 2));
  } finally { sync?.stop(); await engine.stopAll().catch(() => {}); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
