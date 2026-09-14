#!/usr/bin/env node
'use strict';

/**
 * Google BotGuard & reCAPTCHA Signal Surface Adversarial Audit
 * OpenBrowser Hardening
 *
 * Exhaustive A/B adversarial audit comparing:
 *  1. Stock Native Chromium Kernel Baseline (macOS host, un-injected)
 *  2. Injected Production Windows Desktop Persona (Chrome 148, D3D11, full pipeline)
 *  3. Injected Production macOS Desktop Persona (Chrome 148, Metal, full pipeline)
 *  4. Injected Production Android Mobile Persona (Pixel 7, Chrome 148, mobile touch)
 *
 * Focuses on surfaces inspected by Google BotGuard / reCAPTCHA Enterprise:
 *  - window.chrome: own property names, descriptors, types, csi, loadTimes, app, runtime
 *  - navigator: own properties, prototype properties, shadowing, descriptors, brand checks
 *  - BotGuard high-entropy targets: plugins, mimeTypes, pdfViewerEnabled, userAgentData,
 *    connection, getBattery, usb, hid, bluetooth, serial, webdriver, permissions
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const cdp = require('../cdp');
const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
} = require('./fingerprint');
const {
  writeOpenBrowserKernelInit,
  mapFingerprintToInitFields,
  validateKernelInitInvariants,
} = require('./kernel-init-sync');
const { RequestHeaderRewriter } = require('../engine');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reportsDir = path.join(appRoot, 'reports');
const rootReportsDir = path.join(appRoot, '..', 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractRawHeaders(req) {
  const raw = req.rawHeaders || [];
  const list = [];
  const map = {};
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    list.push({ name, value });
    map[name.toLowerCase()] = value;
  }
  return {
    rawList: list,
    namesInOrder: list.map((h) => h.name),
    namesInOrderLower: list.map((h) => h.name.toLowerCase()),
    map,
  };
}

class AuditServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.recordedRequests = {
      mainPage: null,
      fetchRequest: null,
    };
  }

  resetRecorded() {
    for (const k of Object.keys(this.recordedRequests)) {
      this.recordedRequests[k] = null;
    }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const p = parsedUrl.pathname;

      if (p === '/main') {
        this.recordedRequests.mainPage = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/api/fetch') {
        this.recordedRequests.fetchRequest = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
  }

  async stop() {
    if (this.server) {
      await new Promise((r) => this.server.close(r));
    }
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Google BotGuard Surface Audit Probe</title>
</head>
<body>
  <h1>Google BotGuard Surface Probe Page</h1>
  <script>
    (async () => {
      const out = {};
      try {
        // ============================================================
        // 1. window.chrome Full Surface
        // ============================================================
        const chromeObj = window.chrome;
        const hasChrome = 'chrome' in window;
        const chromeOwnKeys = chromeObj ? Object.getOwnPropertyNames(chromeObj) : [];
        const chromeDescriptors = {};
        for (const k of chromeOwnKeys) {
          try {
            const d = Object.getOwnPropertyDescriptor(chromeObj, k);
            chromeDescriptors[k] = {
              typeof: typeof chromeObj[k],
              enumerable: d?.enumerable,
              configurable: d?.configurable,
              writable: d?.writable,
              hasGetter: typeof d?.get === 'function',
              hasSetter: typeof d?.set === 'function',
            };
          } catch (e) {
            chromeDescriptors[k] = { error: e.message };
          }
        }

        // 1.1 window.chrome.csi
        let csiData = { exists: false };
        if (chromeObj && typeof chromeObj.csi === 'function') {
          let csiCall = null;
          let csiNew = null;
          try {
            csiCall = chromeObj.csi();
          } catch (e) {
            csiCall = { threw: true, message: e.message };
          }
          try {
            new chromeObj.csi();
            csiNew = 'no-throw-on-new';
          } catch (e) {
            csiNew = { threw: true, name: e.name, message: e.message };
          }
          csiData = {
            exists: true,
            typeof: 'function',
            toStringText: String(chromeObj.csi),
            callResult: csiCall,
            ctorCheck: csiNew,
            descriptor: Object.getOwnPropertyDescriptor(chromeObj, 'csi'),
          };
        } else if (chromeObj && 'csi' in chromeObj) {
          csiData = { exists: true, typeof: typeof chromeObj.csi, val: chromeObj.csi };
        }

        // 1.2 window.chrome.loadTimes
        let loadTimesData = { exists: false };
        if (chromeObj && typeof chromeObj.loadTimes === 'function') {
          let ltCall = null;
          let ltNew = null;
          try {
            ltCall = chromeObj.loadTimes();
          } catch (e) {
            ltCall = { threw: true, message: e.message };
          }
          try {
            new chromeObj.loadTimes();
            ltNew = 'no-throw-on-new';
          } catch (e) {
            ltNew = { threw: true, name: e.name, message: e.message };
          }
          loadTimesData = {
            exists: true,
            typeof: 'function',
            toStringText: String(chromeObj.loadTimes),
            callResult: ltCall,
            ctorCheck: ltNew,
            descriptor: Object.getOwnPropertyDescriptor(chromeObj, 'loadTimes'),
          };
        } else if (chromeObj && 'loadTimes' in chromeObj) {
          loadTimesData = { exists: true, typeof: typeof chromeObj.loadTimes, val: chromeObj.loadTimes };
        }

        // 1.3 window.chrome.app
        let appData = { exists: false };
        if (chromeObj && chromeObj.app) {
          const app = chromeObj.app;
          const appKeys = Object.getOwnPropertyNames(app);
          const appProps = {};
          for (const k of appKeys) {
            try {
              appProps[k] = {
                typeof: typeof app[k],
                val: typeof app[k] === 'object' ? Object.keys(app[k] || {}) : app[k],
              };
            } catch (e) {}
          }
          let ctorAppMethod = null;
          if (typeof app.getIsInstalled === 'function') {
            try {
              new app.getIsInstalled();
              ctorAppMethod = 'no-throw-on-new';
            } catch (e) {
              ctorAppMethod = { threw: true, name: e.name, message: e.message };
            }
          }
          appData = {
            exists: true,
            typeof: typeof app,
            ownKeys: appKeys,
            properties: appProps,
            isInstalled: app.isInstalled,
            ctorCheck: ctorAppMethod,
            descriptor: Object.getOwnPropertyDescriptor(chromeObj, 'app'),
          };
        }

        // 1.4 window.chrome.runtime
        let runtimeData = { exists: Boolean(chromeObj && chromeObj.runtime) };
        if (runtimeData.exists) {
          runtimeData.typeof = typeof chromeObj.runtime;
          runtimeData.keys = Object.getOwnPropertyNames(chromeObj.runtime);
        }

        out.chrome = {
          hasChrome,
          typeof: typeof chromeObj,
          toStringTag: Object.prototype.toString.call(chromeObj),
          protoIsObjectProto: chromeObj ? Object.getPrototypeOf(chromeObj) === Object.prototype : false,
          ownKeys: chromeOwnKeys,
          descriptors: chromeDescriptors,
          csi: csiData,
          loadTimes: loadTimesData,
          app: appData,
          runtime: runtimeData,
        };

        // ============================================================
        // 2. navigator Surface (Own vs Prototype vs Shadowing)
        // ============================================================
        const navOwnKeys = Object.getOwnPropertyNames(navigator);
        const navProto = typeof Navigator !== 'undefined' ? Navigator.prototype : null;
        const navProtoKeys = navProto ? Object.getOwnPropertyNames(navProto) : [];

        const navPropertiesAudit = {};
        const allInspectedKeys = new Set([
          ...navProtoKeys,
          ...navOwnKeys,
          'webdriver', 'userAgent', 'appVersion', 'platform', 'vendor',
          'language', 'languages', 'hardwareConcurrency', 'deviceMemory',
          'plugins', 'mimeTypes', 'pdfViewerEnabled', 'userAgentData',
          'connection', 'getBattery', 'usb', 'hid', 'bluetooth', 'serial',
          'cookieEnabled', 'onLine', 'permissions', 'storage', 'mediaCapabilities'
        ]);

        for (const key of allInspectedKeys) {
          const isOwn = Object.prototype.hasOwnProperty.call(navigator, key);
          const isOnProto = navProto ? Object.prototype.hasOwnProperty.call(navProto, key) : false;
          const ownDesc = isOwn ? Object.getOwnPropertyDescriptor(navigator, key) : null;
          const protoDesc = isOnProto ? Object.getOwnPropertyDescriptor(navProto, key) : null;

          let protoBrandCheck = null;
          if (protoDesc && typeof protoDesc.get === 'function') {
            try {
              const val = protoDesc.get.call(navProto);
              protoBrandCheck = { threw: false, returnedValue: typeof val === 'object' ? '[object]' : val };
            } catch (err) {
              protoBrandCheck = { threw: true, name: err.name, message: err.message };
            }
          }

          navPropertiesAudit[key] = {
            existsInNavigator: key in navigator,
            isOwnPropertyOnNavigator: isOwn,
            isPropertyOnNavigatorProto: isOnProto,
            typeof: typeof navigator[key],
            ownDescriptor: ownDesc ? {
              enumerable: ownDesc.enumerable,
              configurable: ownDesc.configurable,
              writable: ownDesc.writable,
              hasGet: typeof ownDesc.get === 'function',
            } : null,
            protoDescriptor: protoDesc ? {
              enumerable: protoDesc.enumerable,
              configurable: protoDesc.configurable,
              writable: protoDesc.writable,
              hasGet: typeof protoDesc.get === 'function',
            } : null,
            protoBrandCheck,
          };
        }

        out.navigator = {
          ownKeys: navOwnKeys,
          protoKeys: navProtoKeys,
          properties: navPropertiesAudit,
        };

        // ============================================================
        // 3. BotGuard High-Value Target Details
        // ============================================================
        // 3.1 plugins & mimeTypes
        out.botguardTargets = {
          plugins: {
            length: navigator.plugins?.length,
            names: navigator.plugins ? Array.from(navigator.plugins).map(p => p.name) : [],
            ownKeys: navigator.plugins ? Object.getOwnPropertyNames(navigator.plugins) : [],
            instanceofPluginArray: typeof PluginArray !== 'undefined' && navigator.plugins instanceof PluginArray,
            itemMatchesIndex: navigator.plugins && navigator.plugins.length > 0 ? (navigator.plugins.item(0) === navigator.plugins[0]) : null,
          },
          mimeTypes: {
            length: navigator.mimeTypes?.length,
            types: navigator.mimeTypes ? Array.from(navigator.mimeTypes).map(m => m.type) : [],
            ownKeys: navigator.mimeTypes ? Object.getOwnPropertyNames(navigator.mimeTypes) : [],
            instanceofMimeTypeArray: typeof MimeTypeArray !== 'undefined' && navigator.mimeTypes instanceof MimeTypeArray,
          },
          pdfViewerEnabled: navigator.pdfViewerEnabled,
          webdriver: {
            value: navigator.webdriver,
            hasOwn: Object.prototype.hasOwnProperty.call(navigator, 'webdriver'),
            protoBrandCheck: navPropertiesAudit['webdriver']?.protoBrandCheck,
          },
          languages: {
            value: Array.from(navigator.languages || []),
            identity: navigator.languages === navigator.languages,
            frozen: Object.isFrozen(navigator.languages),
          },
          connection: {
            exists: 'connection' in navigator,
            effectiveType: navigator.connection?.effectiveType,
            rtt: navigator.connection?.rtt,
            downlink: navigator.connection?.downlink,
            saveData: navigator.connection?.saveData,
          },
          battery: {
            exists: 'getBattery' in navigator,
          },
          deviceApis: {
            usb: 'usb' in navigator,
            hid: 'hid' in navigator,
            bluetooth: 'bluetooth' in navigator,
            serial: 'serial' in navigator,
          },
          userAgentData: {
            exists: Boolean(navigator.userAgentData),
            platform: navigator.userAgentData?.platform,
            mobile: navigator.userAgentData?.mobile,
            brands: navigator.userAgentData?.brands,
          },
        };

        if (navigator.getBattery) {
          try {
            const b = await navigator.getBattery();
            out.botguardTargets.battery.callResult = {
              resolved: true,
              charging: b.charging,
              level: b.level,
            };
          } catch (e) {
            out.botguardTargets.battery.callResult = {
              resolved: false,
              name: e.name,
              message: e.message,
            };
          }
        }

      } catch (err) {
        out.auditError = { name: err.name, message: err.message, stack: err.stack };
      } finally {
        window.__AUDIT_RESULT__ = out;
        window.__AUDIT_READY__ = true;
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function runSession(profileConfig, isInject, server) {
  server.resetRecorded();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-bg-sess-' + profileConfig.id + '-'));
  const fp = isInject ? buildFingerprint(profileConfig) : null;

  const launchArgs = [dir, '--headless=new', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

  if (isInject) {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile: profileConfig,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });
    const fpChromeArgs = chromeArgsForFingerprint(fp, profileConfig);
    for (const arg of fpChromeArgs) {
      if (!launchArgs.includes(arg)) launchArgs.push(arg);
    }
  }

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }

  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };

  if (!port) {
    stop();
    return { error: 'Failed to retrieve DevToolsActivePort' };
  }

  let clientResult = null;
  let connection = null;

  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const wsUrl = v.webSocketDebuggerUrl;

    let primarySessionId = null;
    let primaryReadyResolve = null;
    const primaryReadyPromise = new Promise((resolve) => { primaryReadyResolve = resolve; });

    const onEvent = async (event, conn) => {
      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {} } = event.params || {};
        if (targetInfo.type === 'page' && !primarySessionId) {
          primarySessionId = sessionId;
          if (primaryReadyResolve) primaryReadyResolve(sessionId);
        }
      }
    };

    connection = await cdp.connect(wsUrl, { onEvent, timeout: 8000 });

    await connection.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    let sessionId = await Promise.race([
      primaryReadyPromise,
      sleep(3000).then(() => null),
    ]);

    if (!sessionId) {
      const targetList = await cdp.targets(port);
      const defaultTarget = targetList.find((t) => t.type === 'page');
      const targetId = defaultTarget ? defaultTarget.id : null;
      if (targetId) {
        const attached = await connection.command('Target.attachToTarget', { targetId, flatten: true });
        sessionId = attached?.sessionId;
      }
    }

    if (isInject) {
      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, { sessionId }).catch(() => {});

      const sessionCall = async (method, params = {}) => {
        return connection.command(method, params, { sessionId, timeout: 30000 });
      };
      await applyFingerprintToTab(sessionCall, null, fp, profileConfig, {
        applyKey: `session:${sessionId}`,
      });
    }

    await connection.command('Page.enable', {}, { sessionId });
    await connection.command('Runtime.enable', {}, { sessionId });
    await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});

    const mainUrl = `http://127.0.0.1:${server.port}/main`;
    await connection.command('Page.navigate', { url: mainUrl }, { sessionId });

    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      const evalRes = await connection.command('Runtime.evaluate', {
        expression: 'Boolean(window.__AUDIT_READY__)',
        returnByValue: true,
      }, { sessionId, timeout: 12000 }).catch(() => null);
      if (evalRes?.result?.value === true) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      clientResult = { error: 'Timeout waiting for __AUDIT_READY__' };
    } else {
      const dataRes = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_RESULT__',
        returnByValue: true,
      }, { sessionId, timeout: 15000 });
      clientResult = dataRes?.result?.value;
    }
  } catch (err) {
    clientResult = { error: String(err), stack: err.stack };
  } finally {
    if (connection) {
      try { connection.socket?.close(); } catch (_) {}
    }
    stop();
  }

  return {
    client: clientResult,
    fingerprint: fp,
  };
}

(async () => {
  console.log('================================================================');
  console.log('  OpenBrowser Google BotGuard & reCAPTCHA Signal Surface Audit');
  console.log('  Live Kernel Adversarial A/B Diff (Headless Mode)');
  console.log('================================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.error('ERROR: This audit requires the macos-x64 Chromium kernel at', launcher);
    process.exit(1);
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Running on http://127.0.0.1:${server.port}`);

  const auditData = {};

  // 1. Session 1: Baseline (Native Stock Chromium Kernel)
  console.log('\n>>> [Session 1/4] Running Native Baseline (Stock Kernel, No Injections)...');
  const baselineConfig = { id: 'bg-baseline', name: 'Baseline Stock Kernel' };
  auditData.baseline = await runSession(baselineConfig, false, server);
  console.log('    Baseline probe finished. Error:', auditData.baseline.client?.error || 'none');

  // 2. Session 2: Injected Windows Desktop Persona
  console.log('\n>>> [Session 2/4] Running Injected Windows Desktop Persona (Chrome 148, D3D11)...');
  const windowsConfig = {
    id: 'bg-win10',
    name: 'Windows 10 Chrome 148',
    os: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'bg-seed-win-10',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
    },
  };
  auditData.windows = await runSession(windowsConfig, true, server);
  console.log('    Windows session finished. Error:', auditData.windows.client?.error || 'none');

  // 3. Session 3: Injected macOS Desktop Persona
  console.log('\n>>> [Session 3/4] Running Injected macOS Desktop Persona (Chrome 148, Metal)...');
  const macConfig = {
    id: 'bg-macos',
    name: 'macOS Chrome 148',
    os: 'macOS',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'bg-seed-mac-20',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'Asia/Singapore',
      languages: ['zh-TW', 'en-US', 'en'],
    },
  };
  auditData.macos = await runSession(macConfig, true, server);
  console.log('    macOS session finished. Error:', auditData.macos.client?.error || 'none');

  // 4. Session 4: Injected Android Mobile Persona
  console.log('\n>>> [Session 4/4] Running Injected Android Mobile Persona (Pixel 7, Chrome 148)...');
  const androidConfig = {
    id: 'bg-android',
    name: 'Pixel 7 Android 14',
    os: 'Android',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'bg-seed-android-30',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'America/Chicago',
      languages: ['en-US', 'en'],
    },
  };
  auditData.android = await runSession(androidConfig, true, server);
  console.log('    Android session finished. Error:', auditData.android.client?.error || 'none');

  await server.stop();

  // Save Raw Dump
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(rootReportsDir, { recursive: true });
  const rawPath1 = path.join(reportsDir, 'google-botguard-surface-audit-raw.json');
  const rawPath2 = path.join(rootReportsDir, 'google-botguard-surface-audit-raw.json');
  const jsonStr = JSON.stringify(auditData, null, 2);
  fs.writeFileSync(rawPath1, jsonStr, 'utf8');
  fs.writeFileSync(rawPath2, jsonStr, 'utf8');
  console.log(`\n[Audit] Raw data dumped to:\n  - ${rawPath1}\n  - ${rawPath2}`);

  console.log('\n[Audit] Completed successfully. Exiting.');
})();
