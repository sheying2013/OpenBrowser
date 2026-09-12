#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for document lifecycle paths that rebuild a document without a new target.
 *
 * Two paths are easy to get wrong and are both readable by a page:
 *
 *   1. `document.open()/write()` replaces the document but keeps the realm, so anything the layer
 *      installed per document has to survive and nothing may be added twice.
 *   2. a named window (`window.open('', name)`) returns the window that already exists, and that
 *      window can be navigated again and again. Every one of those documents has to carry the same
 *      profile identity, and its observable surface has to stay exactly what the un-injected build
 *      exposes.
 *
 * Both passes drive the kernel the way the engine does: the child frame is attached with
 * waitForDebuggerOnStart, `applyFingerprintToTab` runs on that session before it is resumed.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
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

const SNAPSHOT = `(() => {
  const proto = Object.getPrototypeOf(navigator);
  const descriptor = (key) => { const d = Object.getOwnPropertyDescriptor(proto, key); return d && d.get ? String(d.get).slice(0, 44) : null; };
  const canvasHash = () => {
    try {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 90;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top'; ctx.font = '13px Arial'; ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 180, 90);
      ctx.fillStyle = '#069'; ctx.fillText('OB-DOC', 2, 2);
      const data = ctx.getImageData(0, 0, 180, 90).data;
      let h = 0; for (let i = 0; i < data.length; i += 53) h = ((h << 5) - h + data[i]) | 0;
      return h >>> 0;
    } catch (error) { return 'ERR:' + error.name; }
  };
  return JSON.stringify({
    url: location.href,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    ua: navigator.userAgent,
    languages: (navigator.languages || []).join(','),
    canvas: canvasHash(),
    protoOwn: Object.getOwnPropertyNames(proto).sort(),
    platformGetter: descriptor('platform'),
  });
})()`;

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
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 15000);
      this.pending.set(id, { res, timer }); this.ws.send(JSON.stringify(msg));
    });
  }
  async value(expression, sessionId, userGesture = false) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    const r = m && m.result;
    if (r && r.exceptionDetails) return { error: 'exception:' + String(r.exceptionDetails.text).slice(0, 90) };
    return { value: r && r.result ? r.result.value : null };
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

async function run(inject, profile, fp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-doclife-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/other.html')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>other</body></html>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>document lifecycle probe</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try { const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10); if (p > 0) { port = p; break; } } catch (_) {}
  }
  const teardown = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { server.close(); } catch (_) {}
  };
  if (!port) { teardown(); return { error: 'no devtools port' }; }

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);
  const childSessions = new Map();
  const out = {};
  let pumping = true;
  try {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = await cdp.send('Target.getTargets', {});
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attached.result.sessionId;
    await cdp.send('Page.enable', {}, pageSession);
    if (inject) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: require('./fingerprint').buildInjectionScript(fp) }, pageSession);

    const pump = (async () => {
      while (pumping) {
        const event = await cdp.waitEvent('Target.attachedToTarget', null, 250);
        if (!event) continue;
        const info = event.params.targetInfo || {};
        const session = event.params.sessionId;
        try {
          if (info.type === 'page' || info.type === 'iframe') {
            await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
            if (inject) {
              // The engine's chain: patch the child session before letting it run.
              const sessionCall = (method, params = {}) => cdp.send(method, params, session);
              await applyFingerprintToTab(sessionCall, null, fp, profile, { applyKey: 'session:' + String(info.targetId) });
            }
            childSessions.set(String(info.targetId), session);
          }
        } catch (error) { out.childError = String((error && error.message) || error); }
        if (event.params.waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, session);
      }
    })();

    await cdp.send('Page.navigate', { url: base + '/' }, pageSession);
    await sleep(1500);
    out.mainInitial = JSON.parse((await cdp.value(SNAPSHOT, pageSession)).value || 'null');

    // document.open()/write(): same realm, new document.
    await cdp.value(`(() => {
      document.open();
      document.write('<html><head></head><body>rewritten</body></html>');
      document.close();
      return 'ok';
    })()`, pageSession);
    await sleep(700);
    out.mainRewritten = JSON.parse((await cdp.value(SNAPSHOT, pageSession)).value || 'null');

    // Named window: the second open must return the first window, and each of its documents has to
    // carry the same identity.
    const named = await cdp.value(`(() => {
      const first = window.open('${base}/other.html', 'obDocLifecycle');
      if (!first) return JSON.stringify({ error: 'blocked' });
      first.__obNamedMarker = 'first';
      const second = window.open('', 'obDocLifecycle');
      return JSON.stringify({ same: first === second, marker: second ? second.__obNamedMarker : null });
    })()`, pageSession, true);
    out.namedReuse = named.value ? JSON.parse(named.value) : { error: named.error || 'no-value' };
    await sleep(1200);

    const readPopup = async (targetId) => {
      const session = childSessions.get(String(targetId)) || (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
      const probe = await cdp.value(SNAPSHOT, session);
      return probe.value ? JSON.parse(probe.value) : { error: probe.error || 'no-value' };
    };
    const findPopup = async (needle) => {
      const list = await cdp.send('Target.getTargets', {});
      return ((list.result || {}).targetInfos || []).find((t) => t.type === 'page' && String(t.url).indexOf(needle) >= 0);
    };

    const popup = await findPopup('/other.html');
    if (popup) {
      out.namedFirstDocument = await readPopup(popup.targetId);
      const session = childSessions.get(String(popup.targetId)) || (await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).result.sessionId;
      await cdp.value(`(() => { window.location.href = '${base}/other.html?second=1'; return 'ok'; })()`, session);
      await sleep(1500);
      out.namedSecondDocument = await readPopup(popup.targetId);
    } else {
      out.namedFirstDocument = { error: 'popup target not found' };
      out.namedSecondDocument = { error: 'popup target not found' };
    }
    pumping = false;
    await Promise.race([pump, sleep(500)]);
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  pumping = false;
  try { ws.close(); } catch (_) {}
  teardown();
  return out;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 kernel launcher unavailable');
    console.log('document-lifecycle-fingerprint-e2e-selftest: ok');
    return;
  }
  const profile = {
    id: 'document-lifecycle-probe', name: 'document-lifecycle-probe', kernelVersion: '148.0.7778.165', os: 'windows',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise', cores: 8, memory: 8, privacy: {},
  };
  const fp = buildFingerprint(profile);
  const baseline = await run(false, profile, fp);
  const injected = await run(true, profile, fp);
  fs.writeFileSync(path.join(os.tmpdir(), 'openbrowser-doc-lifecycle-baseline.json'), JSON.stringify(baseline, null, 1));
  fs.writeFileSync(path.join(os.tmpdir(), 'openbrowser-doc-lifecycle-injected.json'), JSON.stringify(injected, null, 1));

  const stages = ['mainInitial', 'mainRewritten', 'namedFirstDocument', 'namedSecondDocument'];
  if (baseline.error || injected.error) {
    skip('document lifecycle probe completed', String(baseline.error || injected.error));
  } else {
    check('every document carries the profile identity', () => {
      for (const stage of stages) {
        const value = injected[stage];
        assert.ok(value && !value.error, `${stage} snapshot: ${JSON.stringify(value && value.error)}`);
        assert.strictEqual(value.platform, fp.platform, `${stage} platform`);
        assert.strictEqual(value.ua, fp.userAgent, `${stage} userAgent`);
        assert.strictEqual(Number(value.cores), Number(fp.hardwareConcurrency), `${stage} hardwareConcurrency`);
      }
    });
    check('the probe environment differs from the profile (test is sensitive)', () => {
      assert.notStrictEqual(baseline.mainInitial.platform, fp.platform, 'platform must differ from the profile');
      assert.notStrictEqual(baseline.mainInitial.canvas, injected.mainInitial.canvas, 'canvas must differ from the profile');
    });
    if (Number(baseline.mainInitial.cores) === Number(fp.hardwareConcurrency)) {
      skip('hardwareConcurrency is observable in this environment', 'the pooled core count equals the host core count');
    } else {
      check('hardwareConcurrency comes from the profile, not the host', () => {
        assert.strictEqual(Number(injected.mainInitial.cores), Number(fp.hardwareConcurrency), 'hardwareConcurrency');
      });
    }
    check('no document gains or loses a navigator member', () => {
      for (const stage of stages) {
        const before = baseline[stage];
        const after = injected[stage];
        assert.ok(before, `${stage} baseline snapshot missing`);
        assert.deepStrictEqual(after.protoOwn, before.protoOwn, `${stage} Navigator.prototype member list`);
        assert.strictEqual(after.platformGetter, before.platformGetter, `${stage} platform getter source`);
        assert.ok(String(after.platformGetter).indexOf('[native code]') >= 0, `${stage} platform getter must read as native`);
      }
    });
    check('document.open()/write() keeps the same member list as before the rewrite', () => {
      assert.deepStrictEqual(injected.mainRewritten.protoOwn, injected.mainInitial.protoOwn, 'member list across document.open()');
      assert.strictEqual(injected.mainRewritten.platformGetter, injected.mainInitial.platformGetter, 'getter identity across document.open()');
    });
    check('a named window is reused rather than recreated', () => {
      assert.strictEqual(injected.namedReuse.same, true, 'window.open("", name) must return the same window');
      assert.strictEqual(baseline.namedReuse.same, true, 'the un-injected build must behave the same');
      assert.strictEqual(injected.namedReuse.marker, 'first', 'the reused window must be the one that was opened first');
    });
    check('the reused window renders a distinct document on each navigation', () => {
      assert.notStrictEqual(injected.namedFirstDocument.url, injected.namedSecondDocument.url, 'both documents must be observable');
      assert.notStrictEqual(injected.namedFirstDocument.canvas, baseline.namedFirstDocument.canvas, 'the first document must carry profile noise, not the host surface');
      assert.notStrictEqual(injected.namedSecondDocument.canvas, baseline.namedSecondDocument.canvas, 'the second document must carry profile noise, not the host surface');
    });
  }

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`document-lifecycle-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`document-lifecycle-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('document-lifecycle-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
