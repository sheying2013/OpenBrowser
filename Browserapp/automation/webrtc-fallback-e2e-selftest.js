#!/usr/bin/env node
'use strict';

/**
 * Real-browser end-to-end selftest for the WebRTC document-level fallback.
 *
 * Runs against the macos-x64 OpenBrowser kernel to verify that:
 * 1. RTCPeerConnection construction succeeds instead of throwing NotSupportedError
 * 2. Prototype branding, instanceof, and Object.prototype.toString are intact
 * 3. createOffer produces valid SDP with v=0, m=, and a=fingerprint, without leaking host IPs
 * 4. icecandidate event fires and candidate carries masked IP
 * 5. getStats returns non-empty report containing candidate entries
 * 6. Function.prototype.toString on RTCPeerConnection looks native without source leakage
 * 7. close transitions signalingState to closed
 *
 * Supports mutation testing via --mutate flag to verify test sensitivity:
 * when the fallback is disabled, construction assertion fails.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { createWebRtcFallbackSource } = require('./webrtc-fallback');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const EXIT_IP = '203.0.113.9';
const LOCAL_IP = '192.168.1.100';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};
const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(method, params = {}) {
    return this.send(method, params);
  }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>webrtc-fallback-test</title><main>webrtc-fallback-test</main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function getHostIps() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list) {
      if (info && info.address && info.address !== '127.0.0.1' && info.address !== '::1' && !info.address.startsWith('fe80:')) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

const PROBE = `(async () => {
  const out = {};
  out.marker = Boolean(window.__marker);

  let pc = null;
  try {
    pc = new RTCPeerConnection();
    out.constructOk = true;
  } catch (e) {
    out.constructOk = false;
    out.constructErr = e.name + ': ' + e.message;
    return JSON.stringify(out);
  }

  out.tag = Object.prototype.toString.call(pc);
  out.isPC = pc instanceof RTCPeerConnection;
  out.ctorName = pc.constructor.name;
  out.ctorToString = Function.prototype.toString.call(RTCPeerConnection);

  try {
    const offer = await pc.createOffer();
    out.offer = true;
    out.hasV0 = offer.sdp.includes('v=0');
    out.hasMLine = offer.sdp.includes('m=');
    out.hasFingerprint = offer.sdp.includes('a=fingerprint');
    out.sdp = offer.sdp;
  } catch (e) {
    out.offerErr = e.name + ': ' + e.message;
  }

  const candidates = [];
  pc.onicecandidate = (ev) => {
    if (ev.candidate && ev.candidate.candidate) {
      candidates.push(ev.candidate.candidate);
    }
  };

  await pc.setLocalDescription();
  await new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 800);
  });

  out.candidates = candidates;
  out.iceGatheringState = pc.iceGatheringState;
  out.iceConnectionState = pc.iceConnectionState;
  out.connectionState = pc.connectionState;

  try {
    const stats = await pc.getStats();
    out.statsSize = stats.size;
    const entries = [];
    stats.forEach((v) => entries.push(v.type));
    out.statsTypes = entries;
  } catch (e) {
    out.statsErr = e.name + ': ' + e.message;
  }

  pc.close();
  out.closedSignalingState = pc.signalingState;

  return JSON.stringify(out);
})()`;

async function runSession(options = {}) {
  const { isMutation = false, serverPort } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-webrtc-test-'));

  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    try {
      const val = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)[0], 10);
      if (val > 0) { port = val; break; }
    } catch (_) {}
  }

  if (!port) {
    await stopChild(child, dir);
    return { error: 'no devtools port' };
  }

  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    return { error: 'no page target' };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
  });

  const cdp = new Cdp(ws);
  await cdp.call('Page.enable', {});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });

  if (!isMutation) {
    const fallbackScript = createWebRtcFallbackSource({
      publicIp: EXIT_IP,
      localIp: LOCAL_IP,
    });
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: fallbackScript });
  }

  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(600);

  const probe = await cdp.value(PROBE);
  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);
  return probe;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`webrtc-fallback-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const isMutationRun = process.argv.includes('--mutate') || process.env.MUTATE === '1';
  const { server, port: serverPort } = await startServer();
  const hostIps = getHostIps();

  let probe;
  try {
    probe = await runSession({ isMutation: isMutationRun, serverPort });
  } finally {
    server.close();
  }

  if (probe.error) {
    throw new Error(`Probe failed: ${probe.error}`);
  }

  check('probe marker verified via Page.addScriptToEvaluateOnNewDocument (window.__marker === true)', () => {
    assert.strictEqual(probe.marker, true, 'Probe invalid: window.__marker must be true');
  });

  check('RTCPeerConnection construction does not throw', () => {
    assert.strictEqual(probe.constructOk, true, `Constructor failed: ${probe.constructErr}`);
  });

  check('Object.prototype.toString tag is [object RTCPeerConnection] and instanceof RTCPeerConnection is true', () => {
    assert.strictEqual(probe.tag, '[object RTCPeerConnection]', 'Object.prototype.toString');
    assert.strictEqual(probe.isPC, true, 'instanceof RTCPeerConnection');
  });

  check('createOffer SDP contains v=0, m=, and a=fingerprint without host IPs', () => {
    assert.strictEqual(probe.offer, true, 'createOffer must return an offer');
    assert.strictEqual(probe.hasV0, true, 'SDP must contain v=0');
    assert.strictEqual(probe.hasMLine, true, 'SDP must contain m=');
    assert.strictEqual(probe.hasFingerprint, true, 'SDP must contain a=fingerprint');
    for (const ip of hostIps) {
      assert.strictEqual(probe.sdp?.includes(ip), false, `SDP leaked host IP: ${ip}`);
    }
  });

  check('icecandidate event arrives and candidate carries masked IP', () => {
    assert.ok(probe.candidates && probe.candidates.length > 0, 'At least one candidate must be gathered');
    for (const cand of probe.candidates) {
      for (const ip of hostIps) {
        assert.strictEqual(cand.includes(ip), false, `Candidate leaked host IP: ${ip}`);
      }
    }
    const hasMasked = probe.candidates.some((c) => c.includes(EXIT_IP) || c.includes(LOCAL_IP));
    assert.strictEqual(hasMasked, true, 'Candidate must contain masked IP');
  });

  check('getStats returns non-empty report containing candidate entries', () => {
    assert.ok(probe.statsSize > 0, 'getStats report must be non-empty');
    assert.ok(probe.statsTypes && probe.statsTypes.some((t) => t === 'local-candidate' || t === 'remote-candidate'), 'getStats must contain candidate entries');
  });

  check('Function.prototype.toString on RTCPeerConnection does not expose source code or local variables', () => {
    assert.ok(probe.ctorToString && probe.ctorToString.includes('[native code]'), 'Function toString must show [native code]');
    for (const leaked of ['createFallbackInstance', 'fallbackInstances', 'PUBLIC_IP', 'LOCAL_IP', 'nativeSource', 'fallbackMethods']) {
      assert.strictEqual(probe.ctorToString.includes(leaked), false, `toString must not leak internal variable ${leaked}`);
    }
  });

  check('close transitions signalingState to closed', () => {
    assert.strictEqual(probe.closedSignalingState, 'closed', 'signalingState after close()');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`webrtc-fallback-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`webrtc-fallback-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webrtc-fallback-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
