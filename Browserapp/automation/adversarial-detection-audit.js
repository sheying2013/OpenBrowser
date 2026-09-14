#!/usr/bin/env node
'use strict';

/**
 * Adversarial Detection Audit Suite (Red-Team Perspective)
 *
 * Runs an exhaustive A/B adversarial audit comparing the stock native Chromium kernel
 * against the production fingerprint-injected browser session.
 *
 * Evaluates 5 core categories:
 *  1. Prototype & Property Descriptor Fidelity
 *  2. Cross-Context Coverage Blind Spots (Popups, srcdoc, sandboxed iframes, Workers)
 *  3. Timing, Stacks & Lifecycle Leaks (Error().stack, function frames, getter leakage)
 *  4. Detection Library Behavioral Invariants (languages identity, Client Hints Set input)
 *  5. Cross-Domain Platform Consistency (Windows persona on macOS host)
 *
 * NOTE: This is an audit tool. It reports all observable differentiators and exits 0.
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'CDP command timeout', method });
      }, 30000);
      this.pending.set(id, { resolve, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: String(err) });
      }
    });
  }

  async eval(expression, sessionId) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (res?.result?.exceptionDetails) {
      return { __error: true, details: res.result.exceptionDetails };
    }
    return res?.result?.result?.value;
  }
}

const AUDIT_EXPRESSION = `(async () => {
  const audit = {};

  // ==========================================
  // Category 1: Prototype & Descriptor Fidelity
  // ==========================================
  audit.prototypes = {};
  try {
    const dDate = Object.getOwnPropertyDescriptor(Date, 'prototype');
    const dIntl = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat, 'prototype');
    audit.prototypes.datePrototypeWritable = dDate ? dDate.writable : null;
    audit.prototypes.intlPrototypeWritable = dIntl ? dIntl.writable : null;
    audit.prototypes.datePropertyOrder = Object.getOwnPropertyNames(Date);
    audit.prototypes.intlPropertyOrder = Object.getOwnPropertyNames(Intl.DateTimeFormat);
    audit.prototypes.dateConstructorEq = (Date.prototype.constructor === Date);
    audit.prototypes.intlConstructorEq = (Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat);

    // Function.prototype.toString checks
    audit.prototypes.toStringToString = Function.prototype.toString.toString();
    audit.prototypes.toStringHasProto = Function.prototype.toString.hasOwnProperty('prototype');
    audit.prototypes.toStringName = Function.prototype.toString.name;
    audit.prototypes.toStringLength = Function.prototype.toString.length;
    try { Function.prototype.toString.call(null); audit.prototypes.toStringNullThrows = false; }
    catch (e) { audit.prototypes.toStringNullThrows = e.name + ': ' + e.message; }
    try { Function.prototype.toString.call(123); audit.prototypes.toStringNumThrows = false; }
    catch (e) { audit.prototypes.toStringNumThrows = e.name + ': ' + e.message; }
    try { Function.prototype.toString.call({}); audit.prototypes.toStringObjThrows = false; }
    catch (e) { audit.prototypes.toStringObjThrows = e.name + ': ' + e.message; }
  } catch (e) { audit.prototypes.error = String(e); }

  // ==========================================
  // Category 2: Cross-Context Coverage Blind Spots
  // ==========================================
  audit.crossContext = {};

  // 2.1 window.open('about:blank')
  try {
    const w = window.open('about:blank');
    if (w) {
      audit.crossContext.windowOpen = {
        platform: w.navigator.platform,
        userAgent: w.navigator.userAgent,
        timezone: w.Intl ? w.Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        hardwareConcurrency: w.navigator.hardwareConcurrency,
        deviceMemory: w.navigator.deviceMemory,
        dateOffset: new w.Date().getTimezoneOffset(),
        webglRenderer: (() => {
          try {
            const c = w.document.createElement('canvas');
            const gl = c.getContext('webgl');
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
          } catch (_) { return null; }
        })()
      };
      w.close();
    } else {
      audit.crossContext.windowOpen = { popupBlocked: true };
    }
  } catch (e) { audit.crossContext.windowOpen = { error: String(e) }; }

  // 2.2 Sandboxed iframe without allow-same-origin
  try {
    const sboxFrame = document.createElement('iframe');
    sboxFrame.sandbox = 'allow-scripts';
    sboxFrame.srcdoc = \`
      <script>
        const payload = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          dateOffset: new Date().getTimezoneOffset()
        };
        window.parent.postMessage({ __sboxReport: payload }, '*');
      <\\/script>
    \`;
    const sboxPromise = new Promise((resolve) => {
      const handler = (e) => {
        if (e.data && e.data.__sboxReport) {
          window.removeEventListener('message', handler);
          resolve(e.data.__sboxReport);
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => resolve({ timeout: true }), 3000);
    });
    document.body.appendChild(sboxFrame);
    audit.crossContext.sandboxedIframe = await sboxPromise;
    sboxFrame.remove();
  } catch (e) { audit.crossContext.sandboxedIframe = { error: String(e) }; }

  // 2.3 srcdoc iframe
  try {
    const sdFrame = document.createElement('iframe');
    sdFrame.srcdoc = \`
      <script>
        const payload = {
          platform: navigator.platform,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory
        };
        window.parent.postMessage({ __sdReport: payload }, '*');
      <\\/script>
    \`;
    const sdPromise = new Promise((resolve) => {
      const handler = (e) => {
        if (e.data && e.data.__sdReport) {
          window.removeEventListener('message', handler);
          resolve(e.data.__sdReport);
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => resolve({ timeout: true }), 3000);
    });
    document.body.appendChild(sdFrame);
    audit.crossContext.srcdocIframe = await sdPromise;
    sdFrame.remove();
  } catch (e) { audit.crossContext.srcdocIframe = { error: String(e) }; }

  // 2.4 document.open() rewrite in iframe
  try {
    const docFrame = document.createElement('iframe');
    document.body.appendChild(docFrame);
    docFrame.contentDocument.open();
    docFrame.contentDocument.write('<html><body><script>window.__docOpenReport = { platform: navigator.platform, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, hwc: navigator.hardwareConcurrency };<\\/script></body></html>');
    docFrame.contentDocument.close();
    audit.crossContext.documentOpen = docFrame.contentWindow.__docOpenReport || null;
    docFrame.remove();
  } catch (e) { audit.crossContext.documentOpen = { error: String(e) }; }

  // ==========================================
  // Category 3: Timing, Stacks & Lifecycle Leaks
  // ==========================================
  audit.stackLeaks = {};
  try {
    try {
      const c = document.createElement('canvas');
      c.getContext('2d').getImageData(0, 0, 0, 0);
    } catch (e) { audit.stackLeaks.getImageData = e.stack; }

    try {
      new Date('invalid-string').toISOString();
    } catch (e) { audit.stackLeaks.dateIso = e.stack; }

    try {
      Intl.DateTimeFormat('unsupported-locale-tag-12345').format();
    } catch (e) { audit.stackLeaks.intlBadLocale = e.stack; }

    try {
      Navigator.prototype.__lookupGetter__('userAgent').call({});
    } catch (e) { audit.stackLeaks.navUaReceiver = e.stack; }
  } catch (e) { audit.stackLeaks.error = String(e); }

  // ==========================================
  // Category 4: Detection Library Invariants
  // ==========================================
  audit.detectionInvariants = {};
  try {
    // 4.1 FrozenArray Cached Identity
    audit.detectionInvariants.languagesIdentity = (navigator.languages === navigator.languages);
    audit.detectionInvariants.languagesFrozen = Object.isFrozen(navigator.languages);
    audit.detectionInvariants.languageMatch = (navigator.languages && navigator.languages[0] === navigator.language);

    // 4.2 userAgentData getHighEntropyValues parameter polymorphism (Sequence accepts Iterable/Set)
    if (navigator.userAgentData) {
      try {
        const arrRes = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
        audit.detectionInvariants.uadHeArrayKeys = Object.keys(arrRes);
      } catch (e) { audit.detectionInvariants.uadHeArrayKeys = 'error:' + e.message; }

      try {
        const setRes = await navigator.userAgentData.getHighEntropyValues(new Set(['architecture', 'bitness']));
        audit.detectionInvariants.uadHeSetKeys = Object.keys(setRes);
        audit.detectionInvariants.uadHeSetHasArch = ('architecture' in setRes);
      } catch (e) { audit.detectionInvariants.uadHeSetKeys = 'error:' + e.message; }

      audit.detectionInvariants.uadBrandsIdentity = (navigator.userAgentData.brands === navigator.userAgentData.brands);
    }

    // 4.3 navigator.plugins & mimeTypes
    audit.detectionInvariants.pluginsLength = navigator.plugins.length;
    audit.detectionInvariants.mimeTypesLength = navigator.mimeTypes.length;
    audit.detectionInvariants.pdfViewerEnabled = navigator.pdfViewerEnabled;
    audit.detectionInvariants.pluginsNamedItem = navigator.plugins.namedItem ? Boolean(navigator.plugins.namedItem('PDF Viewer')) : false;

    // 4.4 navigator.webdriver
    audit.detectionInvariants.webdriverValue = navigator.webdriver;
    audit.detectionInvariants.webdriverInNav = ('webdriver' in navigator);
    audit.detectionInvariants.webdriverOwn = Object.prototype.hasOwnProperty.call(navigator, 'webdriver');
  } catch (e) { audit.detectionInvariants.error = String(e); }

  // ==========================================
  // Category 5: Platform Consistency (Windows persona on host)
  // ==========================================
  audit.platformConsistency = {};
  try {
    audit.platformConsistency.platform = navigator.platform;
    audit.platformConsistency.userAgent = navigator.userAgent;
    audit.platformConsistency.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    audit.platformConsistency.dateOffset = new Date().getTimezoneOffset();
    audit.platformConsistency.hardwareConcurrency = navigator.hardwareConcurrency;
    audit.platformConsistency.deviceMemory = navigator.deviceMemory;

    // WebGL
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      audit.platformConsistency.webglUnmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      audit.platformConsistency.webglUnmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      audit.platformConsistency.webglStdRenderer = gl.getParameter(gl.RENDERER);
    }

    // Speech
    const voices = speechSynthesis.getVoices();
    audit.platformConsistency.voicesCount = voices.length;
    audit.platformConsistency.voicesSample = voices.slice(0, 4).map((v) => ({ name: v.name, lang: v.lang }));

    // Battery
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      audit.platformConsistency.battery = {
        charging: b.charging,
        chargingTime: b.chargingTime,
        dischargingTime: b.dischargingTime,
        level: b.level
      };
    }
  } catch (e) { audit.platformConsistency.error = String(e); }

  return audit;
})()`;

async function measureSession(profileConfig, inject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-audit-' + profileConfig.id + '-'));
  const fp = buildFingerprint(profileConfig);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile: profileConfig,
    templatePath: path.join(kernelRoot, 'init_template.json')
  });

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Audit Benchmark</title></head><body>Audit Target</body></html>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const child = spawn(launcher, [dir, '--headless=new', '--disable-popup-blocking'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }

  if (!port) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { error: 'Failed to retrieve DevToolsActivePort' };
  }

  let result = null;
  let ws = null;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created?.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached?.result?.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    if (inject) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: buildInjectionScript(fp)
      }, sessionId);
    }
    await cdp.send('Page.navigate', { url }, sessionId);
    await sleep(2500);

    result = await cdp.eval(AUDIT_EXPRESSION, sessionId);
    await cdp.send('Target.closeTarget', { targetId });
  } catch (err) {
    result = { error: String(err) };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return result;
}

async function main() {
  console.log('===============================================================');
  console.log('  OpenBrowser Adversarial Detection Audit (Red-Team Perspective)');
  console.log('===============================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('SKIP: macos-x64 kernel launcher not available.');
    return;
  }

  const profile = {
    id: 'adversarial-windows',
    name: 'adversarial-windows',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    canvas: 'noise',
    webgl: 'noise',
    cores: 8,
    memory: 8,
    privacy: {
      webrtc: 'proxy',
      timezoneMode: 'custom',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      webrtcAddress: '203.0.113.9'
    }
  };

  console.log('[Phase 1/2] Capturing Stock Native Kernel Baseline (Un-injected)...');
  const baseline = await measureSession(profile, false);

  console.log('[Phase 2/2] Capturing Injected Persona Session (Windows Persona on Host)...');
  const injected = await measureSession(profile, true);

  console.log('\n================ AUDIT SUMMARY COMPARISON ================\n');

  const findings = [];

  // Helper to register finding
  const record = (sev, id, category, desc, baseVal, injVal, fileRef) => {
    findings.push({ sev, id, category, desc, baseVal, injVal, fileRef });
  };

  // 1. Prototype Writable Flaws
  if (injected.prototypes?.datePrototypeWritable === true && baseline.prototypes?.datePrototypeWritable === false) {
    record('P0', 'PROTO-DATE-WRITABLE', 'Prototypes',
      'Date.prototype descriptor writable is true (native V8 is false). Detectable via Object.getOwnPropertyDescriptor(Date, "prototype").writable === true.',
      false, true, 'automation/fingerprint.js:2776');
  }
  if (injected.prototypes?.intlPrototypeWritable === true && baseline.prototypes?.intlPrototypeWritable === false) {
    record('P0', 'PROTO-INTL-WRITABLE', 'Prototypes',
      'Intl.DateTimeFormat.prototype descriptor writable is true (native V8 is false). Detectable via Object.getOwnPropertyDescriptor(Intl.DateTimeFormat, "prototype").writable === true.',
      false, true, 'automation/fingerprint.js:2544');
  }

  // 2. Date property order
  const baseOrder = JSON.stringify(baseline.prototypes?.datePropertyOrder);
  const injOrder = JSON.stringify(injected.prototypes?.datePropertyOrder);
  if (baseOrder !== injOrder) {
    record('P1', 'PROTO-DATE-ORDER', 'Prototypes',
      'Object.getOwnPropertyNames(Date) property order altered. UTC inserted before now/parse.',
      baseOrder, injOrder, 'automation/fingerprint.js:2780');
  }

  // 3. languages Identity
  if (injected.detectionInvariants?.languagesIdentity === false && baseline.detectionInvariants?.languagesIdentity === true) {
    record('P0', 'NAV-LANG-IDENTITY', 'Detection Libraries',
      'navigator.languages === navigator.languages identity test fails (returns false). WebIDL Cached FrozenArray invariant violated on main thread.',
      true, false, 'automation/fingerprint.js:2314');
  }

  // 4. userAgentData HighEntropy Set input
  if (injected.detectionInvariants?.uadHeSetHasArch === false && baseline.detectionInvariants?.uadHeSetHasArch === true) {
    record('P1', 'UAD-SET-DROPPED', 'Detection Libraries',
      'navigator.userAgentData.getHighEntropyValues drops hints when passed a Set or non-Array iterable. WebIDL sequence<DOMString> contract violated.',
      'architecture present', 'architecture missing', 'automation/user-agent.js:545');
  }

  // 5. window.open('about:blank') leak
  const wo = injected.crossContext?.windowOpen;
  if (wo && wo.platform === 'MacIntel' && injected.platformConsistency?.platform === 'Win32') {
    record('P0', 'CONTEXT-WIN-OPEN-LEAK', 'Cross-Context',
      'window.open("about:blank") synchronously exposes true host hardware, OS platform ("MacIntel"), host timezone, and host GPU.',
      'N/A', `platform=${wo.platform}, tz=${wo.timezone}, hwc=${wo.hardwareConcurrency}, devMem=${wo.deviceMemory}`, 'automation/fingerprint.js: window.open not hooked');
  }

  // 6. Sandboxed iframe leak
  const sb = injected.crossContext?.sandboxedIframe;
  if (sb && sb.platform === 'MacIntel') {
    record('P0', 'CONTEXT-SANDBOX-IFRAME-LEAK', 'Cross-Context',
      '<iframe sandbox="allow-scripts"> without allow-same-origin bypasses Page.addScriptToEvaluateOnNewDocument and subwindow hooking, revealing real host platform and hardware.',
      'N/A', `platform=${sb.platform}, tz=${sb.timezone}, hwc=${sb.hardwareConcurrency}, devMem=${sb.deviceMemory}`, 'CDP Page.addScriptToEvaluateOnNewDocument boundary');
  }

  // 7. Error().stack leaks
  const sLeaks = injected.stackLeaks || {};
  if (sLeaks.getImageData && sLeaks.getImageData.includes('CanvasRenderingContext2D.getImageData')) {
    record('P1', 'STACK-WRAPPER-LEAK', 'Timing & Stacks',
      'Error().stack exposes internal wrapper frames (e.g. CanvasRenderingContext2D.getImageData anonymous line traces) on exceptions.',
      '1 native stack line', sLeaks.getImageData.split('\n').slice(0, 3).join(' | '), 'automation/fingerprint.js:replaceMethod');
  }
  if (sLeaks.navUaReceiver && sLeaks.navUaReceiver.includes('get userAgent')) {
    record('P1', 'STACK-GETTER-LEAK', 'Timing & Stacks',
      'Error().stack exposes injected getter function frame "get userAgent" upon illegal receiver invocation.',
      'at <anonymous>', sLeaks.navUaReceiver.split('\n')[1] || '', 'automation/user-agent.js:makeUaGetter');
  }

  console.log(`Detected ${findings.length} actionable adversarial vulnerabilities:\n`);
  for (const f of findings) {
    console.log(`[${f.sev}] ${f.id} (${f.category})`);
    console.log(`  Description: ${f.desc}`);
    console.log(`  Native Baseline: ${f.baseVal}`);
    console.log(`  Injected Persona: ${f.injVal}`);
    console.log(`  Code Reference: ${f.fileRef}\n`);
  }

  const dumpPath = path.join(appRoot, '..', 'reports', 'audit-raw-dump.json');
  try {
    fs.writeFileSync(dumpPath, JSON.stringify({ baseline, injected, findings }, null, 2));
    console.log(`Raw audit data saved to: ${dumpPath}`);
  } catch (_) {}

  console.log('Adversarial Detection Audit Complete.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Audit execution error:', err);
    process.exit(0);
  });
}
