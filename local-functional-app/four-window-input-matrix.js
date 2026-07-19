const http = require('http');
const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page() {
  return `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif;padding:24px;display:grid;gap:18px}input,textarea,[contenteditable]{font:16px sans-serif;padding:10px;border:1px solid #888}</style>
  <input data-role="dynamic" name="dynamic-field" placeholder="dynamic input">
  <input id="controlled" name="controlled" placeholder="controlled input">
  <textarea id="area" name="area" placeholder="textarea"></textarea>
  <div id="editable" contenteditable="true"></div>
  <div id="shadow"></div>
  <iframe id="frame" srcdoc="<input id='frameInput' name='frame-input' placeholder='iframe input' style='font:16px sans-serif;padding:10px;width:80%'>"></iframe>
  <script>
    const dynamic=document.querySelector('[data-role=dynamic]'); dynamic.id='dynamic-'+Math.random().toString(36).slice(2);
    const controlled=document.querySelector('#controlled'); let state=''; controlled.addEventListener('input',event=>{state=event.target.value;controlled.dataset.state=state}); setInterval(()=>{if(controlled.value!==state)controlled.value=state},30);
    const root=document.querySelector('#shadow').attachShadow({mode:'open'}); root.innerHTML='<input id="shadowInput" name="shadow-input" placeholder="shadow input" style="font:16px sans-serif;padding:10px">';
  </script>`;
}

function startServer() {
  return new Promise((resolve) => { const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page()); }); server.listen(0, '127.0.0.1', () => resolve(server)); });
}

async function evaluate(tab, expression) { const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true }); return result.result?.value; }
async function typeText(tab, focusExpression, text) {
  await evaluate(tab, `(() => { const e=${focusExpression}; e.focus(); if('value' in e){const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,'');}else e.textContent=''; e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'deleteContent'})); return true; })()`);
  for (const char of text) { const upper = char.toUpperCase(); const keyCode = upper.charCodeAt(0); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: char, code: /[A-Z]/i.test(char) ? `Key${upper}` : '', text: char, unmodifiedText: char, windowsVirtualKeyCode: keyCode }); await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: char, code: /[A-Z]/i.test(char) ? `Key${upper}` : '', windowsVirtualKeyCode: keyCode }); }
  await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await cdp.call(tab.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(700);
}

async function main() {
  const server = await startServer(); const port = server.address().port; const url = `http://127.0.0.1:${port}/matrix`;
  const root = path.join(__dirname, '..', 'four-window-input-matrix-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' }); const events = []; let sync;
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `input-env-${index + 1}`, name: index ? `Input Slave ${index}` : 'Input Master', browser: 'Google Chrome', proxy: 'Direct' }));
  try {
    await engine.init(null); engine.syncProfiles(profiles); const sessions=[]; for(const profile of profiles)sessions.push(await engine.start(profile));
    const masterTab = await cdp.newTab(sessions[0].port, url); sync = new LiveSyncController(engine, (event) => events.push(event)); await sync.start(profiles.map((profile) => profile.id)); await cdp.activateTab(sessions[0].port, masterTab.id); await sleep(2200);
    const cases = [
      { name:'dynamic', focus:"document.querySelector('[data-role=dynamic]')", read:"document.querySelector('[data-role=dynamic]').value", text:'DYNX', expected:'DYN' },
      { name:'controlled', focus:"document.querySelector('#controlled')", read:"({value:document.querySelector('#controlled').value,state:document.querySelector('#controlled').dataset.state})", text:'CTRLX', expected:{value:'CTRL',state:'CTRL'} },
      { name:'textarea', focus:"document.querySelector('#area')", read:"document.querySelector('#area').value", text:'AREAX', expected:'AREA' },
      { name:'contenteditable', focus:"document.querySelector('#editable')", read:"document.querySelector('#editable').textContent", text:'EDITX', expected:'EDIT' },
      { name:'shadow', focus:"document.querySelector('#shadow').shadowRoot.querySelector('input')", read:"document.querySelector('#shadow').shadowRoot.querySelector('input').value", text:'SHADX', expected:'SHAD' },
      { name:'iframe', focus:"document.querySelector('#frame').contentDocument.querySelector('input')", read:"document.querySelector('#frame').contentDocument.querySelector('input').value", text:'FRAMX', expected:'FRAM' },
    ];
    const results=[];
    for(const test of cases){ await typeText(masterTab,test.focus,test.text); const mapping=sync.tabMap.get(masterTab.id); const values=[await evaluate(masterTab,test.read)]; for(const slave of sync.slaves){ const tab=(await cdp.tabs(slave.port)).find((item)=>item.id===mapping.get(slave.id)); values.push(await evaluate(tab,test.read)); } const pass=values.every((value)=>JSON.stringify(value)===JSON.stringify(test.expected)); if(!pass)throw new Error(`${test.name} failed: ${JSON.stringify(values)}`); results.push({name:test.name,values}); }
    const errors=events.filter((event)=>event.type==='sync-error'||event.type==='sync-disconnected'); if(errors.length)throw new Error('sync errors: '+JSON.stringify(errors));
    process.stdout.write(JSON.stringify({success:true,windows:4,cases:results,errors:0,skippedOverlappingRefreshes:sync.skippedRefreshes},null,2));
  } finally { sync?.stop(); await engine.stopAll().catch(()=>{}); server.close(); await fs.rm(root,{recursive:true,force:true}).catch(()=>{}); }
}
main().catch((error)=>{process.stderr.write(error.stack||error.message);process.exitCode=1});
