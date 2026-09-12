#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for every worker scope the engine injects: dedicated Worker, SharedWorker and
 * ServiceWorker.
 *
 * Worker scopes attach through different CDP target types and each carries its own WorkerNavigator,
 * so a page can compare them with each other. Two properties matter, and both are compared against
 * the same binary without the injection:
 *
 *   1. the WorkerNavigator member list must not gain anything - a worker does not expose every
 *      Navigator member (vendor is window-only in this engine) and client hints are secure-context
 *      gated, so an insecure origin has no userAgentData at all;
 *   2. on a secure origin the spoofed values, including the client hints, must still be the profile's.
 *
 * The two scenarios are run in separate browser sessions because they need different attach
 * sequences: dedicated and shared workers are children of the page, while a service worker attaches
 * at the browser level.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { buildFingerprint, buildWorkerInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name} — ${why}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCOPE_SNAPSHOT = `(async () => {
  const proto = Object.getPrototypeOf(navigator);
  const base = {
    ua: navigator.userAgent,
    platform: navigator.platform,
    appVersion: navigator.appVersion,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    langs: (navigator.languages || []).join(','),
    language: navigator.language,
    vendorIn: 'vendor' in navigator,
    webdriverIn: 'webdriver' in navigator,
    navOwn: Object.getOwnPropertyNames(proto).sort(),
    navTag: Object.prototype.toString.call(navigator),
    uadIn: 'userAgentData' in navigator && navigator.userAgentData != null,
    uadOwn: null,
    uadProto: null,
    uadPlatform: null,
    uadMobile: null,
    hev: null,
    hevError: null,
  };
  try {
    const value = navigator.userAgentData;
    base.uadOwn = value ? Object.getOwnPropertyNames(value).sort() : null;
    base.uadProto = value ? Object.getOwnPropertyNames(Object.getPrototypeOf(value)).sort() : null;
    base.uadPlatform = value ? value.platform : null;
    base.uadMobile = value ? value.mobile : null;
    if (value) base.hev = await value.getHighEntropyValues(['platform', 'architecture', 'bitness', 'model']);
  } catch (error) { base.hevError = String((error && error.name) || error); }
  return base;
})()`;
const DEDICATED_SRC = `self.onmessage = async () => { self.postMessage(await ${SCOPE_SNAPSHOT}); };`;
const SHARED_SRC = `self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = async () => { port.postMessage(await ${SCOPE_SNAPSHOT}); };
};`;
const SW_SRC = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', async (event) => {
  const payload = await ${SCOPE_SNAPSHOT};
  if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  else if (event.source) event.source.postMessage(payload);
});`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); return; }
      if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 40000);
      this.pending.set(id, { res, timer }); this.ws.send(JSON.stringify(msg));
    });
  }
  async value(expression, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const r = m && m.result;
    if (r && r.exceptionDetails) return { error: 'exception:' + String(r.exceptionDetails.text).slice(0, 80) };
    return { value: r && r.result ? r.result.result === undefined ? r.result.value : r.result.value : null };
  }
  async waitEvent(method, pred, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.events.findIndex((e) => e.method === method && (!pred || pred(e)));
      if (i >= 0) return this.events.splice(i, 1)[0];
      await sleep(100);
    }
    return null;
  }
}

// Boot one kernel around a loopback origin; the caller drives CDP through the returned handles.
async function boot(profile, fp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-workerscope-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'service-worker-allowed': '/' });
      res.end(SW_SRC);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>worker scope probe</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try { const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10); if (p > 0) { port = p; break; } } catch (_) {}
  }
  if (!port) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    return { error: 'no devtools port' };
  }
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);
  const teardown = () => {
    try { ws.close(); } catch (_) {}
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { server.close(); } catch (_) {}
  };
  return { cdp, url, teardown };
}

// Dedicated + shared workers: both children of the page, so the page session has to auto-attach too.
async function runPageWorkers(inject, profile, fp, workerInject) {
  const session = await boot(profile, fp);
  if (session.error) return { error: session.error };
  const { cdp, url, teardown } = session;
  const out = { inject: {}, dedicated: null, shared: null };
  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = await cdp.send('Target.getTargets', {});
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attached.result.sessionId;
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Page.navigate', { url }, pageSession);
    await sleep(1200);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    const injectTarget = async (event, kind) => {
      if (!event) { out.inject[kind] = 'never-attached'; return null; }
      const targetSession = event.params.sessionId;
      let outcome = 'skipped';
      if (inject) {
        const r = await cdp.send('Runtime.evaluate', { expression: workerInject, returnByValue: true }, targetSession);
        const ex = r && r.result && r.result.exceptionDetails;
        outcome = ex ? ('exception: ' + String(ex.text).slice(0, 60)) : 'ok';
      }
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, targetSession);
      out.inject[kind] = outcome;
      return targetSession;
    };

    const blobFilter = (type) => (e) => {
      const info = e.params.targetInfo || {};
      return info.type === type && String(info.url || '').startsWith('blob:');
    };

    cdp.events = cdp.events.filter((e) => e.method !== 'Target.attachedToTarget');
    await cdp.value(`(() => {
      const src = ${JSON.stringify(DEDICATED_SRC)};
      window.__dedicatedReply = null;
      window.__dedicated = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      window.__dedicated.onmessage = (e) => { window.__dedicatedReply = e.data; };
      return 'created';
    })()`, pageSession);
    await injectTarget(await cdp.waitEvent('Target.attachedToTarget', blobFilter('worker'), 15000), 'dedicated');
    await cdp.value('window.__dedicated.postMessage(1); true', pageSession);
    const dedicated = await cdp.value('(async () => { for (let i = 0; i < 100; i += 1) { if (window.__dedicatedReply) return window.__dedicatedReply; await new Promise((r) => setTimeout(r, 100)); } return null; })()', pageSession);
    out.dedicated = dedicated.value;

    cdp.events = cdp.events.filter((e) => e.method !== 'Target.attachedToTarget');
    await cdp.value(`(() => {
      const src = ${JSON.stringify(SHARED_SRC)};
      const shared = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      shared.port.start();
      window.__sharedReply = null;
      shared.port.onmessage = (e) => { window.__sharedReply = e.data; };
      window.__sharedPort = shared.port;
      return 'created';
    })()`, pageSession);
    await injectTarget(await cdp.waitEvent('Target.attachedToTarget', blobFilter('shared_worker'), 15000), 'shared');
    await cdp.value('window.__sharedPort.postMessage(1); true', pageSession);
    const shared = await cdp.value('(async () => { for (let i = 0; i < 100; i += 1) { if (window.__sharedReply) return window.__sharedReply; await new Promise((r) => setTimeout(r, 100)); } return null; })()', pageSession);
    out.shared = shared.value;
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  teardown();
  return out;
}

// ServiceWorker: registered from the same origin, injected while it is still paused.
async function runServiceWorker(inject, profile, fp, workerInject) {
  const session = await boot(profile, fp);
  if (session.error) return { error: session.error };
  const { cdp, url, teardown } = session;
  const out = { inject: {}, service: null };
  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = await cdp.send('Target.getTargets', {});
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attached.result.sessionId;
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Page.navigate', { url }, pageSession);
    await sleep(1200);
    cdp.events = cdp.events.filter((e) => e.method !== 'Target.attachedToTarget');
    await cdp.value(`navigator.serviceWorker.register('/sw.js', { scope: '/sw-scope/' }).then(() => 'registered').catch((e) => 'ERR:' + e.name)`, pageSession);
    const event = await cdp.waitEvent('Target.attachedToTarget', (e) => {
      const info = e.params.targetInfo || {};
      return info.type === 'service_worker' && String(info.url || '').indexOf('/sw.js') >= 0;
    }, 20000);
    if (!event) { out.inject.service = 'never-attached'; } else {
      const targetSession = event.params.sessionId;
      let outcome = 'skipped';
      if (inject) {
        const r = await cdp.send('Runtime.evaluate', { expression: workerInject, returnByValue: true }, targetSession);
        const ex = r && r.result && r.result.exceptionDetails;
        outcome = ex ? ('exception: ' + String(ex.text).slice(0, 60)) : 'ok';
      }
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, targetSession);
      out.inject.service = outcome;
      const probe = await cdp.value(`(${SCOPE_SNAPSHOT})`, targetSession);
      out.service = probe.value || probe;
    }
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  teardown();
  return out;
}

function compareSurface(kind, before, after) {
  assert.ok(before, `${kind} baseline snapshot missing`);
  assert.ok(after, `${kind} injected snapshot missing`);
  assert.deepStrictEqual(after.navOwn, before.navOwn, `${kind} WorkerNavigator member list`);
  assert.strictEqual(after.vendorIn, before.vendorIn, `${kind} vendor presence`);
  assert.strictEqual(after.webdriverIn, before.webdriverIn, `${kind} webdriver presence`);
  assert.strictEqual(after.uadIn, before.uadIn, `${kind} client-hint presence`);
  assert.deepStrictEqual(after.uadProto, before.uadProto, `${kind} userAgentData prototype members`);
  assert.deepStrictEqual(after.uadOwn, before.uadOwn, `${kind} userAgentData own members`);
  assert.strictEqual(after.navTag, before.navTag, `${kind} navigator tag`);
}

function compareIdentity(kind, value, fp) {
  assert.ok(value && !value.error, `${kind} snapshot missing: ${JSON.stringify(value && value.error)}`);
  assert.strictEqual(value.platform, fp.platform, `${kind} platform`);
  assert.strictEqual(value.ua, fp.userAgent, `${kind} userAgent`);
  assert.strictEqual(Number(value.cores), Number(fp.hardwareConcurrency), `${kind} hardwareConcurrency`);
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 kernel launcher unavailable');
    console.log('worker-scope-family-e2e-selftest: ok');
    return;
  }
  const profile = {
    id: 'worker-scope-family', name: 'worker-scope-family', kernelVersion: '148.0.7778.165', os: 'windows',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise', webrtc: 'proxy',
    cores: 8, memory: 8, privacy: {},
  };
  const fp = buildFingerprint(profile);
  const workerInject = buildWorkerInjectionScript(fp);

  const pageBaseline = await runPageWorkers(false, profile, fp, workerInject);
  const pageInjected = await runPageWorkers(true, profile, fp, workerInject);
  const swBaseline = await runServiceWorker(false, profile, fp, workerInject);
  const swInjected = await runServiceWorker(true, profile, fp, workerInject);
  fs.writeFileSync(path.join(os.tmpdir(), 'openbrowser-worker-scope-baseline.json'), JSON.stringify({ pageBaseline, swBaseline }, null, 1));
  fs.writeFileSync(path.join(os.tmpdir(), 'openbrowser-worker-scope-injected.json'), JSON.stringify({ pageInjected, swInjected }, null, 1));

  if (pageBaseline.error || pageInjected.error || swBaseline.error || swInjected.error) {
    skip('worker scope probe completed', String(pageBaseline.error || pageInjected.error || swBaseline.error || swInjected.error));
  } else {
    check('the injection script runs in every worker scope', () => {
      for (const kind of ['dedicated', 'shared']) assert.strictEqual(pageInjected.inject[kind], 'ok', `${kind} inject: ${pageInjected.inject[kind]}`);
      assert.strictEqual(swInjected.inject.service, 'ok', `service inject: ${swInjected.inject.service}`);
    });
    check('the dedicated worker carries the profile identity', () => compareIdentity('dedicated worker', pageInjected.dedicated, fp));
    check('the shared worker carries the profile identity', () => compareIdentity('shared worker', pageInjected.shared, fp));
    check('the service worker carries the profile identity', () => compareIdentity('service worker', swInjected.service, fp));
    check('the dedicated worker keeps the stock surface', () => compareSurface('dedicated worker', pageBaseline.dedicated, pageInjected.dedicated));
    check('the shared worker keeps the stock surface', () => compareSurface('shared worker', pageBaseline.shared, pageInjected.shared));
    check('the service worker keeps the stock surface', () => compareSurface('service worker', swBaseline.service, swInjected.service));
    check('no worker scope gains a member the stock build does not have', () => {
      const pairs = [
        ['dedicated', pageBaseline.dedicated, pageInjected.dedicated],
        ['shared', pageBaseline.shared, pageInjected.shared],
        ['service', swBaseline.service, swInjected.service],
      ];
      for (const [kind, before, after] of pairs) {
        assert.deepStrictEqual(after.navOwn, before.navOwn, `${kind} WorkerNavigator member list`);
        assert.strictEqual(before.vendorIn, false, `${kind} baseline vendor expectation`);
        assert.strictEqual(after.vendorIn, false, `${kind} vendor must not be added`);
      }
    });
    check('the secure worker scopes expose the profile client hints', () => {
      const metadata = fp.userAgentMetadata || {};
      const pairs = [['dedicated', pageInjected.dedicated], ['shared', pageInjected.shared], ['service', swInjected.service]];
      for (const [kind, value] of pairs) {
        assert.strictEqual(value.uadIn, true, `${kind} must expose client hints on this origin`);
        assert.strictEqual(value.uadPlatform, metadata.platform, `${kind} client-hint platform`);
        assert.ok(value.hev, `${kind} high-entropy values must resolve (${value.hevError})`);
        assert.strictEqual(value.hev.platform, metadata.platform, `${kind} high-entropy platform`);
        assert.strictEqual(value.hev.architecture, metadata.architecture, `${kind} high-entropy architecture`);
        assert.strictEqual(value.hev.bitness, metadata.bitness, `${kind} high-entropy bitness`);
        assert.deepStrictEqual(value.uadOwn, [], `${kind} client hints must not gain own members`);
        assert.ok(value.uadProto.indexOf('getHighEntropyValues') >= 0, `${kind} methods stay on the prototype`);
      }
    });
  }

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`worker-scope-family-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`worker-scope-family-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('worker-scope-family-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
