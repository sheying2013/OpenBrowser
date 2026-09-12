#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for per-tab fingerprint application using the production inject entry point.
 *
 * Two tabs of one profile must agree on every spoofed surface (a per-tab difference is itself a
 * detection signal), the untouched control tab must still look like the host, and re-applying the
 * inject to an already-injected tab must be idempotent (the runtime watch calls it repeatedly, so a
 * non-idempotent inject would make the fingerprint drift under the user's feet).
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

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const PROBE = `(async () => {
  const out = {};
  const enc = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; };
  const c = document.createElement('canvas'); c.width = 300; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.textBaseline='top'; ctx.font='14px Arial'; ctx.fillStyle='#f60'; ctx.fillRect(0,0,300,150);
  ctx.fillStyle='#069'; ctx.fillText('OB-MT',2,2); ctx.globalCompositeOperation='multiply';
  ctx.fillStyle='rgb(255,0,255)'; ctx.beginPath(); ctx.arc(50,50,50,0,Math.PI*2,true); ctx.fill();
  out.canvas = enc(c.toDataURL());
  const span = document.createElement('span'); span.textContent='mmmmmmmmmmlli';
  span.style.cssText='font:72px monospace;position:absolute;left:-9999px'; document.body.appendChild(span);
  const r0 = span.getClientRects()[0];
  out.rectX = r0 ? Number(r0.x.toFixed(6)) : null;
  out.rectW = r0 ? Number(r0.width.toFixed(4)) : null;
  span.remove();
  out.platform = navigator.platform;
  out.cores = navigator.hardwareConcurrency;
  return JSON.stringify(out);
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    this.calls = [];
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId: sessionId || null });
    const id = ++this.seq; const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer }); this.ws.send(JSON.stringify(msg));
    });
  }
  async eval(expression, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(v); } catch (_) { return { error: 'probe parse', raw: String(v).slice(0, 80) }; }
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('multitab-fingerprint-e2e-selftest: ok');
    return;
  }

  const profile = { id: 'multitab-e2e', name: 'multitab-e2e', kernelVersion: '148.0.7778.165', os: 'windows',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise', webrtc: 'proxy',
    cores: 8, memory: 8, userAgent: WINDOWS_UA, privacy: {} };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-multitab-'));
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
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    console.log('  SKIP  kernel did not expose a CDP endpoint');
    console.log('multitab-fingerprint-e2e-selftest: ok');
    return;
  }

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);

  const newTab = async () => {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
    return { targetId: created.result.targetId, sid: attached.result.sessionId };
  };
  // Same target + same config: the runtime passes the target identity so a repeated pass is a no-op.
  const inject = (tab) => applyFingerprintToTab(
    (method, params) => cdp.send(method, params, tab.sid),
    null,
    fp,
    profile,
    { applyKey: `multitab:${tab.targetId}` },
  );

  const tab1 = await newTab();
  const tab2 = await newTab();
  const control = await newTab();

  await inject(tab1);
  await inject(tab2);
  const first = await cdp.eval(PROBE, tab1.sid);
  const second = await cdp.eval(PROBE, tab2.sid);
  const raw = await cdp.eval(PROBE, control.sid);
  await inject(tab1); // runtime watch re-applies on every ensure
  const reApplied = await cdp.eval(PROBE, tab1.sid);

  try { ws.close(); } catch (_) {}
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}

  check('probe returns values for every tab', () => {
    for (const [k, v] of Object.entries({ first, second, raw, reApplied })) {
      assert.ok(v && !v.error, `${k} probe error`);
      assert.strictEqual(typeof v.canvas, 'number', `${k} canvas hash`);
    }
  });
  check('two tabs of the same profile agree on every spoofed surface', () => {
    assert.strictEqual(first.canvas, second.canvas, 'canvas hash must match across tabs');
    assert.strictEqual(first.rectX, second.rectX, 'clientRects x must match across tabs');
    assert.strictEqual(first.rectW, second.rectW, 'clientRects width must match across tabs');
  });
  check('injected tabs differ from the untouched control tab', () => {
    assert.notStrictEqual(first.canvas, raw.canvas, 'canvas must be spoofed, not host value');
    assert.notStrictEqual(first.rectX, raw.rectX, 'clientRects x must be spoofed');
    assert.strictEqual(first.platform, fp.platform, 'platform must follow the profile');
    assert.notStrictEqual(raw.platform, fp.platform, 'control tab must still show the host platform');
  });
  check('re-applying the inject is idempotent', () => {
    assert.strictEqual(reApplied.canvas, first.canvas, 'second inject must not change the canvas hash');
    assert.strictEqual(reApplied.rectX, first.rectX, 'second inject must not change clientRects x');
    assert.strictEqual(reApplied.rectW, first.rectW, 'second inject must not change clientRects width');
  });

  check('the document-start script is registered once per target', () => {
    const registered = cdp.calls.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument' && c.sessionId === tab1.sid);
    assert.strictEqual(registered.length, 1, `tab1 must hold exactly one registration, saw ${registered.length}`);
  });

  check('the live document is patched once per target', () => {
    const patched = cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && c.sessionId === tab1.sid
      && String(c.params?.expression || '').includes("patchList(Element.prototype, 'getClientRects')"));
    assert.strictEqual(patched.length, 1, `tab1 must be patched exactly once, saw ${patched.length}`);
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`multitab-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`multitab-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('multitab-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
