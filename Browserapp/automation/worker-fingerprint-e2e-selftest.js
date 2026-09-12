#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for worker-scope fingerprint injection.
 *
 * Main-thread spoofing is not enough: a page can spawn a Worker and read WorkerNavigator plus
 * OffscreenCanvas, so any surface that is only patched on the main thread becomes an oracle that
 * exposes the real hardware. This test drives the real kernel through the same attach sequence the
 * engine uses (browser-level auto-attach, then a nested auto-attach on the page session with
 * waitForDebuggerOnStart) and asserts the worker sees the profile identity, not the host.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFingerprint, buildInjectionScript, buildWorkerInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const WORKER_SRC = `self.onmessage = () => {
  const c = new OffscreenCanvas(300, 150);
  const g = c.getContext('2d');
  g.textBaseline = 'top'; g.font = '14px Arial'; g.fillStyle = '#f60'; g.fillRect(0, 0, 300, 150);
  g.fillStyle = '#069'; g.fillText('OB-W', 2, 2);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(255,0,255)';
  g.beginPath(); g.arc(50, 50, 50, 0, Math.PI * 2, true); g.fill();
  const d = g.getImageData(0, 0, 300, 150).data;
  let h = 0; for (let i = 0; i < d.length; i += 97) h = ((h << 5) - h + d[i]) | 0;
  let glVendor = null; let glRenderer = null;
  try {
    const gl = new OffscreenCanvas(64, 64).getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      glVendor = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
      glRenderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    }
  } catch (e) { glRenderer = 'ERR:' + e.name; }
  self.postMessage({ hash: h >>> 0, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory,
    ua: navigator.userAgent, platform: navigator.platform, langs: (navigator.languages || []).join(','),
    glVendor, glRenderer });
};`;

const results = [];
const check = (name, fn) => {
  try { const d = fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}${d ? ` — ${d}` : ''}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer }); this.ws.send(JSON.stringify(msg));
    });
  }
  async eval(expression, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const v = m && m.result && m.result.result && m.result.result.value;
    return v === undefined ? null : v;
  }
  async waitEvent(method, pred, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = this.events.findIndex((e) => e.method === method && (!pred || pred(e)));
      if (i >= 0) return this.events.splice(i, 1)[0];
      await sleep(80);
    }
    return null;
  }
}

function stop(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('worker-fingerprint-e2e-selftest: ok');
    return;
  }

  const profile = {
    id: 'worker-fp-e2e', name: 'worker-fp-e2e', kernelVersion: '148.0.7778.165', os: 'windows',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise', webrtc: 'proxy',
    cores: 8, memory: 8, userAgent: WINDOWS_UA, privacy: {},
  };
  const fp = buildFingerprint(profile);
  const mainInject = buildInjectionScript(fp);
  const workerInject = buildWorkerInjectionScript(fp);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-worker-fp-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  if (!port) {
    stop(child, dir);
    console.log('  SKIP  kernel did not expose a CDP endpoint');
    console.log('worker-fingerprint-e2e-selftest: ok');
    return;
  }

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const targets = await cdp.send('Target.getTargets', {});
  const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
  const att = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
  const pageSession = att.result.sessionId;
  await cdp.send('Page.enable', {}, pageSession);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);
  await cdp.send('Runtime.evaluate', { expression: mainInject, returnByValue: true }, pageSession);

  const createExpr = `(function () {
    const src = ${JSON.stringify(WORKER_SRC)};
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w = new Worker(url);
    window.__w = w;
    window.__wResult = new Promise((res) => { w.onmessage = (e) => res(e.data); });
    return 'created';
  })()`;

  async function runWorker(inject) {
    cdp.events = cdp.events.filter((e) => e.method !== 'Target.attachedToTarget');
    const created = await cdp.eval(createExpr, pageSession);
    if (created !== 'created') return { error: `worker create failed: ${created}` };
    const ev = await cdp.waitEvent('Target.attachedToTarget', (e) => {
      const info = (e.params && e.params.targetInfo) || {};
      return (info.type === 'worker' || info.type === 'shared_worker') && String(info.url || '').startsWith('blob:');
    });
    if (!ev) return { error: 'worker target never attached' };
    const sid = ev.params.sessionId;
    let injectInfo = 'skipped';
    if (inject) {
      const r = await cdp.send('Runtime.evaluate', { expression: workerInject, returnByValue: true }, sid);
      const ex = r && r.result && r.result.exceptionDetails;
      injectInfo = ex ? `exception: ${String(ex.text).slice(0, 60)}` : 'ok';
    }
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sid);
    await sleep(300);
    const val = await cdp.eval('window.__w.postMessage(1); window.__wResult', pageSession);
    await cdp.eval('window.__w.terminate(); true', pageSession);
    return { value: val, injectInfo };
  }

  const baseline = await runWorker(false);
  await sleep(400);
  const injected = await runWorker(true);
  try { ws.close(); } catch (_) {}
  stop(child, dir);

  check('worker target attaches and can be injected', () => {
    assert.ok(!injected.error, `worker injection error: ${injected.error}`);
    assert.strictEqual(injected.injectInfo, 'ok', `worker inject result: ${injected.injectInfo}`);
  });
  check('worker OffscreenCanvas noise differs from the un-injected worker', () => {
    assert.ok(baseline && baseline.value, 'baseline worker value');
    assert.ok(injected && injected.value, 'injected worker value');
    assert.notStrictEqual(injected.value.hash, baseline.value.hash, 'OffscreenCanvas hash must change');
  });
  check('worker WebGL metadata matches the profile', () => {
    const w = injected.value;
    assert.ok(w.glRenderer && !String(w.glRenderer).startsWith('ERR:'), `worker webgl readable (${w.glRenderer})`);
    if (fp.webgl && fp.webgl.renderer) {
      assert.strictEqual(w.glRenderer, fp.webgl.renderer, 'worker UNMASKED_RENDERER_WEBGL must match the profile');
    }
  });
  check('worker navigator carries the profile identity, not the host', () => {
    const w = injected.value;
    assert.strictEqual(w.platform, fp.platform, `worker platform ${w.platform} !== ${fp.platform}`);
    assert.strictEqual(w.ua, fp.userAgent, 'worker userAgent must match the profile');
    assert.strictEqual(Number(w.cores), Number(fp.hardwareConcurrency), `worker cores ${w.cores} !== ${fp.hardwareConcurrency}`);
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`worker-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`worker-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('worker-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
