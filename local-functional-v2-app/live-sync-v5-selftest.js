const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(tab, expression) { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); return result.result?.value; }
function webTabs(values) { return values.filter((tab) => /^http:\/\/127\.0\.0\.1:/.test(tab.url)); }

async function main() {
  const dataRoot = path.join(__dirname, '..', 'live-sync-v5-selftest-data'); await fs.rm(dataRoot, { recursive: true, force: true }); await fs.mkdir(dataRoot, { recursive: true });
  const server = http.createServer((request, response) => { const page = request.url.includes('tab2') ? 'tab2' : 'tab1'; response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(`<!doctype html><meta charset="utf-8"><title>${page}</title><body data-page="${page}"><h1>${page}</h1><input id="message"><button id="action" data-count="0" onclick="this.dataset.count=String(Number(this.dataset.count)+1)">action</button></body>`); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const app = { getPath(name) { if (name === 'userData') return dataRoot; throw new Error(name); } }; const engine = new BrowserEngine(app); let sync;
  const profiles = [{ id: 'v5-master', name: 'V5 Master', browser: 'Google Chrome', proxy: 'Direct' }, { id: 'v5-slave', name: 'V5 Slave', browser: 'Google Chrome', proxy: 'Direct' }];
  try {
    await engine.init(null); engine.syncProfiles(profiles); const master = await engine.start(profiles[0]); const slave = await engine.start(profiles[1]);
    await Promise.all([cdp.navigate(master.port, origin + '/tab1'), cdp.navigate(slave.port, origin + '/tab1')]); await sleep(900);
    sync = new LiveSyncController(engine, () => {}); await sync.start(profiles.map((item) => item.id));
    const initialMasterTab = webTabs(await cdp.tabs(master.port))[0]; const initialSlaveTab = webTabs(await cdp.tabs(slave.port))[0];
    const marker = { master: await evaluate(initialMasterTab, `Boolean(document.getElementById('openbrowser-master-marker'))`), slave: await evaluate(initialSlaveTab, `Boolean(document.getElementById('openbrowser-master-marker'))`) };
    if (!marker.master || marker.slave) throw new Error('Master marker failed: ' + JSON.stringify(marker));
    const masterTab2 = await cdp.newTab(master.port, origin + '/tab2'); await sleep(2200);
    let slaveTabs = webTabs(await cdp.tabs(slave.port)); const slaveTab1 = slaveTabs.find((tab) => tab.url.endsWith('/tab1')); const slaveTab2 = slaveTabs.find((tab) => tab.url.endsWith('/tab2'));
    if (!slaveTab1 || !slaveTab2 || slaveTabs.length !== 2) throw new Error('New-tab mirror failed: ' + JSON.stringify(slaveTabs));
    await cdp.activateTab(master.port, masterTab2.id); await sleep(1300);
    const visibility = { tab1: await evaluate(slaveTab1, 'document.visibilityState'), tab2: await evaluate(slaveTab2, 'document.visibilityState') };
    if (visibility.tab2 !== 'visible' || visibility.tab1 !== 'hidden') throw new Error('Active-tab mirror failed: ' + JSON.stringify(visibility));
    await evaluate(masterTab2, `message.value='';message.focus();true`);
    for (const [key, code, keyCode] of [['A','KeyA',65],['B','KeyB',66],['C','KeyC',67]]) { await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key, windowsVirtualKeyCode: keyCode }); await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }); }
    await sleep(700); const typed = { tab1: await evaluate(slaveTab1, 'message.value'), tab2: await evaluate(slaveTab2, 'message.value') };
    if (typed.tab2 !== 'ABC' || typed.tab1 !== '') throw new Error('Real keyboard typing failed: ' + JSON.stringify(typed));
    await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await sleep(500);
    const backspace = await evaluate(slaveTab2, 'message.value'); if (backspace !== 'AB') throw new Error('Backspace sync failed: ' + backspace);
    await evaluate(masterTab2, `message.setSelectionRange(0,1);message.dispatchEvent(new Event('select',{bubbles:true}));true`); await sleep(150);
    await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }); await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }); await sleep(500);
    const deleted = await evaluate(slaveTab2, 'message.value'); if (deleted !== 'B') throw new Error('Delete sync failed: ' + deleted);
    const rect = await evaluate(masterTab2, `(() => { const r=action.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 }); await cdp.call(masterTab2.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 }); await sleep(500);
    const mouseCount = await evaluate(slaveTab2, 'action.dataset.count'); if (mouseCount !== '1') throw new Error('Mouse sync failed: ' + mouseCount);
    const values = { tab1: typed.tab1, typed: typed.tab2, backspace, deleted, mouseCount };
    await cdp.closeTab(master.port, masterTab2.id); await sleep(1800); slaveTabs = webTabs(await cdp.tabs(slave.port));
    if (slaveTabs.length !== 1 || !slaveTabs[0].url.endsWith('/tab1')) throw new Error('Close-tab mirror failed: ' + JSON.stringify(slaveTabs));
    const beforeBlank = (await cdp.tabs(slave.port)).length; const masterBlank = await cdp.newTab(master.port, 'chrome://newtab'); await sleep(1600); const duringBlank = (await cdp.tabs(slave.port)).length;
    if (duringBlank !== beforeBlank + 1) throw new Error('Blank-tab open mirror failed: ' + JSON.stringify({ beforeBlank, duringBlank }));
    await cdp.closeTab(master.port, masterBlank.id); await sleep(1600); const afterBlank = (await cdp.tabs(slave.port)).length;
    if (afterBlank !== beforeBlank) throw new Error('Blank-tab close mirror failed: ' + JSON.stringify({ beforeBlank, duringBlank, afterBlank }));
    await cdp.newTab(master.port, origin + '/persist'); await sleep(900); await engine.stop(profiles[0].id); for (let attempt = 0; attempt < 50 && engine.status().some((item) => item.running); attempt += 1) await sleep(200);
    const closedTogether = engine.status().every((item) => !item.running); if (!closedTogether) throw new Error('Master-close cascade failed: ' + JSON.stringify(engine.status()));
    const restarted = await engine.start(profiles[0]); await sleep(700); const resetTabs = await cdp.tabs(restarted.port);
    if (resetTabs.length !== 1 || !resetTabs[0].url.toLowerCase().includes('openbrowser-start.html')) throw new Error('Restart tab reset failed: ' + JSON.stringify(resetTabs));
    process.stdout.write(JSON.stringify({ success: true, browser: master.browser, opened: 2, active: visibility, exactMapping: values, remainingAfterClose: slaveTabs.map((tab) => tab.url), blankLifecycle: { beforeBlank, duringBlank, afterBlank }, marker, closedTogether, restartTabs: resetTabs.map((tab) => tab.url) }, null, 2));
  } finally { sync?.stop(); await engine.stopAll().catch(() => {}); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
