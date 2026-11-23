#!/usr/bin/env node
'use strict';

// Exercise the actual document-start injection in a real browser without TCP/IP access.
// Override OPENBROWSER_TEST_CHROME to select another Chromium executable.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (!process.argv.includes('--isolated-child')) {
  if (process.platform !== 'darwin') {
    console.error('This test requires macOS sandbox-exec to enforce network isolation.');
    process.exit(1);
  }
  const tempRoot = JSON.stringify(fs.realpathSync(os.tmpdir()));
  const policy = `(version 1)(allow default)(deny network*)(allow network* (subpath ${tempRoot}))`;
  const result = spawnSync('/usr/bin/sandbox-exec', [
    '-p', policy, process.execPath, __filename, '--isolated-child',
  ], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exit(result.status === null ? 1 : result.status);
}

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');

async function assertNetworkIsBlocked() {
  const listenError = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', resolve);
    server.listen(0, '127.0.0.1', () => {
      server.close();
      resolve(new Error('TCP listen unexpectedly succeeded'));
    });
  });
  assert(['EPERM', 'EACCES'].includes(listenError.code), `TCP listen not blocked: ${listenError.message}`);
  const connectError = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.once('error', resolve);
    socket.once('connect', () => {
      socket.destroy();
      resolve(new Error('TCP connect unexpectedly succeeded'));
    });
  });
  assert(['EPERM', 'EACCES'].includes(connectError.code), `TCP connect not blocked: ${connectError.message}`);
}

class PipeCdp {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.buffer = '';
    this.closed = false;
    child.stdio[4].on('data', (chunk) => {
      this.buffer += chunk.toString();
      let end;
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const message = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject, timer } = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(timer);
          if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
          else resolve(message.result || {});
        }
        for (const listener of this.listeners.slice()) listener(message);
      }
    });
    child.stdio[3].on('error', () => {});
    child.once('close', (code, signal) => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Browser exited: ${code === null ? signal : code}`));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`Browser exited before ${method}`));
    const id = ++this.nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(JSON.stringify(message) + '\0');
    });
  }

  waitFor(method, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((item) => item !== listener);
        reject(new Error(`CDP event timeout: ${method}`));
      }, 30000);
      const listener = (message) => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((item) => item !== listener);
        resolve(message.params);
      };
      this.listeners.push(listener);
    });
  }
}

const probe = `(() => {
  const child = document.querySelector('iframe').contentWindow;
  const outcome = (fn) => {
    try { return { value: fn() }; } catch (error) { return { error: error.name }; }
  };
  const measure = (win) => {
    const el = win.document.getElementById('box');
    const range = win.document.createRange();
    range.selectNodeContents(el);
    const list = el.getClientRects();
    const rangeList = range.getClientRects();
    const bounding = el.getBoundingClientRect();
    const empty = win.document.getElementById('hidden').getClientRects();
    return {
      bounding: [bounding.x, bounding.y, bounding.width, bounding.height],
      listRect: [list[0].x, list[0].y, list[0].width, list[0].height],
      rangeRect: [rangeList[0].x, rangeList[0].y, rangeList[0].width, rangeList[0].height],
      list, rangeList, empty,
      shape: {
        instance: list instanceof win.DOMRectList,
        rectInstance: list[0] instanceof win.DOMRect,
        tag: Object.prototype.toString.call(list),
        length: list.length,
        item: list.item(0) === list[0],
        iteration: [...list].length,
        emptyLength: empty.length,
        emptyItem: empty.item(0),
        missingItem: outcome(() => list.item()),
        uint32Item: outcome(() => list.item(4294967296) === list[0]),
        bigintItem: outcome(() => list.item(0n) === list[0]),
        illegalItem: outcome(() => win.DOMRectList.prototype.item.call({}, 0)),
        illegalLength: outcome(() => Object.getOwnPropertyDescriptor(win.DOMRectList.prototype, 'length').get.call({})),
      },
    };
  };
  const parent = measure(window);
  const frame = measure(child);
  const cross = (owner, foreign) => ({
    length: outcome(() => Object.getOwnPropertyDescriptor(owner.DOMRectList.prototype, 'length').get.call(foreign)),
    item: outcome(() => owner.DOMRectList.prototype.item.call(foreign, 0) === foreign[0]),
    iterator: outcome(() => Array.from(owner.DOMRectList.prototype[Symbol.iterator].call(foreign)).length),
  });
  return {
    parent: { bounding: parent.bounding, listRect: parent.listRect, rangeRect: parent.rangeRect, shape: parent.shape },
    frame: { bounding: frame.bounding, listRect: frame.listRect, rangeRect: frame.rangeRect, shape: frame.shape },
    parentOnFrame: cross(window, frame.list),
    frameOnParent: cross(child, parent.list),
    parentOnFrameRange: cross(window, frame.rangeList),
    frameOnParentRange: cross(child, parent.rangeList),
  };
})()`;

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function runPage(cdp, source) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] }, sessionId);
    if (source) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
    const frameHtml = '<!doctype html><html><body style="margin:0"><div id="box" style="position:fixed;left:10px;top:20px;width:130px;height:30px">text</div><div id="hidden" style="display:none">x</div></body></html>';
    const html = `<!doctype html><html><body style="margin:0"><div id="box" style="position:fixed;left:10px;top:20px;width:130px;height:30px">text</div><div id="hidden" style="display:none">x</div><iframe srcdoc="${frameHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></body></html>`;
    const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) }, sessionId);
    await loaded;
    const first = await evaluate(cdp, sessionId, probe);
    if (source) {
      await evaluate(cdp, sessionId, source);
      const second = await evaluate(cdp, sessionId, probe);
      assert.deepStrictEqual(second, first, 're-injection must not stack ClientRects noise');
    }
    return first;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

async function main() {
  await assertNetworkIsBlocked();
  console.log('PASS  system sandbox blocks inbound and outbound TCP');
  const executable = process.env.OPENBROWSER_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-clientrects-iframe-'));
  const fp = buildFingerprint({ id: 'clientrects-iframe-test', seed: '4a5b6c7d8e9f0123', privacy: {} });
  const args = [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profileDir}`,
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-gpu', '--no-proxy-server', '--use-mock-keychain',
    '--no-sandbox', '--disable-breakpad', '--disable-crash-reporter',
    '--host-resolver-rules=MAP * ~NOTFOUND', 'about:blank',
  ];
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: profileDir, OPENBROWSER_TEST_HEADLESS: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('error', (error) => { stderr += String(error); });
  const cdp = new PipeCdp(child);
  try {
    const version = await cdp.send('Browser.getVersion');
    console.log(`Browser: ${version.product}`);
    const baseline = await runPage(cdp, '');
    const injected = await runPage(cdp, buildInjectionScript(fp));
    console.log('Native baseline:', JSON.stringify(baseline));
    console.log('Injected result:', JSON.stringify(injected));
    for (const context of ['parent', 'frame']) {
      assert.deepStrictEqual(injected[context].shape, baseline[context].shape, `${context} DOMRectList contract differs from native`);
      assert.notStrictEqual(injected[context].bounding[0], baseline[context].bounding[0], `${context} rect noise was not applied`);
      assert.deepStrictEqual(injected[context].bounding, injected[context].listRect, `${context} element rectangle disagrees with list`);
    }
    for (const key of ['parentOnFrame', 'frameOnParent', 'parentOnFrameRange', 'frameOnParentRange']) {
      assert.deepStrictEqual(injected[key], baseline[key], `${key} cross-realm DOMRectList contract differs from native`);
    }
    assert.deepStrictEqual(injected.parent.bounding, injected.frame.bounding, 'parent and iframe noise differ');
    console.log('PASS  iframe and parent ClientRects match native cross-realm contracts');
  } catch (error) {
    if (stderr) console.error(stderr.slice(-5000));
    throw error;
  } finally {
    try { await cdp.send('Browser.close'); } catch (_) { child.kill('SIGTERM'); }
    await Promise.race([closed, new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000))]);
    if (fs.existsSync(profileDir)) {
      fs.readdirSync(profileDir);
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
    if (stderr && process.exitCode) console.error(stderr.slice(-5000));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
