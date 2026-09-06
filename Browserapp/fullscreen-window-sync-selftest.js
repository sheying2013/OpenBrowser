'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const cdp = require('./cdp');
const { LiveSyncController, __test } = require('./live-sync-v5');
const { injection: baseInjection } = require('./live-sync-v4');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch('open', {});
    });
  }

  addEventListener(type, listener) {
    const values = this.listeners.get(type) || [];
    values.push(listener);
    this.listeners.set(type, values);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  send(raw) {
    const message = JSON.parse(String(raw));
    FakeWebSocket.commands.push(message);
    let result = {};
    const custom = FakeWebSocket.handler?.(message);
    if (custom?.error) {
      queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({ id: message.id, error: custom.error }) }));
      return;
    }
    if (custom?.result !== undefined) {
      result = custom.result;
    } else if (message.method === 'Browser.getWindowForTarget') {
      result = { windowId: 17, bounds: { left: 10, top: 20, width: 640, height: 480, windowState: 'normal' } };
    } else if (message.method === 'Browser.getWindowBounds') {
      result = { bounds: { left: 30, top: 40, width: 900, height: 700, windowState: 'normal' } };
    }
    queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({ id: message.id, result }) }));
    if (message.method === 'Target.setAutoAttach' && !message.sessionId) {
      queueMicrotask(() => this.dispatch('message', { data: JSON.stringify({
        method: 'Target.attachedToTarget',
        params: { sessionId: 'oopif-session', targetInfo: { type: 'iframe', url: 'https://video.example/player' } },
      }) }));
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.dispatch('close', {}));
  }
}
FakeWebSocket.commands = [];
FakeWebSocket.handler = null;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function testWindowBoundsOption() {
  const originalWebSocket = global.WebSocket;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/json/list') {
      response.end(JSON.stringify([{ id: 'tab-1', type: 'page', title: 'test', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://fake/tab' }]));
      return;
    }
    if (request.url === '/json/version') {
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://fake/browser' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const port = await listen(server);
  global.WebSocket = FakeWebSocket;
  try {
    FakeWebSocket.commands.length = 0;
    await cdp.setWindowBounds(port, { left: 30, top: 40, width: 900, height: 700 }, { forceNormal: false });
    const passive = FakeWebSocket.commands.filter((value) => value.method.startsWith('Browser.'));
    assert.deepStrictEqual(passive.map((value) => value.method), [
      'Browser.getWindowForTarget',
      'Browser.setWindowBounds',
    ]);
    assert.strictEqual(passive[1].params.bounds.windowState, undefined);

    FakeWebSocket.commands.length = 0;
    await cdp.setWindowBounds(port, { left: 30, top: 40, width: 900, height: 700 });
    const explicit = FakeWebSocket.commands.filter((value) => value.method.startsWith('Browser.'));
    assert.deepStrictEqual(explicit.map((value) => value.method), [
      'Browser.getWindowForTarget',
      'Browser.setWindowBounds',
      'Browser.setWindowBounds',
      'Browser.getWindowBounds',
    ]);
    assert.strictEqual(explicit[1].params.bounds.windowState, 'normal');

    let windowState = 'normal';
    FakeWebSocket.handler = (message) => {
      if (message.method === 'Browser.getWindowForTarget') {
        return { result: { windowId: 17, bounds: { left: 10, top: 20, width: 640, height: 480, windowState } } };
      }
      if (message.method === 'Browser.setWindowBounds') {
        const requested = message.params.bounds.windowState;
        if (requested && requested !== 'fullscreen') windowState = requested;
        return { result: {} };
      }
      if (message.method === 'Browser.getWindowBounds') return { result: { bounds: { windowState } } };
      return null;
    };
    const degraded = await cdp.setWindowState(port, 'fullscreen', {
      verify: true,
      fallbackState: 'maximized',
      attempts: 1,
    });
    assert.strictEqual(degraded.requestedState, 'fullscreen');
    assert.strictEqual(degraded.state, 'maximized');
    assert.strictEqual(degraded.degraded, true);
  } finally {
    FakeWebSocket.handler = null;
    global.WebSocket = originalWebSocket;
    await close(server);
  }
}

async function testOopifSessionAttachment() {
  const originalWebSocket = global.WebSocket;
  const engine = { running: new Map(), profiles: new Map(), on: () => () => {}, stop: async () => {} };
  const controller = new LiveSyncController(engine, () => {});
  controller.master = { id: 'master', item: { port: 100 } };
  FakeWebSocket.commands.length = 0;
  global.WebSocket = FakeWebSocket;
  try {
    await controller.attach({ id: 'master-tab', webSocketDebuggerUrl: 'ws://master' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const parent = FakeWebSocket.commands.find((item) => item.method === 'Target.setAutoAttach' && !item.sessionId);
    const child = FakeWebSocket.commands.filter((item) => item.sessionId === 'oopif-session');
    assert.ok(parent, 'master target must enable flattened auto-attach');
    assert.ok(child.some((item) => item.method === 'Runtime.addBinding'), 'OOPIF session must receive the binding');
    assert.ok(child.some((item) => item.method === 'Page.addScriptToEvaluateOnNewDocument'), 'OOPIF session must receive fullscreen injection');
    assert.ok(child.some((item) => item.method === 'Runtime.evaluate' && item.params.expression.includes('fullscreenchange')), 'OOPIF session must install the live listener');
    FakeWebSocket.commands.length = 0;
    await controller.handle('master-tab', {
      method: 'Runtime.executionContextCreated',
      sessionId: 'oopif-session',
      params: { context: { id: 99 } },
    });
    const childContext = FakeWebSocket.commands.find((item) => item.method === 'Runtime.evaluate' && item.sessionId === 'oopif-session' && item.params.contextId === 99);
    assert.ok(childContext, 'new OOPIF execution contexts must stay on their child session');
    assert.ok(FakeWebSocket.commands.some((item) => item.method === 'Runtime.evaluate'
      && item.sessionId === 'oopif-session'
      && item.params.contextId === 99
      && item.params.expression === baseInjection), 'the inherited input bridge must also target the OOPIF session');
  } finally {
    global.WebSocket = originalWebSocket;
    controller.stop();
  }
}

async function testFullscreenAndGeometrySync() {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const liveSyncSource = fs.readFileSync(path.join(__dirname, 'live-sync-v5.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.ok(mainSource.includes("['minimized', 'normal', 'maximized', 'fullscreen']"), 'sync:window must allow fullscreen');
  assert.ok(mainSource.includes("fallbackState: 'maximized'"), 'fullscreen window actions must retain a compatibility fallback');
  assert.ok(mainSource.includes("pauseGeometrySync?.(3500"), 'manual tile/cascade must invalidate in-flight geometry sync');
  assert.ok(baseInjection.includes("send('surface'"), 'page focus changes must protect browser-owned surfaces');
  assert.ok(baseInjection.includes("addEventListener('blur'"));
  assert.ok(baseInjection.includes("addEventListener('visibilitychange'"));
  assert.ok(baseInjection.includes("addEventListener('pagehide'"), 'page teardown must report browser surface ownership');
  assert.ok(__test.fullscreenInjection.includes("addEventListener('fullscreenchange'"));
  assert.ok(__test.fullscreenInjection.includes("addEventListener('webkitfullscreenchange'"));
  assert.ok(!__test.fullscreenInjection.includes("window !== window.top"), 'fullscreen hooks must also install in iframe contexts');
  assert.ok(__test.fullscreenInjection.includes('frameUrl'));
  assert.ok(__test.fullscreenInjection.includes('framePath'));
  assert.ok(__test.fullscreenInjection.includes('ancestorOrigins'));
  assert.ok(__test.fullscreenInjection.includes('fullscreenElement = () =>'));
  assert.ok(__test.fullscreenInjection.includes('attachShadow'));
  assert.ok(!__test.fullscreenInjection.includes("addEventListener('fullscreenchange', report"), 'fullscreenchange must not pass the Event object as an error');
  assert.ok(!__test.fullscreenInjection.includes("addEventListener('webkitfullscreenchange', report"), 'webkitfullscreenchange must not pass the Event object as an error');
  assert.ok(__test.fullscreenInjection.includes("addEventListener('fullscreenerror'"));
  assert.ok(__test.fullscreenInjection.includes('requestedActive'));
  assert.ok(__test.fullscreenInjection.includes("report('webkit-begin')"));
  assert.ok(__test.fullscreenInjection.includes("report('webkit-end')"));
  assert.ok(__test.fullscreenInjection.includes("report('initial')"), 'new frame contexts must publish their initial fullscreen state');
  assert.ok(!__test.fullscreenInjection.includes('requestAnimationFrame(() => setTimeout(flush'), 'hidden frame reports must not depend on requestAnimationFrame');
  assert.ok(liveSyncSource.includes('const guardIsCurrent = () => generation === this.syncGeneration'), 'tab activation must retain a transition generation guard');
  assert.ok(liveSyncSource.includes('if (!guardIsCurrent()) return;'), 'tab activation must re-check the guard after async mapping');
  assert.ok(liveSyncSource.includes('if (heavy && foreground)'), 'background tabs must not fan out zoom changes');
  assert.ok(rendererSource.includes('new ResizeObserver(scheduleShellLayoutReconcile)'), 'renderer must reconcile native window resize geometry');
  assert.ok(rendererSource.includes('result ? button === windowButton : button === previous'), 'window action state must only commit after backend success');
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('requestFullscreen'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('webkitEnterFullscreen'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('fullscreenEnabled'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('waitForState'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('data-openbrowser-sync-had-style'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes('data-openbrowser-sync-root-style-saved'));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes("findDeep(document, 'video')"));
  assert.ok(__test.fullscreenExpression({ active: true, selector: '#player', tag: 'video' }).includes("style.setProperty('transform', 'none'"));
  assert.ok(__test.fullscreenExpression({ active: false }).includes('exitFullscreen'));

  const events = [];
  const engine = { running: new Map(), profiles: new Map(), on: () => () => {}, stop: async () => {} };
  const controller = new LiveSyncController(engine, (event) => events.push(event));
  // A down bridge must not prevent CDP from healing the browser viewport.
  controller.nativeBridgeState = 'down';
  controller.master = { id: 'master', item: { port: 100 } };
  controller.masterTabs = [{ id: 'master-tab', url: 'https://example.test/' }];
  controller.slaves = [{ id: 'slave-1', port: 101 }, { id: 'slave-2', port: 102 }];

  const originalCall = cdp.call;
  const originalWindowForPort = cdp.windowForPort;
  const originalSetWindowBounds = cdp.setWindowBounds;
  const runtimeCalls = [];
  const resizeCalls = [];
  try {
    controller.eachSlave = async (_tabId, action) => {
      await action({ id: 'slave-tab-1', webSocketDebuggerUrl: 'ws://slave-1' }, controller.slaves[0]);
      await action({ id: 'slave-tab-2', webSocketDebuggerUrl: 'ws://slave-2' }, controller.slaves[1]);
    };
    cdp.call = async (url, method, params) => {
      runtimeCalls.push({ url, method, params });
      return { result: { value: { active: params.expression.includes('if (!true)') } } };
    };

    const entered = await controller.syncFullscreen('master-tab', { active: true, selector: '#player', tag: 'video', id: 'player' });
    assert.deepStrictEqual(entered, { active: true, applied: 2, failed: 0 });
    assert.ok(runtimeCalls.every((value) => value.method === 'Runtime.evaluate'));
    assert.ok(runtimeCalls.every((value) => value.params.userGesture === true));
    assert.ok(runtimeCalls.every((value) => value.params.awaitPromise === true));
    assert.ok(runtimeCalls.every((value) => value.params.returnByValue === true));

    runtimeCalls.length = 0;
    cdp.call = async (url, method, params) => {
      runtimeCalls.push({ url, method, params });
      return { result: { value: { active: false } } };
    };
    const exited = await controller.syncFullscreen('master-tab', { active: false });
    assert.deepStrictEqual(exited, { active: false, applied: 2, failed: 0 });
    assert.ok(runtimeCalls.every((value) => value.params.userGesture === true));

    cdp.windowForPort = async (port) => {
      if (port === 100) return { bounds: { left: 0, top: 0, width: 1000, height: 700, windowState: 'normal' } };
      if (port === 101) return { bounds: { left: 1000, top: 0, width: 800, height: 600, windowState: 'normal' } };
      return { bounds: { left: 0, top: 700, width: 800, height: 600, windowState: 'fullscreen' } };
    };
    cdp.setWindowBounds = async (port, bounds, options) => { resizeCalls.push({ port, bounds, options }); };
    controller.geometryPausedUntil = 0;
    controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1);
    assert.strictEqual(resizeCalls[0].port, 101);
    assert.deepStrictEqual(resizeCalls[0].options, { forceNormal: false });

    controller.nativePopupActive = true;
    controller.geometryPausedUntil = 0;
    controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'native popup must suppress geometry writes');
    assert.ok(events.some((event) => event.type === 'live-sync-fullscreen' && event.active === true));
    assert.ok(events.some((event) => event.type === 'live-sync-fullscreen' && event.active === false));
  } finally {
    cdp.call = originalCall;
    cdp.windowForPort = originalWindowForPort;
    cdp.setWindowBounds = originalSetWindowBounds;
    controller.stop();
  }
}

async function testFullscreenFrameRoutingAndPopupVisibility() {
  const events = [];
  const engine = { running: new Map(), profiles: new Map(), on: () => () => {}, stop: async () => {} };
  const controller = new LiveSyncController(engine, (event) => events.push(event));
  // This fixture exercises geometry filtering while the native bridge is
  // unavailable; CDP sizing must still remain operational.
  controller.nativeBridgeState = 'down';
  controller.master = { id: 'master', item: { port: 100 } };
  controller.masterTabs = [{ id: 'master-tab', url: 'https://example.test/' }];
  controller.slaves = [{ id: 'slave-1', port: 101 }];

  const originalCall = cdp.call;
  const originalTargets = cdp.targets;
  const originalWindowForPort = cdp.windowForPort;
  const originalSetWindowBounds = cdp.setWindowBounds;
  const calls = [];
  const resizeCalls = [];
  try {
    controller.eachSlave = async (_tabId, action) => action({ id: 'slave-tab', webSocketDebuggerUrl: 'ws://slave' }, controller.slaves[0]);
    cdp.call = async (url, method, params) => {
      calls.push({ url, method, params });
      if (method === 'Page.getFrameTree') {
        return { frameTree: {
          frame: { id: 'root', url: 'https://example.test/', name: '' },
          childFrames: [{ frame: { id: 'child', url: 'https://video.example/player', name: 'player-frame', parentId: 'root' } }],
        } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate') return { result: { value: { active: true } } };
      return {};
    };

    const result = await controller.syncFullscreen('master-tab', {
      active: true,
      selector: '#host >>> video',
      tag: 'video',
      frameUrl: 'https://video.example/player#current',
      frameName: 'player-frame',
      frameDepth: 1,
      framePath: '#player-frame',
    });
    assert.deepStrictEqual(result, { active: true, applied: 1, failed: 0 });
    assert.deepStrictEqual(calls.map((item) => item.method), [
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    assert.strictEqual(calls[1].params.frameId, 'child');
    assert.strictEqual(calls[2].params.contextId, 42);
    assert.strictEqual(calls[2].params.userGesture, true);
    assert.ok(calls[2].params.expression.includes('#host >>> video'));

    calls.length = 0;
    cdp.targets = async (port) => {
      assert.strictEqual(port, 101);
      return [{ type: 'iframe', url: 'https://video.example/player', webSocketDebuggerUrl: 'ws://oopif' }];
    };
    const oopifResult = await controller.syncFullscreen('master-tab', {
      active: true,
      selector: '#host >>> video',
      tag: 'video',
      frameUrl: 'https://video.example/player',
      frameDepth: 1,
    });
    assert.deepStrictEqual(oopifResult, { active: true, applied: 1, failed: 0 });
    assert.deepStrictEqual(calls.map((item) => item.method), ['Runtime.evaluate']);
    assert.strictEqual(calls[0].url, 'ws://oopif');

    calls.length = 0;
    cdp.call = async (url, method, params) => {
      calls.push({ url, method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.test/' } } };
      if (method === 'Runtime.evaluate' && url === 'ws://oopif') {
        return { result: { value: { active: true, mode: 'visual', degraded: true, reason: 'user-gesture-rejected' } } };
      }
      if (method === 'Runtime.evaluate') return { result: { value: { active: true, mode: 'visual', degraded: true } } };
      return {};
    };
    const degradedOopif = await controller.syncFullscreen('master-tab', {
      active: true,
      selector: '#host >>> video',
      tag: 'video',
      frameUrl: 'https://video.example/player',
      frameDepth: 1,
    });
    assert.deepStrictEqual(degradedOopif, { active: true, applied: 1, failed: 0 });
    assert.deepStrictEqual(calls.filter((item) => item.method === 'Runtime.evaluate').map((item) => item.url), [
      'ws://oopif',
      'ws://slave',
    ], 'a visual OOPIF fallback must also expand its embedding frame');
    assert.ok(events.some((event) => event.type === 'live-sync-fullscreen-degraded'
      && event.reason === 'user-gesture-rejected'));

    calls.length = 0;
    cdp.call = async (url, method, params) => {
      calls.push({ url, method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://example.test/' } } };
      if (method === 'Runtime.evaluate') return { result: { value: { active: false, mode: 'none' } } };
      return {};
    };
    const exitedOopif = await controller.syncFullscreen('master-tab', {
      active: false,
      frameUrl: 'https://video.example/player',
      frameDepth: 1,
    });
    assert.deepStrictEqual(exitedOopif, { active: false, applied: 1, failed: 0 });
    assert.deepStrictEqual(calls.filter((item) => item.method === 'Runtime.evaluate').map((item) => item.url), [
      'ws://oopif',
      'ws://slave',
    ], 'fullscreen exit must clean both the OOPIF and its embedding frame');

    calls.length = 0;
    cdp.call = async (url, method, params) => {
      calls.push({ url, method, params });
      if (method === 'Runtime.evaluate') throw new Error('OOPIF runtime unavailable');
      return {};
    };
    const failedOopif = await controller.syncFullscreen('master-tab', {
      active: true,
      selector: '#host >>> video',
      tag: 'video',
      frameUrl: 'https://video.example/player',
      frameDepth: 1,
    });
    assert.deepStrictEqual(failedOopif, { active: true, applied: 0, failed: 1 });
    assert.ok(events.some((event) => event.type === 'live-sync-fullscreen-route-error'
      && event.stage === 'oopif-runtime-evaluate'
      && event.severity === 'error'
      && event.message.includes('OOPIF runtime unavailable')));

    controller.eachSlave = async (_tabId, action) => action({ id: 'slave-tab', webSocketDebuggerUrl: 'ws://slave' }, controller.slaves[0]);
    const forwarded = [];
    const enqueueForward = controller.enqueueForward;
    controller.enqueueForward = (_tabId, payload) => forwarded.push(payload);
    await controller.handle('master-tab', {
      method: 'Runtime.bindingCalled',
      params: { name: 'openBrowserSync', payload: JSON.stringify({ type: 'fullscreen', active: true, frameToken: 'active-frame', frameDepth: 1, frameUrl: 'https://video.example/player' }) },
    });
    assert.strictEqual(controller.fullscreenByTab.get('master-tab'), true);
    assert.strictEqual(forwarded.length, 1);
    forwarded.length = 0;
    controller.geometryPausedUntil = Date.now() + 10000;
    controller.lastGeometryPauseReason = 'fullscreen-transition';
    await controller.handle('master-tab', {
      method: 'Runtime.bindingCalled',
      params: { name: 'openBrowserSync', payload: JSON.stringify({ type: 'fullscreen', active: false, frameToken: 'failed-frame', error: 'NotAllowedError' }) },
    });
    assert.strictEqual(forwarded.length, 0, 'permission failures must not force slaves to exit fullscreen');
    assert.strictEqual(controller.fullscreenByTab.get('master-tab'), true, 'a fullscreenerror in another frame must preserve the active frame');
    assert.ok(events.some((event) => event.type === 'live-sync-fullscreen-error'));

    await controller.handle('master-tab', {
      method: 'Runtime.bindingCalled',
      params: { name: 'openBrowserSync', payload: JSON.stringify({ type: 'fullscreen', active: false, frameToken: 'active-frame', frameDepth: 1, frameUrl: 'https://video.example/player' }) },
    });
    assert.strictEqual(controller.fullscreenByTab.has('master-tab'), false, 'the matching fullscreen exit must clear the active frame');
    assert.ok(controller.geometryPausedUntil <= Date.now() + 500, 'fullscreen exit must release the geometry pause promptly');

    controller.updateFullscreenContext('master-tab', 'page:navigating-frame', { active: true, frameToken: 'navigating-frame' });
    await controller.handle('master-tab', { method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'root', url: 'https://video.example/next' } } });
    assert.strictEqual(controller.fullscreenByTab.get('master-tab'), true, 'a sibling frame navigation must not clear another fullscreen context');
    await controller.handle('master-tab', { method: 'Page.frameNavigated', params: { frame: { id: 'root', url: 'https://example.test/next' } } });
    assert.strictEqual(controller.fullscreenByTab.has('master-tab'), false, 'top-level navigation must clear stale fullscreen state');
    controller.enqueueForward = enqueueForward;

    cdp.windowForPort = async (port) => port === 100
      ? { bounds: { left: 0, top: 0, width: 1000, height: 700, windowState: 'normal' } }
      : { bounds: { left: 1000, top: 0, width: 800, height: 600, windowState: 'normal' } };
    cdp.setWindowBounds = async (port, bounds, options) => resizeCalls.push({ port, bounds, options });

    const hiddenConnection = { command: async () => ({ result: { value: { visible: false, focused: false } } }), close() {} };
    controller.extensionConnections.set('hidden', { connection: hiddenConnection });
    controller.fullscreenByTab.clear();
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'hidden extension targets must not block geometry sync');

    const visibleConnection = { command: async () => ({ result: { value: { visible: true, focused: true } } }), close() {} };
    controller.extensionConnections.set('visible', { connection: visibleConnection });
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'visible extension popup must block geometry writes');

    controller.extensionConnections.clear();
    controller.fullscreenByTab.set('master-tab', true);
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'active document fullscreen must block geometry writes');

    controller.fullscreenByTab.clear();
    controller.connections.set('master-tab', {
      tab: { id: 'master-tab' },
      connection: {
        command: async () => ({ result: { value: { focused: false, picker: false } } }),
        close() {},
      },
    });
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'unfocused master page must not resize another window');

    controller.connections.get('master-tab').connection.command = async () => ({ result: { value: { focused: true, picker: true } } });
    controller.browserOwnedUntil = Date.now() + 1000;
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 1, 'native date/select picker must block geometry writes');

    // Once the picker has closed, the page can still report the input as the
    // active element. The short opening grace must expire so geometry can heal.
    controller.browserOwnedUntil = Date.now() - 1;
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 2, 'closed picker must not permanently block geometry writes');

    controller.nativePopupActive = true;
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 2, 'native popup state must continue blocking geometry writes');

    controller.nativePopupActive = false;
    controller.fullscreenByTab.set('background-master-tab', true);
    controller.activeMasterTab = 'master-tab';
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 2, 'fullscreen in any tracked master context must block geometry writes');

    controller.fullscreenByTab.clear();
    controller.geometryPausedUntil = 0; controller.browserOwnedUntil = 0;
    controller.enqueueForward('master-tab', { type: 'surface', focused: false, visible: true });
    assert.ok(controller.geometryPausedUntil > Date.now(), 'page blur must create a geometry transition guard');
    assert.ok(controller.browserOwnedUntil > Date.now(), 'page blur must protect an external browser menu from activation');

    const generationBeforePopup = controller.windowGuardGeneration;
    controller.pauseGeometrySync(500, 'native-menu-race');
    assert.ok(controller.windowGuardGeneration > generationBeforePopup, 'a newly opened browser surface must invalidate in-flight geometry work');

    // Verify picker interaction protection (select/date/color etc.)
    controller.geometryPausedUntil = 0; controller.browserOwnedUntil = 0;
    controller.syncSettings.click = false; // even when click sync is disabled
    controller.enqueueForward('master-tab', { type: 'click', tag: 'select' });
    assert.ok(controller.browserOwnedUntil > Date.now() + 3000, 'select picker click must grant at least 3500ms protection even when click sync is off');
    assert.ok(controller.geometryPausedUntil > Date.now() + 3000, 'select picker click must pause geometry sync for at least 3500ms');
    controller.syncSettings.click = true;

    // Verify pickerOpen directly blocks geometry sync
    controller.browserOwnedUntil = 0;
    controller.connections.get('master-tab').connection.command = async () => ({
      result: { value: { focused: true, picker: true, pickerOpen: true } },
    });
    controller.geometryPausedUntil = 0; controller.lastWindowSync = 0;
    resizeCalls.length = 0;
    await controller.syncWindowGeometry();
    assert.strictEqual(resizeCalls.length, 0, 'open picker must block geometry writes and refresh browserOwnedUntil');
    assert.ok(controller.browserOwnedUntil > Date.now() + 3000, 'open picker must extend browserOwnedUntil');
  } finally {
    cdp.call = originalCall;
    cdp.targets = originalTargets;
    cdp.windowForPort = originalWindowForPort;
    cdp.setWindowBounds = originalSetWindowBounds;
    controller.stop();
  }
}

async function testMasterCloseCascade() {
  const events = [];
  const listeners = new Set();
  const engine = {
    running: new Map([['slave-1', { id: 'slave-1' }]]),
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    stop: async (id) => { engine.running.delete(id); return { id, running: false }; },
  };
  const controller = new LiveSyncController(engine, (event) => events.push(event));
  controller.master = { id: 'master' };
  controller.slaves = [{ id: 'slave-1', port: 101 }];
  const masterId = controller.master.id;
  const controlledIds = controller.slaves.map((item) => item.id);
  const unsubscribe = engine.on((event) => {
    if (event.type === 'status' && event.running === false && event.id === masterId) controller.scheduleMasterClose(controlledIds);
  });
  try {
    engine.emit({ type: 'status', id: 'master', running: false });
    await controller.masterClosePromise;
    assert.deepStrictEqual([...engine.running.keys()], [], 'master close must stop every controlled environment');
    const closed = events.find((event) => event.type === 'master-closed');
    assert.deepStrictEqual(closed?.controlled, ['slave-1']);
    assert.deepStrictEqual(closed?.remaining, []);
  } finally {
    unsubscribe();
    controller.stop();
  }
}

async function main() {
  await testWindowBoundsOption();
  await testOopifSessionAttachment();
  await testFullscreenAndGeometrySync();
  await testFullscreenFrameRoutingAndPopupVisibility();
  await testMasterCloseCascade();
  process.stdout.write('FULLSCREEN_WINDOW_SYNC_SELFTEST_OK\n');
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
