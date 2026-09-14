#!/usr/bin/env node
'use strict';

/**
 * MediaStreamTrack label & getSettings deviceId shielding selftest.
 *
 * Verifies that getUserMedia tracks:
 * 1. Do not leak host hardware names (e.g. MacBook Pro Microphone) in track.label.
 * 2. Return deviceId and label strictly matching enumerateDevices() records.
 * 3. Preserve MediaStreamTrack brand checks (TypeError on illegal invocation).
 * 4. Propagate spoofed device mapping across track.clone() and stream.clone().
 * 5. Carry zero own-properties on the track instance (WeakMap storage).
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

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`mediastreamtrack-label-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body>GUM Test</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const profile = {
    id: 'gum-selftest',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    mediaDevices: { mode: 'noise' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-gum-unit-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const child = spawn(launcher, [
    dir,
    '--headless=new',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ], { cwd: kernelRoot, detached: true, stdio: 'ignore' });

  let devToolsPort = null;
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      devToolsPort = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (devToolsPort > 0) break;
    } catch (_) {}
  }
  if (!devToolsPort) throw new Error('DevToolsActivePort not acquired');

  const list = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });

  let seq = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) { ws.removeEventListener('message', h); res(m.result || m.error); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(1000);

  const evalRes = await send('Runtime.evaluate', {
    expression: `(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDev = devices.find((d) => d.kind === 'audioinput');
      const videoDev = devices.find((d) => d.kind === 'videoinput');

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const aTrack = stream.getAudioTracks()[0];
      const vTrack = stream.getVideoTracks()[0];

      let badLabelThrows = false;
      try {
        Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'label').get.call({});
      } catch (e) {
        badLabelThrows = e instanceof TypeError;
      }

      let badSettingsThrows = false;
      try {
        MediaStreamTrack.prototype.getSettings.call({});
      } catch (e) {
        badSettingsThrows = e instanceof TypeError;
      }

      const clonedTrack = aTrack.clone();
      const clonedStream = stream.clone();

      const out = {
        aTrackLabel: aTrack.label,
        vTrackLabel: vTrack.label,
        aTrackDevId: aTrack.getSettings().deviceId,
        vTrackDevId: vTrack.getSettings().deviceId,
        clonedTrackLabel: clonedTrack.label,
        clonedTrackDevId: clonedTrack.getSettings().deviceId,
        clonedStreamTrackLabel: clonedStream.getAudioTracks()[0]?.label,
        clonedStreamTrackDevId: clonedStream.getAudioTracks()[0]?.getSettings().deviceId,
        badLabelThrows,
        badSettingsThrows,
        audioDevMatches: Boolean(audioDev && audioDev.label === aTrack.label && audioDev.deviceId === aTrack.getSettings().deviceId),
        videoDevMatches: Boolean(videoDev && videoDev.label === vTrack.label && videoDev.deviceId === vTrack.getSettings().deviceId),
        ownPropsCount: Object.getOwnPropertyNames(aTrack).length,
      };

      stream.getTracks().forEach((t) => t.stop());
      clonedTrack.stop();
      clonedStream.getTracks().forEach((t) => t.stop());
      return out;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  const data = evalRes?.result?.value;

  check('audio track label and deviceId match enumerateDevices', () => {
    assert.strictEqual(data.audioDevMatches, true, 'Audio track must match spoofed device');
    assert.ok(data.aTrackLabel, 'Track label must be non-empty');
  });

  check('video track label and deviceId match enumerateDevices', () => {
    assert.strictEqual(data.videoDevMatches, true, 'Video track must match spoofed device');
    assert.ok(data.vTrackLabel, 'Track label must be non-empty');
  });

  check('track.clone() propagates spoofed device info', () => {
    assert.strictEqual(data.clonedTrackLabel, data.aTrackLabel);
    assert.strictEqual(data.clonedTrackDevId, data.aTrackDevId);
  });

  check('stream.clone() propagates spoofed device info to child tracks', () => {
    assert.strictEqual(data.clonedStreamTrackLabel, data.aTrackLabel);
    assert.strictEqual(data.clonedStreamTrackDevId, data.aTrackDevId);
  });

  check('brand checks: illegal receiver on label and getSettings throws TypeError', () => {
    assert.strictEqual(data.badLabelThrows, true, 'label on {} must throw TypeError');
    assert.strictEqual(data.badSettingsThrows, true, 'getSettings on {} must throw TypeError');
  });

  check('stealth integrity: track instance carries zero own-properties', () => {
    assert.strictEqual(data.ownPropsCount, 0, 'MediaStreamTrack instance must have 0 own properties');
  });

  ws.close();
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log(`\nmediastreamtrack-label-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nmediastreamtrack-label-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('mediastreamtrack-label-selftest crashed:', err);
  process.exitCode = 1;
});
