#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Page-Visible Brand Trace Audit
 *
 * Exhaustive audit of page-observable brand traces, product names, internal IDs,
 * custom globals, and detection artifacts across:
 *  1. Static scan of all injected scripts & generators
 *  2. Runtime comparison: Stock Native Chromium Kernel vs Injected Profile
 *  3. Window / Navigator / Document / Prototype own properties diff
 *  4. Function.prototype.toString & Error().stack leakage
 *  5. Sub-contexts (Same-origin iframe, srcdoc iframe, sandbox iframe, Worker, window.open)
 *  6. LiveSync & Localhost marker traces
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  buildFontMetricsScript
} = require('./fingerprint');
const { buildUaInjectionScript, buildUaProfile } = require('./user-agent');
const { buildCssFontLocalGateSource } = require('./css-font-local-gate');
const { buildQueryLocalFontBlobGateSource } = require('./query-local-font-blob-gate');
const { buildPortScanProtectionScript } = require('./port-scan-protection');
const { buildWorkerFontPresenceSource } = require('./worker-font-presence-fallback');
const { sanitizeHtml, sanitizeCss } = require('./css-font-response-rewrite');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reportsDir = path.join(appRoot, '..', 'reports');

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

// =========================================================================
// PART A: Static Analysis of all Injected Scripts
// =========================================================================

function runStaticAudit(sampleProfile) {
  const fp = buildFingerprint(sampleProfile);
  const results = [];

  const addFinding = (sourceName, severity, rule, description, lineSnippet, category) => {
    results.push({
      sourceName,
      severity,
      rule,
      description,
      lineSnippet: lineSnippet ? String(lineSnippet).trim().slice(0, 160) : '',
      category
    });
  };

  const injectionSources = [
    { name: 'mainScript (buildInjectionScript)', code: buildInjectionScript(fp) },
    { name: 'workerScript (buildWorkerInjectionScript)', code: buildWorkerInjectionScript(fp) },
    { name: 'cssFontLocalGate (buildCssFontLocalGateSource)', code: buildCssFontLocalGateSource(fp.fonts?.list || [], []) },
    { name: 'queryLocalFontBlobGate (buildQueryLocalFontBlobGateSource)', code: buildQueryLocalFontBlobGateSource({ ...fp, bridgeToken: 'test' }) },
    { name: 'portScanProtection (buildPortScanProtectionScript)', code: buildPortScanProtectionScript(['8080']) },
    { name: 'workerFontPresence (buildWorkerFontPresenceSource)', code: buildWorkerFontPresenceSource(fp) }
  ];

  try {
    const liveSyncCode = fs.readFileSync(path.join(appRoot, 'live-sync-v5.js'), 'utf8');
    injectionSources.push({ name: 'live-sync-v5.js (full file)', code: liveSyncCode, isLiveSync: true });
  } catch (_) {}

  try {
    const extManifest = fs.readFileSync(path.join(appRoot, 'bundled-extension', 'manifest.json'), 'utf8');
    const extMarker = fs.readFileSync(path.join(appRoot, 'bundled-extension', 'marker.js'), 'utf8');
    injectionSources.push({ name: 'bundled-extension/manifest.json', code: extManifest, isExt: true });
    injectionSources.push({ name: 'bundled-extension/marker.js', code: extMarker, isExt: true });
  } catch (_) {}

  try {
    const startPageTpl = fs.readFileSync(path.join(appRoot, 'automation', 'start-page-template.js'), 'utf8');
    const startPageSrv = fs.readFileSync(path.join(appRoot, 'automation', 'start-page-server.js'), 'utf8');
    injectionSources.push({ name: 'automation/start-page-template.js', code: startPageTpl, isStartPage: true });
    injectionSources.push({ name: 'automation/start-page-server.js', code: startPageSrv, isStartPage: true });
  } catch (_) {}

  const patterns = [
    { rule: 'BRAND-LITERAL-OPENBROWSER', regex: /openbrowser/i },
    { rule: 'SB-MACHINE-CODE', regex: /SB000000000|MachineCode/i },
    { rule: 'KERNEL-PATH-LITERAL', regex: /kernels\/|macos-x64|chrome_148|init_template/i },
    { rule: 'PROFILE-ID-VARIABLE', regex: /profileId/i },
    { rule: 'OB-PREFIXED-SYMBOL', regex: /__ob|__OPENBROWSER/i },
    { rule: 'LOCAL-PORT-PROBE-MSG', regex: /local port probe blocked/i },
    { rule: 'FONT-FALLBACK-PREFIX', regex: /LocalFontFallback/i },
    { rule: 'OPENBROWSER-SYNC-BINDING', regex: /openBrowserSync/i },
    { rule: 'OPENBROWSER-MARKER-ID', regex: /openbrowser-(?:master|environment|profile)-marker/i }
  ];

  for (const src of injectionSources) {
    const lines = src.code.split('\n');
    lines.forEach((line, idx) => {
      for (const pat of patterns) {
        if (pat.regex.test(line)) {
          let category = 'closure-internal';
          let severity = 'P2';

          if (line.includes('window.__ob_sb_injected__')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (line.includes('__obFsInstalled')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (line.includes('openBrowserSync')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (line.includes('openbrowser-master-marker') || line.includes('openbrowser-environment-marker') || line.includes('openbrowser-profile-marker')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (line.includes('data-openbrowser-sync')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (line.includes('local port probe blocked')) {
            category = 'page-visible';
            severity = 'P1';
          } else if (line.includes('LocalFontFallback')) {
            category = 'page-visible';
            severity = 'P1';
          } else if (line.includes('__openbrowserCollectFingerprint')) {
            category = 'page-visible';
            severity = 'P0';
          } else if (src.isExt && line.includes('OpenBrowser')) {
            category = 'page-visible';
            severity = 'P1';
          } else if (src.isStartPage && line.includes('OpenBrowser')) {
            category = 'page-visible';
            severity = 'P1';
          }

          addFinding(
            src.name,
            severity,
            pat.rule,
            `Found match for pattern ${pat.rule} on line ${idx + 1}`,
            line,
            category
          );
        }
      }
    });
  }

  return results;
}

// =========================================================================
// PART B: Runtime In-Kernel Audit Expression
// =========================================================================

const RUNTIME_AUDIT_EXPRESSION = `(async () => {
  const result = {
    window: {},
    navigator: {},
    document: {},
    storage: {},
    chrome: null,
    subContexts: {},
    functionToString: {},
    stackTraces: {},
    specificTraces: {}
  };

  // 1. Window properties & symbols
  try {
    result.window.ownProps = Object.getOwnPropertyNames(window);
    result.window.ownSymbols = Object.getOwnPropertySymbols(window).map(s => String(s));
    result.window.name = window.name;
    result.window.hasOpenBrowserSync = ('openBrowserSync' in window);
    result.window.hasObSbInjected = ('__ob_sb_injected__' in window);
    result.window.hasOpenbrowserCollect = ('__openbrowserCollectFingerprint' in window);
  } catch (e) { result.window.error = String(e); }

  // 2. Navigator properties
  try {
    result.navigator.ownProps = Object.getOwnPropertyNames(navigator);
    result.navigator.protoProps = Object.getOwnPropertyNames(Navigator.prototype);
    result.navigator.userAgent = navigator.userAgent;
    result.navigator.appVersion = navigator.appVersion;
    result.navigator.platform = navigator.platform;
    result.navigator.vendor = navigator.vendor;
    result.navigator.webdriver = navigator.webdriver;
    if (navigator.userAgentData) {
      result.navigator.uadBrands = navigator.userAgentData.brands;
      result.navigator.uadPlatform = navigator.userAgentData.platform;
    }
  } catch (e) { result.navigator.error = String(e); }

  // 3. Document properties & DOM
  try {
    result.document.ownProps = Object.getOwnPropertyNames(document);
    result.document.ownSymbols = Object.getOwnPropertySymbols(document).map(s => String(s));
    result.document.hasObFsInstalled = ('__obFsInstalled' in document);
    result.document.title = document.title;
    result.document.htmlAttributes = Array.from(document.documentElement.attributes).map(a => ({ name: a.name, value: a.value }));
    result.document.bodyAttributes = document.body ? Array.from(document.body.attributes).map(a => ({ name: a.name, value: a.value })) : [];
    result.document.docStyle = document.documentElement.style.cssText;

    // Check specific DOM markers
    result.document.masterMarker = Boolean(document.getElementById('openbrowser-master-marker'));
    result.document.envMarker = Boolean(document.getElementById('openbrowser-environment-marker'));
    result.document.profileMarker = Boolean(document.getElementById('openbrowser-profile-marker'));
    result.document.syncFullscreenAttrs = Array.from(document.querySelectorAll('[data-openbrowser-sync-fullscreen]')).length;
  } catch (e) { result.document.error = String(e); }

  // 4. Storage & Cookies
  try {
    result.storage.localStorageKeys = Object.keys(localStorage);
    result.storage.sessionStorageKeys = Object.keys(sessionStorage);
    result.storage.cookies = document.cookie;
  } catch (e) { result.storage.error = String(e); }

  // 5. Chrome namespace
  try {
    if (typeof chrome !== 'undefined') {
      result.chrome = {
        exists: true,
        props: Object.getOwnPropertyNames(chrome),
        runtime: typeof chrome.runtime !== 'undefined' ? {
          id: chrome.runtime?.id || null,
          hasManifest: typeof chrome.runtime?.getManifest === 'function'
        } : null
      };
    } else {
      result.chrome = { exists: false };
    }
  } catch (e) { result.chrome = { error: String(e) } }

  // 6. Function.prototype.toString integrity & leak check
  try {
    const fnList = [
      { name: 'Function.prototype.toString', fn: Function.prototype.toString },
      { name: 'fetch', fn: globalThis.fetch },
      { name: 'Date', fn: globalThis.Date },
      { name: 'Date.prototype.getTimezoneOffset', fn: Date.prototype.getTimezoneOffset },
      { name: 'Intl.DateTimeFormat', fn: Intl?.DateTimeFormat },
      { name: 'window.open', fn: window.open },
      { name: 'CanvasRenderingContext2D.prototype.getImageData', fn: CanvasRenderingContext2D?.prototype?.getImageData },
      { name: 'navigator.mediaDevices.enumerateDevices', fn: navigator?.mediaDevices?.enumerateDevices },
      { name: 'speechSynthesis.getVoices', fn: speechSynthesis?.getVoices },
      { name: 'HTMLIFrameElement.prototype.contentWindow', fn: Object.getOwnPropertyDescriptor(HTMLIFrameElement?.prototype, 'contentWindow')?.get },
      { name: 'HTMLIFrameElement.prototype.srcdoc', fn: Object.getOwnPropertyDescriptor(HTMLIFrameElement?.prototype, 'srcdoc')?.set },
      { name: 'Node.prototype.appendChild', fn: Node?.prototype?.appendChild },
      { name: 'Blob', fn: globalThis.Blob }
    ];

    for (const item of fnList) {
      if (!item.fn) continue;
      try {
        const str = Function.prototype.toString.call(item.fn);
        result.functionToString[item.name] = {
          str: str,
          isNative: str.includes('[native code]'),
          hasOpenBrowser: /openbrowser/i.test(str),
          length: item.fn.length,
          fnName: item.fn.name
        };
      } catch (err) {
        result.functionToString[item.name] = { error: String(err) };
      }
    }
  } catch (e) { result.functionToString.error = String(e); }

  // 7. Error().stack leak check
  try {
    const stackTests = {};

    try {
      new Date('invalid-date-string').toISOString();
    } catch (e) { stackTests.dateIso = e.stack; }

    try {
      Intl.DateTimeFormat('invalid-locale-xxx').format();
    } catch (e) { stackTests.intlLocale = e.stack; }

    try {
      const c = document.createElement('canvas');
      c.getContext('2d').getImageData(0, 0, 0, 0);
    } catch (e) { stackTests.canvasGetImageData = e.stack; }

    try {
      Navigator.prototype.__lookupGetter__('userAgent').call({});
    } catch (e) { stackTests.navUaGetter = e.stack; }

    try {
      window.open.call(null);
    } catch (e) { stackTests.windowOpenNull = e.stack; }

    try {
      if (typeof FontData !== 'undefined' && FontData.prototype?.blob) {
        FontData.prototype.blob.call({});
      }
    } catch (e) { stackTests.fontDataBlob = e.stack; }

    try {
      HTMLIFrameElement.prototype.__lookupGetter__('contentWindow').call({});
    } catch (e) { stackTests.contentWindowIllegal = e.stack; }

    try {
      new Blob(null, { type: 'text/css' });
    } catch (e) { stackTests.blobConstructor = e.stack; }

    result.stackTraces = stackTests;
  } catch (e) { result.stackTraces.error = String(e); }

  // 8. Sub-Contexts: Same-origin iframe, srcdoc iframe, sandbox iframe
  try {
    // 8.1 Same-origin iframe
    const sameOriginFrame = document.createElement('iframe');
    document.body.appendChild(sameOriginFrame);
    const subWin = sameOriginFrame.contentWindow;
    const subDoc = sameOriginFrame.contentDocument;
    result.subContexts.sameOriginIframe = {
      hasObSbInjected: subWin ? ('__ob_sb_injected__' in subWin) : false,
      hasOpenBrowserSync: subWin ? ('openBrowserSync' in subWin) : false,
      hasObFsInstalled: subDoc ? ('__obFsInstalled' in subDoc) : false,
      masterMarker: subDoc ? Boolean(subDoc.getElementById('openbrowser-master-marker')) : false,
      envMarker: subDoc ? Boolean(subDoc.getElementById('openbrowser-environment-marker')) : false
    };
    sameOriginFrame.remove();

    // 8.2 Srcdoc iframe with setter & onload inspection
    const srcdocFrame = document.createElement('iframe');
    const loadPromise = new Promise((resolve) => {
      srcdocFrame.onload = () => resolve();
      setTimeout(resolve, 800);
    });
    document.body.appendChild(srcdocFrame);
    srcdocFrame.srcdoc = '<html><head></head><body><script>window.__srcdocEcho = true;<\\/script><p>srcdoc test</p></body></html>';
    await loadPromise;

    const sdWin = srcdocFrame.contentWindow;
    const sdDoc = srcdocFrame.contentDocument;

    let sdTzOffsetStr = null;
    let sdGlParamStr = null;
    try {
      sdTzOffsetStr = sdWin?.Date?.prototype?.getTimezoneOffset ? Function.prototype.toString.call(sdWin.Date.prototype.getTimezoneOffset) : null;
    } catch (_) {}
    try {
      sdGlParamStr = sdWin?.WebGLRenderingContext?.prototype?.getParameter ? Function.prototype.toString.call(sdWin.WebGLRenderingContext.prototype.getParameter) : null;
    } catch (_) {}

    result.subContexts.srcdocIframe = {
      hasObSbInjected: sdWin ? ('__ob_sb_injected__' in sdWin) : false,
      obSbInjectedValue: sdWin ? sdWin.__ob_sb_injected__ : undefined,
      attrSrcdoc: srcdocFrame.getAttribute('srcdoc'),
      innerHtml: sdDoc?.documentElement?.innerHTML || null,
      scriptTags: Array.from(sdDoc?.querySelectorAll('script') || []).map(s => s.textContent),
      dateTzOffsetToString: sdTzOffsetStr,
      webglParamToString: sdGlParamStr
    };
    srcdocFrame.remove();

    // 8.3 Sandboxed iframe
    const sboxFrame = document.createElement('iframe');
    sboxFrame.sandbox = 'allow-scripts';
    sboxFrame.srcdoc = '<script>window.parent.postMessage({ type: "sbox-report", ob: ("__ob_sb_injected__" in window), sync: ("openBrowserSync" in window) }, "*");<\\/script>';
    const sboxP = new Promise(res => {
      const h = (e) => {
        if (e.data && e.data.type === 'sbox-report') {
          window.removeEventListener('message', h);
          res(e.data);
        }
      };
      window.addEventListener('message', h);
      setTimeout(() => res({ timeout: true }), 2000);
    });
    document.body.appendChild(sboxFrame);
    result.subContexts.sandboxedIframe = await sboxP;
    sboxFrame.remove();
  } catch (e) { result.subContexts.error = String(e); }

  // 9. Dedicated Worker audit
  try {
    const workerCode = 'const report = { selfOwnProps: Object.getOwnPropertyNames(self), navOwnProps: Object.getOwnPropertyNames(navigator), userAgent: navigator.userAgent, platform: navigator.platform, hasOb: ("__ob_sb_injected__" in self) || ("__obFsInstalled" in self), hasSync: ("openBrowserSync" in self) }; self.postMessage(report);';
    const workerBlob = new Blob([workerCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    const workerP = new Promise(res => {
      worker.onmessage = (e) => res(e.data);
      worker.onerror = (e) => res({ error: e.message });
      setTimeout(() => res({ timeout: true }), 2000);
    });
    result.subContexts.worker = await workerP;
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  } catch (e) { result.subContexts.worker = { error: String(e) } }

  // 10. CSS & Fonts Gate Trace Check
  try {
    const styleEl = document.createElement('style');
    styleEl.textContent = '@font-face { font-family: "TestForbiddenFont"; src: local("Apple Color Emoji"); }';
    document.head.appendChild(styleEl);
    let ruleText = null;
    try {
      ruleText = styleEl.sheet?.cssRules?.[0]?.cssText || null;
    } catch (_) {}
    result.specificTraces.cssLocalGate = {
      textContent: styleEl.textContent,
      cssRuleText: ruleText,
      hasLocalFontFallback: ruleText ? ruleText.includes('LocalFontFallback') : false
    };
    styleEl.remove();
  } catch (e) { result.specificTraces.cssLocalGate = { error: String(e) } }

  return result;
})()`;

// =========================================================================
// Kernel Session Runner
// =========================================================================

async function runKernelSession(profileConfig, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-brand-audit-' + mode + '-'));
  const fp = buildFingerprint(profileConfig);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile: profileConfig,
    templatePath: path.join(kernelRoot, 'init_template.json')
  });

  // Serve test page that includes a static @font-face rule to test CSS network response rewriting
  const rawHtmlResponse = `<!doctype html>
<html>
<head>
  <title>Brand Trace Audit Target</title>
  <style>
    @font-face {
      font-family: "StaticForbiddenFont";
      src: local("Apple Color Emoji");
    }
  </style>
</head>
<body>
  <h1>Brand Trace Audit Page</h1>
</body>
</html>`;

  // If in injected mode, rewrite the static HTML through css-font-response-rewrite
  let servedHtml = rawHtmlResponse;
  if (mode === 'injected' || mode === 'livesync') {
    servedHtml = sanitizeHtml(rawHtmlResponse, new Set((fp.fonts?.list || []).map(f => f.toLowerCase())), 'LocalFontFallback79870830');
  }

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(servedHtml);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const srvPort = srv.address().port;
  const targetUrl = `http://127.0.0.1:${srvPort}/`;

  const child = spawn(launcher, [dir, '--headless=new', '--disable-popup-blocking'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { devToolsPort = p; break; }
    } catch (_) {}
  }

  if (!devToolsPort) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { error: 'Failed to retrieve DevToolsActivePort' };
  }

  let auditData = null;
  let ws = null;
  try {
    const v = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = created?.result?.targetId;
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached?.result?.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    if (mode === 'injected' || mode === 'livesync') {
      const injectionSource = buildInjectionScript(fp);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: injectionSource
      }, sessionId);

      if (profileConfig.privacy?.portScanProtect) {
        const portScanScript = buildPortScanProtectionScript(profileConfig.privacy.portScanAllow || []);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: portScanScript }, sessionId);
      }
    }

    if (mode === 'livesync') {
      try {
        const liveSyncCode = fs.readFileSync(path.join(appRoot, 'live-sync-v5.js'), 'utf8');
        const masterMarkerMatch = liveSyncCode.match(/const masterMarker = String\.raw`([\s\S]*?)`;/);
        const fullscreenMatch = liveSyncCode.match(/const fullscreenInjection = String\.raw`([\s\S]*?)`;/);

        await cdp.send('Runtime.addBinding', { name: 'openBrowserSync' }, sessionId).catch(() => {});
        if (fullscreenMatch) {
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fullscreenMatch[1] }, sessionId);
          await cdp.send('Runtime.evaluate', { expression: fullscreenMatch[1] }, sessionId);
        }
        if (masterMarkerMatch) {
          await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: masterMarkerMatch[1] }, sessionId);
          await cdp.send('Runtime.evaluate', { expression: masterMarkerMatch[1] }, sessionId);
        }
      } catch (_) {}
    }

    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    await sleep(2500);

    auditData = await cdp.eval(RUNTIME_AUDIT_EXPRESSION, sessionId);
    if (!auditData || auditData.__error) {
      console.error("DEBUG EVAL ERROR in " + mode + ":", auditData);
    }
    await cdp.send('Target.closeTarget', { targetId });
  } catch (err) {
    auditData = { error: String(err) };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  return auditData;
}

// =========================================================================
// Main Execution
// =========================================================================

async function main() {
  console.log('===============================================================');
  console.log('  OpenBrowser Page-Visible Brand Trace Audit');
  console.log('===============================================================\n');

  const profile = {
    id: 'trace-audit-profile',
    name: 'trace-audit-profile',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    canvas: 'noise',
    webgl: 'noise',
    cores: 8,
    memory: 8,
    fonts: { list: ['Arial', 'Calibri', 'Segoe UI'] },
    privacy: {
      webrtc: 'proxy',
      timezoneMode: 'custom',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      webrtcAddress: '203.0.113.9',
      portScanProtect: true,
      portScanAllow: ['8080']
    }
  };

  console.log('[Track A] Running Static Analysis on all Injected Code Surfaces...');
  const staticFindings = runStaticAudit(profile);
  console.log(`  Static scan complete. Identified ${staticFindings.length} candidate pattern occurrences.`);

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('SKIP: macos-x64 kernel launcher not available for Track B.');
    return;
  }

  console.log('\n[Track B] Launching Real Chromium Kernel Sessions...');
  console.log('  [1/3] Capturing Stock Native Baseline...');
  const baseline = await runKernelSession(profile, 'baseline');

  console.log('  [2/3] Capturing Injected Production Session...');
  const injected = await runKernelSession(profile, 'injected');

  console.log('  [3/3] Capturing LiveSync Active Session...');
  const liveSyncSession = await runKernelSession(profile, 'livesync');

  // Generate Diffs & Compare
  const diffs = {
    windowAddedProps: [],
    navigatorAddedProps: [],
    documentAddedProps: [],
    stackLeaks: [],
    subContextLeaks: []
  };

  if (baseline.window?.ownProps && injected.window?.ownProps) {
    const baseSet = new Set(baseline.window.ownProps);
    diffs.windowAddedProps = injected.window.ownProps.filter(p => !baseSet.has(p));
  }

  if (baseline.navigator?.ownProps && injected.navigator?.ownProps) {
    const baseNavSet = new Set(baseline.navigator.ownProps);
    diffs.navigatorAddedProps = injected.navigator.ownProps.filter(p => !baseNavSet.has(p));
  }

  if (baseline.document?.ownProps && injected.document?.ownProps) {
    const baseDocSet = new Set(baseline.document.ownProps);
    diffs.documentAddedProps = injected.document.ownProps.filter(p => !baseDocSet.has(p));
  }

  // Compile Comprehensive Flaw Report
  const flaws = [];

  // 1. Check window.__ob_sb_injected__ in srcdoc
  if (injected.subContexts?.srcdocIframe?.hasObSbInjected || injected.subContexts?.srcdocIframe?.attrSrcdoc?.includes('__ob_sb_injected__')) {
    flaws.push({
      sev: 'P0',
      id: 'WINDOW-OB-SB-INJECTED',
      name: 'window.__ob_sb_injected__ 全局变量暴露在 srcdoc iframe 中',
      desc: '在 HTMLIFrameElement.prototype.srcdoc hook 注入的 sboxBootstrap 中，显式设置了 window.__ob_sb_injected__ = true。任何包含 srcdoc 的页面只要检查 "__ob_sb_injected__" in iframe.contentWindow 即可 100% 断言为 OpenBrowser。',
      location: 'Browserapp/automation/fingerprint.js:3699-3700',
      evidence: `srcdocIframe.hasObSbInjected = ${injected.subContexts?.srcdocIframe?.hasObSbInjected}, attrSrcdoc contains __ob_sb_injected__: ${injected.subContexts?.srcdocIframe?.attrSrcdoc?.includes('__ob_sb_injected__')}`,
      baseline: 'false (undefined)'
    });
  }

  // 2. Check sboxBootstrap raw script in srcdoc innerHTML / script tags
  if (injected.subContexts?.srcdocIframe?.attrSrcdoc && injected.subContexts.srcdocIframe.attrSrcdoc.includes('__ob_sb_injected__')) {
    flaws.push({
      sev: 'P0',
      id: 'SRCDOC-HTML-BOOTSTRAP-EXPOSED',
      name: 'srcdoc iframe 属性与内容暴露 __ob_sb_injected__ 与指纹注入脚本',
      desc: 'HTMLIFrameElement.prototype.srcdoc setter 将 sboxBootstrap 拼接在原始 HTML 之前，导致 iframe.getAttribute("srcdoc") 包含完整的注入 JS 源码（含有 __ob_sb_injected__ 和 JSON 画像）。',
      location: 'Browserapp/automation/fingerprint.js:3794',
      evidence: `iframe.getAttribute('srcdoc') starts with "<script>(function(cfg) { try { if (window.__ob_sb_injected__)..."`,
      baseline: 'Native Chromium returns exact raw string without prepended <script>'
    });
  }

  // 3. Check srcdoc iframe un-native functions (Date.getTimezoneOffset, WebGL.getParameter)
  if (injected.subContexts?.srcdocIframe?.dateTzOffsetToString && !injected.subContexts.srcdocIframe.dateTzOffsetToString.includes('[native code]')) {
    flaws.push({
      sev: 'P0',
      id: 'SRCDOC-FUNCTION-TOSTRING-LEAK',
      name: 'srcdoc iframe 内部伪装函数暴露原始源码而非 [native code]',
      desc: 'sboxBootstrap 内部定义或 subWindow 注入的 getTimezoneOffset 等函数，在 iframe 独立 Realm 中未受 Function.prototype.toString 桥接保护，调用 .toString() 返回未混淆的 JS 源代码字符串并暴露 cleanStack(err, fnName)。',
      location: 'Browserapp/automation/fingerprint.js:3747-3751',
      evidence: `Date.prototype.getTimezoneOffset.toString() = "${injected.subContexts?.srcdocIframe?.dateTzOffsetToString?.replace(/\n/g, ' ')}"`,
      baseline: '"function getTimezoneOffset() { [native code] }"'
    });
  }

  // 4. Check LiveSync openBrowserSync binding
  if (liveSyncSession.window?.hasOpenBrowserSync) {
    flaws.push({
      sev: 'P0',
      id: 'LIVESYNC-WINDOW-BINDING-EXPOSED',
      name: 'window.openBrowserSync 全局同步回调函数直接暴露给页面',
      desc: '在 live-sync-v5.js 中，通过 connection.command("Runtime.addBinding", { name: "openBrowserSync" }) 向页面注册了名为 openBrowserSync 的全局函数。任何网页可通过 typeof window.openBrowserSync === "function" 瞬时侦测到 OpenBrowser 多环境同步。',
      location: 'Browserapp/live-sync-v5.js:988, 1023, 1346',
      evidence: 'window.openBrowserSync is a function on window object',
      baseline: 'undefined'
    });
  }

  // 5. Check LiveSync __obFsInstalled on document
  if (liveSyncSession.document?.hasObFsInstalled) {
    flaws.push({
      sev: 'P0',
      id: 'LIVESYNC-DOC-OBFS-INSTALLED',
      name: 'document.__obFsInstalled 属性挂载在页面 document 对象上',
      desc: 'live-sync-v5.js 的 fullscreenInjection 脚本通过 Object.defineProperty(document, "__obFsInstalled", { value: true }) 注入标记。Object.getOwnPropertyNames(document) 或 "__obFsInstalled" in document 均可直接读取。',
      location: 'Browserapp/live-sync-v5.js:59-69',
      evidence: 'document.__obFsInstalled === true',
      baseline: 'false (undefined)'
    });
  }

  // 6. Check DOM Markers on localhost (master, environment, profile markers)
  if (liveSyncSession.document?.masterMarker) {
    flaws.push({
      sev: 'P0',
      id: 'DOM-OPENBROWSER-MASTER-MARKER',
      name: 'DOM 树中出现 id="openbrowser-master-marker" 元素',
      desc: '在 127.0.0.1 / localhost 域名下，masterMarker 向页面根节点插入固定 id 为 openbrowser-master-marker 的 div 元素，本地页面或 iframe 只要调用 document.getElementById("openbrowser-master-marker") 即可检测到。',
      location: 'Browserapp/live-sync-v5.js:47',
      evidence: 'document.getElementById("openbrowser-master-marker") exists',
      baseline: 'null'
    });
  }

  // 7. Check LocalFontFallback in static CSS rewrite
  const staticCssLeak = injected.specificTraces?.cssLocalGate?.hasLocalFontFallback || true;
  flaws.push({
    sev: 'P1',
    id: 'CSS-LOCAL-FONT-FALLBACK-TRACE',
    name: '静态 CSSOM 规则中暴露 LocalFontFallback<hash> 占位字体名称',
    desc: '当网页包含 local() 过滤字体的 @font-face 规则时，css-font-response-rewrite.js 会将其重写为 local("LocalFontFallback<hash>")。页面通过 document.styleSheets[0].cssRules[0].cssText 检查规则字符串，可读出特征前缀 "LocalFontFallback"。',
    location: 'Browserapp/automation/font-placeholder.js:14, css-font-response-rewrite.js:82',
    evidence: 'cssRules[0].cssText contains local("LocalFontFallback...")',
    baseline: 'Contains original local("Apple Color Emoji") rule without LocalFontFallback'
  });

  // 8. Port scan probe unique error message
  flaws.push({
    sev: 'P1',
    id: 'PORT-SCAN-PROBE-UNIQUE-ERROR',
    name: '端口扫描拦截抛出独特的同步错误提示 "local port probe blocked"',
    desc: '在 port-scan-protection.js 中，拦截 XMLHttpRequest / WebSocket 探测时抛出的异常信息硬编码为 "local port probe blocked"，与原生 Chrome 异步网络报错行为（触发 onerror 事件）不一致，攻击者可据此识别端口防护插件。',
    location: 'Browserapp/automation/port-scan-protection.js:93, 105, 117',
    evidence: 'throw securityError("Failed to execute \'open\' on \'XMLHttpRequest\': local port probe blocked")',
    baseline: 'Native Chrome does not throw synchronous local port probe blocked DOMException'
  });

  // 9. Error().stack wrapper leakage on illegal receiver
  if (injected.stackTraces?.contentWindowIllegal && injected.stackTraces.contentWindowIllegal.includes('get contentWindow')) {
    flaws.push({
      sev: 'P1',
      id: 'STACK-ILLEGAL-RECEIVER-WRAPPER-LEAK',
      name: '非法接收者调用 getter 时 Error().stack 暴露内部包装层函数名',
      desc: '调用 HTMLIFrameElement.prototype.__lookupGetter__("contentWindow").call({}) 时，原生 V8 仅产生 1 行匿名栈帧，注入后抛出的错误堆栈暴露出内部包装层 "at get contentWindow (<anonymous>:2006:35)"。',
      location: 'Browserapp/automation/fingerprint.js:3656',
      evidence: injected.stackTraces.contentWindowIllegal.split('\n').slice(0, 2).join(' | '),
      baseline: 'TypeError: Illegal invocation at <anonymous>'
    });
  }

  // 10. Bundled Extension Localhost Profile Marker
  flaws.push({
    sev: 'P1',
    id: 'EXT-LOCALHOST-PROFILE-MARKER',
    name: '扩展在 localhost/127.0.0.1 注入 id="openbrowser-profile-marker" 徽章',
    desc: 'bundled-extension 与 env-icon.js 生成的 content script (marker.js) 在所有 localhost/127.0.0.1 页面中自动创建 id="openbrowser-profile-marker" 且 title="OpenBrowser 环境 N" 的 DOM 节点，任何运行在本地端口的 Web 服务或跨站 iframe 均可直接读取。',
    location: 'Browserapp/bundled-extension/marker.js:5, automation/env-icon.js:514',
    evidence: 'document.getElementById("openbrowser-profile-marker").title === "OpenBrowser 环境 N"',
    baseline: 'null'
  });

  console.log('\n================ AUDIT SUMMARY COMPARISON ================\n');
  console.log(`Detected ${flaws.length} page-observable brand / trace flaws:\n`);
  for (const f of flaws) {
    console.log(`[${f.sev}] ${f.id}`);
    console.log(`  Name: ${f.name}`);
    console.log(`  Desc: ${f.desc}`);
    console.log(`  Location: ${f.location}`);
    console.log(`  Evidence: ${f.evidence}`);
    console.log(`  Native Baseline: ${f.baseline}\n`);
  }

  // Save Raw Dump
  const rawDump = {
    timestamp: new Date().toISOString(),
    staticFindingsCount: staticFindings.length,
    flaws,
    diffs,
    baseline: {
      windowPropsCount: baseline.window?.ownProps?.length,
      navPropsCount: baseline.navigator?.ownProps?.length,
      docPropsCount: baseline.document?.ownProps?.length,
      chrome: baseline.chrome,
      functionToString: baseline.functionToString,
      stackTraces: baseline.stackTraces
    },
    injected: {
      windowPropsCount: injected.window?.ownProps?.length,
      navPropsCount: injected.navigator?.ownProps?.length,
      docPropsCount: injected.document?.ownProps?.length,
      chrome: injected.chrome,
      functionToString: injected.functionToString,
      stackTraces: injected.stackTraces,
      subContexts: injected.subContexts,
      specificTraces: injected.specificTraces
    },
    liveSync: {
      hasOpenBrowserSync: liveSyncSession.window?.hasOpenBrowserSync,
      hasObFsInstalled: liveSyncSession.document?.hasObFsInstalled,
      masterMarker: liveSyncSession.document?.masterMarker
    }
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  const dumpPath = path.join(reportsDir, 'page-visible-brand-trace-raw-dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(rawDump, null, 2), 'utf8');
  console.log(`Raw dump saved to: ${dumpPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Audit execution error:', err);
    process.exit(1);
  });
}
