#!/usr/bin/env node
'use strict';

/**
 * Static-surface integrity guard, run against the bundled kernel.
 *
 * A page can enumerate the object graph the browser exposes and compare it with what a stock build
 * of the same version looks like. Two properties make that comparison cheap for a detector and were
 * both broken before this guard existed:
 *
 *   1. Distinct entry points must stay distinct objects. A shim that installed one replacement under
 *      two different names made `Element.prototype.requestFullscreen === webkitRequestFullscreen`
 *      true (a stock build reports false) and left the legacy entry point carrying the standard
 *      name.
 *   2. Replacement functions must keep the metadata of the function they replace - name, arity and
 *      the presence of `prototype`.
 *
 * The check compares the injection-enabled build against the same binary without the injection, so
 * it isolates the effect of the injected layer and stays valid across kernel version changes.
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

const SURFACE_PROBE = `(() => {
  const out = { keys: [], aliases: [], fullscreen: {}, roots: 0, protos: 0 };
  const seenProto = new Set();
  const scanProto = (pn, p) => {
    if (!p || seenProto.has(p)) return;
    seenProto.add(p);
    let names = []; try { names = Object.getOwnPropertyNames(p); } catch (_) { return; }
    const fns = [];
    for (const k of names) {
      let d = null; try { d = Object.getOwnPropertyDescriptor(p, k); } catch (_) { continue; }
      if (!d) continue;
      if (typeof d.value === 'function') {
        fns.push([k, d.value]);
        let nm = '', ln = -1, hp = null;
        try { nm = d.value.name; } catch (_) {}
        try { ln = d.value.length; } catch (_) {}
        try { hp = Object.prototype.hasOwnProperty.call(d.value, 'prototype'); } catch (_) {}
        out.keys.push(pn + '.' + k + '#name=' + nm + '#len=' + ln + '#proto=' + hp);
      } else if (typeof d.get === 'function' || typeof d.set === 'function') {
        const g = d.get, s = d.set;
        out.keys.push(pn + '%' + k + '%get=' + (typeof g === 'function' ? (g.name + '/' + g.length) : '-') +
          '%set=' + (typeof s === 'function' ? (s.name + '/' + s.length) : '-'));
      } else {
        // Constants and other plain data properties are part of the surface too.
        out.keys.push(pn + '!' + k + '!' + typeof d.value);
      }
    }
    for (let i = 0; i < fns.length; i += 1) {
      for (let j = i + 1; j < fns.length; j += 1) {
        if (fns[i][1] === fns[j][1]) out.aliases.push(pn + ':' + fns[i][0] + '=' + fns[j][0]);
      }
    }
  };
  for (const k of Object.getOwnPropertyNames(globalThis)) {
    let v = null; try { v = globalThis[k]; } catch (_) { continue; }
    if (typeof v === 'function') { out.roots += 1; try { scanProto(k, v.prototype); } catch (_) {} }
  }
  scanProto('globalThis', globalThis);
  out.keys.sort(); out.aliases.sort();
  out.protos = seenProto.size;
  try {
    const rf = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen');
    const wf = Object.getOwnPropertyDescriptor(Element.prototype, 'webkitRequestFullscreen');
    out.fullscreen = {
      identity: Element.prototype.requestFullscreen === Element.prototype.webkitRequestFullscreen,
      requestName: rf && rf.value && rf.value.name,
      webkitName: wf && wf.value && wf.value.name,
      requestLength: rf && rf.value && rf.value.length,
      webkitLength: wf && wf.value && wf.value.length,
    };
  } catch (e) { out.fullscreen = { err: String(e) }; }
  return JSON.stringify(out);
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startLoopbackServer = () => new Promise((res) => {
  const s = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.end('<!doctype html><title>surface probe</title><body>probe</body>');
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

function profileFor(id) {
  return { id, name: id, kernelVersion: '148.0.7778.165', os: 'macos', canvas: 'noise', webgl: 'noise',
    audio: 'noise', clientRects: 'noise', webrtc: 'proxy', cores: 8, memory: 8, privacy: {} };
}

function stop(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
}

async function measure(profileId, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-surface-'));
  const profile = profileFor(profileId);
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
  for (let i = 0; i < 25; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const v = await r.json();
      if (v && v.webSocketDebuggerUrl) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res) => { ws.onopen = res; ws.onerror = res; });
        const cdp = new Cdp(ws);
        const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const targetId = created && created.result && created.result.targetId;
        const attached = targetId ? await cdp.send('Target.attachToTarget', { targetId, flatten: true }) : null;
        const sessionId = attached && attached.result && attached.result.sessionId;
        if (sessionId) {
          await cdp.send('Page.enable', {}, sessionId);
          if (inject) {
            // Same anchoring as production: the layer is installed while the document is created, so
            // the page never observes an unpatched intermediate state.
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectionScript(fp) }, sessionId);
          }
          await cdp.send('Page.navigate', { url }, sessionId);
          await sleep(1500);
          const m = await cdp.send('Runtime.evaluate', { expression: SURFACE_PROBE, returnByValue: true }, sessionId);
          const val = m && m.result && m.result.result ? m.result.result.value : null;
          try { result = JSON.parse(val); } catch (_) { result = { error: 'probe parse failed', raw: String(val).slice(0, 200) }; }
          await cdp.send('Target.closeTarget', { targetId });
        } else { result = { error: 'attach failed' }; }
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

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('surface-integrity-e2e-selftest: ok');
    return;
  }

  const baseline = await measure('surface-baseline', false);
  const injected = await measure('surface-injected', true);

  check('both builds expose a full enumerable surface', () => {
    for (const [k, v] of Object.entries({ baseline, injected })) {
      assert.ok(v && !v.error, `${k} probe error: ${v && v.error}`);
      assert.ok(v.keys.length > 9000, `${k} enumerated too few properties: ${v.keys.length}`);
      assert.ok(v.protos > 500, `${k} walked too few prototypes: ${v.protos}`);
      assert.ok(v.aliases.length > 0, `${k} found no native aliases at all, which cannot be right`);
    }
  });

  check('the injected layer adds and removes no observable property', () => {
    const base = new Set(baseline.keys);
    const inj = new Set(injected.keys);
    const removed = [...base].filter((k) => !inj.has(k));
    const added = [...inj].filter((k) => !base.has(k));
    assert.deepStrictEqual(removed, [], `properties disappeared under injection: ${removed.slice(0, 8).join(', ')}`);
    assert.deepStrictEqual(added, [], `properties appeared under injection: ${added.slice(0, 8).join(', ')}`);
  });

  check('the injected layer introduces no function-object aliases', () => {
    const base = new Set(baseline.aliases);
    const added = injected.aliases.filter((a) => !base.has(a));
    assert.deepStrictEqual(added, [],
      `entry points that are separate functions in the real build now share one object: ${added.join(', ')}`);
    const lost = baseline.aliases.filter((a) => !new Set(injected.aliases).has(a));
    assert.deepStrictEqual(lost, [], `native aliases disappeared: ${lost.join(', ')}`);
  });

  check('fullscreen entry points keep distinct identities and their own names', () => {
    const f = injected.fullscreen || {};
    assert.ok(!f.err, `fullscreen probe failed: ${f.err}`);
    assert.strictEqual(f.identity, false,
      'requestFullscreen and webkitRequestFullscreen must be distinct objects, as in a real build');
    assert.strictEqual(f.requestName, 'requestFullscreen', 'standard entry point must keep its name');
    assert.strictEqual(f.webkitName, 'webkitRequestFullscreen', 'legacy entry point must keep its own name');
    assert.strictEqual(f.requestLength, 0, 'standard entry point arity must match the real build');
    assert.strictEqual(f.webkitLength, 0, 'legacy entry point arity must match the real build');
    assert.deepStrictEqual(injected.fullscreen, baseline.fullscreen,
      'the fullscreen surface must match the same build without the injected layer');
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log(`surface-integrity-e2e-selftest: FAILED ${failed.length}/${results.length}`);
  else console.log(`surface-integrity-e2e-selftest: OK ${results.length}/${results.length}`);
})().catch((err) => {
  console.error('surface-integrity-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
