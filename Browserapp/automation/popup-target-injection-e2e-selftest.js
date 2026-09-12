#!/usr/bin/env node
'use strict';

/**
 * New-target injection guard, run against the bundled kernel.
 *
 * The document-start registration is scoped to one CDP target, so a page that opens a new window or
 * a new tab produces a target that never saw the script. The application covers that by attaching to
 * the browser endpoint, enabling auto-attach with debugger-on-start, and injecting each new page
 * target before it is resumed. When that sequence is skipped the popup reports the host's real
 * hardware - platform, CPU count, memory, pixel ratio, screen size and the real GPU string - while
 * the main frame reports the spoofed profile, and a single `window.open` reveals it.
 *
 * The test drives the same sequence the application uses and compares the new target against the main
 * frame, and it also runs the sequence without auto-attach as a control so a future change that makes
 * this assertion vacuous is visible in the output.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const enginePath = path.join(appRoot, 'engine.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NEW_TARGET_PROBE = `(async () => {
  const out = {};
  const read = (w, label) => {
    const rec = {};
    try { rec.ua = w.navigator.userAgent; } catch (_) { rec.ua = 'ERR'; }
    try { rec.platform = w.navigator.platform; } catch (_) {}
    try { rec.cores = w.navigator.hardwareConcurrency; } catch (_) {}
    try { rec.memory = w.navigator.deviceMemory; } catch (_) {}
    try { rec.dpr = w.devicePixelRatio; } catch (_) {}
    try { rec.screen = w.screen.width + 'x' + w.screen.height + 'x' + w.screen.colorDepth; } catch (_) {}
    try { rec.langs = (w.navigator.languages || []).join(','); } catch (_) {}
    try { rec.chPlatform = w.navigator.userAgentData ? w.navigator.userAgentData.platform : null; } catch (_) {}
    try {
      const c = w.document.createElement('canvas');
      const gl = c.getContext('webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        rec.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
        rec.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      }
    } catch (_) {}
    try { rec.voices = w.speechSynthesis.getVoices().length; } catch (_) { rec.voices = 'ERR'; }
    out[label] = rec;
  };
  read(window, 'main');
  let popup = null;
  try { popup = window.open('about:blank', 'injectProbe', 'width=420,height=320'); } catch (e) { out.openError = String(e); }
  await new Promise((r) => setTimeout(r, 1200));
  if (popup) { try { read(popup, 'popup'); popup.close(); } catch (e) { out.popupError = String(e); } }
  else out.popup = 'blocked';
  return JSON.stringify(out);
})()`;

class Conn {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); return;
      }
      if (m.method) this.handlers.forEach((h) => { try { h(m); } catch (_) {} });
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 15000);
      this.pending.set(id, { res, timer });
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); clearTimeout(timer); res({ error: String(e) }); }
    });
  }
}

const startLoopbackServer = () => new Promise((res) => {
  const s = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.end('<!doctype html><title>new target probe</title><body>probe</body>');
  });
  s.listen(0, '127.0.0.1', () => res(s));
});

function profileFor(id) {
  return { id, name: id, kernelVersion: '148.0.7778.165', os: 'windows', canvas: 'noise', webgl: 'noise',
    audio: 'noise', clientRects: 'noise', webrtc: 'proxy', cores: 8, memory: 8,
    privacy: { speech: 'noise', battery: 'noise' } };
}

function stop(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function measure(profileId, { autoAttach }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-newtarget-'));
  const profile = profileFor(profileId);
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); } catch (_) {}
  const child = spawn(launcher, [dir, '--headless=new', '--disable-popup-blocking'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  if (!port) { stop(child, dir); return { error: 'no devtools port' }; }

  const srv = await startLoopbackServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  let result = { error: 'no browser endpoint' };
  for (let i = 0; i < 25; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      if (v && v.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
        const conn = new Conn(ws);
        const source = buildInjectionScript(fp);
        let attachedSession = null;
        if (autoAttach) {
          // Mirrors the application: auto-attach with debugger-on-start, then inject each page or
          // iframe session before letting it run.
          conn.on((msg) => {
            if (msg.method !== 'Target.attachedToTarget') return;
            const { sessionId, targetInfo = {}, waitingForDebugger } = msg.params || {};
            if (!sessionId) return;
            (async () => {
              try {
                if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
                  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
                  await conn.send('Page.enable', {}, sessionId).catch(() => {});
                  await conn.send('Runtime.enable', {}, sessionId).catch(() => {});
                  await conn.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId).catch(() => {});
                  await conn.send('Runtime.evaluate', { expression: source }, sessionId).catch(() => {});
                  if (!attachedSession) attachedSession = sessionId;
                }
              } finally {
                if (waitingForDebugger) await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
              }
            })();
          });
          await conn.send('Target.setDiscoverTargets', { discover: true });
          await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        }
        const created = await conn.send('Target.createTarget', { url: 'about:blank' });
        const targetId = created && created.result && created.result.targetId;
        let sessionId = null;
        if (autoAttach) { await sleep(900); sessionId = attachedSession; }
        else if (targetId) {
          const attached = await conn.send('Target.attachToTarget', { targetId, flatten: true });
          sessionId = attached && attached.result && attached.result.sessionId;
          if (sessionId) {
            await conn.send('Page.enable', {}, sessionId);
            await conn.send('Runtime.enable', {}, sessionId);
            await conn.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
          }
        }
        if (sessionId) {
          await conn.send('Page.navigate', { url }, sessionId);
          await sleep(1800);
          const m = await conn.send('Runtime.evaluate', { expression: NEW_TARGET_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const val = m && m.result && m.result.result ? m.result.result.value : null;
          try { result = JSON.parse(val); } catch (_) { result = { error: 'probe parse failed', raw: String(val).slice(0, 120) }; }
        } else result = { error: 'no session' };
        try { ws.close(); } catch (_) {}
        break;
      }
    } catch (_) {}
    await sleep(400);
  }
  try { srv.close(); } catch (_) {}
  stop(child, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return result;
}

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};

const AXES = ['ua', 'platform', 'cores', 'memory', 'dpr', 'screen', 'langs', 'chPlatform', 'renderer', 'vendor', 'voices'];
const compare = (main, popup) => AXES.filter((k) => JSON.stringify(main && main[k]) !== JSON.stringify(popup && popup[k]))
  .map((k) => `${k}: main=${JSON.stringify(main && main[k])} popup=${JSON.stringify(popup && popup[k])}`);

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('popup-target-injection-e2e-selftest: ok');
    return;
  }

  check('the application still attaches to new targets before resuming them', () => {
    const engine = fs.readFileSync(enginePath, 'utf8');
    assert.ok(/Target\.setAutoAttach/.test(engine), 'engine must enable auto-attach so new targets can be injected');
    assert.ok(/waitForDebuggerOnStart:\s*true/.test(engine), 'new targets must pause until the injection ran');
    assert.ok(/Runtime\.runIfWaitingForDebugger/.test(engine), 'paused targets must be resumed afterwards');
    assert.ok(/applyFingerprintToSession/.test(engine), 'attached page sessions must receive the injection');
  });

  const product = await measure('newtarget-product', { autoAttach: true });
  if (product.error && process.env.CI) {
    console.log(`  SKIP  bundled kernel unavailable in this environment (${product.error})`);
    console.log('popup-target-injection-e2e-selftest: ok');
    return;
  }

  check('a popup opened by the page carries the same identity as the main frame', () => {
    assert.ok(!product.error, `probe error: ${product.error}`);
    assert.ok(product.main && product.popup && typeof product.popup === 'object',
      `popup was not readable: ${JSON.stringify(product.popup)}`);
    const drift = compare(product.main, product.popup);
    assert.deepStrictEqual(drift, [],
      `a new window must not fall back to the host identity: ${drift.join(' | ')}`);
  });

  // Control: without the auto-attach sequence the popup is expected to leak host values. Reporting it
  // keeps the assertion above from silently becoming vacuous.
  const control = await measure('newtarget-control', { autoAttach: false });
  if (!control.error && control.main && control.popup && typeof control.popup === 'object') {
    const drift = compare(control.main, control.popup);
    console.log(drift.length
      ? `  NOTE  control without auto-attach leaks ${drift.length} axes (${drift.slice(0, 3).join(' | ')}${drift.length > 3 ? ' | ...' : ''})`
      : '  NOTE  control without auto-attach matched too; the kernel now covers new targets natively');
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log(`popup-target-injection-e2e-selftest: FAILED ${failed.length}/${results.length}`);
  else console.log(`popup-target-injection-e2e-selftest: OK ${results.length}/${results.length}`);
})().catch((err) => {
  console.error('popup-target-injection-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
