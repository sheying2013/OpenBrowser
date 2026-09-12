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
    // Descriptor attributes are part of the observable surface: a replacement installed with a
    // different enumerability than the real build shows up in Object.keys() and descriptor reads.
    const attrs = (d) => (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-');
    for (const k of names) {
      let d = null; try { d = Object.getOwnPropertyDescriptor(p, k); } catch (_) { continue; }
      if (!d) continue;
      const flag = attrs(d);
      if (typeof d.value === 'function') {
        fns.push([k, d.value]);
        let nm = '', ln = -1, hp = null;
        try { nm = d.value.name; } catch (_) {}
        try { ln = d.value.length; } catch (_) {}
        try { hp = Object.prototype.hasOwnProperty.call(d.value, 'prototype'); } catch (_) {}
        out.keys.push(pn + '.' + k + '#' + flag + '#name=' + nm + '#len=' + ln + '#proto=' + hp);
      } else if (typeof d.get === 'function' || typeof d.set === 'function') {
        const g = d.get, s = d.set;
        out.keys.push(pn + '%' + k + '#' + flag + '%get=' + (typeof g === 'function' ? (g.name + '/' + g.length) : '-') +
          '%set=' + (typeof s === 'function' ? (s.name + '/' + s.length) : '-'));
      } else {
        // Constants and other plain data properties are part of the surface too.
        out.keys.push(pn + '!' + k + '#' + flag + '!' + typeof d.value);
      }
    }
    // Property order is observable through Object.getOwnPropertyNames, so it is compared as-is.
    out.keys.push(pn + '#ORDER#' + names.join(','));
    let syms = []; try { syms = Object.getOwnPropertySymbols(p); } catch (_) {}
    for (const sym of syms) {
      let d = null; try { d = Object.getOwnPropertyDescriptor(p, sym); } catch (_) { continue; }
      if (!d) continue;
      const flag = attrs(d);
      const kind = typeof d.value === 'function' ? ('fn:' + d.value.name + '/' + d.value.length)
        : typeof d.get === 'function' ? ('acc:' + d.get.name + '/' + d.get.length) : ('value:' + typeof d.value);
      out.keys.push(pn + '[' + String(sym) + ']=' + kind + ':' + flag);
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
  // Live instances are part of the surface too: shadowing a prototype member with an own property
  // on the instance (or the reverse) is visible through hasOwnProperty/Object.getOwnPropertyNames.
  const shapeOf = (obj, key) => {
    let d = null; try { d = Object.getOwnPropertyDescriptor(obj, key); } catch (_) { return 'err'; }
    if (!d) return 'absent';
    const flag = (d.writable ? 'w' : '-') + (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-');
    if (typeof d.value === 'function') return 'fn:' + flag + ':' + d.value.name + '/' + d.value.length;
    if (typeof d.value !== 'undefined') return typeof d.value + ':' + flag;
    return 'acc:' + flag + ':get=' + (typeof d.get === 'function' ? (d.get.name + '/' + d.get.length) : '-') +
      ':set=' + (typeof d.set === 'function' ? (d.set.name + '/' + d.set.length) : '-');
  };
  const snapInstance = (label, obj) => {
    if (!obj || typeof obj !== 'object') return;
    const rec = { tag: Object.prototype.toString.call(obj), own: {}, symbols: [], chain: [] };
    let names = []; try { names = Object.getOwnPropertyNames(obj); } catch (_) {}
    for (const k of names) rec.own[k] = shapeOf(obj, k);
    let syms = []; try { syms = Object.getOwnPropertySymbols(obj); } catch (_) {}
    rec.symbols = syms.map(String).sort();
    let cur = obj, guard = 0;
    while (cur && guard < 6) { rec.chain.push(Object.prototype.toString.call(cur)); cur = Object.getPrototypeOf(cur); guard += 1; }
    out.instances[label] = rec;
  };
  out.instances = {};
  for (const [label, getter] of [
    ['navigator', () => navigator],
    ['screen', () => screen],
    ['document', () => document],
    ['location', () => location],
    ['history', () => history],
    ['performance', () => performance],
    ['speechSynthesis', () => speechSynthesis],
    ['mediaDevices', () => navigator.mediaDevices],
    ['userAgentData', () => navigator.userAgentData],
    ['screenOrientation', () => screen.orientation],
    ['visualViewport', () => window.visualViewport],
    ['documentElement', () => document.documentElement],
    ['navigatorProto', () => Object.getPrototypeOf(navigator)],
    ['canvas', () => document.createElement('canvas')],
    ['canvasContext', () => document.createElement('canvas').getContext('2d')],
    ['webgl', () => document.createElement('canvas').getContext('webgl')],
    ['audioContext', () => new (window.AudioContext || window.webkitAudioContext)()],
    ['audioAnalyser', () => new (window.AudioContext || window.webkitAudioContext)().createAnalyser()],
    ['rtcPeerConnection', () => new RTCPeerConnection()],
    ['storage', () => localStorage],
    ['plugins', () => navigator.plugins],
    ['mimeTypes', () => navigator.mimeTypes],
  ]) {
    try { snapInstance(label, getter()); } catch (_) {}
  }
  try {
    const ua = {};
    if (typeof NavigatorUAData !== 'undefined') {
      for (const k of ['getHighEntropyValues', 'toJSON', 'brands', 'mobile', 'platform']) {
        const d = Object.getOwnPropertyDescriptor(NavigatorUAData.prototype, k);
        ua[k] = d ? { value: typeof d.value, enumerable: d.enumerable, configurable: d.configurable,
          writable: 'writable' in d ? d.writable : undefined, name: d.value ? d.value.name : (d.get ? d.get.name : undefined) } : null;
      }
      ua.ownOnInstance = (() => { try { return Object.getOwnPropertyNames(navigator.userAgentData).sort(); } catch (_) { return null; } })();
    }
    out.uaData = ua;
  } catch (e) { out.uaData = { err: String(e) }; }
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

// Wrong-receiver behaviour is observable: a detector can call a patched method with a plain object
// and compare what comes back. Replacements must therefore reproduce the native outcome - the same
// synchronous throw, the same returned value shape, or the same rejection - instead of answering.
const RECEIVER_PROBE = `(async () => {
  const out = {};
  const bogus = {};
  const settle = async (label, fn, args) => {
    if (typeof fn !== 'function') { out[label] = 'missing'; return; }
    try {
      const r = fn.apply(bogus, args || []);
      if (r && typeof r.then === 'function') {
        try { const v = await r; out[label] = 'resolved:' + (v === undefined ? 'undefined' : typeof v); }
        catch (e) { out[label] = 'rejected:' + (e && e.name) + ':' + String(e && e.message).slice(0, 60); }
      } else { out[label] = 'returned:' + (r === undefined ? 'undefined' : typeof r); }
    } catch (e) { out[label] = 'threw:' + (e && e.name) + ':' + String(e && e.message).slice(0, 60); }
  };
  const scan = (name, ctor, allow) => {
    let proto = null; try { proto = ctor && ctor.prototype; } catch (_) {}
    if (!proto) return;
    for (const key of allow) {
      let fn = null; try { fn = proto[key]; } catch (_) {}
      if (typeof fn === 'function') settle(name + '.' + key, fn, []);
    }
  };
  scan('Date', Date, ['getTimezoneOffset', 'toString', 'toDateString', 'getHours', 'setHours']);
  scan('AudioBuffer', window.AudioBuffer, ['getChannelData', 'copyFromChannel']);
  scan('AnalyserNode', window.AnalyserNode, ['getFloatFrequencyData', 'getByteTimeDomainData']);
  scan('HTMLCanvasElement', HTMLCanvasElement, ['toDataURL', 'toBlob', 'getContext']);
  scan('CanvasRenderingContext2D', CanvasRenderingContext2D, ['getImageData']);
  scan('OffscreenCanvas', window.OffscreenCanvas, ['convertToBlob', 'getContext']);
  scan('WebGLRenderingContext', window.WebGLRenderingContext, ['getExtension', 'getParameter', 'readPixels', 'getSupportedExtensions']);
  scan('RTCPeerConnection', window.RTCPeerConnection, ['createOffer', 'addEventListener', 'removeEventListener']);
  scan('MediaDevices', window.MediaDevices, ['enumerateDevices', 'getUserMedia']);
  scan('SpeechSynthesis', window.SpeechSynthesis, ['getVoices', 'cancel']);
  scan('Element', window.Element, ['requestFullscreen', 'webkitRequestFullscreen', 'getBoundingClientRect']);
  scan('Navigator', Navigator, ['getBattery']);
  await settle('NavigatorUAData.getHighEntropyValues', window.NavigatorUAData && NavigatorUAData.prototype.getHighEntropyValues, [[]]);
  await settle('NavigatorUAData.toJSON', window.NavigatorUAData && NavigatorUAData.prototype.toJSON, []);
  // Calling fullscreen on a real element must finish. A retry path that bounced between two
  // replacements never settled and left the page spinning, so the outcome and liveness are both
  // compared here.
  const settleClass = (value, ms) => Promise.race([
    Promise.resolve(value).then(() => 'resolved', (e) => 'rejected:' + (e && e.name)),
    new Promise((r) => setTimeout(() => r('never-settled'), ms)),
  ]);
  try {
    const el = document.createElement('div');
    document.body.appendChild(el);
    out['fullscreen.element'] = await settleClass(el.requestFullscreen(), 2500);
    out['fullscreen.legacyElement'] = await settleClass(el.webkitRequestFullscreen(), 2500);
    el.remove();
  } catch (e) { out['fullscreen.element'] = 'threw:' + (e && e.name) + ':' + String(e && e.message).slice(0, 40); }
  for (const [iface, key] of [['Navigator', 'userAgent'], ['Screen', 'width'], ['Document', 'fullscreenEnabled'],
    ['VisualViewport', 'width'], ['VisualViewport', 'height'], ['NavigatorUAData', 'brands']]) {
    let proto = null; try { proto = window[iface] && window[iface].prototype; } catch (_) {}
    if (!proto) continue;
    let d = null; try { d = Object.getOwnPropertyDescriptor(proto, key); } catch (_) {}
    if (!d || typeof d.get !== 'function') { out['get:' + iface + '.' + key] = 'no-getter'; continue; }
    try { const v = d.get.call(bogus); out['get:' + iface + '.' + key] = 'returned:' + typeof v; }
    catch (e) { out['get:' + iface + '.' + key] = 'threw:' + e.name + ':' + String(e.message).slice(0, 60); }
  }
  return JSON.stringify(out);
})()`;

// A spoofed BatteryManager must stay a real native object: the browser exposes its four values as
// prototype accessors and the instance has no own members. The probe records both the shape and the
// live values so the injected run can be compared with the stock run and the configured profile.
const BATTERY_PROBE = `(async () => {
  const out = {};
  try {
    const manager = await navigator.getBattery();
    const proto = Object.getPrototypeOf(manager);
    const descriptors = {};
    for (const key of ['charging', 'chargingTime', 'dischargingTime', 'level']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      descriptors[key] = descriptor ? {
        getterName: descriptor.get && descriptor.get.name,
        getterLength: descriptor.get && descriptor.get.length,
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
      } : null;
    }
    let listenerOk = false;
    try { manager.addEventListener('levelchange', () => {}); listenerOk = true; } catch (_) {}
    out.own = Object.getOwnPropertyNames(manager).sort();
    out.protoNames = Object.getOwnPropertyNames(proto).sort();
    out.descriptors = descriptors;
    out.tag = Object.prototype.toString.call(manager);
    out.instanceofBatteryManager = typeof BatteryManager !== 'undefined' ? manager instanceof BatteryManager : null;
    out.listenerOk = listenerOk;
    out.values = {
      charging: manager.charging,
      chargingTime: manager.chargingTime,
      dischargingTime: manager.dischargingTime,
      level: manager.level,
    };
  } catch (error) { out.error = String(error && error.name || error) + ':' + String(error && error.message || ''); }
  return JSON.stringify(out);
})()`;

// Synthetic objects that model browser interfaces must not add own members or replace prototype
// accessors with data properties. A page can detect that without calling any of the spoofed values,
// so the stock and injected runs are compared as object graphs rather than only as value sets.
const SPOOF_INSTANCE_PROBE = `(async () => {
  const out = {};
  const shapeOf = (obj, keys) => {
    if (!obj) return null;
    const proto = Object.getPrototypeOf(obj);
    const descriptors = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      descriptors[key] = descriptor ? {
        kind: descriptor.value !== undefined ? 'value' : (descriptor.get ? 'getter' : 'unknown'),
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        name: descriptor.get && descriptor.get.name,
        length: descriptor.get && descriptor.get.length,
      } : null;
    }
    return { own: Object.getOwnPropertyNames(obj).sort(), protoNames: Object.getOwnPropertyNames(proto).sort(), descriptors, tag: Object.prototype.toString.call(obj) };
  };
  const protoShape = (ctor, keys) => {
    if (!ctor || !ctor.prototype) return null;
    const descriptors = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, key);
      descriptors[key] = descriptor ? {
        kind: descriptor.value !== undefined ? 'value' : (descriptor.get ? 'getter' : 'unknown'),
        enumerable: descriptor.enumerable,
        configurable: descriptor.configurable,
        name: descriptor.get && descriptor.get.name,
        length: descriptor.get && descriptor.get.length,
      } : null;
    }
    return { names: Object.getOwnPropertyNames(ctor.prototype).sort(), descriptors };
  };
  try { out.mediaProto = protoShape(typeof MediaDeviceInfo !== 'undefined' ? MediaDeviceInfo : null, ['deviceId', 'kind', 'label', 'groupId', 'toJSON']); } catch (_) {}
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const item = list[0];
    out.media = shapeOf(item, ['deviceId', 'kind', 'label', 'groupId']);
    out.mediaValues = item ? { deviceId: item.deviceId, kind: item.kind, label: item.label, groupId: item.groupId } : null;
    out.mediaJSON = item && typeof item.toJSON === 'function' ? item.toJSON() : null;
    out.mediaInstanceof = !!(item && typeof MediaDeviceInfo !== 'undefined' && item instanceof MediaDeviceInfo);
  } catch (error) { out.mediaError = String(error && error.name || error); }
  try {
    const voice = speechSynthesis.getVoices()[0];
    out.voice = shapeOf(voice, ['name', 'lang', 'default', 'localService', 'voiceURI']);
    out.voiceInstanceof = !!(voice && typeof SpeechSynthesisVoice !== 'undefined' && voice instanceof SpeechSynthesisVoice);
  } catch (error) { out.voiceError = String(error && error.name || error); }
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      out.adapter = shapeOf(adapter, ['info', 'features', 'limits']);
      out.adapterInstanceof = !!(adapter && typeof GPUAdapter !== 'undefined' && adapter instanceof GPUAdapter);
      const info = adapter && adapter.info;
      out.adapterInfo = shapeOf(info, ['vendor', 'architecture', 'device', 'description']);
      out.adapterInfoInstanceof = !!(info && typeof GPUAdapterInfo !== 'undefined' && info instanceof GPUAdapterInfo);
      const ownInfo = adapter ? Object.getOwnPropertyDescriptor(adapter, 'info') : null;
      out.adapterInfoOwnDescriptor = ownInfo ? { kind: ownInfo.get ? 'getter' : 'value', enumerable: ownInfo.enumerable, configurable: ownInfo.configurable } : null;
    }
  } catch (error) { out.gpuError = String(error && error.name || error); }
  return JSON.stringify(out);
})()`;

// DOMRectList has indexed own properties but no own length; length/item/iterator live on the
// prototype. Compare the live object graph as well as the returned geometry.
const RECTS_PROBE = `(() => {
  const out = {};
  const snap = (obj) => {
    if (!obj) return null;
    const chain = [];
    let cursor = obj;
    let guard = 0;
    while (cursor && guard++ < 6) { chain.push(Object.prototype.toString.call(cursor)); cursor = Object.getPrototypeOf(cursor); }
    const descriptors = {};
    for (const key of Object.getOwnPropertyNames(obj)) {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key);
      descriptors[key] = descriptor ? { kind: descriptor.get ? 'getter' : 'value', enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable, valueType: typeof descriptor.value } : null;
    }
    return { own: Object.getOwnPropertyNames(obj).sort(), symbols: Object.getOwnPropertySymbols(obj).map(String).sort(), chain, descriptors, tag: Object.prototype.toString.call(obj) };
  };
  const el = document.createElement('div');
  el.textContent = 'rect probe';
  el.style.cssText = 'position:absolute;left:10px;top:20px;width:100px;height:30px;font:14px Arial;white-space:nowrap';
  document.body.appendChild(el);
  const list = el.getClientRects();
  const rect = el.getBoundingClientRect();
  out.list = snap(list);
  out.rect = snap(rect);
  out.listInstanceof = typeof DOMRectList !== 'undefined' ? list instanceof DOMRectList : null;
  out.rectInstanceof = typeof DOMRect !== 'undefined' ? rect instanceof DOMRect : null;
  out.length = list.length;
  out.itemType = typeof list.item;
  out.item0 = list.item(0) ? Object.prototype.toString.call(list.item(0)) : null;
  out.arrayLength = Array.from(list).length;
  out.spreadLength = (() => { try { return [...list].length; } catch (_) { return 'ERR'; } })();
  el.remove();
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
  // Speech and battery spoofing are switched on so the receiver guards on those entry points are
  // actually exercised; a profile that leaves them at their defaults would make those assertions
  // vacuous. The WebRTC address is set for the same reason: the proxy rewrite only installs when a
  // replacement address is configured, and without it the whole block - including the prototype
  // accessors it rewrites - would be skipped and never compared against the stock build.
  return { id, name: id, kernelVersion: '148.0.7778.165', os: 'macos', canvas: 'noise', webgl: 'noise',
    audio: 'noise', clientRects: 'noise', webrtc: 'proxy', cores: 8, memory: 8,
    privacy: { speech: 'noise', battery: 'noise', webgpu: 'webgl', webrtcAddress: '203.0.113.9' } };
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
          const m = await cdp.send('Runtime.evaluate', { expression: SURFACE_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const val = m && m.result && m.result.result ? m.result.result.value : null;
          try { result = JSON.parse(val); } catch (_) { result = { error: 'probe parse failed', raw: String(val).slice(0, 200) }; }
          const m2 = await cdp.send('Runtime.evaluate', { expression: RECEIVER_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const val2 = m2 && m2.result && m2.result.result ? m2.result.result.value : null;
          try { result.receivers = JSON.parse(val2); } catch (_) { result.receivers = { error: 'receiver probe parse failed' }; }
          const rectResult = await cdp.send('Runtime.evaluate', { expression: RECTS_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const rectValue = rectResult && rectResult.result && rectResult.result.result ? rectResult.result.result.value : null;
          try { result.rects = JSON.parse(rectValue); } catch (_) { result.rects = { error: 'rect probe parse failed' }; }
          const m3 = await cdp.send('Runtime.evaluate', { expression: BATTERY_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const val3 = m3 && m3.result && m3.result.result ? m3.result.result.value : null;
          try { result.battery = JSON.parse(val3); } catch (_) { result.battery = { error: 'battery probe parse failed' }; }
          const m4 = await cdp.send('Runtime.evaluate', { expression: SPOOF_INSTANCE_PROBE, returnByValue: true, awaitPromise: true }, sessionId);
          const val4 = m4 && m4.result && m4.result.result ? m4.result.result.value : null;
          try { result.spoofInstances = JSON.parse(val4); } catch (_) { result.spoofInstances = { error: 'spoof instance probe parse failed' }; }
          result.expectedBattery = fp.battery && fp.battery.value ? fp.battery.value : null;
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

  // A hosted runner may not be able to launch the bundled kernel at all. That is an environment
  // limitation rather than a result, so it is reported as a skip there; an ordinary run still fails.
  const startup = [baseline, injected].find((r) => r && r.error);
  if (startup && process.env.CI) {
    console.log(`  SKIP  bundled kernel unavailable in this environment (${startup.error})`);
    console.log('surface-integrity-e2e-selftest: ok');
    return;
  }

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

  check('client-hint members keep their native descriptor shape', () => {
    const a = injected.uaData || {};
    const b = baseline.uaData || {};
    assert.ok(!a.err, `client-hint probe failed: ${a.err}`);
    assert.deepStrictEqual(a, b, 'the client-hint surface must match the same build without the injected layer');
    for (const k of ['getHighEntropyValues', 'toJSON']) {
      assert.strictEqual(a[k].enumerable, true,
        `${k} is enumerable on the prototype in a real build, so it must stay enumerable here`);
      assert.strictEqual(a[k].configurable, true, `${k} must stay configurable`);
      assert.strictEqual(a[k].writable, true, `${k} must stay writable`);
    }
    assert.deepStrictEqual(a.ownOnInstance, [],
      'the userAgentData instance carries no own members in a real build');
  });

  check('live instances keep the same own-property shape', () => {
    const base = baseline.instances || {};
    const inj = injected.instances || {};
    const labels = new Set([...Object.keys(base), ...Object.keys(inj)]);
    assert.ok(labels.size >= 15, `instance snapshot covered too few objects: ${labels.size}`);
    const drift = [];
    for (const label of labels) {
      const before = JSON.stringify(base[label]);
      const after = JSON.stringify(inj[label]);
      if (before === after) continue;
      const a = base[label] || {}, b = inj[label] || {};
      const keys = new Set([...Object.keys(a.own || {}), ...Object.keys(b.own || {})]);
      for (const k of keys) {
        if ((a.own || {})[k] !== (b.own || {})[k]) {
          drift.push(`${label}.${k}: native=${(a.own || {})[k] || 'absent'} injected=${(b.own || {})[k] || 'absent'}`);
        }
      }
      if (JSON.stringify(a.symbols) !== JSON.stringify(b.symbols)) drift.push(`${label}: symbol keys differ`);
      if (JSON.stringify(a.chain) !== JSON.stringify(b.chain)) drift.push(`${label}: prototype chain differs`);
      if (a.tag !== b.tag) drift.push(`${label}: toStringTag ${a.tag} -> ${b.tag}`);
    }
    assert.deepStrictEqual(drift, [],
      `instances gained or lost own members versus the same build without injection: ${drift.join('; ')}`);
  });

  check('synthetic browser objects keep the native own-property and prototype shape', () => {
    const before = baseline.spoofInstances || {};
    const after = injected.spoofInstances || {};
    assert.ok(!after.error, `spoof instance probe failed: ${after.error}`);
    if (before.mediaProto && after.mediaProto) {
      assert.deepStrictEqual(after.mediaProto, before.mediaProto, 'MediaDeviceInfo prototype shape changed');
    }
    if (after.media) {
      assert.deepStrictEqual(after.media.own, [], 'MediaDeviceInfo instances must not gain own members');
      assert.strictEqual(after.mediaInstanceof, true, 'MediaDeviceInfo instances must keep their native brand');
      assert.ok(after.mediaJSON && typeof after.mediaJSON.deviceId === 'string', 'MediaDeviceInfo.toJSON must stay usable');
    }
    for (const [name, instanceKey, brandKey] of [
      ['SpeechSynthesisVoice', 'voice', 'voiceInstanceof'],
      ['GPUAdapter', 'adapter', 'adapterInstanceof'],
      ['GPUAdapterInfo', 'adapterInfo', 'adapterInfoInstanceof'],
    ]) {
      const expected = before[instanceKey];
      const actual = after[instanceKey];
      if (expected && actual) assert.deepStrictEqual(actual, expected, `${name} instance shape changed`);
      if (actual) {
        assert.deepStrictEqual(actual.own, [], `${name} instances must not gain own members`);
        assert.strictEqual(after[brandKey], true, `${name} instances must keep their native brand`);
      }
    }
    if (after.adapter) {
      assert.strictEqual(after.adapterInfoOwnDescriptor, null, 'GPUAdapter.info must stay on the prototype');
    }
  });

  check('client-rect lists keep the native own-property, prototype and iterator shape', () => {
    const before = baseline.rects || {};
    const after = injected.rects || {};
    assert.ok(!before.error && !after.error, `rect probe failed: ${before.error || after.error}`);
    assert.deepStrictEqual(after.list, before.list, 'DOMRectList instance shape changed');
    assert.deepStrictEqual(after.rect, before.rect, 'DOMRect instance shape changed');
    assert.strictEqual(after.listInstanceof, before.listInstanceof, 'DOMRectList brand changed');
    assert.strictEqual(after.rectInstanceof, before.rectInstanceof, 'DOMRect brand changed');
    assert.strictEqual(after.length, before.length, 'DOMRectList length changed');
    assert.strictEqual(after.item0, before.item0, 'DOMRectList.item must return a DOMRect');
    assert.strictEqual(after.arrayLength, before.arrayLength, 'DOMRectList Array.from changed');
    assert.strictEqual(after.spreadLength, before.spreadLength, 'DOMRectList spread changed');
  });

  check('battery manager keeps the native prototype shape and applies the profile values', () => {
    const before = baseline.battery || {};
    const after = injected.battery || {};
    assert.ok(!before.error && !after.error, `battery probe failed: ${before.error || after.error}`);
    assert.deepStrictEqual(after.own, before.own, 'the injected manager gained own properties that a stock manager does not have');
    assert.deepStrictEqual(after.protoNames, before.protoNames, 'the BatteryManager prototype surface changed');
    assert.deepStrictEqual(after.descriptors, before.descriptors, 'BatteryManager accessor descriptors changed');
    assert.strictEqual(after.tag, before.tag, 'BatteryManager brand changed');
    assert.strictEqual(after.instanceofBatteryManager, before.instanceofBatteryManager, 'BatteryManager instanceof changed');
    assert.strictEqual(after.listenerOk, true, 'the returned manager must remain a usable EventTarget');
    const expected = injected.expectedBattery;
    assert.ok(expected, 'the injected run did not carry a battery payload');
    assert.strictEqual(after.values.charging, Boolean(expected.charging), 'charging value mismatch');
    // JSON transport turns Infinity into null, so both sides are compared in that same normal form.
    assert.strictEqual(after.values.chargingTime, expected.chargingTime == null ? null : Number(expected.chargingTime), 'chargingTime value mismatch');
    assert.strictEqual(after.values.dischargingTime, expected.dischargingTime == null ? null : Number(expected.dischargingTime), 'dischargingTime value mismatch');
    assert.strictEqual(after.values.level, Math.min(1, Math.max(0, Number(expected.level) || 0)), 'level value mismatch');
  });

  check('wrong-receiver calls behave exactly as they do without the injected layer', () => {
    const a = baseline.receivers || {};
    const b = injected.receivers || {};
    assert.ok(!a.error && !b.error, `receiver probe failed: ${a.error || b.error}`);
    const labels = Object.keys(a);
    assert.ok(labels.length >= 20, `receiver probe covered too few entry points: ${labels.length}`);
    const drift = labels.filter((k) => String(a[k]) !== String(b[k]))
      .map((k) => `${k}: native=${a[k]} injected=${b[k]}`);
    assert.deepStrictEqual(drift, [],
      `calling these with a foreign receiver no longer matches the native build: ${drift.join(' | ')}`);
  });

  check('fullscreen calls settle instead of retrying between replacements', () => {
    const a = baseline.receivers || {};
    const b = injected.receivers || {};
    for (const key of ['fullscreen.element', 'fullscreen.legacyElement']) {
      assert.ok(key in a && key in b, `${key} was not probed`);
      assert.notStrictEqual(String(b[key]), 'never-settled', `${key} never settled under injection`);
      assert.strictEqual(String(b[key]), String(a[key]), `${key}: native=${a[key]} injected=${b[key]}`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.log(`surface-integrity-e2e-selftest: FAILED ${failed.length}/${results.length}`);
  else console.log(`surface-integrity-e2e-selftest: OK ${results.length}/${results.length}`);
})().catch((err) => {
  console.error('surface-integrity-e2e-selftest: crashed', (err && err.stack) || err);
  process.exitCode = 1;
});
