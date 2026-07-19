const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true }); let out = ''; let err = '';
    child.stdout.on('data', (value) => { out += value; }); child.stderr.on('data', (value) => { err += value; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || out || `devtools driver exited ${code}`)));
  });
}

async function devToolsTextState(target, text) {
  const expression = `(() => { const elements=[]; const walk=(root)=>{for(const node of root.querySelectorAll('*')){elements.push(node);if(node.shadowRoot)walk(node.shadowRoot);}}; walk(document); const matches=elements.filter((node)=>node.textContent?.trim().includes(${JSON.stringify(text)})).sort((a,b)=>a.textContent.trim().length-b.textContent.trim().length); const e=matches.find((node)=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0;}) || matches[0]; if(!e)return {missing:true,screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight}; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,visible:r.width>0&&r.height>0,selected:e.getAttribute('aria-selected')==='true'||/selected/.test(String(e.className))}; })()`;
  const result = await cdp.call(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value;
}

async function main() {
  const root = path.join(__dirname, '..', 'four-window-devtools-data');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: `devtools-env-${index + 1}`, name: String(index + 1), browser: 'Google Chrome', proxy: 'Direct' }));
  const events = []; const controller = new LiveSyncController(engine, (event) => events.push(event));
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const bounds = [
      { left: 0, top: 0, width: 900, height: 480 }, { left: 900, top: 0, width: 900, height: 480 },
      { left: 0, top: 480, width: 900, height: 480 }, { left: 900, top: 480, width: 900, height: 480 },
    ];
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, bounds[index])));
    await controller.start(profiles.map((profile) => profile.id)); await wait(1200);
    const driver = path.join(__dirname, 'native-extension-popup-driver.exe');
    const f12Output = await run(driver, ['--f12', String(sessions[0].pid)]);
    await wait(2400);
    if (!controller.nativeDevToolsMode) throw new Error('native DevTools mode was not activated after master F12: ' + JSON.stringify(events.slice(-10)));
    const targetSnapshots = await Promise.all(sessions.map((session) => cdp.targets(session.port)));
    const devToolsTargets = targetSnapshots.map((items) => items.find((item) => String(item.url || '').startsWith('devtools://')));
    if (devToolsTargets.some((item) => !item)) throw new Error('DevTools did not open in all four environments: ' + JSON.stringify(targetSnapshots));
    const sourceRects = await Promise.all(devToolsTargets.map((target) => devToolsTextState(target, 'Sources')));
    if (sourceRects.some((item) => item.missing || !item.visible)) throw new Error('Sources tab was not visible in all DevTools targets: ' + JSON.stringify(sourceRects));
    const source = sourceRects[0];
    const sourcePoint = [Math.round(source.screenX + source.x + source.width / 2), Math.round(source.screenY + (source.outerHeight - source.innerHeight) + source.y + source.height / 2)];
    const sourcesClick = await run(driver, ['--coordinates', String(sourcePoint[0]), String(sourcePoint[1])]);
    await wait(900);
    const sourceStates = await Promise.all(devToolsTargets.map((target) => devToolsTextState(target, 'Sources')));
    const moreRects = await Promise.all(devToolsTargets.map((target) => devToolsTextState(target, 'Show more')));
    if (moreRects.some((item) => item.missing || !item.visible)) throw new Error('Sources Show more control was not visible in all environments: ' + JSON.stringify(moreRects));
    const more = moreRects[0]; const morePoint = [Math.round(more.screenX + more.x + more.width / 2), Math.round(more.screenY + (more.outerHeight - more.innerHeight) + more.y + more.height / 2)];
    const moreClick = await run(driver, ['--coordinates', String(morePoint[0]), String(morePoint[1])]); await wait(500);
    const snippetRects = await Promise.all(devToolsTargets.map((target) => devToolsTextState(target, 'Snippets')));
    let snippetPoint = null; let snippetsClick = 'not exposed by this Chromium build'; let emptyStates = [];
    const snippetsAvailable = snippetRects.every((item) => !item.missing && item.visible);
    if (snippetsAvailable) {
      const snippet = snippetRects[0];
      snippetPoint = [Math.round(snippet.screenX + snippet.x + snippet.width / 2), Math.round(snippet.screenY + (snippet.outerHeight - snippet.innerHeight) + snippet.y + snippet.height / 2)];
      snippetsClick = await run(driver, ['--coordinates', String(snippetPoint[0]), String(snippetPoint[1])]);
      await wait(900);
      emptyStates = await Promise.all(devToolsTargets.map((target) => devToolsTextState(target, 'No snippets saved')));
      if (emptyStates.some((item) => item.missing || !item.visible)) throw new Error('Snippets empty state did not synchronize in all environments: ' + JSON.stringify(emptyStates));
    }
    process.stdout.write(JSON.stringify({ success: true, fourChrome: sessions.map((session) => ({ id: session.id, pid: session.pid })), f12Output, devToolsTargets: devToolsTargets.length, sourcePoint, sourcesClick, sourceStates, morePoint, moreClick, snippetsAvailable, snippetPoint, snippetsClick, emptyStates, nativeDevToolsMode: controller.nativeDevToolsMode }, null, 2));  } finally {
    controller.stop(); await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
