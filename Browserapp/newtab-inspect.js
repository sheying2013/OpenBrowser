const path = require('path');
const fs = require('fs/promises');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.join(__dirname, '..', 'newtab-inspect-data'); await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const app = { getPath(name) { if (name === 'userData') return root; throw new Error(name); } }; const engine = new BrowserEngine(app);
  try {
    await engine.init(null); const profile = { id: 'newtab-inspect', name: 'New Tab Inspect', browser: 'Google Chrome', proxy: 'Direct' }; engine.syncProfiles([profile]); const running = await engine.start(profile);
    const tab = await cdp.newTab(running.port, 'chrome://newtab'); await cdp.activateTab(running.port, tab.id); await sleep(1600);
    const expression = `(() => { const walk=(root,out=[])=>{for(const e of root.querySelectorAll('*')){if(e.matches('input,textarea,[contenteditable=true],cr-searchbox,ntp-realbox'))out.push({tag:e.tagName,id:e.id,type:e.getAttribute('type'),editable:e.getAttribute('contenteditable')});if(e.shadowRoot)walk(e.shadowRoot,out);}return out}; return {href:location.href,title:document.title,html:document.documentElement?.outerHTML.length||0,elements:walk(document)}; })()`;
    const inspected = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
    let binding = 'ok'; try { await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.addBinding', { name: 'openBrowserInspect' }); } catch (error) { binding = error.message; }
    process.stdout.write(JSON.stringify({ success: true, result: inspected.result?.value, binding }, null, 2));
  } finally { await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
