const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const focusScript = `(() => {
  const inputs=[];
  const walk=(root)=>{for(const element of root.querySelectorAll('*')){if(element.matches('input:not([type=hidden]),textarea,[contenteditable=true]'))inputs.push(element);if(element.shadowRoot)walk(element.shadowRoot);}};
  walk(document);
  const target=inputs.find((element)=>element.type==='search')||inputs.find((element)=>element.type==='text')||inputs[0];
  if(!target)return false;
  target.focus();
  if('value' in target)target.value='';else target.textContent='';
  target.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:''}));
  return true;
})()`;
const readScript = `(() => {
  const inputs=[];
  const walk=(root)=>{for(const element of root.querySelectorAll('*')){if(element.matches('input:not([type=hidden]),textarea,[contenteditable=true]'))inputs.push(element);if(element.shadowRoot)walk(element.shadowRoot);}};
  walk(document);
  const target=inputs.find((element)=>element.type==='search')||inputs.find((element)=>element.type==='text')||inputs[0];
  return target ? ('value' in target ? String(target.value) : String(target.textContent || '')) : null;
})()`;
async function evaluate(tab, expression) {
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value;
}

async function main() {
  const root = path.join(__dirname, '..', 'specified-text-four-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const app = { getPath(name) { if (name === 'userData') return root; throw new Error(name); } };
  const engine = new BrowserEngine(app);
  const profiles = Array.from({ length: 4 }, (_unused, index) => ({ id: 'specified-' + (index + 1), number: index + 1, name: String(index + 1), browser: 'Google Chrome', proxy: 'Direct' }));
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const running = [];
    for (const profile of profiles) running.push(await engine.start(profile));
    const tabs = [];
    for (const item of running) {
      const tab = await cdp.newTab(item.port, 'chrome://newtab');
      await cdp.activateTab(item.port, tab.id); tabs.push(tab);
    }
    await sleep(1800);
    for (const tab of tabs) if (!await evaluate(tab, focusScript)) throw new Error('Focused input not found for ' + tab.id);
    const writes = [];
    for (let index = 0; index < running.length; index += 1) writes.push(await cdp.insertText(running[index].port, String(index + 1)));
    const values = [];
    for (const tab of tabs) values.push(await evaluate(tab, readScript));
    const expected = ['1', '2', '3', '4'];
    if (JSON.stringify(values) !== JSON.stringify(expected)) throw new Error('Specified text mismatch: ' + JSON.stringify({ expected, values }));
    process.stdout.write(JSON.stringify({ success: true, expected, values, verifiedTargets: writes.map((item) => item.targetId) }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });