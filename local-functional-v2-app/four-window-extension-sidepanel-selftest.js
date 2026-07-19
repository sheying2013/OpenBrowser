const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(value, message) { if (!value) throw new Error(message); }

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let output = ''; let error = '';
    child.stdout.on('data', (value) => { output += value; });
    child.stderr.on('data', (value) => { error += value; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error || output || ('driver exited ' + code))));
  });
}

function rawTargets(port) {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:' + port + '/json/list', { timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('target list timeout')));
    request.on('error', reject);
  });
}

async function extensionTargets(session, page) {
  return (await rawTargets(session.port)).filter((target) => String(target.url || '').toLowerCase().startsWith('chrome-extension://') && String(target.url || '').toLowerCase().includes('/' + page));
}

async function popupTargets(session) { return extensionTargets(session, 'sidepanel.html'); }
async function sesTargets(session) { return extensionTargets(session, 'ses.html'); }
async function openerTargets(session) { return extensionTargets(session, 'opener.html'); }

async function main() {
  const root = path.join(__dirname, '..', 'four-window-extension-sidepanel-data');
  const extensionPath = path.join(root, 'probe-extension');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(extensionPath, { recursive: true });
  await fs.writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'OpenBrowser Popup Sync Probe',
    version: '1.0.0',
    action: { default_popup: 'opener.html', default_title: 'Popup Sync Probe' },
    permissions: ['sidePanel'],
    side_panel: { default_path: 'sidepanel.html' },
    background: { service_worker: 'background.js' },
    sandbox: { pages: ['ses.html'] },
  }, null, 2));
  await fs.writeFile(path.join(extensionPath, 'background.js'), "chrome.runtime.onInstalled.addListener(()=>chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}));chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});chrome.action.onClicked.addListener(tab=>chrome.sidePanel.open({windowId:tab.windowId}));");
  await fs.writeFile(path.join(extensionPath, 'opener.html'), '<!doctype html><meta charset="utf-8"><style>body{margin:0}button{width:260px;height:70px;font:700 18px Segoe UI}</style><button id="open">Open Side Panel</button><script src="opener.js"></script>');
  await fs.writeFile(path.join(extensionPath, 'opener.js'), 'document.getElementById("open").addEventListener("click",()=>{document.body.dataset.clicked="1";chrome.windows.getCurrent(w=>chrome.sidePanel.open({windowId:w.id}).then(()=>document.body.dataset.opened="1",e=>document.body.dataset.error=String(e&&e.message||e))) });');
  await fs.writeFile(path.join(extensionPath, 'sidepanel.html'), '<!doctype html><meta charset="utf-8"><style>body{min-width:240px;height:100vh;margin:0;overflow:hidden}iframe{border:0;width:100%;height:100%}</style><iframe id="ui-ses-iframe" src="ses.html?sestheme=light"></iframe>');
  await fs.writeFile(path.join(extensionPath, 'ses.html'), '<!doctype html><meta charset="utf-8"><style>body{width:300px;height:190px;margin:0;display:grid;place-items:center;font:16px Segoe UI}input,button{box-sizing:border-box;width:240px;height:52px;font:700 18px Segoe UI}</style><input id="password" type="password" placeholder="Enter password"><button id="probe">Unlock 0</button><script>let count=0;probe.onclick=()=>{count+=1;probe.textContent="Unlock "+count;document.body.dataset.clicked=String(count)};</script>');

  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({ id: 'sidepanel-env-' + (index + 1), name: index ? ('SidePanel Slave ' + index) : 'SidePanel Master', browser: 'Google Chrome', proxy: 'Direct' }));
  const events = [];
  const controller = new LiveSyncController(engine, (event) => events.push(event));
  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const extension = await engine.addExtension(extensionPath);
    await engine.assignExtension(extension.id, profiles.map((profile) => profile.id), true);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const bounds = [
      { left: 0, top: 0, width: 900, height: 480 },
      { left: 900, top: 0, width: 900, height: 480 },
      { left: 0, top: 480, width: 900, height: 480 },
      { left: 900, top: 480, width: 900, height: 480 },
    ];
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, bounds[index])));
    await wait(800);
    await controller.start(profiles.map((profile) => profile.id));
    await wait(700);
    const openerTabs = await Promise.all(sessions.map(async (session) => {
      const loaded = (session.loadedExtensions || []).find((item) => String(item.path || '').toLowerCase() === extensionPath.toLowerCase());
      const extensionId = loaded?.id || loaded?.chromeExtensionId;
      assert(extensionId, 'side-panel extension ID missing for ' + session.id + ': ' + JSON.stringify(session.loadedExtensions));
      return cdp.newTab(session.port, 'chrome-extension://' + extensionId + '/opener.html');
    }));
    await wait(700);
    const openerButtonPoints = await Promise.all(openerTabs.map((target) => cdp.call(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: '(() => { const r=document.getElementById("open").getBoundingClientRect(); const border=(window.outerWidth-window.innerWidth)/2; return {x:Math.round(window.screenX+border+r.left+r.width/2),y:Math.round(window.screenY+(window.outerHeight-window.innerHeight)-border+r.top+r.height/2),metrics:{screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}}; })()',
      returnByValue: true,
    })));
    const nativePoints = openerButtonPoints.map((result) => result.result?.value);
    assert(nativePoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)), 'failed to calculate native opener coordinates: ' + JSON.stringify(openerButtonPoints));
    const driverOutput = await run(path.join(__dirname, 'native-extension-popup-driver.exe'), ['--coordinates', ...nativePoints.flatMap((point) => [String(point.x), String(point.y)])]);
    const openerStates = await Promise.all(openerTabs.map((target) => cdp.call(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '({clicked:document.body.dataset.clicked||"",opened:document.body.dataset.opened||"",error:document.body.dataset.error||""})', returnByValue: true })));
    const sidePanelOpenResults = [{ native: driverOutput, points: nativePoints, states: openerStates.map((result) => result.result?.value) }];
    await wait(1100);

    let popupLists = []; let targetLists = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      [popupLists, targetLists] = await Promise.all([
        Promise.all(sessions.map(popupTargets)),
        Promise.all(sessions.map(sesTargets)),
      ]);
      if (popupLists.every((list) => list.length) && targetLists.every((list) => list.length)) break;
      await wait(150);
    }
    if (!popupLists.every((list) => list.length === 1)) {
      const allTargets = await Promise.all(sessions.map((session) => rawTargets(session.port)));
      const browserTargetInfos = await Promise.all(sessions.map(async (session) => {
        const socket = await cdp.browserSocket(session.port);
        return (await cdp.call(socket, 'Target.getTargets')).targetInfos || [];
      }));
      throw new Error('extension side panel did not converge across four environments: ' + popupLists.map((list) => list.length).join('/') + ' open=' + JSON.stringify(sidePanelOpenResults) + ' targets=' + JSON.stringify(allTargets.map((list) => list.filter((target) => String(target.url || '').startsWith('chrome-extension://')).map((target) => ({ type: target.type, url: target.url })))) + ' browserTargets=' + JSON.stringify(browserTargetInfos.map((list) => list.filter((target) => String(target.url || '').startsWith('chrome-extension://')).map((target) => ({ targetId: target.targetId, type: target.type, subtype: target.subtype, url: target.url })))) + ' driver=' + driverOutput);
    }
    assert(targetLists.every((list) => list.length === 1), 'sandboxed password iframe target was not exposed in all four environments: ' + targetLists.map((list) => list.length).join('/'));
    for (let attempt = 0; attempt < 25 && controller.extensionConnections.size < 2; attempt += 1) await wait(100);
    assert(controller.extensionConnections.size === 2, 'master outer page and password iframe were not both attached: ' + JSON.stringify(targetLists.map((list) => list.map((target) => ({ type: target.type, url: target.url })))) + ' events=' + JSON.stringify(events.filter((event) => /extension|sync-error/.test(String(event.type)))));
    const masterPasswordPage = targetLists[0][0];
    await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'password.value="";true', returnByValue: true });
    const inputPointResult = await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '(() => { const r=password.getBoundingClientRect(); return {x:r.left+r.width*.18,y:r.top+r.height*.5}; })()', returnByValue: true });
    const inputPoint = inputPointResult.result?.value;
    await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: inputPoint.x, y: inputPoint.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputPoint.x, y: inputPoint.y, button: 'left', buttons: 0, clickCount: 1 });
    await wait(500);
    const readActive = () => Promise.all(targetLists.map((list) => cdp.call(list[0].webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.activeElement && document.activeElement.id', returnByValue: true })));
    const focusedIds = (await readActive()).map((result) => String(result.result?.value || ''));
    assert(focusedIds.every((value) => value === 'password'), 'password focus/caret did not reach every extension iframe: ' + focusedIds.join('/') + ' stats=' + JSON.stringify(controller.forwardStats) + ' map=' + JSON.stringify([...(controller.extensionMap.get(masterPasswordPage.id) || new Map()).entries()].map(([id,target]) => [id,target.type,target.url])) + ' events=' + JSON.stringify(events.filter((event) => /sync-error|sync-health/.test(String(event.type))).slice(-8)));
    for (let index = 0; index < 8; index += 1) {
      await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key: '0', code: 'Digit0', text: '0', unmodifiedText: '0', windowsVirtualKeyCode: 48, nativeVirtualKeyCode: 48 });
      await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchKeyEvent', { type: 'keyUp', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, nativeVirtualKeyCode: 48 });
    }
    await wait(700);
    const readPasswords = () => Promise.all(targetLists.map((list) => cdp.call(list[0].webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'password.value', returnByValue: true })));
    const typedValues = (await readPasswords()).map((result) => String(result.result?.value || ''));
    assert(typedValues.every((value) => value === '00000000'), 'per-key password input did not reach all extension iframe pages: ' + typedValues.join('/'));
    await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'password.focus();password.select();true', returnByValue: true });
    await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.insertText', { text: 'paste-87654321' });
    await wait(700);
    const pastedValues = (await readPasswords()).map((result) => String(result.result?.value || ''));
    assert(pastedValues.every((value) => value === 'paste-87654321'), 'paste-style password input did not reach all extension iframe pages: ' + pastedValues.join('/'));
    const readClicks = async () => (await Promise.all(targetLists.map((list) => cdp.call(list[0].webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'Number(document.body.dataset.clicked || 0)', returnByValue: true })))).map((value) => Number(value.result?.value || 0));
    const clickSequence = [await readClicks()];
    assert(clickSequence[0].every((value) => value === clickSequence[0][0]), 'initial visible Unlock click did not converge: ' + clickSequence[0].join('/'));
    for (let round = 0; round < 2; round += 1) {
      const buttonPointResult = await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: '(() => { const r=probe.getBoundingClientRect(); return {x:r.left+r.width*.73,y:r.top+r.height*.5}; })()', returnByValue: true });
      const buttonPoint = buttonPointResult.result?.value;
      await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: buttonPoint.x, y: buttonPoint.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.call(masterPasswordPage.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: buttonPoint.x, y: buttonPoint.y, button: 'left', buttons: 0, clickCount: 1 });
      await wait(650);
      const values = await readClicks(); const expected = clickSequence[clickSequence.length - 1][0] + 1;
      assert(values.every((value) => value === expected), 'later semantic Unlock click did not converge on round ' + (round + 1) + ': ' + values.join('/') + ' expected=' + expected);
      clickSequence.push(values);
    }
    const clicks = clickSequence[clickSequence.length - 1];
    const visiblePopupUis = popupLists.map((list) => list.length === 1);
    assert(visiblePopupUis.every(Boolean), 'plugin UI was not visibly opened in all four environments');

    process.stdout.write(JSON.stringify({
      success: true,
      fourChrome: sessions.map((session) => ({ id: session.id, browser: session.browser, port: session.port })),
      sidePanelTargets: popupLists.map((list) => list[0].url),
      passwordIframeTargets: targetLists.map((list) => ({ type: list[0].type, url: list[0].url })),
      focusedIds,
      popupClicks: clicks,
      clickSequence,
      typedValues,
      pastedValues,
      visiblePopupUis,
      driverOutput,
      syncErrors: events.filter((event) => event.type === 'sync-error'),
    }, null, 2));
  } finally {
    controller.stop();
    await engine.stopAll().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
