#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the mediaDevices surface, run against the bundled kernel.
 *
 * Two properties are pinned because both were observably wrong before:
 *   1. Chrome publishes identifiers and labels only after a capture permission is granted; before
 *      that the same entries come back with every field empty. Returning ids up front diverged
 *      from the real surface and exposed the synthetic identifiers without any prompt.
 *   2. Identifiers must be per-profile unique and shaped like Chrome's (64 lowercase hex). A
 *      running-sum derivation made the audio-input id depend only on the first two characters of
 *      the seed, so profiles sharing an id prefix published the same deviceId.
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

const HEX64 = /^[0-9a-f]{64}$/;

const PROBE = `(async () => {
  const out = { hasMd: !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices), secure: !!window.isSecureContext };
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    out.count = list.length;
    out.devices = list.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId, groupId: d.groupId }));
  } catch (e) { out.err = String(e && e.name) + ': ' + String(e && e.message); }
  return JSON.stringify(out);
})()`;

const MARKER_PROBE = `(async () => {
  const acc = [];
  const push = (k, v) => { try { if (v !== undefined && v !== null) acc.push(k + '=' + String(v)); } catch (_) {} };
  const walk = (obj, label) => {
    if (!obj) return;
    let keys = []; try { keys = Object.keys(obj); } catch (_) { return; }
    for (const k of keys.slice(0, 40)) {
      let v; try { v = obj[k]; } catch (_) { continue; }
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') push(label + '.' + k, v);
    }
  };
  walk(navigator, 'nav'); walk(screen, 'screen');
  push('nav.userAgent', navigator.userAgent);
  push('nav.platform', navigator.platform);
  push('nav.vendor', navigator.vendor);
  try { for (const p of navigator.plugins) { push('plugin.name', p.name); push('plugin.filename', p.filename); } } catch (_) {}
  try { for (const m of navigator.mimeTypes) push('mime.type', m.type); } catch (_) {}
  try { for (const v of speechSynthesis.getVoices()) { push('voice.name', v.name); push('voice.uri', v.voiceURI); } } catch (_) {}
  try {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) { push('gl.vendor', gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)); push('gl.renderer', gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)); }
      push('gl.VERSION', gl.getParameter(gl.VERSION));
      push('gl.MAX_TEXTURE_SIZE', gl.getParameter(gl.MAX_TEXTURE_SIZE));
    }
  } catch (_) {}
  try { push('intl.tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_) {}
  try { push('window.name', window.name); } catch (_) {}
  return JSON.stringify(acc);
})()`;

// Runs at document start, so firstSync is the page's very first synchronous read.
const VOICE_PROBE = `(async () => {
  const out = {};
  try {
    out.firstSync = speechSynthesis.getVoices().length;
    await new Promise((r) => setTimeout(r, 900));
    const list = speechSynthesis.getVoices();
    out.afterWait = list.length;
    out.sample = list.slice(0, 2).map((v) => ({ name: v.name, uri: v.voiceURI }));
  } catch (e) { out.err = String(e); }
  window.__docStartProbe = out;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};

const startLoopbackServer = () => new Promise((res) => {
  const s = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.end('<!doctype html><title>media probe</title><body>probe</body>');
  });
  s.listen(0, '127.0.0.1', () => res(s));
});

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const { res, timer } = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(timer); res(m); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer });
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.pending.delete(id); clearTimeout(timer); res({ error: String(e) }); }
    });
  }
}

function profileFor(id, privacyExtra) {
  return { id, name: id, kernelVersion: '148.0.7778.165', os: 'macos', canvas: 'noise', webgl: 'noise',
    audio: 'noise', clientRects: 'noise', webrtc: 'proxy', cores: 8, memory: 8,
    privacy: Object.assign({}, privacyExtra || {}) };
}

function stop(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function measure(profileId, grant, probeExpr, privacyExtra, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-media-'));
  const profile = profileFor(profileId, privacyExtra);
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); } catch (_) {}
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
  if (!port) { stop(child, dir); return { error: 'no devtools port' }; }

  const srv = await startLoopbackServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  let result = { error: 'no browser endpoint' };
  let browserWs = null;
  for (let i = 0; i < 25; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      if (v && v.webSocketDebuggerUrl) { browserWs = v.webSocketDebuggerUrl; break; }
    } catch (_) {}
    await sleep(500);
  }
  if (browserWs) {
    const ws = new WebSocket(browserWs);
    await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
    const cdp = new Cdp(ws);
    const created = await cdp.send('Target.createTarget', { url });
    const targetId = created && created.result && created.result.targetId;
    if (targetId) {
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached && attached.result && attached.result.sessionId;
      if (sessionId) {
        await cdp.send('Page.enable', {}, sessionId);
        if (grant) {
          await cdp.send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['videoCapture', 'audioCapture'] });
        }
        if (opts && opts.atDocumentStart) {
          // A page observes the voice table from its own first synchronous call, which happens while
          // the document is being parsed. Installing the probe together with the injection at document
          // start reproduces that ordering; probing a document that has already been alive for a
          // second would measure past the asynchronous load window and prove nothing.
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) + '\n' + probeExpr }, sessionId);
          await cdp.send('Page.navigate', { url }, sessionId);
          await sleep(1600);
          const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__docStartProbe || null)', returnByValue: true }, sessionId);
          const v = r && r.result && r.result.result ? r.result.result.value : null;
          let q = null; try { q = JSON.parse(v); } catch (_) { q = { raw: v }; }
          result = q || { error: 'no probe result' };
          await cdp.send('Target.closeTarget', { targetId });
        } else {
        await sleep(1800);
        const inject = buildInjectionScript(fp);
        await cdp.send('Runtime.evaluate', { expression: inject, returnByValue: true }, sessionId);
        await sleep(400);
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const m = await cdp.send('Runtime.evaluate', { expression: probeExpr || PROBE, awaitPromise: true, returnByValue: true }, sessionId);
          const val = m && m.result && m.result.result ? m.result.result.value : null;
          let q = null; try { q = JSON.parse(val); } catch (_) { q = { raw: val }; }
          if (q && q.err && /detached/i.test(String(q.err))) { result = q; await sleep(700); continue; }
          result = q; break;
        }
        await cdp.send('Target.closeTarget', { targetId });
        }
      } else { result = { error: 'attach failed' }; }
    } else { result = { error: 'createTarget failed' }; }
    try { ws.close(); } catch (_) {}
  }
  try { srv.close(); } catch (_) {}
  stop(child, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return result;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('media-devices-e2e-selftest: ok');
    return;
  }

  // A hosted runner may not be able to launch the bundled kernel at all; report that as a skip
  // instead of a failure, while an ordinary run keeps failing loudly.
  const firstRun = await measure('media-withheld', false);
  if (firstRun && firstRun.error && process.env.CI) {
    console.log(`  SKIP  bundled kernel unavailable in this environment (${firstRun.error})`);
    console.log('media-devices-e2e-selftest: ok');
    return;
  }
  const withheld = firstRun;
  await sleep(600);
  const granted = await measure('media-granted', true);
  await sleep(600);
  const grantedAgain = await measure('media-granted', true);
  await sleep(600);
  const otherProfile = await measure('media-other', true);

  check('probe returns a device list in every state', () => {
    for (const [k, v] of Object.entries({ withheld, granted, grantedAgain, otherProfile })) {
      assert.ok(v && !v.error, `${k} probe error: ${v && (v.error || v.err)}`);
      assert.ok(v.hasMd, `${k} mediaDevices missing`);
      assert.strictEqual(typeof v.count, 'number', `${k} device count`);
    }
  });

  check('without capture permission every identifier and label is withheld', () => {
    assert.strictEqual(withheld.count, 3, 'Chrome lists one entry per kind before permission');
    for (const d of withheld.devices) {
      assert.strictEqual(d.deviceId, '', `${d.kind} deviceId must be empty before permission`);
      assert.strictEqual(d.groupId, '', `${d.kind} groupId must be empty before permission`);
      assert.strictEqual(d.label, '', `${d.kind} label must be empty before permission`);
    }
  });

  check('granted permission exposes Chrome-shaped identifiers', () => {
    assert.strictEqual(granted.count, 3);
    const groupIds = new Set(granted.devices.map((d) => d.groupId));
    assert.strictEqual(groupIds.size, 1, 'devices in one machine share a groupId, as in Chrome');
    for (const d of granted.devices) {
      assert.ok(HEX64.test(d.deviceId), `${d.kind} deviceId must be 64 lowercase hex, got ${d.deviceId}`);
      assert.ok(HEX64.test(d.groupId), `${d.kind} groupId must be 64 lowercase hex`);
      assert.ok(!/^ob-/.test(d.deviceId), 'deviceId must not carry a product marker');
      assert.ok(d.label && d.label.length > 0, `${d.kind} label must be populated once granted`);
    }
    assert.ok(granted.devices.some((d) => d.kind === 'audioinput'));
    assert.ok(granted.devices.some((d) => d.kind === 'videoinput'));
    assert.ok(granted.devices.some((d) => d.kind === 'audiooutput'));
  });

  check('the same profile reports identical identifiers after a restart', () => {
    assert.deepStrictEqual(
      granted.devices.map((d) => [d.kind, d.deviceId, d.groupId]),
      grantedAgain.devices.map((d) => [d.kind, d.deviceId, d.groupId]),
      'identifiers must not drift between launches'
    );
  });

  check('different profiles never share an identifier', () => {
    const a = granted.devices.map((d) => d.deviceId);
    const b = otherProfile.devices.map((d) => d.deviceId);
    for (const id of a) assert.ok(!b.includes(id), `deviceId leaked across profiles: ${id}`);
    assert.notStrictEqual(granted.devices[0].groupId, otherProfile.devices[0].groupId,
      'groupIds must differ across profiles');
  });

  const voicesInjected = await measure('voices-injected', false, VOICE_PROBE, { speech: 'noise' }, { atDocumentStart: true });
  const voicesNative = await measure('voices-native', false, VOICE_PROBE, { speech: 'real' }, { atDocumentStart: true });

  check('the voice table is withheld until the asynchronous load window has passed', () => {
    for (const [k, v] of Object.entries({ voicesInjected, voicesNative })) {
      assert.ok(v && !v.error && !v.err, `${k} probe error: ${v && (v.error || v.err)}`);
      assert.strictEqual(v.firstSync, 0,
        `${k} first synchronous getVoices() must be empty, as a real build returns`);
    }
    assert.ok(voicesNative.afterWait > 0,
      'the bundled kernel must still publish its own table asynchronously; if it does not, the withheld window is untested');
    assert.ok(voicesInjected.afterWait > 0, 'the spoofed table must appear once the window has passed');
    assert.ok(voicesInjected.sample.every((v) => v.name && v.uri === v.name),
      'served voices must carry a plain name as their URI');
  });

  const markers = await measure('media-markers', false, MARKER_PROBE, { speech: 'noise' });
  check('no page-readable surface carries a product marker', () => {
    assert.ok(Array.isArray(markers), 'marker sweep must return a list');
    assert.ok(markers.length >= 40, `marker sweep sampled too few surfaces: ${markers.length}`);
    const markersRe = [/ob-/i, /openbrowser/i, /hubstudio/i, /\\bSB[0-9]{6,}/, /squilla/i, /wayfern/i];
    const hits = markers.filter((entry) => markersRe.some((re) => re.test(entry)));
    assert.deepStrictEqual(hits, [], `product markers leaked into page-readable surfaces: ${hits.join(', ')}`);
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`media-devices-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`media-devices-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('media-devices-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
