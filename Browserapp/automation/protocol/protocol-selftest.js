'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const {
  CUSTOM_BROWSER_METHODS,
  translateToStandardCdp,
  buildFanoutPlan,
  computeCascadeBounds,
  parseOperateList,
  MOUSE_ACTION,
} = require('./window-sync-protocol');

const {
  RPA_PLUS_ACTIONS,
  parseProcessContent,
  normalizeStep,
  isRegistered,
  ACTION_PARAM_SCHEMA,
} = require('./rpa-registry');

const {
  toLocalRecord,
  copyApplication,
  checkApplicationFolder,
  mergeLoadExtensionArgs,
  stageAppsForLaunch,
} = require('./app-center-protocol');

const { EVENT_TYPE, payloadToSyncEvent, settingsToOperateList, operateAllows } = require('./event-map');
const { planFanoutFromPayload } = require('./sync-fanout');
const {
  syncCapabilities,
  isWindows,
  isMac,
  LOCAL_API_PORTS,
  toFileUrl,
  extractUserDataDir,
  windowsExecutableMatches,
} = require('./cross-platform');

function pass(name) { console.log('  PASS  ' + name); }

async function main() {
  console.log('Pixel-protocol selftest\n');

  // ---- window sync protocol ----
  assert.ok(CUSTOM_BROWSER_METHODS.includes('Browser.click'));
  assert.ok(CUSTOM_BROWSER_METHODS.includes('Browser.clickheadbox_withsize'));
  assert.ok(CUSTOM_BROWSER_METHODS.includes('Browser.keyboard_toheadbox'));
  pass('custom Browser.* method list');

  const clickPlan = translateToStandardCdp('Browser.click', { action: MOUSE_ACTION.DOWN, x: 10, y: 20 });
  assert.strictEqual(clickPlan[0].method, 'Input.dispatchMouseEvent');
  assert.strictEqual(clickPlan[0].params.type, 'mousePressed');
  pass('Browser.click → Input.mousePressed');

  const scrollPlan = translateToStandardCdp('Browser.scroll', { dX: 0, dY: 120, x: 5, y: 6 });
  assert.strictEqual(scrollPlan[0].params.type, 'mouseWheel');
  assert.strictEqual(scrollPlan[0].params.deltaY, 120);
  pass('Browser.scroll → mouseWheel');

  const keyPlan = translateToStandardCdp('Browser.keyboard', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  assert.strictEqual(keyPlan.length, 2);
  assert.strictEqual(keyPlan[0].params.type, 'keyDown');
  assert.strictEqual(keyPlan[1].params.type, 'keyUp');
  pass('Browser.keyboard → keyDown/keyUp');

  const fanout = buildFanoutPlan(
    { kind: 'mouse', params: { action: 0, x: 1, y: 2 } },
    { operate: 'click,move,scroll,keyboard', isDelay: '1', mouseDelayMin: 10, mouseDelayMax: 20 }
  );
  assert.strictEqual(fanout.skip, false);
  assert.strictEqual(fanout.proprietary.method, 'Browser.click');
  assert.ok(fanout.delayMs >= 10 && fanout.delayMs <= 20);
  pass('fanout plan delay + operate gate');

  const skipScroll = buildFanoutPlan(
    { kind: 'scroll', params: { dY: 1 } },
    { operate: 'click,move' }
  );
  assert.strictEqual(skipScroll.skip, true);
  pass('operate list gates scroll');

  const cascade = computeCascadeBounds(['a', 'b', 'c'], { left: 0, top: 0, width: 800, height: 600, vs: 40 });
  assert.strictEqual(cascade[0].bounds.left, 0);
  assert.strictEqual(cascade[1].bounds.left, 40);
  assert.strictEqual(cascade[2].bounds.left, 80);
  pass('operateRang cascade geometry');

  assert.deepStrictEqual(parseOperateList('click, move ,keyboard'), ['click', 'move', 'keyboard']);
  pass('parseOperateList');

  // ---- RPA registry ----
  assert.ok(RPA_PLUS_ACTIONS.includes('gotoUrl'));
  assert.ok(RPA_PLUS_ACTIONS.includes('ifElse'));
  assert.ok(RPA_PLUS_ACTIONS.includes('getOpenAI'));
  assert.ok(RPA_PLUS_ACTIONS.length >= 50);
  pass('RPA Plus action registry size=' + RPA_PLUS_ACTIONS.length);

  assert.ok(isRegistered('click'));
  assert.ok(ACTION_PARAM_SCHEMA.waitTime.fields.includes('timeoutType'));
  pass('param schema waitTime/click');

  const steps = parseProcessContent(JSON.stringify([
    { type: 'gotoUrl', url: 'https://example.com', timeout: 15000 },
    { type: 'waitTime', timeout: 500, timeoutType: 'randomInterval', timeoutMin: 100, timeoutMax: 200 },
    { type: 'click', selector: 'a', selectorRadio: 'CSS', button: 'left' },
    { type: 'inputContent', selector: 'input', content: 'hi', isClear: true },
  ]));
  assert.strictEqual(steps.length, 4);
  assert.strictEqual(steps[0].type, 'gotoUrl');
  assert.strictEqual(steps[0].params.url, 'https://example.com');
  assert.strictEqual(steps[3].params.content, 'hi');
  pass('process_content array parse + normalize');

  const graph = parseProcessContent({
    nodes: [
      { id: 's', type: 'startNode' },
      { id: '1', type: 'gotoUrl', url: 'https://a.test' },
      { id: '2', type: 'waitTime', timeout: 1 },
    ],
  });
  assert.ok(graph.some((s) => s.type === 'gotoUrl'));
  pass('process_content graph linearize');

  // ---- app center copy protocol ----
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-appcenter-'));
  const globalRoot = path.join(root, 'extension');
  const cacheFolder = path.join(root, 'cache');
  const extensionCenter = path.join(root, 'center');
  const unique = 'abcdefghijklmnopqrstuvwxyzabcdef';
  const appId = '9001';
  const src = path.join(globalRoot, appId, unique);
  await fsp.mkdir(src, { recursive: true });
  await fsp.writeFile(path.join(src, 'manifest.json'), JSON.stringify({ name: 'Demo', version: '1.0.0', manifest_version: 3 }));

  const record = toLocalRecord({
    id: appId,
    unique_id: unique,
    application_name: { en: 'Demo' },
    status: '1',
    version: '1.0.0',
  });
  assert.strictEqual(record.name, 'Demo');
  assert.strictEqual(record.unique_id, unique);
  pass('postApplication-style record map');

  const staged = await copyApplication(record, {
    extensionCenter,
    cacheFolder,
    globalExtensionRoot: globalRoot,
  });
  assert.ok(fs.existsSync(path.join(staged, 'manifest.json')));
  pass('copyApplication global → extensionCenter');

  // junk folder should be cleaned
  await fsp.mkdir(path.join(extensionCenter, 'junk'), { recursive: true });
  await checkApplicationFolder(extensionCenter, [unique]);
  assert.ok(!fs.existsSync(path.join(extensionCenter, 'junk')));
  assert.ok(fs.existsSync(path.join(extensionCenter, unique)));
  pass('checkApplicationFolder prune');

  const merged = mergeLoadExtensionArgs(['--foo'], [staged, '/tmp/other']);
  assert.ok(merged.some((a) => a.startsWith('--load-extension=')));
  assert.ok(merged.find((a) => a.startsWith('--load-extension=')).includes(staged));
  pass('merge --load-extension');

  const launch = await stageAppsForLaunch([record], {
    extensionCenter,
    cacheFolder,
    globalExtensionRoot: globalRoot,
  });
  assert.strictEqual(launch.loadPaths.length, 1);
  assert.ok(launch.args[0].startsWith('--load-extension='));
  pass('stageAppsForLaunch');

  await fsp.rm(root, { recursive: true, force: true });

  // ---- event map + fanout end-to-end ----
  const mouseDown = payloadToSyncEvent({ type: 'mouse', phase: 'down', x: 12, y: 34 });
  assert.strictEqual(mouseDown.type, EVENT_TYPE.WEB_MOUSE);
  assert.strictEqual(mouseDown.action, 1);
  pass('payload mouse.down → type=1 action=1');

  const headbox = payloadToSyncEvent({ type: 'mouse', phase: 'move', x: 1, y: 2 }, { headbox: true });
  assert.strictEqual(headbox.type, EVENT_TYPE.HEADBOX_MOUSE);
  pass('payload headbox mouse → type=20');

  const wheel = payloadToSyncEvent({ type: 'wheel', deltaX: 0, deltaY: 80, x: 3, y: 4 });
  assert.strictEqual(wheel.type, EVENT_TYPE.WEB_WHEEL);
  pass('payload wheel → type=2');

  const key = payloadToSyncEvent({ type: 'key', phase: 'down', key: 'a', code: 'KeyA', keyCode: 65, ctrl: true });
  assert.strictEqual(key.type, EVENT_TYPE.WEB_KEY);
  assert.ok(key.modifiers & 2);
  pass('payload key → type=3 modifiers');

  const operate = settingsToOperateList({ click: true, track: true, scroll: false, keyboard: true });
  assert.ok(operate.includes('click') && operate.includes('move') && !operate.includes('scroll'));
  assert.ok(operateAllows(EVENT_TYPE.WEB_MOUSE, operate));
  assert.ok(!operateAllows(EVENT_TYPE.WEB_WHEEL, operate));
  pass('settings ↔ operate gates');

  const fan = planFanoutFromPayload(
    { type: 'mouse', phase: 'down', x: 10, y: 20 },
    { syncSettings: { click: true, track: true, scroll: true, keyboard: true, delayClick: true, clickMinMs: 5, clickMaxMs: 15 } }
  );
  assert.strictEqual(fan.skip, false);
  assert.strictEqual(fan.eventType, EVENT_TYPE.WEB_MOUSE);
  assert.strictEqual(fan.proprietary.command, 'Browser.click');
  assert.ok(fan.standard.length >= 1);
  assert.ok(fan.delayMs >= 5 && fan.delayMs <= 15);
  pass('end-to-end planFanoutFromPayload');

  const blocked = planFanoutFromPayload(
    { type: 'wheel', deltaY: 10, x: 0, y: 0 },
    { syncSettings: { click: true, track: true, scroll: false, keyboard: true } }
  );
  assert.strictEqual(blocked.skip, true);
  pass('fanout operate-gate blocks scroll');

  // ---- cross-platform ----
  const caps = syncCapabilities();
  assert.ok(caps.pageCdpSync === true);
  assert.strictEqual(caps.nativeOsInputMirror, process.platform === 'win32');
  assert.ok(LOCAL_API_PORTS.includes(50325));
  assert.ok(toFileUrl(__filename).startsWith('file:'));
  assert.strictEqual(
    extractUserDataDir('"C:\\Program Files\\Browser\\browser.exe" "--user-data-dir=C:\\OpenBrowser Data\\env-001" --remote-debugging-port=9222'),
    'C:\\OpenBrowser Data\\env-001'
  );
  assert.strictEqual(
    extractUserDataDir('browser.exe --user-data-dir="C:\\OpenBrowser Data\\env-002" --no-first-run'),
    'C:\\OpenBrowser Data\\env-002'
  );
  assert.strictEqual(
    windowsExecutableMatches('C:\\Program Files\\Browser\\browser.exe', 'C:\\Program Files\\Browser\\browser.exe'),
    true
  );
  assert.strictEqual(
    windowsExecutableMatches('C:\\Program Files\\Browser\\browser.exe', 'C:\\Other\\browser.exe'),
    false
  );
  pass('Windows process identity parsing');
  pass('cross-platform caps Win=' + isWindows() + ' Mac=' + isMac());

  console.log('\nAll pixel-protocol selftests passed.');
}

main().catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});
