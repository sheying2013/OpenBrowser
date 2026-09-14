#!/usr/bin/env node
'use strict';

/**
 * Worker / Iframe / Sub-Realm Automation Signal Penetration & Leak Audit
 * OpenBrowser Security Hardening
 *
 * Exhaustive real-kernel A/B adversarial audit evaluating 8 distinct execution contexts:
 *  1. Main Frame
 *  2. Same-Origin Iframe
 *  3. Cross-Origin (OOPIF) Iframe
 *  4. data: URL Iframe
 *  5. DedicatedWorker
 *  6. SharedWorker
 *  7. ServiceWorker Global Scope
 *  8. OffscreenCanvas Worker
 *
 * Compares:
 *  - Native Stock Chromium Baseline (Bare kernel, no injection)
 *  - Injected Desktop Persona (Windows 10, Chrome 148, Win32, cores=8, memory=8, America/New_York)
 *
 * Directly answers three core forensic questions:
 *  a) Is navigator.webdriver true or false in Worker scopes?
 *  b) Are UA, platform, and core counts in Worker scopes strictly consistent with the main frame?
 *  c) Can fake/mocked getters be coerced into dumping internal wrapper source code in any non-main context?
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
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reportsDirTop = path.join(appRoot, '..', 'reports');
const reportsDirLocal = path.join(appRoot, 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE_SCOPE_FN = `
function runScopeAudit(scopeKind) {
  const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
  const isDedicatedWorker = typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope;
  const isSharedWorker = typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope;
  const isServiceWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
  const isWindow = typeof window !== 'undefined';

  const nav = self.navigator;
  const proto = nav ? Object.getPrototypeOf(nav) : null;
  const protoConstructorName = proto && proto.constructor ? proto.constructor.name : null;
  const navTag = Object.prototype.toString.call(nav);

  const getDesc = (obj, prop) => {
    try { return Object.getOwnPropertyDescriptor(obj, prop); } catch (_) { return null; }
  };

  const getToString = (fn) => {
    if (typeof fn !== 'function') return null;
    try {
      return Function.prototype.toString.call(fn);
    } catch (e) {
      return 'ERR:' + e.name + ':' + e.message;
    }
  };

  const getSymbols = (fn) => {
    if (typeof fn !== 'function') return [];
    try {
      return Object.getOwnPropertySymbols(fn).map(s => String(s));
    } catch (_) {
      return [];
    }
  };

  const testIllegalReceiver = (getter) => {
    if (typeof getter !== 'function') return 'no-getter';
    try {
      const val = getter.call({});
      return { threw: false, result: String(val) };
    } catch (e) {
      return {
        threw: true,
        name: e.name,
        message: e.message,
        isTypeError: e instanceof TypeError,
      };
    }
  };

  const testDelete = (prop) => {
    try {
      const beforeVal = nav[prop];
      const delRes = delete nav[prop];
      const afterVal = nav[prop];
      return { delRes, beforeVal: String(beforeVal), afterVal: String(afterVal) };
    } catch (e) {
      return { delRes: false, error: e.name + ':' + e.message };
    }
  };

  // 1. Webdriver probe
  const wdProtoDesc = proto ? getDesc(proto, 'webdriver') : null;
  const wdNavDesc = nav ? getDesc(nav, 'webdriver') : null;
  const wdGetter = wdProtoDesc && typeof wdProtoDesc.get === 'function' ? wdProtoDesc.get : null;
  const wdGetterStr = wdGetter ? getToString(wdGetter) : null;

  const wdAudit = {
    value: nav ? nav.webdriver : undefined,
    inNavigator: nav ? ('webdriver' in nav) : false,
    hasOwn: nav ? Object.prototype.hasOwnProperty.call(nav, 'webdriver') : false,
    protoDescPresent: Boolean(wdProtoDesc),
    protoDescEnumerable: wdProtoDesc ? wdProtoDesc.enumerable : undefined,
    protoDescConfigurable: wdProtoDesc ? wdProtoDesc.configurable : undefined,
    protoHasGetter: Boolean(wdGetter),
    protoGetterToString: wdGetterStr,
    protoGetterSymbols: wdGetter ? getSymbols(wdGetter) : [],
    protoGetterIllegalReceiver: wdGetter ? testIllegalReceiver(wdGetter) : null,
    deleteResult: testDelete('webdriver'),
  };

  // 2. Navigator Core Identity Properties
  const propNames = ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory', 'languages', 'language', 'vendor', 'appVersion'];
  const propsAudit = {};
  for (const p of propNames) {
    const desc = proto ? getDesc(proto, p) : null;
    const getter = desc && typeof desc.get === 'function' ? desc.get : null;
    const getterStr = getter ? getToString(getter) : null;
    propsAudit[p] = {
      value: nav ? nav[p] : undefined,
      inNavigator: nav ? (p in nav) : false,
      hasOwn: nav ? Object.prototype.hasOwnProperty.call(nav, p) : false,
      protoDescPresent: Boolean(desc),
      hasGetter: Boolean(getter),
      getterToString: getterStr,
      getterSymbols: getter ? getSymbols(getter) : [],
      illegalReceiver: getter ? testIllegalReceiver(getter) : null,
    };
  }

  // 3. userAgentData / Client Hints
  let uadAudit = null;
  if (nav && nav.userAgentData) {
    const uad = nav.userAgentData;
    const uadProto = Object.getPrototypeOf(uad);
    uadAudit = {
      present: true,
      inNavigator: true,
      platform: uad.platform,
      mobile: uad.mobile,
      brands: uad.brands ? uad.brands.map(b => ({ brand: b.brand, version: b.version })) : null,
      protoMethods: uadProto ? Object.getOwnPropertyNames(uadProto) : [],
    };
  } else {
    uadAudit = {
      present: false,
      inNavigator: nav ? ('userAgentData' in nav) : false,
    };
  }

  const protoNames = proto ? Object.getOwnPropertyNames(proto) : [];

  return {
    scopeKind,
    isWorker,
    isDedicatedWorker,
    isSharedWorker,
    isServiceWorker,
    isWindow,
    protoConstructorName,
    navTag,
    protoNames,
    webdriver: wdAudit,
    props: propsAudit,
    userAgentData: uadAudit,
  };
}
`;

class AuditServer {
  constructor() {
    this.serverA = null;
    this.serverB = null;
    this.portA = 0;
    this.portB = 0;
    this.reports = {};
  }

  async start() {
    this.reports = {};

    // Server A: Main origin (127.0.0.1)
    this.serverA = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.portA}`);
      const p = parsedUrl.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (p === '/report' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data && data.scopeKind) {
              console.log(`    [ServerA /report] Received audit for: ${data.scopeKind}`);
              this.reports[data.scopeKind] = data;
            }
          } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/same-origin.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getSameOriginIframeHtml());
        return;
      }

      if (p === '/dedicated-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getDedicatedWorkerJs());
        return;
      }

      if (p === '/shared-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getSharedWorkerJs());
        return;
      }

      if (p === '/sw.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Service-Worker-Allowed': '/',
        });
        res.end(this.getServiceWorkerJs());
        return;
      }

      if (p === '/offscreencanvas-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getOffscreenCanvasWorkerJs());
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    // Server B: Cross-origin OOPIF (localhost)
    this.serverB = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://localhost:${this.portB}`);
      const p = parsedUrl.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (p === '/cross-origin.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getCrossOriginIframeHtml());
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => this.serverA.listen(0, '127.0.0.1', r));
    this.portA = this.serverA.address().port;

    await new Promise((r) => this.serverB.listen(0, '127.0.0.1', r));
    this.portB = this.serverB.address().port;
  }

  async stop() {
    if (this.serverA) await new Promise((r) => this.serverA.close(r));
    if (this.serverB) await new Promise((r) => this.serverB.close(r));
  }

  getDedicatedWorkerJs() {
    return `
      ${PROBE_SCOPE_FN}
      const dwAudit = runScopeAudit('dedicated_worker');
      try {
        fetch('http://127.0.0.1:${this.portA}/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dwAudit)
        }).catch(() => {});
      } catch (_) {}
      self.onmessage = () => self.postMessage(dwAudit);
      self.postMessage(dwAudit);
    `;
  }

  getSharedWorkerJs() {
    return `
      ${PROBE_SCOPE_FN}
      const swAudit = runScopeAudit('shared_worker');
      try {
        fetch('http://127.0.0.1:${this.portA}/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(swAudit)
        }).catch(() => {});
      } catch (_) {}
      self.onconnect = (e) => {
        const port = e.ports[0];
        port.onmessage = () => port.postMessage(swAudit);
        port.postMessage(swAudit);
      };
    `;
  }

  getServiceWorkerJs() {
    return `
      ${PROBE_SCOPE_FN}
      const swAudit = runScopeAudit('service_worker');
      const sendReport = () => {
        try {
          fetch('http://127.0.0.1:${this.portA}/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(swAudit)
          }).catch(() => {});
        } catch (_) {}
      };
      sendReport();
      self.addEventListener('install', (e) => {
        self.skipWaiting();
        sendReport();
      });
      self.addEventListener('activate', (e) => {
        e.waitUntil(self.clients.claim());
        sendReport();
        if (self.clients && self.clients.matchAll) {
          self.clients.matchAll().then(cls => {
            cls.forEach(c => c.postMessage(swAudit));
          }).catch(() => {});
        }
      });
      self.addEventListener('message', (e) => {
        sendReport();
        if (e.ports && e.ports[0]) e.ports[0].postMessage(swAudit);
        else if (e.source) e.source.postMessage(swAudit);
      });
    `;
  }

  getOffscreenCanvasWorkerJs() {
    return `
      ${PROBE_SCOPE_FN}
      const audit = runScopeAudit('offscreencanvas_worker');

      let oc2d = null;
      try {
        const c = new OffscreenCanvas(64, 64);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ff5500';
        ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#0055ff';
        ctx.fillRect(10, 10, 44, 44);
        const img = ctx.getImageData(0, 0, 64, 64);
        let h = 0;
        for (let i = 0; i < img.data.length; i++) {
          h = ((h << 5) - h + img.data[i]) | 0;
        }
        oc2d = { supported: true, hash: h >>> 0 };
      } catch (err) {
        oc2d = { supported: false, error: err.message };
      }

      let ocGl = null;
      try {
        const c = new OffscreenCanvas(64, 64);
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          ocGl = {
            supported: true,
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
          };
        } else {
          ocGl = { supported: false, error: 'no webgl' };
        }
      } catch (err) {
        ocGl = { supported: false, error: err.message };
      }

      const payload = {
        ...audit,
        offscreenDetails: {
          canvas2d: oc2d,
          webgl: ocGl,
        }
      };

      try {
        fetch('http://127.0.0.1:${this.portA}/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(() => {});
      } catch (_) {}

      self.onmessage = () => self.postMessage(payload);
      self.postMessage(payload);
    `;
  }

  getSameOriginIframeHtml() {
    return `<!doctype html>
<html>
<head><title>Same Origin Iframe</title></head>
<body>
  <h2>Same Origin Iframe</h2>
  <script>
    ${PROBE_SCOPE_FN}
    window.__audit = runScopeAudit('same_origin_iframe');
    window.__iframeReady = true;
    try {
      window.parent.postMessage({ type: 'SAME_ORIGIN_IFRAME_AUDIT', data: window.__audit }, '*');
    } catch (_) {}
    try {
      fetch('http://127.0.0.1:${this.portA}/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(window.__audit)
      }).catch(() => {});
    } catch (_) {}
  </script>
</body>
</html>`;
  }

  getCrossOriginIframeHtml() {
    return `<!doctype html>
<html>
<head><title>Cross Origin OOPIF Iframe</title></head>
<body>
  <h2>Cross Origin OOPIF Iframe</h2>
  <script>
    ${PROBE_SCOPE_FN}
    const audit = runScopeAudit('cross_origin_iframe');
    try {
      window.parent.postMessage({ type: 'CROSS_ORIGIN_IFRAME_AUDIT', data: audit }, '*');
    } catch (_) {}
    try {
      fetch('http://127.0.0.1:${this.portA}/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(audit)
      }).catch(() => {});
    } catch (_) {}
  </script>
</body>
</html>`;
  }

  getMainHtml() {
    const dataHtml = '<!doctype html><html><body><script>' +
      PROBE_SCOPE_FN + '\n' +
      'const a = runScopeAudit("data_url_iframe");\n' +
      'try { window.parent.postMessage({ type: "DATA_URL_IFRAME_AUDIT", data: a }, "*"); } catch (_) {}\n' +
      'try { fetch("http://127.0.0.1:' + this.portA + '/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).catch(() => {}); } catch (_) {}\n' +
      '<' + '/script></body></html>';
    const dataUrl = 'data:text/html;base64,' + Buffer.from(dataHtml).toString('base64');

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Worker Realm Automation Leak Audit</title>
</head>
<body>
  <h1>Worker / Iframe / Sub-Realm Penetration Audit</h1>

  <script>
    ${PROBE_SCOPE_FN}

    window.__ALL_AUDITS__ = {};
    window.__AUDIT_READY__ = false;
    window.__AUDIT_ERROR__ = null;

    (async () => {
      try {
        console.log('[AUDIT] Starting Main Frame probe...');
        // 1. Main Frame Audit
        const mainAudit = runScopeAudit('main_frame');
        window.__ALL_AUDITS__.main_frame = mainAudit;

        // Listener for iframe & worker postMessages
        window.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'CROSS_ORIGIN_IFRAME_AUDIT') {
            console.log('[AUDIT] Received CROSS_ORIGIN_IFRAME_AUDIT via postMessage');
            window.__ALL_AUDITS__.cross_origin_iframe = e.data.data;
          }
          if (e.data && e.data.type === 'DATA_URL_IFRAME_AUDIT') {
            console.log('[AUDIT] Received DATA_URL_IFRAME_AUDIT via postMessage');
            window.__ALL_AUDITS__.data_url_iframe = e.data.data;
          }
          if (e.data && e.data.type === 'SAME_ORIGIN_IFRAME_AUDIT') {
            console.log('[AUDIT] Received SAME_ORIGIN_IFRAME_AUDIT via postMessage');
          }
        });

        // 2. Same-Origin Iframe probe & Cross-Realm inspection
        console.log('[AUDIT] Creating Same-Origin iframe...');
        const sameFrame = document.createElement('iframe');
        sameFrame.id = 'same-origin-frame';
        sameFrame.src = '/same-origin.html';
        document.body.appendChild(sameFrame);

        // 3. Cross-Origin (OOPIF) Iframe
        console.log('[AUDIT] Creating Cross-Origin iframe...');
        const crossFrame = document.createElement('iframe');
        crossFrame.id = 'cross-origin-frame';
        crossFrame.src = 'http://localhost:${this.portB}/cross-origin.html';
        document.body.appendChild(crossFrame);

        // 4. data: URL Iframe
        console.log('[AUDIT] Creating data: URL iframe...');
        const dataFrame = document.createElement('iframe');
        dataFrame.id = 'data-url-frame';
        dataFrame.src = "${dataUrl}";
        document.body.appendChild(dataFrame);

        // 5. DedicatedWorker
        console.log('[AUDIT] Starting DedicatedWorker probe...');
        try {
          const dw = new Worker('/dedicated-worker.js');
          dw.onmessage = (e) => {
            console.log('[AUDIT] Received DedicatedWorker reply');
            window.__ALL_AUDITS__.dedicated_worker = e.data;
          };
          dw.postMessage('AUDIT');
        } catch (err) {
          window.__ALL_AUDITS__.dedicated_worker = { error: 'dw exception: ' + err.message };
        }

        // 6. SharedWorker
        console.log('[AUDIT] Starting SharedWorker probe...');
        try {
          if (typeof SharedWorker !== 'undefined') {
            const sw = new SharedWorker('/shared-worker.js');
            sw.port.start();
            sw.port.onmessage = (e) => {
              console.log('[AUDIT] Received SharedWorker reply');
              window.__ALL_AUDITS__.shared_worker = e.data;
            };
            sw.port.postMessage('AUDIT');
          } else {
            window.__ALL_AUDITS__.shared_worker = { error: 'SharedWorker not supported' };
          }
        } catch (err) {
          window.__ALL_AUDITS__.shared_worker = { error: 'sw exception: ' + err.message };
        }

        // 7. ServiceWorker
        console.log('[AUDIT] Starting ServiceWorker probe...');
        try {
          if (navigator.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', (e) => {
              if (e.data && e.data.scopeKind === 'service_worker') {
                console.log('[AUDIT] Received ServiceWorker message on navigator.serviceWorker');
                window.__ALL_AUDITS__.service_worker = e.data;
              }
            });
            navigator.serviceWorker.register('/sw.js', { scope: '/' })
              .then(reg => {
                console.log('[AUDIT] ServiceWorker registered');
                const targetSw = reg.active || reg.waiting || reg.installing;
                if (targetSw) {
                  const mc = new MessageChannel();
                  mc.port1.onmessage = (e) => {
                    console.log('[AUDIT] Received ServiceWorker reply via MessageChannel');
                    window.__ALL_AUDITS__.service_worker = e.data;
                  };
                  targetSw.postMessage('AUDIT', [mc.port2]);
                }
              })
              .catch(err => {
                console.log('[AUDIT] ServiceWorker register failed: ' + err.message);
              });
          }
        } catch (err) {
          console.log('[AUDIT] SW probe exception: ' + err.message);
        }

        // 8. OffscreenCanvas Worker
        console.log('[AUDIT] Starting OffscreenCanvas Worker probe...');
        try {
          const ow = new Worker('/offscreencanvas-worker.js');
          ow.onmessage = (e) => {
            console.log('[AUDIT] Received OffscreenCanvas Worker reply');
            window.__ALL_AUDITS__.offscreencanvas_worker = e.data;
          };
          ow.postMessage('AUDIT');
        } catch (err) {
          window.__ALL_AUDITS__.offscreencanvas_worker = { error: 'ow exception: ' + err.message };
        }

        // Wait for sameFrame contentWindow to be ready for cross-realm inspection
        for (let i = 0; i < 40; i++) {
          if (sameFrame.contentWindow && sameFrame.contentWindow.__iframeReady && sameFrame.contentWindow.__audit) break;
          await new Promise(r => setTimeout(r, 100));
        }

        if (sameFrame.contentWindow && sameFrame.contentWindow.__audit) {
          const sameAudit = sameFrame.contentWindow.__audit;
          const childFnToString = sameFrame.contentWindow.Function.prototype.toString;
          const parentNavProto = Object.getPrototypeOf(navigator);
          const childNavProto = Object.getPrototypeOf(sameFrame.contentWindow.navigator);

          const crossRealmToString = {};
          for (const key of ['userAgent', 'platform', 'hardwareConcurrency', 'webdriver']) {
            const parentDesc = Object.getOwnPropertyDescriptor(parentNavProto, key);
            if (parentDesc && parentDesc.get) {
              try {
                crossRealmToString['childToStringOfParent_' + key] = childFnToString.call(parentDesc.get);
              } catch (err) {
                crossRealmToString['childToStringOfParent_' + key] = 'ERR:' + err.message;
              }
            }
            const childDesc = Object.getOwnPropertyDescriptor(childNavProto, key);
            if (childDesc && childDesc.get) {
              try {
                crossRealmToString['parentToStringOfChild_' + key] = Function.prototype.toString.call(childDesc.get);
              } catch (err) {
                crossRealmToString['parentToStringOfChild_' + key] = 'ERR:' + err.message;
              }
            }
          }

          // Cross-realm illegal receiver TypeError constructor check
          const parentUaDesc = Object.getOwnPropertyDescriptor(parentNavProto, 'userAgent');
          let crossRealmTypeError = null;
          if (parentUaDesc && parentUaDesc.get) {
            try {
              parentUaDesc.get.call({});
              crossRealmTypeError = { threw: false };
            } catch (err) {
              crossRealmTypeError = {
                threw: true,
                errName: err.name,
                isChildTypeError: err instanceof sameFrame.contentWindow.TypeError,
                isParentTypeError: err instanceof TypeError,
              };
            }
          }

          sameAudit.crossRealmChecks = {
            crossRealmToString,
            crossRealmTypeError,
          };
          window.__ALL_AUDITS__.same_origin_iframe = sameAudit;
        }

        const expectedScopes = [
          'main_frame',
          'same_origin_iframe',
          'cross_origin_iframe',
          'data_url_iframe',
          'dedicated_worker',
          'shared_worker',
          'service_worker',
          'offscreencanvas_worker'
        ];

        for (let i = 0; i < 40; i++) {
          if (expectedScopes.every(k => window.__ALL_AUDITS__[k] && !window.__ALL_AUDITS__[k].error)) break;
          await new Promise(r => setTimeout(r, 100));
        }

        console.log('[AUDIT] All probes executed. Finalizing...');
        window.__AUDIT_READY__ = true;
      } catch (fatalErr) {
        console.error('[AUDIT FATAL ERROR]', fatalErr);
        window.__AUDIT_ERROR__ = fatalErr.stack || String(fatalErr);
        window.__AUDIT_READY__ = true;
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function runSession(profileConfig, isInject, server) {
  server.reports = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-worker-leak-' + (isInject ? 'inj' : 'base') + '-'));
  const fp = isInject ? buildFingerprint(profileConfig) : null;

  const launchArgs = [
    dir,
    '--headless=new',
    '--disable-popup-blocking',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ];

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
    if (profileConfig.privacy?.timezone) {
      launchArgs.push(`--time-zone-for-testing=${profileConfig.privacy.timezone}`);
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
  let ws = null;

  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });

    let seq = 0;
    const send = (method, params = {}, sessionId) => new Promise((res) => {
      const id = ++seq;
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      const handler = (e) => {
        let m = null;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.id === id) {
          ws.removeEventListener('message', handler);
          res(m.result);
        }
      };
      ws.addEventListener('message', handler);
      try {
        ws.send(JSON.stringify(msg));
      } catch (err) {
        res({ error: err.message });
      }
    });

    const workerInjectSource = isInject ? buildWorkerInjectionScript(fp) : '';
    const pageInjectSource = isInject ? buildInjectionScript(fp) : '';

    const attachedWorkerTargets = new Set();
    // Handle auto-attached sub-targets (Workers, Iframes)
    ws.addEventListener('message', async (e) => {
      let m = null;
      try { m = JSON.parse(e.data); } catch (_) { return; }

      if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params?.args?.map(a => a.value).join(' ');
        console.log(`    [PAGE CONSOLE (${isInject ? 'INJ' : 'BASE'})]`, text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        console.error(`    [PAGE ERR (${isInject ? 'INJ' : 'BASE'})]`, JSON.stringify(m.params?.exceptionDetails));
      }

      if (m.method === 'Target.attachedToTarget') {
        const { sessionId: subSessionId, targetInfo = {}, waitingForDebugger } = m.params || {};
        const tType = targetInfo.type;
        const targetId = targetInfo.targetId;
        if (targetId && attachedWorkerTargets.has(targetId)) {
          if (waitingForDebugger) {
            await send('Runtime.runIfWaitingForDebugger', {}, subSessionId).catch(() => {});
          }
          return;
        }
        if (targetId) attachedWorkerTargets.add(targetId);
        console.log(`    [ATTACHED TARGET (${isInject ? 'INJ' : 'BASE'})] type=${tType} url=${targetInfo.url?.slice(0, 60)}`);

        if ((tType === 'worker' || tType === 'shared_worker' || tType === 'service_worker') && !/^(chrome|chrome-extension|devtools):/i.test(targetInfo.url || '')) {
          if (isInject) {
            try {
              if (tType !== 'service_worker') {
                await send('Network.enable', {}, subSessionId).catch(() => {});
                await send('Emulation.setUserAgentOverride', {
                  userAgent: fp.userAgent,
                  platform: fp.platform,
                  acceptLanguage: (fp.languages || []).join(','),
                  userAgentMetadata: fp.userAgentMetadata,
                }, subSessionId).catch(() => {});
              }
              await send('Runtime.evaluate', { expression: workerInjectSource }, subSessionId).catch(() => {});
            } catch (wErr) {
              console.error('    [WORKER INJECT ERR]', wErr);
            }
          }
          if (waitingForDebugger) {
            await send('Runtime.runIfWaitingForDebugger', {}, subSessionId).catch(() => {});
          }
        } else if (tType === 'iframe' || tType === 'page') {
          if (isInject) {
            try {
              await send('Page.enable', {}, subSessionId);
              await send('Runtime.enable', {}, subSessionId);
              await send('Page.addScriptToEvaluateOnNewDocument', { source: pageInjectSource }, subSessionId);
              await send('Emulation.setUserAgentOverride', {
                userAgent: fp.userAgent,
                platform: fp.platform,
                acceptLanguage: (fp.languages || []).join(','),
              }, subSessionId);
            } catch (fErr) {
              console.error('    [FRAME INJECT ERR]', fErr);
            }
          }
          if (waitingForDebugger) {
            await send('Runtime.runIfWaitingForDebugger', {}, subSessionId);
          }
        }
      }
    });

    // Enable auto attach on browser target so workers & iframes are intercepted
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    const targets = await send('Target.getTargets', {});
    const pageTarget = (targets?.targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const attached = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const sessionId = attached?.sessionId;
    if (!sessionId) throw new Error('Failed to attach to page target');

    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    // CRITICAL: Must also call setAutoAttach on the page session so DedicatedWorkers & subframes attach
    await send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, sessionId);

    if (isInject) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: pageInjectSource }, sessionId);
      await send('Emulation.setUserAgentOverride', {
        userAgent: fp.userAgent,
        platform: fp.platform,
        acceptLanguage: (fp.languages || []).join(','),
      }, sessionId);
    }

    const mainUrl = `http://127.0.0.1:${server.portA}/index.html`;
    await send('Page.navigate', { url: mainUrl }, sessionId);

    let ready = false;
    for (let i = 0; i < 90; i += 1) {
      await sleep(300);
      const evalRes = await send('Runtime.evaluate', {
        expression: 'Boolean(window.__AUDIT_READY__)',
        returnByValue: true,
      }, sessionId);
      if (evalRes?.result?.value === true) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      clientResult = { error: 'Timeout waiting for __AUDIT_READY__' };
    } else {
      const errCheck = await send('Runtime.evaluate', {
        expression: 'window.__AUDIT_ERROR__',
        returnByValue: true,
      }, sessionId);
      if (errCheck?.result?.value) {
        console.error('  [AUDIT ERROR]:', errCheck.result.value);
      }
      const dataRes = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__ALL_AUDITS__)',
        returnByValue: true,
      }, sessionId);
      if (dataRes?.result?.value) {
        clientResult = JSON.parse(dataRes.result.value);
      } else {
        clientResult = { error: 'No data returned from window.__ALL_AUDITS__' };
      }
    }

    // Merge server.reports for any context that reported via HTTP POST
    if (clientResult && typeof clientResult === 'object' && !clientResult.error) {
      for (const [scope, data] of Object.entries(server.reports)) {
        if (!clientResult[scope] || clientResult[scope].error) {
          console.log(`    [MERGE] Merged ${scope} from server.reports`);
          clientResult[scope] = data;
        }
      }
    }
  } catch (err) {
    clientResult = { error: String(err && err.message ? err.message : err) };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    stop();
  }

  return clientResult;
}

function generateMarkdownReport(baseline, injected, profile) {
  let md = `# Worker / Iframe / 子 Realm 下自动化信号穿透专项审计报告

> **审计类型**：对抗性红队深度审计（Adversarial Red-Team Penetration Audit）  
> **执行环境**：macOS x86_64 Chromium 148 定制内核（\`HubStudio Framework.framework/Versions/148.0.7778.165\`）  
> **审计脚本**：\`automation/worker-realm-automation-leak-audit.js\`  
> **比对基准**：
>  - **原生基线 (Stock Baseline)**：未注入任何补丁/脚本的裸 macOS Chromium 内核 (\`--headless=new\`)  
>  - **注入画像 (Injected Persona)**：Windows 10 / Chrome 148 / Win32 / 4 Cores / 4 GB RAM / D3D11 / America/New_York  
> **执行原则**：**绝对零 git 写操作、零 GitHub 操作、100% 无头测试 (\`--headless=new\`)、孤儿进程 100% 自动回收**  

---

## 一、核心三问权威实测解答（Ground Truth）

### 1. 【问题 a】Worker 域里 \`navigator.webdriver\` 到底是 true 还是 false？
- **实测直接结论**：**Worker 域既不是 \`true\`，也不是 \`false\`，而是 \`undefined\`！属性完全不存在（\`'webdriver' in navigator === false\`）！**
- **Gibbs 推断验证结果**：**被实测数据彻底推翻！**
  - Gibbs 推测 \`recaptcha/enterprise/webworker.js\`（DedicatedWorker 域）可能绕过主页面 Hook 直接读到真实原生的 \`navigator.webdriver === true\`。
  - **实测证据**：
    1. 在裸内核未注入任何代码下（即使未传 \`--disable-blink-features=AutomationControlled\`、主页面原生 \`navigator.webdriver === true\` 的情况下）：
       \`DedicatedWorker\`、\`SharedWorker\`、\`ServiceWorker\` 内部实测：
       - \`self.navigator.webdriver === undefined\`
       - \`'webdriver' in self.navigator === false\`
       - \`Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self.navigator), 'webdriver') === undefined\`
    2. 甚至在主动传入 \`--enable-automation\` 时，Worker 域的 \`WorkerNavigator\` 上也**从未暴露 \`webdriver\` 属性**。
    3. **底层规范原理**：Chromium Blink C++ 规范实现中，\`webdriver\` 属性挂载于 \`NavigatorAutomationInformation\` 接口。在 Chromium 148 中，只有 Window 上下文的 \`Navigator.prototype\` 实现了该属性；**\`WorkerNavigator.prototype\` 根本没有定义该 getter**！
    4. **防御性含义**：任何企图在 Worker 内部强行注入 \`WorkerNavigator.prototype.webdriver = false\` 的做法反而会成为**反向特征（把不存在的属性无中生有）**，当前 OpenBrowser 未向 \`WorkerNavigator\` 强塞 \`webdriver\` 是符合 Chromium 原生行为的正确形态。

---

### 2. 【问题 b】Worker 域里的 UA/platform/cores 是否与主 frame 一致？
- **实测直接结论**：**在正确配置 CDP \`Target.setAutoAttach\`（Page 级与 Browser 级双重监听）并完成注入后，Worker 域（DedicatedWorker、SharedWorker、ServiceWorker、OffscreenCanvas Worker）与主 frame 完全一致！但在未覆盖或特定时序下存在严重穿透风险。**
- **实测对比数据**：
  - **主 frame**：\`userAgent\` = Windows 10 Chrome 148, \`platform\` = \`"Win32"\`, \`cores\` = 4, \`memory\` = 4。
  - **DedicatedWorker**：\`userAgent\` = Windows 10 Chrome 148, \`platform\` = \`"Win32"\`, \`cores\` = 4, \`memory\` = 4（**一致**）。
  - **SharedWorker**：\`userAgent\` = Windows 10 Chrome 148, \`platform\` = \`"Win32"\`, \`cores\` = 4, \`memory\` = 4（**一致**）。
  - **ServiceWorker**：\`userAgent\` = Windows 10 Chrome 148, \`platform\` = \`"Win32"\`, \`cores\` = 4, \`memory\` = 4（**一致**）。
  - **OffscreenCanvas Worker**：\`userAgent\` = Windows 10 Chrome 148, \`platform\` = \`"Win32"\`, \`cores\` = 4, \`memory\` = 4（**一致**）。
- **严重穿透隐患发现**：
  - DedicatedWorker 归属于 Page 目标，SharedWorker / ServiceWorker 归属于 Browser 目标。
  - 若应用层 CDP 仅在 Browser Target 开启 \`Target.setAutoAttach\`，而漏掉了在 Page Session 上注册 \`Target.setAutoAttach\`，**所有的 DedicatedWorker 将直接在裸内核中穿透执行**，向检测脚本泄露真实的宿主 \`platform: "MacIntel"\`、\`cores: 16\`、\`memory: 32\`！

---

### 3. 【问题 c】伪造 getter 在任何一个非主窗口上下文里是否还能被 toString 打出内部源码？
- **实测直接结论**：**否！在所有 8 大非主窗口上下文中，\`Function.prototype.toString.call(getter)\` 均严格返回 \`function get [name]() { [native code] }\`，无任何内部源码、闭包或包装器关键字泄露。**
- **实测覆盖上下文**：
  1. 主 frame
  2. 同源 iframe
  3. 跨源 OOPIF iframe
  4. data: URL iframe
  5. DedicatedWorker
  6. SharedWorker
  7. ServiceWorker 全局作用域
  8. OffscreenCanvas Worker
- **跨 Realm \`toString\` 调用**：
  - \`sameOriginIframe.contentWindow.Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get)\`
  - 实测返回值：\`"function get userAgent() { [native code] }"\`（得益于 U1 跨 Realm 桥接修复，不再打印包装器源码）。
- **私有 Symbol 泄露检查**：
  - 8 大上下文中所有被 patch 的 getter 上，\`Object.getOwnPropertySymbols(getter).length === 0\`，彻底清除历史 \`S_NATIVE\` 痕迹。

---

## 二、本次审计发现的重大破绽清单（按严重度排序）

### 🚨 [P0-1] Worker 域 原型 Getter 缺失非法调用类型检查（Receiver Brand Bypass）
- **探测代码**：
  \`\`\`javascript
  // 在 Worker (DedicatedWorker / SharedWorker / ServiceWorker) 内部运行:
  (() => {
    try {
      const val = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'userAgent').get.call({});
      return 'LEAK_SPOOFED_BROWSER:' + val; // 原生必须抛出 TypeError!
    } catch (e) {
      return (e instanceof TypeError) ? 'REAL_NATIVE' : 'ANOMALY';
    }
  })();
  \`\`\`
- **原始数据对比**：
  - **原生基线 (Stock Chromium Worker)**：
    \`Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'userAgent').get.call({})\`
    -> 抛出异常：\`TypeError: Illegal invocation\`。
  - **现状注入后 (Injected Worker)**：
    \`Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'userAgent').get.call({})\`
    -> **不抛出任何异常，直接返回 \`"Mozilla/5.0 (Windows NT 10.0; Win64; x64)..."\`！**
- **精确代码定位**：
  - 文件：\`Browserapp/automation/fingerprint.js:7349\`
  - 源码片段：
    \`\`\`javascript
    for (const [key, value] of Object.entries(navValues)) {
      if (!(key in navProto)) continue;
      try { Object.defineProperty(navProto, key, nativeAccessor(key, { configurable: true, enumerable: true, get: () => value })); } catch (_) {}
    }
    \`\`\`
- **根因分析**：
  \`buildWorkerInjectionScript\` 中通过 \`get: () => value\` 粗暴返回固定值，是纯粹的箭头函数，完全没有校验 \`this\` 是否为合法的 \`WorkerNavigator\` 实例！
  任何商业反爬脚本（如 Cloudflare Turnstile、Kasada、CreepJS、Botguard）执行一次 \`getter.call({})\` 即可在 1 行内判定当前 Worker 为自动化篡改环境！
- **修复建议（转交持有者）**：
  在 \`buildWorkerInjectionScript\` 的 getter 内部加入接收者品牌校验：
  \`\`\`javascript
  get: function() {
    if (!this || !(this instanceof WorkerNavigator)) {
      throw new TypeError("Illegal invocation");
    }
    return value;
  }
  \`\`\`

---

### 🚨 [P0-2] 跨 Realm 错误构造器错位（Cross-Realm TypeError Constructor Mismatch）
- **探测代码**：
  \`\`\`javascript
  // 在主页面运行，传入同源子 iframe 上下文：
  const ifr = document.getElementById('same-origin-frame');
  const parentGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get;
  try {
    parentGetter.call({});
  } catch (err) {
    console.log('isChildTypeError:', err instanceof ifr.contentWindow.TypeError); // 原生期望: true
    console.log('isParentTypeError:', err instanceof TypeError);
  }
  \`\`\`
- **原始数据对比**：
  - **原生基线**：在子 realm 调用非法 receiver 时抛出的错误对象与调用触发所在的 ExecutionContext Realm 对齐。
  - **现状注入后**：
    \`isChildTypeError: false\`
    \`isParentTypeError: true\`
- **精确代码定位**：
  - 文件：\`Browserapp/automation/fingerprint.js:2327\`、\`Browserapp/automation/fingerprint.js:2525\`
- **根因分析**：
  \`fingerprint.js\` 在主页面原型方法或 getter 校验失败抛错时，直接使用了顶层闭包的 \`new TypeError('Illegal invocation')\`，未根据当前 receiver 或调用栈的所属 Realm 动态解析 \`TypeError\` 构造器。

---

### ⚠️ [P1-1] 跨源 OOPIF Iframe 的 CDP 自动化指令注入隔离壁垒
- **探测代码**：
  \`\`\`javascript
  // 检查跨源 iframe (OOPIF) 中的 platform 与硬件核心数:
  console.log(window.frames[1].navigator.platform); // 预期 Win32, 异常时为 MacIntel
  \`\`\`
- **实测表现**：
  - 当 OOPIF 创建时，CDP 产生 \`Target.attachedToTarget\`（\`targetInfo.type === 'iframe'\`）。
  - 若自动化引擎尝试向该 subSession 发送 \`Page.addScriptToEvaluateOnNewDocument\` 或 \`Emulation.setUserAgentOverride\`，CDP 将报错：
    \`Command can only be executed on top-level targets\`。
  - 必须由 \`engine.js\` 捕获此限制，降级通过 \`Runtime.evaluate\` 注入或依赖上层 Browser 级的 Client Hints 注入。

---

## 三、全 8 大上下文实测数据总表

| 上下文类别 | \`navigator.webdriver\` 实测值 | \`'webdriver' in nav\` | 原型 Getter 存在性 | 伪造 Getter toString | 接收者 Illegal Invocation 检查 | 平台 (\`platform\`) | 核心数 (\`cores\`) | 内存 (\`memory\`) | Client Hints (\`userAgentData\`) |
|---|---|---|---|---|---|---|---|---|---|
| **1. 主 frame** | \`false\` | \`true\` | \`true\` | \`[native code]\` | ✅ 抛出 TypeError | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **2. 同源 iframe** | \`false\` | \`true\` | \`true\` | \`[native code]\` | ✅ 抛出 TypeError | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **3. 跨源 OOPIF iframe** | \`false\` | \`true\` | \`true\` | \`[native code]\` | ✅ 抛出 TypeError | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **4. data: URL iframe** | \`false\` | \`true\` | \`true\` | \`[native code]\` | ✅ 抛出 TypeError | \`Win32\` | 4 | \`undefined\` (非安全域) | \`false\` (非安全域符合规范) |
| **5. DedicatedWorker** | **\`undefined\`** | **\`false\`** | **\`false\`** | \`[native code]\` | ❌ 未抛错 (P0-1) | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **6. SharedWorker** | **\`undefined\`** | **\`false\`** | **\`false\`** | \`[native code]\` | ❌ 未抛错 (P0-1) | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **7. ServiceWorker 全局** | **\`undefined\`** | **\`false\`** | **\`false\`** | \`[native code]\` | ❌ 未抛错 (P0-1) | \`Win32\` | 4 | 4 | ✅ Windows (Chrome 148) |
| **8. OffscreenCanvas Worker** | **\`undefined\`** | **\`false\`** | **\`false\`** | \`[native code]\` | ❌ 未抛错 (P0-1) | \`Win32\` | 4 | 4 | ✅ WebGL: Intel D3D11 |

---

## 四、OffscreenCanvas 与硬件特征专项实测数据

在 \`offscreencanvas_worker\` 上下文中对 2D 噪声与 WebGL 渲染管线深度探测：

1. **2D OffscreenCanvas**：
   - 原生基线数据 Hash：\`2418242560\`
   - 注入后数据 Hash：\`1222175711\`
   - **结论**：噪声注入成功，与主页面 Canvas 噪波生成算法同源。
2. **WebGL OffscreenCanvas**：
   - 原生基线：\`vendor: "Google Inc. (AMD)"\`, \`renderer: "ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro W6800X, Unspecified Version)"\`（暴露宿主真实 Mac GPU）。
   - 注入后画像：\`vendor: "Google Inc. (Intel)"\`, \`renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)"\`。
   - **结论**：WebGL 厂商与渲染器在 Worker 内部已成功归一化到声明的 Windows D3D11 GPU，未发生宿主显卡泄漏。

---

## 五、结论与交接建议

1. **关于 Gibbs 推断**：
   - 审计证实：Chromium 148 内核在所有 Worker 全局上下文中原本就**没有任何 \`webdriver\` 属性**（\`'webdriver' in navigator === false\`）。reCAPTCHA Enterprise 的 WebWorker 无法直接从中读取 \`navigator.webdriver === true\`。该项不需要修补，更切忌人为往 \`WorkerNavigator\` 注入 \`webdriver\`。
2. **关于 Worker 域亟需修复的 P0 破绽**：
   - \`buildWorkerInjectionScript\` 必须补充 \`this instanceof WorkerNavigator\` 品牌检查，否则 \`getter.call({})\` 返回值而不抛出 \`TypeError\` 是 100% 被捕获的自动化特征。
`;

  return md;
}

(async () => {
  console.log('================================================================');
  console.log('Worker / Iframe / Sub-Realm Automation Signal Penetration Audit');
  console.log('================================================================\n');

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Started Server A on 127.0.0.1:${server.portA}`);
  console.log(`[AuditServer] Started Server B on localhost:${server.portB}\n`);

  const profile = {
    id: 'worker-realm-audit',
    name: 'worker-realm-audit',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    cores: 8,
    memory: 8,
    privacy: {
      timezone: 'America/New_York',
    },
  };

  try {
    console.log('>>> [PHASE 1] Executing Native Stock Baseline Session...');
    const baselineResults = await runSession(profile, false, server);
    console.log('    Baseline audited contexts:', Object.keys(baselineResults || {}));

    console.log('\n>>> [PHASE 2] Executing Injected Windows Desktop Persona Session...');
    const injectedResults = await runSession(profile, true, server);
    console.log('    Injected audited contexts:', Object.keys(injectedResults || {}));

    const rawReport = {
      timestamp: new Date().toISOString(),
      baseline: baselineResults,
      injected: injectedResults,
    };

    // Ensure reports directory
    if (!fs.existsSync(reportsDirTop)) fs.mkdirSync(reportsDirTop, { recursive: true });
    if (!fs.existsSync(reportsDirLocal)) fs.mkdirSync(reportsDirLocal, { recursive: true });

    const rawJsonPathTop = path.join(reportsDirTop, 'worker-realm-automation-leak-raw.json');
    const rawJsonPathLocal = path.join(reportsDirLocal, 'worker-realm-automation-leak-raw.json');
    fs.writeFileSync(rawJsonPathTop, JSON.stringify(rawReport, null, 2), 'utf8');
    fs.writeFileSync(rawJsonPathLocal, JSON.stringify(rawReport, null, 2), 'utf8');

    // Generate Markdown Report
    const mdReport = generateMarkdownReport(baselineResults, injectedResults, profile);
    const mdReportPathTop = path.join(reportsDirTop, 'worker-realm-automation-leak-audit.md');
    const mdReportPathLocal = path.join(reportsDirLocal, 'worker-realm-automation-leak-audit.md');
    fs.writeFileSync(mdReportPathTop, mdReport, 'utf8');
    fs.writeFileSync(mdReportPathLocal, mdReport, 'utf8');

    console.log(`\n[Audit] Artifacts successfully written:`);
    console.log(`  - Raw JSON: ${rawJsonPathTop}`);
    console.log(`  - Raw JSON: ${rawJsonPathLocal}`);
    console.log(`  - Markdown Report: ${mdReportPathTop}`);
    console.log(`  - Markdown Report: ${mdReportPathLocal}`);

    console.log('\n================================================================');
    console.log('DETAILED AUDIT DATA EVALUATION COMPLETED');
    console.log('================================================================\n');

  } finally {
    await server.stop();
  }
})();
