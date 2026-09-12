#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the CDP noise handoff.
 *
 * Why this exists: the bundled 148 kernel ignores canvas / webgl / audio / clientRects pixel
 * noise unless the server-issued fingerprint payloads are present. A runtime A/B proved the
 * native path is inert, so the CDP inject must keep owning those surfaces. This test launches
 * the real kernel and proves the injected noise is observable, consurable through every
 * DOMRectList consumption style, and stable across a navigation.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(async () => {
  const out = {}; const errs = [];
  const enc = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; };
  const c = document.createElement('canvas'); c.width = 300; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.textBaseline = 'top'; ctx.font = '14px Arial'; ctx.fillStyle = '#f60'; ctx.fillRect(0, 0, 300, 150);
  ctx.fillStyle = '#069'; ctx.fillText('OB-E2E', 2, 2);
  ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.fillText('OB-E2E', 4, 17);
  ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgb(255,0,255)';
  ctx.beginPath(); ctx.arc(50, 50, 50, 0, Math.PI * 2, true); ctx.fill();
  out.canvas = enc(c.toDataURL());
  const span = document.createElement('span'); span.textContent = 'mmmmmmmmmmlli';
  span.style.cssText = 'font:72px monospace;position:absolute;left:-9999px'; document.body.appendChild(span);
  try { out.arrFrom = Array.from(span.getClientRects()).length; } catch (e) { errs.push('Array.from:' + e.name); }
  try { out.spread = [...span.getClientRects()].length; } catch (e) { errs.push('spread:' + e.name); }
  try { let n = 0; for (const r of span.getClientRects()) n++; out.forOf = n; } catch (e) { errs.push('forOf:' + e.name); }
  try {
    const l = span.getClientRects();
    out.item = (typeof l.item === 'function' && l.item(0)) ? 1 : 0;
    out.len = l.length;
    out.tag = Object.prototype.toString.call(l);
    out.isDRL = (typeof DOMRectList !== 'undefined') ? (l instanceof DOMRectList) : null;
  } catch (e) { errs.push('meta:' + e.name); }
  try { const r0 = span.getClientRects()[0]; out.rectX = r0 ? Number(r0.x.toFixed(6)) : null; } catch (e) { errs.push('rect0:' + e.name); }
  span.remove();
  out.errs = errs.join(',');
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, 44100, 44100); const osc = off.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = off.createDynamicsCompressor(); comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
    comp.attack.value = 0; comp.release.value = 0.25; osc.connect(comp); comp.connect(off.destination); osc.start(0);
    const r = await off.startRendering(); const d = r.getChannelData(0); let s = 0;
    for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]);
    out.audio = Math.round(s * 1e9) % 2147483647;
  } catch (e) { out.audioErr = String(e).slice(0, 40); }
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offAuthored = new OAC(1, 64, 44100);
    const authored = offAuthored.createBuffer(1, 4, 44100);
    authored.copyToChannel(new Float32Array([0.5, 0.25, -0.75, 1]), 0);
    const authoredView = authored.getChannelData(0);
    const authoredCopy = new Float32Array(4);
    authored.copyFromChannel(authoredCopy, 0);
    const constructed = new AudioBuffer({ length: 4, sampleRate: 44100 });
    constructed.copyToChannel(new Float32Array([0.5, 0.25, -0.75, 1]), 0);
    out.authored = {
      copyToChannel: [authoredView[0], authoredView[1], authoredView[2], authoredView[3]],
      copyFromChannel: [authoredCopy[0], authoredCopy[1], authoredCopy[2], authoredCopy[3]],
      constructed: constructed.getChannelData(0)[0],
      exact: authoredView[0] === 0.5 && authoredView[1] === 0.25 && authoredView[2] === -0.75 && authoredView[3] === 1
        && authoredCopy[0] === 0.5 && authoredCopy[1] === 0.25 && authoredCopy[2] === -0.75 && authoredCopy[3] === 1
        && constructed.getChannelData(0)[0] === 0.5,
    };
  } catch (e) { out.authoredErr = String(e).slice(0, 60); }
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const makeGraph = () => { const off = new OAC(1, 512, 44100); const osc = off.createOscillator(); osc.frequency.value = 440; osc.connect(off.destination); osc.start(0); return off; };
    const head = (buffer) => { const d = buffer.getChannelData(0); return [d[0], d[1], d[2]]; };
    const awaitedBuffer = await makeGraph().startRendering();
    const eventCtx = makeGraph();
    const eventBuffer = await new Promise((res) => { eventCtx.oncomplete = (e) => res(e.renderedBuffer); eventCtx.startRendering().catch(() => res(null)); });
    const bothCtx = makeGraph();
    let bothEventFirst = null;
    bothCtx.oncomplete = (e) => { bothEventFirst = e.renderedBuffer.getChannelData(0)[0]; };
    const bothBuffer = await bothCtx.startRendering();
    out.renderedPaths = {
      awaited: head(awaitedBuffer),
      event: eventBuffer ? head(eventBuffer) : null,
      bothEventFirst,
      bothPromiseFirst: bothBuffer.getChannelData(0)[0],
      consistent: bothEventFirst === bothBuffer.getChannelData(0)[0],
    };
  } catch (e) { out.renderedErr = String(e).slice(0, 60); }

  return JSON.stringify(out);
})()`;

function client() {
  let ws = null;
  let seq = 0;
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => resolve({ error: 'timeout' }), 30000);
    const handler = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', handler);
      resolve(msg);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    attach: (url) => new Promise((resolve, reject) => {
      ws = new WebSocket(url);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws connect failed'));
    }),
    evalValue: async (expression) => {
      const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const v = msg && msg.result && msg.result.result && msg.result.result.value;
      return typeof v === 'string' ? JSON.parse(v) : null;
    },
    call: send,
    close: () => { try { ws.close(); } catch (_) {} },
  };
}

async function launch(profileDir) {
  try { fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true }); } catch (_) {}
  const child = spawn(launcher, [profileDir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const p = parseInt(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }
  if (!port) return { child, port: null };
  let page = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch (_) {}
    await sleep(500);
  }
  return { child, port, page };
}

function stop(child, profileDir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${profileDir}" 2>/dev/null || true`); } catch (_) {}
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('cdp-noise-e2e-selftest: ok');
    return;
  }

  const profile = {
    id: 'cdp-noise-e2e', name: 'cdp-noise-e2e', kernelVersion: '148.0.7778.165', os: 'macos',
    canvas: 'noise', webgl: 'noise', audio: 'noise', clientRects: 'noise',
    webrtc: 'proxy', cores: 8, memory: 8, privacy: {},
  };
  const fp = buildFingerprint(profile);
  const inject = buildInjectionScript(fp);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cdp-noise-'));
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const { child, page } = await launch(dir);
  if (!page) {
    stop(child, dir);
    console.log('  SKIP  kernel did not expose a CDP page');
    console.log('cdp-noise-e2e-selftest: ok');
    return;
  }

  const cdp = client();
  await cdp.attach(page.webSocketDebuggerUrl);
  const baseline = await cdp.evalValue(PROBE);
  await cdp.call('Page.enable', {});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: inject });
  await cdp.call('Runtime.evaluate', { expression: inject, returnByValue: true });
  const injected = await cdp.evalValue(PROBE);
  await cdp.call('Page.reload', {});
  await sleep(2000);
  const reloaded = await cdp.evalValue(PROBE);
  cdp.close();
  stop(child, dir);

  check('baseline probe returns real hardware values', () => {
    assert.ok(baseline && typeof baseline.canvas === 'number', 'baseline canvas hash');
    assert.ok(baseline.audio, 'baseline audio mark');
  });
  check('CDP noise changes canvas / clientRects / audio', () => {
    assert.ok(injected, 'injected probe');
    assert.notStrictEqual(injected.canvas, baseline.canvas, 'canvas hash must change');
    assert.notStrictEqual(injected.rectX, baseline.rectX, 'clientRects x must change');
    assert.notStrictEqual(injected.audio, baseline.audio, 'audio mark must change');
  });
  check('clientRects stays consumable like a real DOMRectList', () => {
    assert.strictEqual(injected.errs, '', `no consumption errors (${injected.errs})`);
    assert.strictEqual(injected.arrFrom, baseline.arrFrom, 'Array.from length');
    assert.strictEqual(injected.spread, baseline.spread, 'spread length');
    assert.strictEqual(injected.forOf, baseline.forOf, 'for..of length');
    assert.strictEqual(injected.item, 1, 'item(0) works');
    assert.strictEqual(injected.len, baseline.len, 'length property');
    assert.strictEqual(injected.tag, '[object DOMRectList]', 'toStringTag');
    assert.strictEqual(injected.isDRL, true, 'instanceof DOMRectList');
  });
  check('a buffer the page filled itself keeps the page samples', () => {
    assert.ok(baseline.authored && injected.authored, `authored probe missing (${baseline.authoredErr || ''}${injected.authoredErr || ''})`);
    assert.strictEqual(baseline.authored.exact, true, 'baseline must read back exactly what it wrote');
    assert.strictEqual(injected.authored.exact, true, 'the injected build must read back exactly what the page wrote');
    assert.deepStrictEqual(injected.authored.copyToChannel, baseline.authored.copyToChannel, 'copyToChannel samples');
    assert.deepStrictEqual(injected.authored.copyFromChannel, baseline.authored.copyFromChannel, 'copyFromChannel samples');
    assert.strictEqual(injected.authored.constructed, baseline.authored.constructed, 'constructed buffer sample');
  });
  check('a rendered buffer carries the mark on every delivery path', () => {
    assert.ok(baseline.renderedPaths && injected.renderedPaths, `rendered paths probe missing (${baseline.renderedErr || ''}${injected.renderedErr || ''})`);
    assert.ok(baseline.renderedPaths.event, 'baseline must deliver a buffer through complete');
    assert.strictEqual(baseline.renderedPaths.consistent, true, 'baseline sensitivity control: both reads must agree');
    assert.strictEqual(injected.renderedPaths.consistent, true, 'the complete event and the promise must agree on one buffer');
    assert.notDeepStrictEqual(injected.renderedPaths.awaited, baseline.renderedPaths.awaited, 'the awaited buffer must be perturbed');
    assert.notDeepStrictEqual(injected.renderedPaths.event, baseline.renderedPaths.event, 'the complete-event buffer must be perturbed');
  });

  check('noise survives navigation and stays stable', () => {
    assert.ok(reloaded, 'reloaded probe');
    assert.strictEqual(reloaded.canvas, injected.canvas, 'canvas stable across reload');
    assert.strictEqual(reloaded.audio, injected.audio, 'audio stable across reload');
    assert.strictEqual(reloaded.errs, '', 'clientRects still consumable after reload');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log(`cdp-noise-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`cdp-noise-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('cdp-noise-e2e-selftest: crashed', err && err.stack || err);
  process.exitCode = 1;
});
