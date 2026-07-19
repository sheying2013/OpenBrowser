const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(tab, expression) { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); return result.result?.value; }
const deepScript = `(() => { const all=[]; const walk=(root)=>{for(const e of root.querySelectorAll('*')){if(e.matches('input,textarea'))all.push(e);if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);const preferred=all.find(e=>e.type==='search')||all.find(e=>e.type==='text')||all[0];return {values:all.map(e=>({type:e.type,value:e.value,placeholder:e.placeholder})),preferred:preferred?.value||'',marker:document.getElementById('openbrowser-environment-marker')?.textContent||'',master:Boolean(document.getElementById('openbrowser-master-marker'))};})()`;
const focusScript = `(() => { const all=[]; const walk=(root)=>{for(const e of root.querySelectorAll('*')){if(e.matches('input,textarea'))all.push(e);if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);const e=all.find(e=>e.type==='search')||all.find(e=>e.type==='text')||all[0];if(!e)return false;e.focus();e.value='';e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:''}));return true;})()`;

async function main() {
  const root = path.join(__dirname, '..', 'newtab-sync-selftest-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const app = { getPath(name) { if (name === 'userData') return root; throw new Error(name); } }; const engine = new BrowserEngine(app); let sync;
  const profiles = [{ id: 'env-701', name: 'NewTab Master', browser: 'Google Chrome', proxy: 'Direct' }, { id: 'env-702', name: 'NewTab Slave', browser: 'Google Chrome', proxy: 'Direct' }];
  try {
    await engine.init(null); engine.syncProfiles(profiles); const master = await engine.start(profiles[0]); const slave = await engine.start(profiles[1]);
    const masterTab = await cdp.newTab(master.port, 'chrome://newtab'); const slaveTab = await cdp.newTab(slave.port, 'chrome://newtab'); await cdp.activateTab(master.port, masterTab.id); await cdp.activateTab(slave.port, slaveTab.id); await sleep(1600);
    sync = new LiveSyncController(engine, () => {}); await sync.start(profiles.map((item) => item.id)); await cdp.activateTab(master.port, masterTab.id); await sleep(1500);
    const focused = await evaluate(masterTab, focusScript); if (!focused) throw new Error('Master new-tab search input not found');
    for (const key of ['1','1','1']) { await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'Digit1', text: key, unmodifiedText: key, windowsVirtualKeyCode: 49 }); await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Digit1', windowsVirtualKeyCode: 49 }); }
    await sleep(900); const typed = { master: await evaluate(masterTab, deepScript), slave: await evaluate(slaveTab, deepScript) };
    await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await cdp.call(masterTab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(700); const deleted = { master: await evaluate(masterTab, deepScript), slave: await evaluate(slaveTab, deepScript) };
    if (typed.master.preferred !== '111' || typed.slave.preferred !== '111') throw new Error('New-tab 111 sync failed: ' + JSON.stringify(typed));
    if (deleted.master.preferred !== '11' || deleted.slave.preferred !== '11') throw new Error('New-tab Backspace sync failed: ' + JSON.stringify(deleted));
    if (!typed.master.marker.includes('env-701') || !typed.slave.marker.includes('env-702')) throw new Error('Environment number marker failed: ' + JSON.stringify(typed));
    process.stdout.write(JSON.stringify({ success: true, typed: { master: typed.master.preferred, slave: typed.slave.preferred }, deleted: { master: deleted.master.preferred, slave: deleted.slave.preferred }, markers: { master: typed.master.marker, slave: typed.slave.marker }, masterBadge: typed.master.master }, null, 2));
  } finally { sync?.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
