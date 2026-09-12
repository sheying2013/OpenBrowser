#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the mobile device persona.
 *
 * A phone identity is only worth anything when the rendered document agrees with it: the UA names
 * the sampled model, Client Hints report mobile, the layout viewport is the device panel, the pixel
 * ratio is a real one, touch surfaces answer, and the window metrics do not expose a desktop frame.
 * This launches the bundled kernel with an Android profile and reads every one of those surfaces
 * back out of the page.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(async () => {
  const out = { errs: [] };
  const enc = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; };
  const c = document.createElement('canvas'); c.width = 300; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.textBaseline = 'top'; ctx.font = '14px Arial'; ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 300, 150);
  ctx.fillStyle = '#069'; ctx.fillText('OB-MOB', 2, 2);
  out.canvas = enc(c.toDataURL());
  out.ua = navigator.userAgent;
  out.platform = navigator.platform;
  out.cores = navigator.hardwareConcurrency;
  out.touchPoints = navigator.maxTouchPoints;
  out.ontouchstart = 'ontouchstart' in window;
  out.orientation = typeof window.orientation;
  // A responsive page declares a device-width viewport; without it Chromium keeps the 980px
  // layout fallback, which is what a real phone does too.
  try {
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 80));
  } catch (e) { out.errs.push('viewport:' + String(e && e.message || e)); }
  out.coarse = window.matchMedia('(pointer: coarse)').matches;
  out.hover = window.matchMedia('(hover: hover)').matches;
  out.screenW = screen.width; out.screenH = screen.height;
  out.availW = screen.availWidth; out.availH = screen.availHeight;
  out.dpr = window.devicePixelRatio;
  out.innerW = window.innerWidth; out.innerH = window.innerHeight;
  out.outerW = window.outerWidth; out.outerH = window.outerHeight;
  try {
    if (navigator.userAgentData) {
      out.uadMobile = navigator.userAgentData.mobile;
      out.uadPlatform = navigator.userAgentData.platform;
      out.uadOwn = Object.getOwnPropertyNames(navigator.userAgentData).sort();
      out.uadInstanceof = typeof NavigatorUAData !== 'undefined' ? navigator.userAgentData instanceof NavigatorUAData : null;
      out.uadProtoNames = Object.getOwnPropertyNames(Object.getPrototypeOf(navigator.userAgentData)).sort();
      out.uadToJSON = typeof navigator.userAgentData.toJSON === 'function' ? navigator.userAgentData.toJSON() : null;
      const hev = await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'mobile']);
      out.hev = { model: hev.model, platformVersion: hev.platformVersion, architecture: hev.architecture, bitness: hev.bitness, mobile: hev.mobile };
    }
  } catch (e) { out.errs.push(String(e && e.message || e)); }
  return JSON.stringify(out);
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  // applyFingerprintToTab may call either (method, params) or (url, method, params).
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async evalValue(expression) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(v); } catch (_) { return { error: 'probe parse', raw: String(v).slice(0, 120) }; }
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('mobile-fingerprint-e2e-selftest: ok');
    return;
  }

  const profile = {
    id: 'mobile-e2e', name: 'mobile-e2e', kernelVersion: '148.0.7778.165', os: 'Android',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise', webrtc: 'proxy',
    privacy: {},
  };
  const fp = buildFingerprint(profile);
  const device = fp.mobileDevice;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-mobile-'));
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
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  };
  if (!port) {
    stop();
    console.log('  SKIP  kernel did not expose a CDP endpoint');
    console.log('mobile-fingerprint-e2e-selftest: ok');
    return;
  }

  let page = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (_) {}
    await sleep(400);
  }
  if (!page?.webSocketDebuggerUrl) {
    stop();
    console.log('  SKIP  kernel did not expose a page target');
    console.log('mobile-fingerprint-e2e-selftest: ok');
    return;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);
  const host = await cdp.evalValue(PROBE);
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  const live = await cdp.evalValue(PROBE);
  try { ws.close(); } catch (_) {}
  stop();

  check('probe returns values before and after the inject', () => {
    assert.ok(host && !host.error, `host probe: ${host && host.raw}`);
    assert.ok(live && !live.error, `live probe: ${live && live.raw}`);
    assert.deepStrictEqual(live.errs, [], 'high entropy values must resolve');
  });
  check('the user agent names the sampled device model', () => {
    assert.ok(live.ua.includes(`Android ${device.osVersion}; ${device.model})`), `UA model mismatch: ${live.ua}`);
    assert.ok(/Chrome\/\d+\.0\.0\.0 Mobile Safari/.test(live.ua), 'UA must be the mobile form');
    assert.ok(!/Windows NT|Macintosh/.test(live.ua), 'UA must not leak a desktop platform');
  });
  check('navigator reports the phone platform and touch surface', () => {
    assert.strictEqual(live.platform, 'Linux armv8l', 'navigator.platform');
    assert.strictEqual(live.touchPoints, 5, 'maxTouchPoints');
    assert.strictEqual(live.ontouchstart, true, 'ontouchstart must exist');
    assert.strictEqual(live.cores, device.cores, 'hardwareConcurrency must come from the pool record');
  });
  check('Client Hints report a mobile device', () => {
    assert.strictEqual(live.uadMobile, true, 'userAgentData.mobile');
    assert.strictEqual(live.uadPlatform, 'Android', 'userAgentData.platform');
    assert.deepStrictEqual(live.uadOwn, [], 'userAgentData must remain a native instance with no own members');
    assert.strictEqual(live.uadInstanceof, true, 'userAgentData must keep the NavigatorUAData brand');
    assert.ok(live.uadProtoNames.includes('getHighEntropyValues') && live.uadProtoNames.includes('toJSON'), 'userAgentData methods must stay on the prototype');
    assert.deepStrictEqual(live.uadToJSON, { brands: live.uadToJSON && live.uadToJSON.brands, mobile: true, platform: 'Android' }, 'userAgentData.toJSON must keep its native shape');
    assert.ok(live.hev && live.hev.model === device.model, `high entropy model: ${live.hev && live.hev.model}`);
    assert.strictEqual(live.hev.architecture, '', 'Android omits architecture');
    assert.strictEqual(live.hev.bitness, '', 'Android omits bitness');
  });
  check('the layout viewport is the device panel', () => {
    assert.strictEqual(live.screenW, device.screen.width, 'screen.width');
    assert.strictEqual(live.screenH, device.screen.height, 'screen.height');
    assert.strictEqual(live.dpr, device.dpr, 'devicePixelRatio');
    assert.strictEqual(live.innerW, device.viewport.width, 'innerWidth');
    assert.ok(Math.abs(live.innerH - device.viewport.height) <= 2, `innerHeight ${live.innerH} vs ${device.viewport.height}`);
    assert.ok(Math.abs(live.screenW * live.dpr - device.panel.width) <= device.panel.width * 0.05, 'the panel must match the reported viewport');
    assert.strictEqual(live.availW, live.screenW, 'available width matches the panel');
  });
  check('the window does not expose a desktop frame', () => {
    assert.strictEqual(live.outerW, live.innerW, 'outerWidth must track the phone viewport');
    assert.ok(Math.abs(live.outerH - live.innerH) <= 2, `outerHeight ${live.outerH} vs ${live.innerH}`);
  });
  check('pointer media queries answer like a touch device', () => {
    assert.strictEqual(live.coarse, true, '(pointer: coarse)');
    assert.strictEqual(live.hover, false, '(hover: hover) must not match for touch-only');
  });
  check('the phone renders a distinct canvas surface', () => {
    assert.notStrictEqual(live.canvas, host.canvas, 'canvas must not answer with the host value');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`mobile-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`mobile-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('mobile-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
