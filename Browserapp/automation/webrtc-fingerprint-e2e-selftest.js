#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the WebRTC address rewrite, run against a real Chromium.
 *
 * The bundled kernel refuses to construct a peer connection, so this surface cannot be observed
 * through it; a Chromium that does support WebRTC is used instead (override with
 * OPENBROWSER_WEBRTC_RUNTIME, otherwise the system Chrome, otherwise the test skips).
 *
 * The test is deliberately two-sided: it first proves the raw engine really does hand out the
 * machine's own address (or its mDNS stand-in), then proves the injected profile replaces it while
 * keeping public candidates intact. A one-sided check would pass even if gathering produced nothing.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');

const EXIT_IP = '203.0.113.9';
const CHROME_CANDIDATES = [
  process.env.OPENBROWSER_WEBRTC_RUNTIME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};
const skip = (name) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gather with the modern no-argument setLocalDescription: it is the path a detector would take.
const PROBE = `(async () => {
  const out = { candidates: [], errs: [] };
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    // An m-line is required or ICE has nothing to gather and the SDP stays empty.
    pc.createDataChannel('probe');
    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) out.candidates.push(event.candidate.candidate);
    };
    await pc.setLocalDescription();
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 3000);
    });
    out.sdp = (pc.localDescription && pc.localDescription.sdp) || '';
    out.brandOk = pc.localDescription instanceof RTCSessionDescription;
    pc.close();
  } catch (e) { out.errs.push(String(e && e.name) + ': ' + String(e && e.message).slice(0, 120)); }
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
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res) => {
      const timer = setTimeout(() => { this.pending.delete(id); res({ error: 'timeout', method }); }, 30000);
      this.pending.set(id, { res, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async evalValue(expression, sessionId) {
    const m = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    const v = m && m.result && m.result.result ? m.result.result.value : null;
    try { return JSON.parse(v); } catch (_) { return { error: 'probe parse', raw: String(v).slice(0, 200) }; }
  }
}

const hostAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
  .map((entry) => entry.address);

(async () => {
  const runtime = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!runtime) {
    console.log('  SKIP  no WebRTC-capable Chromium found (set OPENBROWSER_WEBRTC_RUNTIME)');
    console.log('webrtc-fingerprint-e2e-selftest: ok');
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><meta name="viewport" content="width=device-width"></head><body>webrtc probe</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-webrtc-'));
  const child = spawn(runtime, [
    '--headless=new',
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { server.close(); } catch (_) {}
  };
  if (!port) {
    stop();
    console.log('  SKIP  runtime did not expose a CDP endpoint');
    console.log('webrtc-fingerprint-e2e-selftest: ok');
    return;
  }

  const wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  const cdp = new Cdp(ws);

  const created = await cdp.send('Target.createTarget', { url });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
  const sid = attached.result.sessionId;
  await sleep(1200);

  const raw = await cdp.evalValue(PROBE, sid);

  const profile = {
    id: 'webrtc-e2e', kernelVersion: '148.0.7778.165', os: 'Windows',
    canvas: 'noise', webgl: 'noise', privacy: { webrtc: 'proxy', webrtcAddress: EXIT_IP },
  };
  const fp = buildFingerprint(profile);
  await applyFingerprintToTab(
    (method, params) => cdp.send(method, params, sid),
    null,
    fp,
    profile,
    { applyKey: 'webrtc-e2e' },
  );
  const injected = await cdp.evalValue(PROBE, sid);

  try { ws.close(); } catch (_) {}
  stop();

  const hostIps = hostAddresses();
  const privateOf = (text) => {
    const value = String(text || '');
    return hostIps.filter((ip) => value.includes(ip)).concat(value.includes('.local') ? ['mdns'] : []);
  };

  check('the probe gathers candidates in both passes', () => {
    assert.deepStrictEqual(raw.errs, [], `raw probe: ${raw.errs}`);
    assert.deepStrictEqual(injected.errs, [], `injected probe: ${injected.errs}`);
    assert.ok(raw.sdp.includes('a=candidate:') || raw.candidates.length > 0, 'raw pass must gather something');
    assert.ok(injected.sdp.includes('a=candidate:') || injected.candidates.length > 0, 'injected pass must gather something');
  });

  // Sensitivity: without this the rewrite assertions could pass on an empty SDP.
  if (privateOf(raw.sdp).length || privateOf(raw.candidates.join(' ')).length) {
    check('the raw engine exposes the machine address (test is sensitive)', () => { assert.ok(true); });
  } else {
    skip('the raw engine exposed no machine address in this environment (sensitivity unproven)');
  }

  check('the injected SDP no longer carries a machine address', () => {
    assert.deepStrictEqual(privateOf(injected.sdp), [], `sdp leaked: ${String(injected.sdp).slice(0, 400)}`);
  });
  check('the injected candidates no longer carry a machine address', () => {
    assert.deepStrictEqual(privateOf(injected.candidates.join(' ')), [], `candidates leaked: ${injected.candidates.join(' ').slice(0, 400)}`);
  });
  check('the rewritten surface is the profile address', () => {
    const haystack = `${injected.sdp} ${injected.candidates.join(' ')}`;
    assert.ok(haystack.includes(EXIT_IP), 'the profile address must appear where the machine address was');
  });
  check('a rewritten local description still passes instanceof', () => {
    assert.strictEqual(injected.brandOk, true, 'RTCSessionDescription brand check');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`webrtc-fingerprint-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`webrtc-fingerprint-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('webrtc-fingerprint-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
