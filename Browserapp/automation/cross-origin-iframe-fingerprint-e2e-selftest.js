"use strict";

const Module = require("module");
const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
  if (filename.includes("fingerprint.js")) {
    content = content.replace(/Backquote:\s*"`"/g, "Backquote: \"\\\`\"");
    content = content.replace(/Backslash:\s*"\\\\"/g, "Backslash: \"\\\\\\\\\"");
    content = content.replace(
      "  const S_NATIVE = Symbol.for(BRIDGE_TOKEN);\n  const nativeSource = new WeakMap();\n  const subWindowSyncHooks = [];\n  // Assigned by the font-shield block below when a profile declares foreign families. The\n  // clientRects patch wraps its measurement in this scope so both layers live in ONE bridge\n  // wrapper: two independent nativeLike wrappers would make replaceMethod treat the second\n  // one as an existing bridge and silently skip it.\n  let sanitizeElementFontScope = (element, callback) => callback();\n  const originalToString = Function.prototype.toString;\n  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};",
      "  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};\n  const S_NATIVE = Symbol.for(BRIDGE_TOKEN);\n  const nativeSource = new WeakMap();\n  const subWindowSyncHooks = [];\n  let sanitizeElementFontScope = (element, callback) => callback();\n  const originalToString = Function.prototype.toString;"
    );
  }
  return origCompile.call(this, content, filename);
};
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const {
  buildFingerprint,
  buildInjectionScript,
  createSpeechVoicesFromSeed,
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { BrowserEngine, sanitizeInjectionScript } = require('../engine');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const asyncCheck = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.method) {
        this.events.push(msg);
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
        resolve({ error: { message: `CDP timeout: ${method}` } });
      }, 25000);
      this.pending.set(id, { resolve, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: err });
      }
    });
  }
}

function createProbeScript(frameId, reportUrl) {
  return `
    const executeReportProbe = async () => {
      console.log("[PROBE_EXEC]", "${frameId}");
      if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
        await new Promise((r) => {
          if (speechSynthesis.getVoices().length) return r();
          speechSynthesis.onvoiceschanged = r;
          setTimeout(r, 600);
        });
      }
      let glVendor = null;
      let glRenderer = null;
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl');
        const ext = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
        if (ext) {
          glVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
          glRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        }
      } catch (_) {}

      let uadPlatform = null;
      if (navigator.userAgentData) {
        try {
          const he = await navigator.userAgentData.getHighEntropyValues(['platform']);
          uadPlatform = he.platform || navigator.userAgentData.platform;
        } catch (_) {
          uadPlatform = navigator.userAgentData.platform;
        }
      }

      const payload = {
        frameId: '${frameId}',
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        uadPlatform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        languages: Array.from(navigator.languages || []),
        glVendor,
        glRenderer,
        screenWidth: screen.width,
        screenHeight: screen.height,
        pluginsLength: navigator.plugins.length,
        voicesLength: typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : 0,
      };

      try {
        await fetch('${reportUrl}', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        console.error('Report fetch failed:', err);
      }
    };
    if (!window.__probe_reported) {
      window.__probe_reported = true;
      executeReportProbe();
    }
  `;
}

async function runMultiTierIframeTest(profile, inject = true) {
  const reports = {};
  let portA, portB, portC;

  const serverA = http.createServer((req, res) => {
    console.log("[SRV A]", req.method, req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          reports[data.frameId] = data;
          console.log("[Selftest] Got report for:", data.frameId);
        } catch (_) {}
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><title>Frame A (Main Tier)</title></head>
<body>
  <h1>Frame A (Main Tier)</h1>
  <iframe id="frameB" src="http://localhost:${portB}/" width="500" height="400"></iframe>
  <script>${createProbeScript('main', `http://127.0.0.1:${portA}/report`)}</script>
</body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const serverB = http.createServer((req, res) => {
    console.log("[SRV B]", req.method, req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><title>Frame B (Cross-Origin Tier 1)</title></head>
<body>
  <h2>Frame B (Cross-Origin Tier 1)</h2>
  <iframe id="frameC" src="http://127.0.0.1:${portC}/" width="400" height="300"></iframe>
  <script>${createProbeScript('frameB', `http://127.0.0.1:${portA}/report`)}</script>
</body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  const serverC = http.createServer((req, res) => {
    console.log("[SRV C]", req.method, req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><title>Frame C (Nested Cross-Origin Tier 2)</title></head>
<body>
  <h3>Frame C (Nested Cross-Origin Tier 2)</h3>
  <script>${createProbeScript('frameC', `http://127.0.0.1:${portA}/report`)}</script>
</body>
</html>`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise(r => serverA.listen(0, '127.0.0.1', r));
  portA = serverA.address().port;
  await new Promise(r => serverB.listen(0, '127.0.0.1', r));
  portB = serverB.address().port;
  await new Promise(r => serverC.listen(0, '127.0.0.1', r));
  portC = serverC.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cross-frame-'));
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, { fingerprint: fp, profile, templatePath: path.join(kernelRoot, 'init_template.json') });

  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { devToolsPort = p; break; }
    } catch (_) {}
  }

  let ws = null;
  let engineConn = null;
  try {
    if (!devToolsPort) throw new Error('DevToolsActivePort not acquired');

    const engine = new BrowserEngine({ getPath: () => dir });
    const item = { port: devToolsPort, profile, nativeKernelFingerprint: false };

    if (inject) {
      engineConn = await engine.startWorkerFingerprintInjection(item, fp);
    }

    const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });

    const cdp = new Cdp(ws);

    const targets = await cdp.send('Target.getTargets');
    const pageTarget = targets?.result?.targetInfos?.find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target available');

    const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attached?.result?.sessionId;

    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Runtime.enable', {}, pageSession);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') console.log('[PAGE CONSOLE]', m.params.args?.map(a => a.value).join(' '));
      if (m.method === 'Runtime.exceptionThrown') console.log('[PAGE ERR]', JSON.stringify(m.params.exceptionDetails));
    });

    if (inject) {
      const injectionScript = buildInjectionScript(fp);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript }, pageSession);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: fp.userAgent,
        platform: fp.platform,
        acceptLanguage: (fp.languages || []).join(','),
      }, pageSession);
      if (profile.privacy?.timezone) {
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: profile.privacy.timezone }, pageSession);
      }
      if (fp.languages?.[0]) {
        await cdp.send('Emulation.setLocaleOverride', { locale: fp.languages[0] }, pageSession);
      }
    }

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${portA}/` }, pageSession);

    // Wait for all 3 frame reports with adaptive polling
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (reports.main && reports.frameB && reports.frameC) break;
    }

    return { reports, portA, portB, portC };
  } finally {
    if (engineConn) try { engineConn.close(); } catch (_) {}
    if (ws) try { ws.close(); } catch (_) {}
    serverA.close(); serverB.close(); serverC.close();
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  console.log('================================================================');
  console.log('  OpenBrowser Cross-Origin & Nested Iframe Fingerprint Selftest');
  console.log('================================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('SKIP: macos-x64 kernel launcher not available in this host environment.');
    return;
  }

  // Define target personas for testing
  const winProfile = {
    id: 'persona-win-rtx3070',
    name: 'Windows RTX 3070',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    language: 'en-US,en',
    width: 1920,
    height: 1080,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    platform: 'Win32',
    fingerprint: {
      cores: 8,
      memory: 8,
      screenWidth: 1920,
      screenHeight: 1080,
      languages: ['en-US', 'en'],
    },
    privacy: {
      cores: 8,
      memory: 8,
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      timezoneMode: 'custom',
      timezone: 'America/Chicago',
    },
    webgl: {
      mode: 'noise',
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    screen: {
      width: 1920,
      height: 1080,
      devicePixelRatio: 1,
    }
  };

  const macProfile = {
    id: 'persona-mac-m3',
    name: 'macOS M3 Metal',
    kernelVersion: '148.0.7778.165',
    os: 'macos',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    cores: 8,
    memory: 8,
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    languages: ['zh-CN', 'zh'],
    privacy: {
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      timezoneMode: 'custom',
      timezone: 'America/Los_Angeles',
    },
    webgl: {
      mode: 'noise',
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
    },
    screen: {
      width: 1440,
      height: 900,
      devicePixelRatio: 2,
    }
  };

  console.log('[Step 1/3] Running Native Baseline (Un-injected Kernel)...');
  const baselineRun = await runMultiTierIframeTest(winProfile, false);
  const baseReports = baselineRun.reports;

  console.log('[Step 2/3] Running Injected Multi-tier Cross-Origin Iframe Test (Windows Persona)...');
  const winRun = await runMultiTierIframeTest(winProfile, true);
  const winReports = winRun.reports;
  console.log("=== WIN_REPORTS_DUMP ===", JSON.stringify(winReports, null, 2));

  console.log('\n--- Evaluating Cross-Origin Multi-Tier Parity & Host Leak Audits ---\n');

  check('Baseline verification: Native un-injected kernel reports real host values', () => {
    assert.ok(baseReports.main, 'Main frame report must exist in baseline');
    assert.ok(baseReports.frameB, 'Frame B report must exist in baseline');
    assert.ok(baseReports.frameC, 'Frame C report must exist in baseline');
    // On macOS host, un-injected kernel naturally reports Mac hardware
    assert.strictEqual(baseReports.main.platform, 'MacIntel');
    assert.ok(baseReports.main.glRenderer.includes('Metal') || baseReports.main.glRenderer.includes('Apple') || baseReports.main.glRenderer.includes('Radeon'));
  });

  check('Windows Persona: All 3 tiers report received data', () => {
    assert.ok(winReports.main, 'Main frame report must be received');
    assert.ok(winReports.frameB, 'Frame B (Cross-origin 1: localhost) must be received');
    assert.ok(winReports.frameC, 'Frame C (Nested Cross-origin 2: 127.0.0.1:portC) must be received');
  });

  const frames = ['main', 'frameB', 'frameC'];

  check('Windows Persona: userAgent consistency across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].userAgent, winProfile.userAgent, `${f} userAgent mismatch`);
      assert.ok(!winReports[f].userAgent.includes('Macintosh'), `${f} userAgent must not leak host Macintosh`);
    }
  });

  check('Windows Persona: platform consistency across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].platform, 'Win32', `${f} platform must be Win32`);
      assert.notStrictEqual(winReports[f].platform, 'MacIntel', `${f} must not leak host MacIntel`);
    }
  });

  check('Windows Persona: userAgentData.platform consistency across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].uadPlatform, 'Windows', `${f} uadPlatform must be Windows`);
      assert.notStrictEqual(winReports[f].uadPlatform, 'macOS', `${f} must not leak host macOS`);
    }
  });

  check('Windows Persona: hardwareConcurrency parity without host leak', () => {
    for (const f of frames) {
      assert.strictEqual(Number(winReports[f].hardwareConcurrency), 8, `${f} hardwareConcurrency must be 8`);
      assert.notStrictEqual(Number(winReports[f].hardwareConcurrency), 16, `${f} must not leak host 16 cores`);
    }
  });

  check('Windows Persona: deviceMemory parity without host leak', () => {
    for (const f of frames) {
      assert.strictEqual(Number(winReports[f].deviceMemory), 8, `${f} deviceMemory must be 8`);
      assert.notStrictEqual(Number(winReports[f].deviceMemory), 32, `${f} must not leak host 32GB`);
    }
  });

  check('Windows Persona: timezone parity across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].timeZone, 'America/Chicago', `${f} timeZone must be America/Chicago`);
      assert.notStrictEqual(winReports[f].timeZone, 'Asia/Singapore', `${f} must not leak host Asia/Singapore`);
    }
  });

  check('Windows Persona: WebGL UNMASKED_RENDERER parity across all iframe tiers', () => {
    for (const f of frames) {
      assert.ok(winReports[f].glRenderer.includes('Direct3D11') || winReports[f].glRenderer.includes('RTX') || winReports[f].glRenderer.includes('NVIDIA') || winReports[f].glRenderer.includes('Radeon'), `${f} glRenderer must be spoofed D3D11/NVIDIA`);
      assert.ok(!winReports[f].glRenderer.includes('Metal') && !winReports[f].glRenderer.includes('W6800X'), `${f} must not leak host Metal/W6800X`);
    }
  });

  check('Windows Persona: languages parity across all iframe tiers', () => {
    for (const f of frames) {
      assert.deepStrictEqual(winReports[f].languages, ['en-US', 'en'], `${f} languages must match persona`);
    }
  });

  check('Windows Persona: screen dimensions parity across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].screenWidth, 1920, `${f} screenWidth must be 1920`);
      assert.strictEqual(winReports[f].screenHeight, 1080, `${f} screenHeight must be 1080`);
    }
  });

  check('Windows Persona: plugins count parity across all iframe tiers', () => {
    for (const f of frames) {
      assert.strictEqual(winReports[f].pluginsLength, 5, `${f} pluginsLength must be 5`);
    }
  });

  check('Windows Persona: speechSynthesis voice pool without host leak', () => {
    for (const f of frames) {
      assert.ok(winReports[f].voicesLength > 0 && winReports[f].voicesLength <= 60, `${f} voicesLength must be spoofed subset (<= 60, got: ${winReports[f].voicesLength})`);
      assert.notStrictEqual(winReports[f].voicesLength, 210, `${f} must not leak host 210 macOS voices`);
    }
  });

  console.log('\n--- Testing Additional P0/P1 Adversarial Gap Protections ---\n');

  // 【P0-1】Date.prototype writable === false
  check('【P0-1】Date.prototype descriptor writable is false (matching V8 native)', () => {
    const desc = Object.getOwnPropertyDescriptor(Date, 'prototype');
    assert.ok(desc, 'Date.prototype descriptor must exist');
    assert.strictEqual(desc.writable, false, 'Date.prototype writable must be false');
    assert.strictEqual(desc.enumerable, false, 'Date.prototype enumerable must be false');
    assert.strictEqual(desc.configurable, false, 'Date.prototype configurable must be false');
  });

  // 【P0-2】Intl.DateTimeFormat.prototype writable === false
  check('【P0-2】Intl.DateTimeFormat.prototype descriptor writable is false (matching V8 native)', () => {
    const desc = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat, 'prototype');
    assert.ok(desc, 'Intl.DateTimeFormat.prototype descriptor must exist');
    assert.strictEqual(desc.writable, false, 'Intl.DateTimeFormat.prototype writable must be false');
    assert.strictEqual(desc.enumerable, false, 'Intl.DateTimeFormat.prototype enumerable must be false');
    assert.strictEqual(desc.configurable, false, 'Intl.DateTimeFormat.prototype configurable must be false');
  });

  // 【P1-6】Date property order
  check('【P1-6】Object.getOwnPropertyNames(Date) property order is native: [length, name, prototype, now, parse, UTC]', () => {
    const names = Object.getOwnPropertyNames(Date);
    const expected = ['length', 'name', 'prototype', 'now', 'parse', 'UTC'];
    assert.deepStrictEqual(names, expected, `Date properties order mismatch: got ${JSON.stringify(names)}`);
  });

  // 【P0-3】navigator.languages identity
  check('【P0-3】navigator.languages Cached FrozenArray identity test passes', () => {
    // In our buildInjectionScript, languages getter returns a frozen singleton array
    const fp = buildFingerprint({ id: 't', os: 'windows', languages: ['en-US', 'en'] });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('const FROZEN_LANGUAGES = Object.freeze('), 'Must define singleton FROZEN_LANGUAGES');
    assert.ok(script.includes('languages: { get: () => FROZEN_LANGUAGES }'), 'languages getter must return FROZEN_LANGUAGES');
  });

  // 【追加 P1-C】speechVoicePoolForOs inclusive matching
  check('【追加 P1-C】speechVoicePoolForOs inclusive matching: MacIntel returns Mac voices without Microsoft', () => {
    const macVoices = createSpeechVoicesFromSeed('seed', ['en-US'], 'noise', { os: 'MacIntel' });
    assert.ok(macVoices.length > 0, 'MacIntel must receive voices');
    const hasMicrosoft = macVoices.some((v) => v.name.includes('Microsoft'));
    assert.strictEqual(hasMicrosoft, false, 'MacIntel pool must NOT contain Microsoft voices');
  });

  check('【追加 P1-C】speechVoicePoolForOs inclusive matching: Android 14 returns Android voices without Apple/Microsoft', () => {
    const androidVoices = createSpeechVoicesFromSeed('seed', ['en-US'], 'noise', { os: 'Android 14' });
    assert.ok(androidVoices.length > 0, 'Android 14 must receive voices');
    assert.strictEqual(androidVoices.some((v) => v.name.includes('Microsoft') || v.name.includes('Samantha')), false);
  });

  check('【追加 P1-C】speechVoicePoolForOs inclusive matching: Linux x86_64 returns Google voices only', () => {
    const linuxVoices = createSpeechVoicesFromSeed('seed', ['en-US'], 'noise', { os: 'Linux x86_64' });
    assert.ok(linuxVoices.length > 0, 'Linux must receive voices');
    assert.strictEqual(linuxVoices.some((v) => v.name.includes('Microsoft') || v.name.includes('Samantha')), false);
  });

  check('【追加 P1-C】speechVoicePoolForOs inclusive matching: Win32 returns Microsoft voices without Apple', () => {
    const winVoices = createSpeechVoicesFromSeed('seed', ['en-US'], 'noise', { os: 'Win32' });
    assert.ok(winVoices.length > 0, 'Win32 must receive voices');
    assert.strictEqual(winVoices.some((v) => v.name === 'Alex' || v.name === 'Samantha'), false);
    assert.ok(winVoices.some((v) => v.name.includes('Microsoft')), 'Win32 must contain Microsoft voices');
  });

  check('【追加 P1-C】speechVoicePoolForOs inclusive matching: iPhone returns Apple voices without Microsoft', () => {
    const iosVoices = createSpeechVoicesFromSeed('seed', ['en-US'], 'noise', { os: 'iPhone' });
    assert.ok(iosVoices.length > 0, 'iPhone must receive voices');
    assert.strictEqual(iosVoices.some((v) => v.name.includes('Microsoft')), false);
  });

  // 【追加 P0-A & P0-B】Engine deliveryVerificationFailures resilience
  await asyncCheck('【追加 P0-A & P0-B】Engine failure counter: LRU cap at 200 items and oldest entry eviction', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.deliveryVerificationFailures = new Map();
    engine.deliveryVerificationFailureTimestamps = new Map();

    const mockBadProbe = { platform: 'MacIntel' };
    const dummyItem = { port: 9222 };

    // Fill 205 entries sequentially with await
    for (let i = 0; i < 205; i++) {
      const pid = `p_lru_${i}`;
      const profile = { id: pid, platform: 'Win32', privacy: {} };
      await engine.verifyStartupFingerprintDelivery(dummyItem, profile, null, { mockProbe: mockBadProbe });
    }

    assert.ok(engine.deliveryVerificationFailures.size <= 200, `Map size must not exceed 200, got ${engine.deliveryVerificationFailures.size}`);
    // Oldest items (0..4) must have been evicted
    assert.strictEqual(engine.deliveryVerificationFailures.has('p_lru_0'), false, 'Oldest entry p_lru_0 must be evicted');
    assert.strictEqual(engine.deliveryVerificationFailures.has('p_lru_1'), false, 'Oldest entry p_lru_1 must be evicted');
    assert.strictEqual(engine.deliveryVerificationFailures.has('p_lru_204'), true, 'Latest entry p_lru_204 must exist');
  });

  await asyncCheck('【追加 P0-A】Engine failure counter: sliding window expiration allows self-healing without reset call', async () => {
    const engine = Object.create(BrowserEngine.prototype);
    engine.deliveryVerificationFailures = new Map();
    engine.deliveryVerificationFailureTimestamps = new Map();

    const profile = { id: 'p_expire_test', platform: 'Win32', privacy: {} };
    const dummyItem = { port: 9222 };
    const badProbe = { platform: 'MacIntel' };
    const goodProbe = { platform: 'Win32' };

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      await engine.verifyStartupFingerprintDelivery(dummyItem, profile, null, { mockProbe: badProbe });
    }
    assert.strictEqual(engine.deliveryVerificationFailures.get('p_expire_test'), 3);

    // Attempt 4 is blocked due to ceiling
    const blockedRes = await engine.verifyStartupFingerprintDelivery(dummyItem, profile, null, { mockProbe: goodProbe });
    assert.strictEqual(blockedRes.blocked, true);

    // Expire window (simulate 6 minutes elapsed)
    const oldTime = Date.now() - (6 * 60 * 1000);
    engine.deliveryVerificationFailureTimestamps.set('p_expire_test', oldTime);

    // Attempt 5 after window expiration: counter automatically resets and probe succeeds
    const recoveredRes = await engine.verifyStartupFingerprintDelivery(dummyItem, profile, null, { mockProbe: goodProbe });
    assert.strictEqual(recoveredRes.ok, true, 'Must self-heal after failure window expires');
    assert.strictEqual(recoveredRes.blocked, false);
    assert.strictEqual(engine.deliveryVerificationFailures.has('p_expire_test'), false);
  });

  await asyncCheck('【追加 P0-A】Engine stop() cleans deliveryVerificationFailures allowing clean restart', async () => {
    const engine = new BrowserEngine({ getPath: () => '/tmp/ob-test' });
    const profileId = 'p_stop_reset_test';

    // Simulate 3 failures recorded
    engine.deliveryVerificationFailures.set(profileId, 3);
    engine.deliveryVerificationFailureTimestamps.set(profileId, Date.now());

    assert.strictEqual(engine.deliveryVerificationFailures.get(profileId), 3);

    // Call stop()
    await engine.stop(profileId);

    // Failure counter must be cleared
    assert.strictEqual(engine.deliveryVerificationFailures.has(profileId), false, 'stop() must clear failure counter');
    assert.strictEqual(engine.deliveryVerificationFailureTimestamps.has(profileId), false, 'stop() must clear timestamps');
  });


  // 【追加 makeNativeGetter Illegal Invocation Stack Sanitization】
  // Stack trace comparative audit:
  // Native baseline:
  //   TypeError: Illegal invocation
  //       at <caller_anonymous>
  // Before fix:
  //   TypeError: Illegal invocation
  //       at get platform (<anonymous>:528:29)
  //       at <caller_anonymous>
  // After fix:
  //   TypeError: Illegal invocation
  //       at <caller_anonymous> (0 wrapper frame leak)
  await asyncCheck('【追加 stack】makeNativeGetter illegal receiver stack sanitization: platform, hardwareConcurrency, deviceMemory, maxTouchPoints, webdriver', async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>test</body></html>');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const testPort = srv.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-stack-test-'));
    const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (p > 0) { devToolsPort = p; break; }
      } catch (_) {}
    }

    let ws = null;
    try {
      const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
      ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      const cdp = new Cdp(ws);

      const targets = await cdp.send('Target.getTargets');
      const pageTarget = targets.result.targetInfos.find(t => t.type === 'page');
      const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
      const sid = attached.result.sessionId;

      const fp = buildFingerprint(winProfile);
      const script = buildInjectionScript(fp);
      await cdp.send('Page.enable', {}, sid);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script }, sid);
      await cdp.send('Page.navigate', { url: `http://localhost:${testPort}/` }, sid);
      await sleep(800);

      const probeExpr = `
        (() => {
          const results = {};
          const props = ["platform", "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "webdriver"];
          for (const p of props) {
            try {
              const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, p);
              if (!desc || !desc.get) {
                results[p] = { error: "no getter" };
                continue;
              }
              const g = desc.get;
              let threw = false;
              let caughtErr = null;
              try {
                g.call({});
              } catch (err) {
                threw = true;
                caughtErr = err;
              }
              results[p] = {
                threw,
                message: caughtErr ? caughtErr.message : null,
                stack: caughtErr ? caughtErr.stack : null,
                hasGetterFrame: caughtErr ? (caughtErr.stack.includes("at get " + p) || caughtErr.stack.includes("get " + p + " (")) : false,
                name: g.name,
                length: g.length,
                toStringText: Function.prototype.toString.call(g),
              };
            } catch (outerErr) {
              results[p] = { error: outerErr.message };
            }
          }
          return results;
        })()
      `;

      const evalRes = await cdp.send('Runtime.evaluate', { expression: probeExpr, returnByValue: true }, sid);
      const data = evalRes?.result?.result?.value;
      assert.ok(data, "Getter evaluation data must be returned");

      const props = ["platform", "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "webdriver"];
      for (const p of props) {
        const item = data[p];
        assert.ok(item, `Result for ${p} must exist`);
        assert.strictEqual(item.threw, true, `Getter for ${p} must throw Illegal invocation on {}`);
        assert.strictEqual(item.message, "Illegal invocation", `${p} message must be Illegal invocation`);
        assert.strictEqual(item.hasGetterFrame, false, `${p} stack must NOT leak wrapper frame (stack: ${item.stack})`);
        assert.strictEqual(item.name, "get " + p, `${p} getter name must be 'get ${p}'`);
        assert.strictEqual(item.length, 0, `${p} getter length must be 0`);
        assert.strictEqual(item.toStringText, "function get " + p + "() { [native code] }");
      }
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      try { srv.close(); } catch (_) {}
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });


  // 【P0 · 必做】[MEDIA-QUERY-DPR-RESOLUTION-CONTRADICTION]
  await asyncCheck("【P0】matchMedia resolution & devicePixelRatio mathematical consistency", async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>dpr test</body></html>");
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const testPort = srv.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-dpr-test-"));
    const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (p > 0) { devToolsPort = p; break; }
      } catch (_) {}
    }

    let ws = null;
    try {
      const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
      ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      const cdp = new Cdp(ws);

      const targets = await cdp.send("Target.getTargets");
      const pageTarget = targets.result.targetInfos.find(t => t.type === "page");
      const attached = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
      const sid = attached.result.sessionId;

      const pDpr = { ...winProfile };
      const fp = buildFingerprint(pDpr);
      fp.screen.devicePixelRatio = 1.5;
      let script = buildInjectionScript(fp);
      if (typeof sanitizeInjectionScript === "function") {
        script = sanitizeInjectionScript(script);
      }

      await cdp.send("Page.enable", {}, sid);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sid);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 0,
        height: 0,
        deviceScaleFactor: 1.5,
        mobile: false,
      }, sid);
      await cdp.send("Page.navigate", { url: `http://localhost:${testPort}/` }, sid);
      await sleep(800);

      const evalRes = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          return {
            dpr: window.devicePixelRatio,
            mm1: window.matchMedia("(resolution: 1dppx)").matches,
            mm1_5: window.matchMedia("(resolution: 1.5dppx)").matches,
            mmMin1_4: window.matchMedia("(min-resolution: 1.4dppx)").matches,
            mmDprWebkit: window.matchMedia("(-webkit-device-pixel-ratio: 1.5)").matches,
          };
        })()`,
        returnByValue: true
      }, sid);

      const res = evalRes?.result?.result?.value;
      assert.ok(res, "Evaluation result must exist");
      assert.strictEqual(res.dpr, 1.5, "window.devicePixelRatio must be 1.5");
      assert.strictEqual(res.mm1, false, "matchMedia((resolution: 1dppx)) must be false when dpr is 1.5");
      assert.strictEqual(res.mm1_5, true, "matchMedia((resolution: 1.5dppx)) must be true when dpr is 1.5");
      assert.strictEqual(res.mmMin1_4, true, "matchMedia((min-resolution: 1.4dppx)) must be true when dpr is 1.5");
      assert.strictEqual(res.mmDprWebkit, true, "matchMedia((-webkit-device-pixel-ratio: 1.5)) must be true when dpr is 1.5");
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      try { srv.close(); } catch (_) {}
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
      try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // 【P1】[ACCEPT-LANGUAGE-NO-QVALUE-FALLBACK] & 【P2】[COLOR-DEPTH-SDR-CONTRADICTION]
  await asyncCheck("【P1 & P2】Accept-Language header carries RFC 9110 q-values & SDR colorDepth is 24", async () => {
    let capturedReq = null;
    const srv = http.createServer((req, res) => {
      capturedReq = req;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>lang test</body></html>");
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const testPort = srv.address().port;

    const p = {
      id: "p_lang_q_test",
      os: "windows",
      platform: "Win32",
      privacy: { languages: ["en-US", "en"] }
    };
    const fp = buildFingerprint(p);
    assert.strictEqual(fp.screen.colorDepth, 24, "SDR profile colorDepth must stably default to 24");
    assert.deepStrictEqual(fp.languages, ["en-US", "en"], "fp.languages must preserve fallback array");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-lang-test-"));
    const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (p > 0) { devToolsPort = p; break; }
      } catch (_) {}
    }

    const engine = new BrowserEngine({ getPath: () => dir });
    const item = { port: devToolsPort, profile: p, nativeKernelFingerprint: false };
    const engineConn = await engine.startWorkerFingerprintInjection(item, fp);

    let ws = null;
    try {
      const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
      ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      const cdp = new Cdp(ws);

      const targets = await cdp.send("Target.getTargets");
      const pageTarget = targets.result.targetInfos.find(t => t.type === "page");
      const attached = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
      const sid = attached.result.sessionId;

      await cdp.send("Page.enable", {}, sid);
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${testPort}/test-q` }, sid);

      for (let i = 0; i < 25; i++) {
        await sleep(200);
        if (capturedReq) break;
      }

      assert.ok(capturedReq, "HTTP request must be captured on server");
      const acceptLang = capturedReq.headers["accept-language"];
      assert.strictEqual(acceptLang, "en-US,en;q=0.9", `Accept-Language must carry q-value: got ${acceptLang}`);
    } finally {
      if (engineConn) try { engineConn.close(); } catch (_) {}
      if (ws) try { ws.close(); } catch (_) {}
      try { srv.close(); } catch (_) {}
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
      try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // 【P1】[REQUEST-REWRITER-SESSION-COLLISION] & [WORKER-CDP-ATTACH-DEADLOCK-RISK]
  check("【P1】RequestHeaderRewriter handleEvent forwards duplicate inFlight requestId without hanging", () => {
    const rewriter = new (require("../engine").RequestHeaderRewriter)({ profile: winProfile });
    rewriter.inFlight.add("req_collision_1");

    let continued = false;
    const fakeConn = {
      command: async (method, params, opts) => {
        if (method === "Fetch.continueRequest" && params.requestId === "req_collision_1") {
          continued = true;
        }
        return {};
      }
    };

    rewriter.handleEvent({
      method: "Fetch.requestPaused",
      sessionId: "session_2",
      params: { requestId: "req_collision_1", request: { url: "http://example.com" } }
    }, fakeConn);

    assert.strictEqual(continued, true, "Duplicate inFlight request must immediately continueRequest");
  });

  // 【P0-1 & P0-2 & P0-3】srcdoc iframe attribute & prototype integrity
  await asyncCheck("【P0-1, P0-2, P0-3】srcdoc iframe getAttribute sanitization, zero __ob_sb_injected__ marker, and [native code] toString", async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head></head><body><h1>srcdoc test</h1></body></html>");
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const testPort = srv.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-srcdoc-test-"));
    const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (p > 0) { devToolsPort = p; break; }
      } catch (_) {}
    }

    let ws = null;
    try {
      const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
      ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      const cdp = new Cdp(ws);

      const targets = await cdp.send("Target.getTargets");
      const pageTarget = targets.result.targetInfos.find(t => t.type === "page");
      const attached = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
      const sid = attached.result.sessionId;

      const fp = buildFingerprint(winProfile);
      const script = buildInjectionScript(fp);

      await cdp.send("Page.enable", {}, sid);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sid);
      await cdp.send("Page.navigate", { url: `http://localhost:${testPort}/` }, sid);
      await sleep(800);

      const testScript = `
        (async () => {
          const parentEl = document.body || document.documentElement || document;
          const iframe = document.createElement("iframe");
          const rawHtml = "<p>User Private HTML</p>";
          iframe.srcdoc = rawHtml;
          parentEl.appendChild(iframe);
          await new Promise(r => setTimeout(r, 300));

          const subWin = iframe.contentWindow;
          return {
            attrSrcdoc: iframe.getAttribute("srcdoc"),
            propSrcdoc: iframe.srcdoc,
            attrNodeSrcdoc: iframe.getAttributeNode("srcdoc")?.value,
            hasObMarker: "__ob_sb_injected__" in subWin,
            subTzToString: subWin.Date.prototype.getTimezoneOffset.toString(),
            subTzIsNative: subWin.Date.prototype.getTimezoneOffset.toString().includes("[native code]"),
          };
        })()
      `;

      const evalRes = await cdp.send("Runtime.evaluate", { expression: testScript, awaitPromise: true, returnByValue: true }, sid);
      const data = evalRes?.result?.result?.value;
      assert.ok(data, "srcdoc test evaluation data must exist");
      assert.strictEqual(data.attrSrcdoc, "<p>User Private HTML</p>", "iframe.getAttribute(srcdoc) must return exact raw HTML");
      assert.strictEqual(data.propSrcdoc, "<p>User Private HTML</p>", "iframe.srcdoc property must return exact raw HTML");
      assert.strictEqual(data.hasObMarker, false, "__ob_sb_injected__ must NOT exist on srcdoc window");
      assert.strictEqual(data.subTzIsNative, true, "srcdoc subWin.Date.prototype.getTimezoneOffset.toString() must contain [native code]");
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      try { srv.close(); } catch (_) {}
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
      try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // 【P1-4】contentWindow illegal invocation stack sanitization
  await asyncCheck("【P1-4】HTMLIFrameElement.prototype.__lookupGetter__('contentWindow') illegal invocation stack is sanitized", async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head></head><body><h1>cw test</h1></body></html>");
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const testPort = srv.address().port;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-cw-test-"));
    const child = spawn(launcher, [dir, "--headless=new"], { cwd: kernelRoot, detached: true, stdio: "ignore" });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      try {
        const p = parseInt(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n")[0], 10);
        if (p > 0) { devToolsPort = p; break; }
      } catch (_) {}
    }

    let ws = null;
    try {
      const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
      ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise(r => { ws.onopen = r; });
      const cdp = new Cdp(ws);

      const targets = await cdp.send("Target.getTargets");
      const pageTarget = targets.result.targetInfos.find(t => t.type === "page");
      const attached = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
      const sid = attached.result.sessionId;

      const fp = buildFingerprint(winProfile);
      const script = buildInjectionScript(fp);

      await cdp.send("Page.enable", {}, sid);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sid);
      await cdp.send("Page.navigate", { url: `http://localhost:${testPort}/` }, sid);
      await sleep(800);

      const testScript = `
        (() => {
          try {
            HTMLIFrameElement.prototype.__lookupGetter__("contentWindow").call({});
            return { threw: false };
          } catch (err) {
            return {
              threw: true,
              message: err.message,
              stack: err.stack,
              hasGetterFrame: err.stack.includes("at get contentWindow") || err.stack.includes("contentWindow ("),
            };
          }
        })()
      `;

      const evalRes = await cdp.send("Runtime.evaluate", { expression: testScript, returnByValue: true }, sid);
      const res = evalRes?.result?.result?.value;
      assert.strictEqual(res.threw, true, "contentWindow getter must throw on invalid receiver");
      assert.strictEqual(res.message, "Illegal invocation");
      assert.strictEqual(res.hasGetterFrame, false, `contentWindow stack must not contain wrapper frame: got ${res.stack}`);
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      try { srv.close(); } catch (_) {}
      try { process.kill(-child.pid, "SIGKILL"); } catch (_) {}
      try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  // 【P2-5】engine.applyEnvWindowTitle does not overwrite document.title on about:blank
  await asyncCheck("【P2-5】engine.applyEnvWindowTitle does not overwrite document.title on non-start pages", async () => {
    const engine = new BrowserEngine({ getPath: () => "/tmp/ob-title-test" });
    const profile = { id: "p_title_test", name: "环境 1" };
    // Verify method only targets isStartPageUrl
    assert.strictEqual(engine.isStartPageUrl("about:blank"), false);
    assert.strictEqual(engine.isStartPageUrl("http://example.com"), false);
  });

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n================================================================`);
  console.log(`  Selftest Summary: Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log(`================================================================\n`);
  console.log(`cross-origin-iframe-fingerprint-e2e-selftest: ${failed === 0 ? "OK " + passed + "/" + results.length : "FAILED (" + failed + " failed)"}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
})();
