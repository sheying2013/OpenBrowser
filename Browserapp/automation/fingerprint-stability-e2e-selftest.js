#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the two invariants that decide whether a spoofed profile reads as a real
 * machine: the same profile must show the same values across browser restarts, and two different
 * profiles must never collapse onto the same values. It also pins the clientRects edge cases that
 * previously made the surface silently pass host values through (a zero derived offset, and
 * width/height being returned untouched while font-metric fingerprinting reads exactly those).
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

const PROBE = `(async () => {
  const out = {};
  const enc = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h >>> 0; };
  const c = document.createElement('canvas'); c.width = 300; c.height = 150;
  const ctx = c.getContext('2d');
  ctx.textBaseline='top'; ctx.font='14px Arial'; ctx.fillStyle='#f60'; ctx.fillRect(0,0,300,150);
  ctx.fillStyle='#069'; ctx.fillText('OB-ST',2,2); ctx.fillStyle='rgba(102,204,0,0.7)'; ctx.fillText('OB-ST',4,17);
  ctx.globalCompositeOperation='multiply'; ctx.fillStyle='rgb(255,0,255)';
  ctx.beginPath(); ctx.arc(50,50,50,0,Math.PI*2,true); ctx.fill();
  out.canvas = enc(c.toDataURL());
  const span = document.createElement('span'); span.textContent='mmmmmmmmmmlli';
  span.style.cssText='font:72px monospace;position:absolute;left:-9999px'; document.body.appendChild(span);
  const r0 = span.getClientRects()[0];
  out.rectX = r0 ? Number(r0.x.toFixed(6)) : null;
  out.rectW = r0 ? Number(r0.width.toFixed(6)) : null;
  span.remove();
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1,44100,44100); const osc = off.createOscillator(); osc.type='triangle'; osc.frequency.value=10000;
    const comp = off.createDynamicsCompressor(); comp.threshold.value=-50; comp.knee.value=40; comp.ratio.value=12;
    comp.attack.value=0; comp.release.value=0.25; osc.connect(comp); comp.connect(off.destination); osc.start(0);
    const rr = await off.startRendering(); const d = rr.getChannelData(0); let s = 0;
    for (let i=4500;i<5000;i++) s += Math.abs(d[i]);
    out.audio = Math.round(s*1e9)%2147483647;
  } catch (e) { out.audioErr = String(e).slice(0,40); }
  return JSON.stringify(out);
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${err.message}`); process.exitCode = 1; }
};

function profileFor(id) {
  return { id, name: id, kernelVersion: '148.0.7778.165', os: 'macos', canvas: 'noise', webgl: 'noise',
    audio: 'noise', clientRects: 'noise', webrtc: 'proxy', cores: 8, memory: 8, privacy: {} };
}

function stop(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function measure(dir, profileId, withInject, reuseInit) {
  const profile = profileFor(profileId);
  const fp = buildFingerprint(profile);
  const inject = buildInjectionScript(fp);
  if (!reuseInit || !fs.existsSync(path.join(dir, 'init.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });
  }
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
  let page = null;
  for (let i = 0; i < 20; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const t = await r.json();
      page = (t || []).find((x) => x.type === 'page'); if (page) break; } catch (_) {}
    await sleep(500);
  }
  if (!page) { stop(child, dir); return { error: 'no page target' }; }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
  const call = (id, method, params) => new Promise((res) => {
    const t = setTimeout(() => res(null), 25000);
    const h = (ev) => { try { const m = JSON.parse(ev.data); if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); res(m); } } catch (_) {} };
    ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params }));
  });
  if (withInject) {
    await call(1, 'Page.enable', {});
    await call(2, 'Runtime.evaluate', { expression: inject, returnByValue: true });
  }
  const m = await call(3, 'Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true });
  const val = m && m.result && m.result.result ? m.result.result.value : null;
  try { ws.close(); } catch (_) {}
  stop(child, dir);
  try { return JSON.parse(val); } catch (_) { return { error: 'probe parse', val }; }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('fingerprint-stability-e2e-selftest: ok');
    return;
  }

  // Pick an id whose derived clientRects step used to collapse to zero (mark % 7 === 3).
  let zeroId = null;
  for (let i = 0; i < 40; i += 1) {
    const id = `stability-zero-${i}`;
    const fp = buildFingerprint(profileFor(id));
    const mark = Number(fp.clientRects && fp.clientRects.mark) || 1;
    if (((mark % 7) + 7) % 7 === 3) { zeroId = id; break; }
  }

  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-stability-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-stability-b-'));
  const dirZ = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-stability-z-'));

  const rawZ = await measure(dirZ, zeroId || 'stability-zero-fallback', false, false);
  await sleep(600);
  const A1 = await measure(dirA, 'stability-a', true, false);
  await sleep(1200);
  const A2 = await measure(dirA, 'stability-a', true, true);
  await sleep(600);
  const B1 = await measure(dirB, 'stability-b', true, false);
  await sleep(600);
  const Z1 = await measure(dirZ, zeroId || 'stability-zero-fallback', true, false);

  check('probe returns values for every profile', () => {
    for (const [k, v] of Object.entries({ A1, A2, B1, Z1 })) {
      assert.ok(v && !v.error, `${k} probe error: ${v && v.error}`);
      assert.strictEqual(typeof v.canvas, 'number', `${k} canvas hash`);
    }
  });
  check('same profile is stable across browser restarts', () => {
    assert.strictEqual(A1.canvas, A2.canvas, 'canvas hash must not drift between restarts');
    assert.strictEqual(A1.rectX, A2.rectX, 'clientRects x must not drift');
    assert.strictEqual(A1.rectW, A2.rectW, 'clientRects width must not drift');
    assert.strictEqual(A1.audio, A2.audio, 'audio mark must not drift');
  });
  check('different profiles produce different fingerprints', () => {
    assert.notStrictEqual(A1.canvas, B1.canvas, 'canvas hash must differ per profile');
    assert.notStrictEqual(A1.audio, B1.audio, 'audio mark must differ per profile');
  });
  check('clientRects noise never collapses to zero', () => {
    assert.ok(rawZ && !rawZ.error, 'raw probe');
    assert.ok(Z1 && !Z1.error, 'injected probe');
    assert.notStrictEqual(Z1.rectX, rawZ.rectX, 'x must move even when the derived step would be zero');
    assert.notStrictEqual(Z1.rectX, Math.round(Z1.rectX), 'x must carry a non-integer offset');
  });
  check('clientRects width/height carry font-metric noise', () => {
    assert.ok(rawZ && !rawZ.error, 'raw probe');
    assert.notStrictEqual(Z1.rectW, rawZ.rectW, 'width must move, not be passed through');
  });

  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log(`fingerprint-stability-e2e-selftest: OK ${results.length}/${results.length}`);
  else { console.log(`fingerprint-stability-e2e-selftest: FAILED ${failed.length}/${results.length}`); process.exitCode = 1; }
})().catch((err) => {
  console.error('fingerprint-stability-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
