const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(port, expression) {
  const tab = await cdp.firstTab(port);
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value;
}

async function main() {
  const dataRoot = path.join(__dirname, '..', 'live-sync-selftest-data');
  await fs.mkdir(dataRoot, { recursive: true });
  const page = `<!doctype html><meta charset="utf-8"><style>body{height:2400px;margin:0;padding:30px;font:18px sans-serif}button,input{font:inherit;margin:10px;padding:10px}</style><input id="message"><button id="counter" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1);this.textContent='count:'+this.dataset.count">count:0</button><div style="margin-top:1600px">bottom</div>`;
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const app = { getPath(name) { if (name === 'userData') return dataRoot; throw new Error(`Unexpected path: ${name}`); } };
  const engine = new BrowserEngine(app);
  const profiles = [
    { id: 'live-master', name: 'Live Master', browser: 'Microsoft Edge', proxy: 'Direct', language: 'zh-CN' },
    { id: 'live-slave', name: 'Live Slave', browser: 'Microsoft Edge', proxy: 'Direct', language: 'zh-CN' }
  ];
  let controller;
  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const master = await engine.start(profiles[0]);
    const slave = await engine.start(profiles[1]);
    if (!master.port || !slave.port) throw new Error('CDP ports unavailable');
    await Promise.all([cdp.navigate(master.port, url), cdp.navigate(slave.port, url)]);
    await sleep(900);
    controller = new LiveSyncController(engine, () => {});
    const originalForward = controller.forward.bind(controller);
    controller.forward = async (payload) => { process.stderr.write('PAYLOAD ' + JSON.stringify(payload) + '\n'); return originalForward(payload); };
    await controller.start(profiles.map((item) => item.id));

    await evaluate(master.port, `(() => { const e=document.querySelector('#message'); e.value='REAL_SYNC_OK'; e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'REAL_SYNC_OK',inputType:'insertText'})); return true; })()`);
    await sleep(350);
    const rect = await evaluate(master.port, `(() => { const r=document.querySelector('#counter').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const masterTab = await cdp.firstTab(master.port);
    await evaluate(master.port, `document.querySelector('#counter').click(); true`);
    await evaluate(master.port, `scrollTo(0,900); dispatchEvent(new Event('scroll')); true`);
    await sleep(650);

    const result = await evaluate(slave.port, `({value:document.querySelector('#message').value,count:document.querySelector('#counter').dataset.count||'0',scrollY:Math.round(scrollY)})`);
    if (result.value !== 'REAL_SYNC_OK') throw new Error(`Input sync failed: ${JSON.stringify(result)}`);
    if (result.count !== '1') throw new Error(`Click sync failed: ${JSON.stringify(result)}`);
    if (Math.abs(result.scrollY - 900) > 5) throw new Error(`Scroll sync failed: ${JSON.stringify(result)}`);
    process.stdout.write(JSON.stringify({ success: true, masterPort: master.port, slavePort: slave.port, result }, null, 2));
  } finally {
    controller?.stop();
    await engine.stopAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
